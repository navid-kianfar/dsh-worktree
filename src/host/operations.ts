/**
 * Every reading and mutation the `worktree` namespace publishes, expressed as git invocations over
 * {@link GitClient} and the parsers in `./parse.ts`.
 *
 * Three rules hold across the file. A value from the browser becomes a git argument only after this
 * layer has proved what it names — a branch through the shared name rules (which refuse a leading
 * `-`) and `rev-parse --verify`, a worktree path through git's own listing — so a request cannot
 * smuggle an option or a pathspec into an argument list; where git's parser allows it, `--` also ends
 * the options before those values, so a later edit that forgets the proof still cannot turn one into
 * an option. A reading taken without anyone asking for it — the chip's poll — runs no program the
 * repository's configuration names (see {@link WorktreeOperations.readingOptions}). And nothing here
 * throws for a business outcome: a dirty checkout, an unmerged delete, and a locked worktree are
 * returned as classified failures, because the browser's next move differs for each.
 * @module @achasoft/dsh-worktree/host/operations
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  basenameOf, expandPathTemplate, flattenBranch, isAbsolutePath, parentOf,
} from '../shared/path.ts'
import { checkBranchName, localBranchOf } from '../shared/branch-name.ts'
import { classify, fail, type GitClient } from './git.ts'
import {
  BRANCH_FORMAT, READING_CONFIG_KEYS, branchWorktreeIndex, countBranchRecords, parseBranches,
  parseContents, parseFilterDrivers, parseStatus, parseWorktrees, worktreeConfigEnabled,
} from './parse.ts'
import { isEmptyDirectory, resolveDirectory, resolvePath, type ResolvedPath } from './paths.ts'
import type { CommandOutcome } from './run.ts'
import type {
  AddWorktreeRequest, AddWorktreeResult, BranchEntry, CheckoutRequest, CreateBranchRequest,
  DeleteBranchRequest, GitFailure, InspectWorktreeRequest, InspectWorktreeResult,
  LockWorktreeRequest, MutationResult, OverviewResult, RemoveWorktreeRequest, RenameBranchRequest,
  RepoRequest, SearchBranchesRequest, SearchBranchesResult, SuggestPathRequest, SuggestPathResult,
  WorktreeContents, WorktreeEntry, WorktreeSettings,
} from './types.ts'

/** What every endpoint resolves before touching a repository. */
interface Repository {
  /** The requested directory, canonicalized. */
  readonly requested: ResolvedPath
  /** Absolute path of the worktree the request landed in. */
  readonly worktreeRoot: string
  /** Every worktree of the repository, main worktree first. */
  readonly worktrees: readonly WorktreeEntry[]
}

/** A resolved repository, or the failure to answer with instead. */
type RepositoryOutcome = { readonly ok: true; readonly value: Repository } | { readonly ok: false; readonly failure: GitFailure }

/** A bounded branch listing, or the failure to answer with instead. */
type BranchListing = { readonly ok: true; readonly branches: BranchEntry[]; readonly truncated: boolean } | GitFailure

/** Arguments placed ahead of a reading's subcommand, or the failure to answer with instead. */
type ReadingOptions = { readonly ok: true; readonly argv: readonly string[] } | GitFailure

/**
 * A full object name: SHA-1 or SHA-256 hex. The only spelling {@link DeleteBranchRequest.expectedTip}
 * accepts, because comparing against anything git would still have to resolve — a branch name, an
 * abbreviation — would compare against whatever it resolves to at that moment.
 */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** Characters git forbids in every ref name, and that `for-each-ref` would read as a glob. */
