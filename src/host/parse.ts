/**
 * Parsers for the three machine formats this plugin reads: `git status --porcelain=v2 --branch`,
 * `git worktree list --porcelain`, and one fixed `git for-each-ref --format`.
 *
 * Pure functions over already-captured text, with no context and no I/O, so every format quirk is
 * covered by a unit test rather than by a live repository.
 * @module @achasoft/dsh-worktree/host/parse
 */

import type { BranchEntry, DirtyState, TrackingState, WorktreeEntry } from './types.ts'

/** Field separator inside one `for-each-ref` record; `%1f` in the format string. */
export const FIELD_SEPARATOR = '\u001f'

/** Record separator between `for-each-ref` records; `%1e` in the format string. */
export const RECORD_SEPARATOR = '\u001e'

/**
 * The `for-each-ref` format this parser reads, in the field order {@link parseBranches} expects.
 *
 * `%(worktreepath)` is deliberately absent even though it would answer {@link BranchEntry.checkedOutAt}
 * directly: that atom needs git 2.23, and the worktree listing this plugin already takes carries the
 * same fact for every git that has worktrees at all.
 */
export const BRANCH_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(objectname:short)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:unix)',
  '%(authorname)',
  '%(HEAD)',
  '%(symref)',
  '%(contents:subject)',
].join('%1f') + '%1e'

/** `ahead 2, behind 1` as `%(upstream:track,nobracket)` writes it; git does not translate these. */
const AHEAD = /\bahead (\d+)/u
const BEHIND = /\bbehind (\d+)/u

/**
 * Read one `%(upstream:track,nobracket)` value.
 * @param upstream - the short upstream name; empty means the branch tracks nothing.
 * @param track - git's track summary: `ahead N`, `behind N`, `ahead N, behind M`, `gone`, or empty.
 * @returns the tracking state, or undefined when there is no upstream.
 */
export function parseTracking(upstream: string, track: string): TrackingState | undefined {
  if (upstream === '') return undefined
  return {
    upstream,
    ahead: Number(AHEAD.exec(track)?.[1] ?? 0),
    behind: Number(BEHIND.exec(track)?.[1] ?? 0),
    gone: track.includes('gone'),
  }
}

/**
 * Parse `git for-each-ref` output written with {@link BRANCH_FORMAT}.
 *
 * Symbolic refs are dropped: `refs/remotes/origin/HEAD` is a pointer at another row in the same
 * list, and offering it as a branch would let someone try to check out a name git resolves elsewhere.
 * @param stdout - the captured output.
 * @param checkedOutAt - branch short name to the worktree holding it, from {@link parseWorktrees}.
 * @returns one entry per real branch, in git's own output order.
 */
export function parseBranches(
  stdout: string, checkedOutAt: ReadonlyMap<string, string>,
): BranchEntry[] {
  const entries: BranchEntry[] = []
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    // git writes a newline after each record's terminator, so every record but the first arrives
    // with it still attached; the last split part is the trailing newline alone.
    const trimmed = record.replace(/^\r?\n/u, '')
    if (trimmed === '') continue
    const fields = trimmed.split(FIELD_SEPARATOR)
    if (fields.length < 10) continue
    const [ref, name, sha, upstream, track, committed, author, head, symref, ...subject] =
      fields as [string, string, string, string, string, string, string, string, string, ...string[]]
    if (symref !== '') continue
    const tracking = parseTracking(upstream, track)
    const worktree = checkedOutAt.get(name)
    entries.push({
      name,
      ref,
      kind: ref.startsWith('refs/remotes/') ? 'remote' : 'local',
      current: head === '*',
      ...tracking === undefined ? {} : { tracking },
      sha,
      // A subject containing the field separator would have split; rejoining is what keeps such a
      // commit message readable instead of truncated at the first separator-shaped byte.
      subject: subject.join(FIELD_SEPARATOR),
      author,
      committedAt: Number(committed) * 1_000,
      ...worktree === undefined ? {} : { checkedOutAt: worktree },
    })
  }
  return entries
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Records are separated by an empty line and each attribute is `<key>` or `<key> <value>`. The main
 * worktree is always git's first record, which is what {@link WorktreeEntry.main} records.
 * @param stdout - the captured output.
 * @param separator - line separator: `\n` for the plain form, `\0` for the `-z` form.
 * @param currentWorktree - absolute path of the worktree the request landed in.
 * @returns one entry per worktree, in git's own order.
 */
export function parseWorktrees(
  stdout: string, separator: string, currentWorktree: string,
): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let draft: {
    path: string
    sha?: string
    branch?: string
    bare: boolean
    detached: boolean
    locked: boolean
    lockReason?: string
    prunable: boolean
    prunableReason?: string
  } | undefined

  const flush = (): void => {
    if (draft === undefined) return
    entries.push({
      path: draft.path,
      ...draft.sha === undefined ? {} : { sha: draft.sha },
      ...draft.branch === undefined ? {} : { branch: draft.branch },
      bare: draft.bare,
      detached: draft.detached,
      locked: draft.locked,
      ...draft.lockReason === undefined ? {} : { lockReason: draft.lockReason },
      prunable: draft.prunable,
      ...draft.prunableReason === undefined ? {} : { prunableReason: draft.prunableReason },
      current: draft.path === currentWorktree,
      main: entries.length === 0,
    })
    draft = undefined
  }

  for (const raw of stdout.split(separator)) {
    const line = separator === '\n' ? raw.replace(/\r$/u, '') : raw
    if (line === '') {
      flush()
      continue
    }
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      flush()
      draft = { path: value, bare: false, detached: false, locked: false, prunable: false }
      continue
    }
    if (draft === undefined) continue
    switch (key) {
      case 'HEAD':
        // Abbreviated here rather than asked of git: `worktree list` always prints the full object
        // name, and seven characters is what `%(objectname:short)` gives the branch rows beside it.
        draft.sha = value.slice(0, 7)
        break
      case 'branch':
        draft.branch = value.replace(/^refs\/heads\//u, '')
        break
      case 'bare':
        draft.bare = true
        break
      case 'detached':
        draft.detached = true
        break
      case 'locked':
        draft.locked = true
        if (value !== '') draft.lockReason = value
        break
      case 'prunable':
        draft.prunable = true
        if (value !== '') draft.prunableReason = value
        break
      default:
        // git may add attributes; an unknown one describes a worktree this surface still lists.
        break
    }
  }
  flush()
  return entries
}

/**
 * Branch short name to the absolute path of the worktree holding it.
 *
 * git refuses to check one branch out in two worktrees, so this is a function rather than a
 * relation — and it is the fact that decides whether a branch row offers a switch or a jump.
 * @param worktrees - the parsed worktree listing.
 * @returns the lookup {@link parseBranches} takes.
 */
export function branchWorktreeIndex(worktrees: readonly WorktreeEntry[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const worktree of worktrees) {
    if (worktree.branch !== undefined) index.set(worktree.branch, worktree.path)
  }
  return index
}

/** What `git status --porcelain=v2 --branch` says about HEAD, beyond the change records. */
export interface StatusHeader {
  /** Current branch, absent when HEAD is detached. */
  readonly branch?: string
  /** Abbreviated commit HEAD points at, absent before the first commit. */
  readonly sha?: string
  /** True when HEAD points straight at a commit. */
  readonly detached: boolean
  /** True before the first commit. */
  readonly unborn: boolean
  /** Tracking state of the current branch, absent when it tracks nothing. */
  readonly tracking?: TrackingState
}

/** One status reading: where HEAD is, and how much is uncommitted. */
export interface StatusReading {
  readonly header: StatusHeader
  readonly dirty: DirtyState
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * The `-z` form is what makes this safe: paths arrive NUL-terminated and unquoted, so a path holding
 * a quote or a newline cannot be miscounted. A rename record (`2 `) carries its original path as a
 * separate NUL-terminated field, which is consumed here so it is never counted as its own change.
 * @param stdout - the captured output.
 * @returns the header and the four change counts.
 */
export function parseStatus(stdout: string): StatusReading {
  let branch: string | undefined
  let sha: string | undefined
  let upstream = ''
  let ahead = 0
  let behind = 0
  let counted = false
  let detached = false
  let unborn = false
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0

  const fields = stdout.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''
    if (field === '') continue
    if (field.startsWith('# ')) {
      const [key, ...rest] = field.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        if (value === '(initial)') unborn = true
        else sha = value.slice(0, 10)
      } else if (key === 'branch.head') {
        if (value === '(detached)') detached = true
        else branch = value
      } else if (key === 'branch.upstream') {
        upstream = value
      } else if (key === 'branch.ab') {
        // `+N -M`, always both, and printed exactly when the upstream still resolves.
        const [plus, minus] = value.split(' ')
        counted = true
        ahead = Number((plus ?? '').replace('+', '')) || 0
        behind = Number((minus ?? '').replace('-', '')) || 0
      }
      continue
    }
    const kind = field.charAt(0)
    if (kind === '?') {
      untracked += 1
      continue
    }
    if (kind === '!') continue
    if (kind === 'u') {
      conflicted += 1
      continue
    }
    if (kind !== '1' && kind !== '2') continue
    // `<kind> <XY> …`: X is the index status, Y the worktree status, and `.` means unchanged there.
    const xy = field.slice(2, 4)
    if (xy.charAt(0) !== '.') staged += 1
    if (xy.charAt(1) !== '.') unstaged += 1
    // A rename's original path is its own NUL-terminated field; skipping it here is what keeps the
    // next iteration looking at a record rather than at a bare path.
    if (kind === '2') index += 1
  }

  // git names the upstream of a branch whose upstream ref has been deleted, but cannot count
  // against it — so a missing `# branch.ab` beside a present `# branch.upstream` IS the gone signal.
  const tracking = upstream === ''
    ? undefined
    : { upstream, ahead, behind, gone: !counted }
  return {
    header: {
      ...branch === undefined ? {} : { branch },
      ...sha === undefined ? {} : { sha },
      detached,
      unborn,
      ...tracking === undefined ? {} : { tracking },
    },
    dirty: { staged, unstaged, untracked, conflicted },
  }
}