const GLOB_CHARACTERS = /[*?[\\]/u

/** `git config --get-regexp` found nothing: its documented "no match" exit, not a failure. */
const CONFIG_NO_MATCH = 1

/**
 * git's own one-line account of what a successful command did.
 *
 * stdout first, then stderr, because git splits these by command rather than by importance:
 * `worktree add` reports the resulting commit on stdout while `switch` reports the branch on stderr,
 * and taking the first non-empty line of either is what makes both read the same in the UI.
 * @param outcome - a command that exited zero.
 * @returns the summary line, or empty when git printed nothing.
 */
function summarize(outcome: CommandOutcome): string {
  return [...outcome.stdout.split('\n'), ...outcome.stderr.split('\n')]
    .map(part => part.trim())
    .find(part => part !== '') ?? ''
}

/**
 * Turn a mutating command's outcome into its result.
 * @param outcome - the finished command.
 * @returns success carrying git's own summary, or the classified failure.
 */
function settle(outcome: CommandOutcome): MutationResult {
  if (outcome.exitCode !== 0) return classify(outcome)
  return { ok: true, detail: summarize(outcome) }
}

/**
 * Refuse a branch name git would refuse, before it becomes an argument.
 * @param name - the proposed name.
 * @returns the failure to return, or undefined when the name is usable.
 */
function rejectBranchName(name: string): GitFailure | undefined {
  const verdict = checkBranchName(name)
  if (verdict.ok) return undefined
  return fail('invalid-request', `"${name}" is not a usable branch name (${verdict.problem})`)
}

/** Reads and mutates one Host's repositories on behalf of the `worktree` Remote namespace. */
export class WorktreeOperations {
  /**
   * @param ctx - Host context carrying the filesystem capability.
   * @param git - the shared git client.
   * @param source - reads the current settings section, per request.
   */
  constructor(
    private readonly ctx: Context,
    private readonly git: GitClient,
    private readonly source: () => WorktreeSettings,
  ) {}

  /**
   * Read everything the chip and both popovers draw.
   * @param request - the workspace directory to read.
   * @param signal - cancellation for the reading.
   * @returns the reading, or a classified failure.
   */
  async overview(request: RepoRequest, signal?: AbortSignal): Promise<OverviewResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const { requested, worktreeRoot, worktrees } = prepared.value
    const settings = this.source()

    const options = await this.readingOptions(requested.processPath, signal)
    if (!options.ok) return options
    const status = await this.git.run(
      requested.processPath,
      [
        ...options.argv,
        'status', '--porcelain=v2', '--branch', '--untracked-files=normal',
        // `dirty` rather than the default: counting changes INSIDE a submodule means git spawns a
        // status in it, and that child reads the submodule's own config — filter drivers this layer
        // never saw. A submodule whose recorded commit moved is still reported.
        '--ignore-submodules=dirty',
        '-z',
      ],
      {},
      signal,
    )
    if (status.exitCode !== 0) return classify(status)
    const reading = parseStatus(status.stdout)

    const refs = settings.includeRemoteBranches ? ['refs/heads', 'refs/remotes'] : ['refs/heads']
    const listing = await this.listBranches(requested.processPath, worktrees, refs, [], signal)
    if (!listing.ok) return listing

    const main = worktrees[0]
    return {
      ok: true,
      repo: {
        root: main?.path ?? worktreeRoot,
        worktreeRoot,
        name: basenameOf(main?.path ?? worktreeRoot),
        ...reading.header.branch === undefined ? {} : { branch: reading.header.branch },
        ...reading.header.sha === undefined ? {} : { sha: reading.header.sha },
        detached: reading.header.detached,
        unborn: reading.header.unborn,
        ...reading.header.tracking === undefined ? {} : { tracking: reading.header.tracking },
        dirty: reading.dirty,
        linked: main !== undefined && main.path !== worktreeRoot,
      },
      branches: this.orderBranches(listing.branches),
      branchesTruncated: listing.truncated,
      worktrees,
      readAt: Date.now(),
    }
  }

  /**
   * Find branches whose short name contains some text, beyond the ceiling an overview is cut at.
   *
   * The switcher filters the reading it holds, and that reading stops at
   * {@link WorktreeSettings.maxBranches} — so on a repository with more branches than that, typing a
   * name that exists would otherwise find nothing, and offer to create it.
   * @param request - the repository and the text to search for.
   * @param signal - cancellation for the listing.
   * @returns the matching branches, or a classified failure.
   */
  async searchBranches(request: SearchBranchesRequest, signal?: AbortSignal): Promise<SearchBranchesResult> {
    const query = request.query.trim()
    if (query === '') return fail('invalid-request', 'a branch search needs some text to search for')
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    // No ref name can contain these, so nothing can match — and passing them on would make the query
    // a glob that matches far more than the text typed.
    if (GLOB_CHARACTERS.test(query)) return { ok: true, branches: [], truncated: false }
    const roots = this.source().includeRemoteBranches ? ['refs/heads/', 'refs/remotes/'] : ['refs/heads/']
    // `for-each-ref` matches patterns with path semantics — `*` stops at `/` — so a substring needs
    // two: `**/*q*` for a match in the last component, `**/*q*/**` for one with components after
    // it (`**/` also matches no directory at all). git prints a ref matching both once. For a remote
    // the remote's own name is part of the text searched, as it is part of the name the switcher shows.
    const patterns = roots.flatMap(root => [`${root}**/*${query}*`, `${root}**/*${query}*/**`])
    const listing = await this.listBranches(
      prepared.value.requested.processPath, prepared.value.worktrees, patterns, ['--ignore-case'], signal,
    )
    if (!listing.ok) return listing
    return { ok: true, branches: this.orderBranches(listing.branches), truncated: listing.truncated }
  }

  /**
   * Update remote-tracking refs and drop the ones whose remote branch is gone.
   * @param request - the workspace directory whose repository to fetch.
   * @param signal - cancellation for the fetch.
   * @returns git's summary, or a classified failure.
   */
  async fetch(request: RepoRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const outcome = await this.git.run(
      prepared.value.requested.processPath,
      ['fetch', '--all', '--prune', '--quiet'],
      { network: true },
      signal,
    )
    return settle(outcome)
  }

  /**
   * Move the requested worktree's HEAD onto a branch.
   *
   * A remote-tracking name creates the matching local branch and starts it tracking, which is what
   * makes a row from the remote section of the switcher act the way a person expects it to.
   * @param request - the branch to switch to, and whether to carry uncommitted changes.
   * @param signal - cancellation for the switch.
   * @returns git's summary, or a classified failure.
   */
  async checkout(request: CheckoutRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const cwd = prepared.value.requested.processPath
    const rejected = rejectBranchName(request.branch)
    if (rejected !== undefined) return rejected

    // What the request names is decided by which ref actually resolves, never by the string's shape:
    // a local branch called `origin/x` is a legal (if unwise) name, and it must win over the remote
    // of the same spelling exactly as it does everywhere else in git.
    const local = await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)
    const remote = local ? false : await this.hasRef(cwd, `refs/remotes/${request.branch}`, signal)
    if (!local && !remote) {
      return fail('not-found', `no branch named "${request.branch}" in this repository`)
    }
    // A remote row whose local branch already exists switches to that branch rather than asking git
    // to create it a second time — which is what someone clicking `origin/x` means when `x` is
    // already here, and avoids git's "a branch named 'x' already exists" for an ordinary action.
    const target = remote && await this.hasRef(cwd, `refs/heads/${localBranchOf(request.branch)}`, signal)
      ? localBranchOf(request.branch)
      : request.branch
    const track = remote && target === request.branch

    // A branch already checked out elsewhere is refused HERE rather than by git, because git's own
    // message names the worktree by path while this one can say which branch it was about.
    const holder = branchWorktreeIndex(prepared.value.worktrees).get(target)
    if (!track && holder !== undefined && holder !== prepared.value.worktreeRoot) {
      return fail('refused', `"${target}" is already checked out at ${holder}`)
    }

    const argv = ['switch', ...request.carryChanges ? ['--merge'] : []]
    // `--track` names a remote-tracking ref and creates the local branch after it; without it git
    // refuses a remote branch outright rather than guessing.
    if (track) argv.push('--track', target)
    else argv.push(target)
    return settle(await this.git.run(cwd, argv, {}, signal))
  }

  /**
   * Create a branch, optionally moving HEAD onto it.
   * @param request - the name, its start point, and whether to switch.
   * @param signal - cancellation for the command.
   * @returns git's summary, or a classified failure.
   */
  async createBranch(request: CreateBranchRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const cwd = prepared.value.requested.processPath
    const rejected = rejectBranchName(request.branch)
    if (rejected !== undefined) return rejected
    if (await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)) {
      return fail('refused', `a branch named "${request.branch}" already exists`)
    }
    const start = await this.resolveStartPoint(cwd, request.startPoint, signal)
    if (start !== undefined && 'ok' in start) return start

    // `--` for `git branch`, whose parser ends its options there on every release; not for `switch`,
    // whose handling of `--` has varied, so its values rest on the proofs above alone.
    const argv = request.checkout
      ? ['switch', '--create', request.branch, ...start === undefined ? [] : [start.value]]
      : ['branch', '--', request.branch, ...start === undefined ? [] : [start.value]]
    return settle(await this.git.run(cwd, argv, {}, signal))
  }

  /**
   * Delete a local branch.
   *
   * Only local: a remote branch is deleted by pushing a deletion, which is an irreversible change to
   * somebody else's repository and not something a switcher popover should be able to do by accident.
   * @param request - the branch, and whether to delete an unmerged one.
   * @param signal - cancellation for the command.
   * @returns git's summary, or a classified failure.
   */
  async deleteBranch(request: DeleteBranchRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const cwd = prepared.value.requested.processPath
    const rejected = rejectBranchName(request.branch)
    if (rejected !== undefined) return rejected
    if (!await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)) {
      return fail('not-found', `no local branch named "${request.branch}"`)
    }
    const holder = branchWorktreeIndex(prepared.value.worktrees).get(request.branch)
    if (holder !== undefined) {
      return fail('refused', `"${request.branch}" is checked out at ${holder}; switch or remove that worktree first`)
    }
    if (request.expectedTip === undefined) {
      const argv = ['branch', request.force ? '-D' : '-d', '--', request.branch]
      return settle(await this.git.run(cwd, argv, {}, signal))
    }
    if (!OBJECT_NAME.test(request.expectedTip)) {
      return fail('invalid-request', `"${request.expectedTip}" is not a full commit object name`)
    }
    const tip = await this.commitOf(cwd, `refs/heads/${request.branch}`, signal)
    if (tip !== request.expectedTip) {
      return fail('refused', `"${request.branch}" no longer points at ${request.expectedTip.slice(0, 7)}, so it may hold work; it was not deleted`)
    }
    // Forced, because the tip being the commit the branch was created at is the proof `-d` looks for
    // in a merge: no commit is reachable only from this branch. The check and the delete are two
    // commands, and the window between them is accepted: the branch is checked out nowhere (refused
    // above), so nothing is in a position to commit to it in between.
    return settle(await this.git.run(cwd, ['branch', '-D', '--', request.branch], {}, signal))
  }

  /**
   * Rename a local branch.
   * @param request - the branch and its new name.
   * @param signal - cancellation for the command.
   * @returns git's summary, or a classified failure.
   */
  async renameBranch(request: RenameBranchRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const cwd = prepared.value.requested.processPath
    const rejectedSource = rejectBranchName(request.branch)
    if (rejectedSource !== undefined) return rejectedSource
    const rejectedTarget = rejectBranchName(request.name)
    if (rejectedTarget !== undefined) return rejectedTarget
    if (!await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)) {
      return fail('not-found', `no local branch named "${request.branch}"`)
    }
    if (request.name !== request.branch && await this.hasRef(cwd, `refs/heads/${request.name}`, signal)) {
      return fail('refused', `a branch named "${request.name}" already exists`)
    }
    // `-m`, never `-M`: a rename onto an existing name is refused above, and forcing here would let
    // a race between the check and the command discard the other branch.
    const argv = ['branch', '-m', '--', request.branch, request.name]
    return settle(await this.git.run(cwd, argv, {}, signal))
  }

  /**
   * Expand the configured template for one branch and report what is already at the result.
   * @param request - the repository and the branch the worktree would hold.
   * @param signal - cancellation for the resolutions.
   * @returns the suggestion, or a classified failure.
   */
  async suggestPath(request: SuggestPathRequest, signal?: AbortSignal): Promise<SuggestPathResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const path = this.expandPath(prepared.value, request.branch)
    const resolved = await resolvePath(this.ctx, path, signal)
    if (!resolved.ok) return resolved.failure
    return {
      ok: true,
      path: resolved.value.processPath,
      exists: resolved.value.exists,
      emptyDirectory: resolved.value.directory
        && await isEmptyDirectory(this.ctx, resolved.value, signal),
    }
  }

  /**
   * Add a worktree for a new or existing branch.
   * @param request - the destination, the branch, and how to check it out.
   * @param signal - cancellation for the command.
   * @returns the created worktree, or a classified failure.
   */
  async addWorktree(request: AddWorktreeRequest, signal?: AbortSignal): Promise<AddWorktreeResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const cwd = prepared.value.requested.processPath

    if (!request.detach) {
      const rejected = rejectBranchName(request.branch)
      if (rejected !== undefined) return rejected
    }
    if (request.path !== undefined && !isAbsolutePath(request.path)) {
      return fail('invalid-request', `worktree path "${request.path}" must be absolute`)
    }
    const target = await resolvePath(
      this.ctx,
      request.path ?? this.expandPath(prepared.value, request.branch),
      signal,
    )
    if (!target.ok) return target.failure
    // git creates the directory itself and refuses a non-empty one; refusing here first is what
    // turns "fatal: … is not an empty directory" into a sentence naming the path the browser sent.
    if (target.value.exists && !await isEmptyDirectory(this.ctx, target.value, signal)) {
      return fail('refused', `${target.value.processPath} already exists and is not empty`)
    }

    // Three mutually exclusive forms, each with its own precondition and its own argument order:
    //   detach          `worktree add --detach -- <path> <commit-ish>`
    //   create branch   `worktree add -b <new> -- <path> [<start-point>]`
    //   existing branch `worktree add -- <path> <branch>`
    const argv = ['worktree', 'add']
    if (request.detach) {
      // The commit-ish is proved rather than name-checked: a detached worktree may sit on a tag, a
      // sha, or `HEAD~3`, none of which is a branch name.
      const start = await this.resolveStartPoint(cwd, request.startPoint ?? request.branch, signal)
      if (start === undefined) return fail('invalid-request', 'a detached worktree needs a commit to check out')
      if ('ok' in start) return start
      argv.push('--detach', '--', target.value.processPath, start.value)
    } else if (request.createBranch) {
      if (await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)) {
        return fail('refused', `a branch named "${request.branch}" already exists`)
      }
      const start = await this.resolveStartPoint(cwd, request.startPoint, signal)
      if (start !== undefined && 'ok' in start) return start
      argv.push('-b', request.branch, '--', target.value.processPath)
      if (start !== undefined) argv.push(start.value)
    } else {
      if (!await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)) {
        return fail('not-found', `no local branch named "${request.branch}"`)
      }
      const holder = branchWorktreeIndex(prepared.value.worktrees).get(request.branch)
      if (holder !== undefined) {
        return fail('refused', `"${request.branch}" is already checked out at ${holder}`)
      }
      argv.push('--', target.value.processPath, request.branch)
    }

    const outcome = await this.git.run(cwd, argv, {}, signal)
    if (outcome.exitCode !== 0) return classify(outcome)
    // Re-resolved after the fact: git canonicalizes the destination itself, and the path it settled
    // on is what a workspace must be registered under for the two to refer to one directory.
    const created = await resolvePath(this.ctx, target.value.processPath, signal)
    const path = created.ok ? created.value.processPath : target.value.processPath
    // Read back rather than taken from the start point: a start point is whatever the request named,
    // and the commit git actually checked out is what a caller undoing this creation must compare with.
    const sha = await this.commitOf(path, 'HEAD', signal)
    return {
      ok: true,
      path,
      ...request.detach ? {} : { branch: request.branch },
      ...sha === undefined ? {} : { sha },
      detail: summarize(outcome),
    }
  }

  /**
   * Report what removing a worktree would delete that no commit keeps.
   * @param request - the repository and the worktree path.
   * @param signal - cancellation for the reading.
   * @returns the counts and the first ignored entries, or a classified failure.
   */
  async inspectWorktree(request: InspectWorktreeRequest, signal?: AbortSignal): Promise<InspectWorktreeResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const entry = this.findWorktree(prepared.value, request.path)
    if (entry === undefined) {
      return fail('not-found', `${request.path} is not a worktree of this repository`)
    }
    const directory = await resolveDirectory(this.ctx, entry.path, signal)
    if (!directory.ok) return directory.failure
    return this.readContents(directory.value.processPath, signal)
  }

  /**
   * Remove a worktree.
   * @param request - the worktree path, whether to remove one with uncommitted work, and whether its
   * ignored files may go with it.
   * @param signal - cancellation for the command.
   * @returns git's summary, or a classified failure.
   */
  async removeWorktree(request: RemoveWorktreeRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const entry = this.findWorktree(prepared.value, request.path)
    if (entry === undefined) {
      return fail('not-found', `${request.path} is not a worktree of this repository`)
    }
    if (entry.main) {
      return fail('refused', 'the main worktree holds the repository and cannot be removed')
    }
    // Removing the worktree a request is working in deletes the directory the session itself runs
    // in, out from under it; that is done from another workspace or not at all.
    if (entry.path === prepared.value.worktreeRoot) {
      return fail('refused', `${entry.path} is the worktree this workspace is in; remove it from another workspace`)
    }
    if (request.discardIgnored !== true) {
      const ignored = await this.refuseIgnoredLoss(entry.path, request.force, signal)
      if (ignored !== undefined) return ignored
    }
    const argv = ['worktree', 'remove', ...request.force ? ['--force'] : [], '--', entry.path]
    return settle(await this.git.run(prepared.value.requested.processPath, argv, {}, signal))
  }

  /**
   * Lock or unlock a worktree against pruning and removal.
   * @param request - the worktree path, the target state, and an optional lock reason.
   * @param signal - cancellation for the command.
   * @returns git's summary, or a classified failure.
   */
  async lockWorktree(request: LockWorktreeRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const entry = this.findWorktree(prepared.value, request.path)
    if (entry === undefined) {
      return fail('not-found', `${request.path} is not a worktree of this repository`)
    }
    if (entry.main) {
      return fail('refused', 'the main worktree is never pruned, so it cannot be locked')
    }
    const reason = request.reason?.trim() ?? ''
    const argv = request.locked
      ? ['worktree', 'lock', ...reason === '' ? [] : ['--reason', reason], '--', entry.path]
      : ['worktree', 'unlock', '--', entry.path]
    return settle(await this.git.run(prepared.value.requested.processPath, argv, {}, signal))
  }

  /**
   * Drop the administrative records of worktrees whose directories are gone.
   * @param request - the workspace directory whose repository to prune.
   * @param signal - cancellation for the command.
   * @returns git's summary, or a classified failure.
   */
  async pruneWorktrees(request: RepoRequest, signal?: AbortSignal): Promise<MutationResult> {
    const prepared = await this.prepare(request, signal)
    if (!prepared.ok) return prepared.failure
    const argv = ['worktree', 'prune', '--verbose']
    const outcome = await this.git.run(prepared.value.requested.processPath, argv, {}, signal)
    if (outcome.exitCode !== 0) return classify(outcome)
    // `prune` reports on stdout and says nothing when it removed nothing, so the empty case is
    // spelled out rather than surfacing as a blank success line.
    const detail = outcome.stdout.trim()
    return { ok: true, detail: detail === '' ? 'no worktree records were stale' : detail }
  }

  /**
   * Resolve the requested directory and take the worktree listing every endpoint needs.
   * @param request - the workspace directory.
   * @param signal - cancellation for the resolutions and the listing.
   * @returns the repository, or the failure to return.
   */
  private async prepare(request: RepoRequest, signal?: AbortSignal): Promise<RepositoryOutcome> {
    if (!isAbsolutePath(request.workspacePath)) {
      return {
        ok: false,
        failure: fail('invalid-request', `workspace path "${request.workspacePath}" must be absolute`),
      }
    }
    const requested = await resolveDirectory(this.ctx, request.workspacePath, signal)
    if (!requested.ok) return { ok: false, failure: requested.failure }

    const top = await this.git.run(
      requested.value.processPath, ['rev-parse', '--show-toplevel'], {}, signal,
    )
    if (top.exitCode !== 0) return { ok: false, failure: classify(top) }
    const worktreeRoot = top.stdout.trim()

    const nul = this.git.supportsNulListing()
    const listing = await this.git.run(
      requested.value.processPath,
      ['worktree', 'list', '--porcelain', ...nul ? ['-z'] : []],
      {},
      signal,
    )
    if (listing.exitCode !== 0) return { ok: false, failure: classify(listing) }
    return {
      ok: true,
      value: {
        requested: requested.value,
        worktreeRoot,
        worktrees: parseWorktrees(listing.stdout, nul ? '\0' : '\n', worktreeRoot),
      },
    }
  }

  /**
   * The options that keep a reading from running a program the repository's config names.
   *
   * Three things, each because the chip reads a folder as soon as it is selected and on every poll,
   * so a folder someone merely opened must not be able to execute anything:
   *
   * - `core.fsmonitor=false` — carried by every invocation; see `INVOCATION_CONFIG` in `./git.ts`.
   * - Every filter driver the repository's own config defines gets an empty `clean` and `process`.
   *   git re-reads a file whose stat information changed but whose size did not, and runs it through
   *   its clean filter to compare — so a `.gitattributes` line plus `filter.x.clean` in `.git/config`
   *   is a program a plain `git status` executes. Only the local and worktree scopes are neutralised:
   *   those are the files a folder brings with it, while a filter configured globally (git-lfs, say)
   *   is the operator's own and keeps working. An empty command is git's own "no filter".
   * - `--no-optional-locks`, so a background reading never takes `index.lock` or rewrites the index
   *   while the agent is running git in the same worktree. `core.untrackedCache` is still honoured —
   *   it is a cache, not a program — but a reading never persists an update to it.
   *
   * Hooks need nothing: no reading here runs one.
   * @param cwd - the directory the reading will run in.
   * @param signal - cancellation for the config queries.
   * @returns the arguments to place before the subcommand, or the failure to answer with.
   */
  private async readingOptions(cwd: string, signal?: AbortSignal): Promise<ReadingOptions> {
    const local = await this.filterDrivers(cwd, '--local', signal)
    if (!local.ok) return local
    // Per-worktree config is a second file the folder brings with it, but `--worktree` is an error in
    // a repository with linked worktrees unless the extension is on — so it is asked for only then.
    // Without the extension git reads no such file, and `--local` has already covered everything.
    const worktree = local.worktreeConfig ? await this.filterDrivers(cwd, '--worktree', signal) : undefined
    if (worktree !== undefined && !worktree.ok) return worktree
    const names = new Set([...local.names, ...worktree?.names ?? []])
    const argv = ['--no-optional-locks']
    for (const name of names) {
      // `-c` splits its argument at the first `=`, so a driver name holding one cannot be addressed
      // and its filter could not be switched off. Refusing the reading is the only safe answer.
      if (name.includes('=')) {
        return fail('refused', `the repository configures a filter driver named "${name}" that cannot be disabled for a background reading, so it is not read automatically`)
      }
      argv.push('-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`)
    }
    return { ok: true, argv }
  }

  /**
   * Read the filter drivers one config scope defines, and whether per-worktree config is enabled.
   * @param cwd - the directory the reading will run in.
   * @param scope - `--local` or `--worktree`.
   * @param signal - cancellation for the query.
   * @returns the driver names and the extension flag, or a classified failure.
   */
  private async filterDrivers(
    cwd: string, scope: '--local' | '--worktree', signal?: AbortSignal,
  ): Promise<{ readonly ok: true; readonly names: readonly string[]; readonly worktreeConfig: boolean } | GitFailure> {
    // `--includes` because a file-scoped query does not follow `include.path` by default, and an
    // included file is as much the folder's as `.git/config` itself.
    const outcome = await this.git.run(
      cwd, ['config', '--null', scope, '--includes', '--get-regexp', READING_CONFIG_KEYS], {}, signal,
    )
    const empty = outcome.exitCode === CONFIG_NO_MATCH && !outcome.timedOut && !outcome.aborted
    if (!empty && outcome.exitCode !== 0) return classify(outcome)
    const names = empty ? [] : parseFilterDrivers(outcome.stdout)
    const worktreeConfig = empty ? false : worktreeConfigEnabled(outcome.stdout)
    return { ok: true, names, worktreeConfig }
  }

  /**
   * Read a bounded, ordered branch listing, and whether the ceiling cut it.
   *
   * `--count` bounds what git prints, symbolic refs included, and those are dropped afterwards — so
   * a listing asked for one more than the ceiling can come back with exactly the ceiling after
   * `origin/HEAD` is dropped, and read as complete when it is not. The count is therefore widened by
   * however many records were dropped until either the ceiling is exceeded or git printed fewer
   * records than asked for, which is the only proof the listing is complete. Each round adds at least
   * one record and a repository holds few symbolic refs, so this is one query in practice.
   * @param cwd - directory to run in.
   * @param worktrees - the repository's worktrees, for each branch's `checkedOutAt`.
   * @param patterns - `for-each-ref` patterns.
   * @param flags - extra `for-each-ref` options.
   * @param signal - cancellation for the listing.
   * @returns at most {@link WorktreeSettings.maxBranches} branches, or a classified failure.
   */
  private async listBranches(
    cwd: string,
    worktrees: readonly WorktreeEntry[],
    patterns: readonly string[],
    flags: readonly string[],
    signal?: AbortSignal,
  ): Promise<BranchListing> {
    const ceiling = this.source().maxBranches
    const index = branchWorktreeIndex(worktrees)
    let count = ceiling + 1
    for (;;) {
      const outcome = await this.git.run(
        cwd,
        ['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', `--count=${String(count)}`, ...flags, ...patterns],
        {},
        signal,
      )
      if (outcome.exitCode !== 0) return classify(outcome)
      const parsed = parseBranches(outcome.stdout, index)
      const records = countBranchRecords(outcome.stdout)
      if (parsed.length > ceiling || records < count) {
        return { ok: true, branches: parsed.slice(0, ceiling), truncated: parsed.length > ceiling }
      }
      count += records - parsed.length
    }
  }

  /**
   * Read what a worktree holds beyond its commits, under the same guards as the chip's reading.
   * @param cwd - the worktree directory.
   * @param signal - cancellation for the reading.
   * @returns the contents, or a classified failure.
   */
  private async readContents(cwd: string, signal?: AbortSignal): Promise<WorktreeContents | GitFailure> {
    const options = await this.readingOptions(cwd, signal)
    if (!options.ok) return options
    const outcome = await this.git.run(
      cwd,
      [
        ...options.argv,
        // `--ignored` in its traditional form reports a wholly ignored directory once, as `build/`,
        // which is what a confirmation can name without listing a dependency tree file by file.
        'status', '--porcelain=v2', '--untracked-files=normal', '--ignored', '--ignore-submodules=dirty', '-z',
      ],
      {},
      signal,
    )
    if (outcome.exitCode !== 0) return classify(outcome)
    return { ok: true, ...parseContents(outcome.stdout) }
  }

  /**
   * Refuse a removal that would delete ignored files nobody was shown.
   * @param path - the worktree directory as git lists it.
   * @param force - whether the removal is forced; a forced removal of an unreadable worktree proceeds.
   * @param signal - cancellation for the reading.
   * @returns the failure to answer with, or undefined when the removal may go ahead.
   */
  private async refuseIgnoredLoss(path: string, force: boolean, signal?: AbortSignal): Promise<GitFailure | undefined> {
    const directory = await resolvePath(this.ctx, path, signal)
    // A worktree whose directory is already gone has nothing left to lose; git drops its record.
    if (!directory.ok || !directory.value.directory) return undefined
    const contents = await this.readContents(directory.value.processPath, signal)
    if (!contents.ok) return force ? undefined : contents
    if (contents.ignored === 0) return undefined
    const sample = contents.ignoredPaths.slice(0, 3).join(', ')
    const more = contents.ignored > 3 ? ', …' : ''
    return fail('refused', `removing ${path} would delete ${String(contents.ignored)} ignored ${contents.ignored === 1 ? 'entry' : 'entries'} (${sample}${more}); confirm deleting them to remove it`)
  }

  /**
   * Read the commit a revision points at.
   * @param cwd - directory to run in.
   * @param revision - a full ref (`refs/heads/x`) or `HEAD`; never browser text.
   * @param signal - cancellation for the invocation.
   * @returns the full object name, or undefined when it does not resolve.
   */
  private async commitOf(cwd: string, revision: string, signal?: AbortSignal): Promise<string | undefined> {
    const outcome = await this.git.run(cwd, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {}, signal)
    if (outcome.exitCode !== 0) return undefined
    return outcome.stdout.trim()
  }

  /**
   * Ask git whether a ref exists, without letting the name reach any other command first.
   * @param cwd - directory to run in.
   * @param ref - the FULL ref (`refs/heads/x`), so a local and a remote of one name stay distinct.
   * @param signal - cancellation for the invocation.
   * @returns true when the ref resolves.
   */
  private async hasRef(cwd: string, ref: string, signal?: AbortSignal): Promise<boolean> {
    const outcome = await this.git.run(
      cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {}, signal,
    )
    return outcome.exitCode === 0
  }

  /**
   * Prove a browser-supplied commit-ish before it becomes a git argument.
   * @param cwd - directory to run in.
   * @param startPoint - the commit-ish as sent; absent means HEAD, which needs no proving.
   * @param signal - cancellation for the invocation.
   * @returns the accepted value, the failure to return, or undefined when none was requested.
   */
  private async resolveStartPoint(
    cwd: string, startPoint: string | undefined, signal?: AbortSignal,
  ): Promise<{ value: string } | GitFailure | undefined> {
    if (startPoint === undefined || startPoint === '') return undefined
    if (startPoint.startsWith('-')) {
      return fail('invalid-request', `"${startPoint}" is not a usable start point`)
    }
    const outcome = await this.git.run(
      cwd, ['rev-parse', '--verify', '--quiet', `${startPoint}^{commit}`], {}, signal,
    )
    if (outcome.exitCode !== 0) {
      return fail('not-found', `"${startPoint}" does not name a commit in this repository`)
    }
    return { value: startPoint }
  }

  /**
   * Expand the configured worktree path template for one branch.
   * @param repository - the resolved repository.
   * @param branch - the branch the worktree would hold.
   * @returns the expanded path, before canonicalization.
   */
  private expandPath(repository: Repository, branch: string): string {
    const repoRoot = repository.worktrees[0]?.path ?? repository.worktreeRoot
    return expandPathTemplate(this.source().worktreePathTemplate, {
      repoRoot,
      repoParent: parentOf(repoRoot),
      repo: basenameOf(repoRoot),
      branch: flattenBranch(branch),
      branchPath: branch,
    })
  }

  /**
   * Find a worktree by the path the browser sent.
   *
   * git's own listing is the authority: matching against it is what proves the path names a worktree
   * of THIS repository rather than an arbitrary directory a request happened to name.
   * @param repository - the resolved repository.
   * @param path - the path as sent.
   * @returns the entry, or undefined when the listing has no such worktree.
   */
  private findWorktree(repository: Repository, path: string): WorktreeEntry | undefined {
    const trimmed = path.replace(/[\\/]+$/u, '')
    return repository.worktrees.find(entry => entry.path.replace(/[\\/]+$/u, '') === trimmed)
  }

  /**
   * Order the branch list the way the switcher reads it: current first, then local by recency, then
   * remote-tracking by recency.
   * @param branches - the parsed list, already sorted by committer date.
   * @returns the ordered list.
   */
  private orderBranches(branches: readonly BranchEntry[]): BranchEntry[] {
    const rank = (entry: BranchEntry): number => {
      if (entry.current) return 0
      return entry.kind === 'local' ? 1 : 2
    }
    // A stable sort by rank alone: git already ordered within each rank by committer date, and
    // Array#sort has been required to be stable since ES2019.
    return [...branches].sort((left, right) => rank(left) - rank(right))
  }
}
