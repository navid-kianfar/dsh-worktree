/**
 * Every reading and mutation the `worktree` namespace publishes, expressed as git invocations over
 * {@link GitClient} and the parsers in `./parse.ts`.
 *
 * Two rules hold across the file. A value from the browser becomes a git argument only after this
 * layer has proved what it names — a branch through `rev-parse --verify`, a worktree path through
 * git's own listing — so a request cannot smuggle an option or a pathspec into an argument list.
 * And nothing here throws for a business outcome: a dirty checkout, an unmerged delete, and a locked
 * worktree are returned as classified failures, because the browser's next move differs for each.
 * @module @achasoft/dsh-worktree/host/operations
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  basenameOf, expandPathTemplate, flattenBranch, isAbsolutePath, parentOf,
} from '../shared/path.ts'
import { checkBranchName, localBranchOf } from '../shared/branch-name.ts'
import { classify, fail, type GitClient } from './git.ts'
import {
  BRANCH_FORMAT, branchWorktreeIndex, parseBranches, parseStatus, parseWorktrees,
} from './parse.ts'
import { isEmptyDirectory, resolveDirectory, resolvePath, type ResolvedPath } from './paths.ts'
import type { CommandOutcome } from './run.ts'
import type {
  AddWorktreeRequest, AddWorktreeResult, BranchEntry, CheckoutRequest, CreateBranchRequest,
  DeleteBranchRequest, GitFailure, LockWorktreeRequest, MutationResult, OverviewResult,
  RemoveWorktreeRequest, RenameBranchRequest, RepoRequest, SuggestPathRequest, SuggestPathResult,
  WorktreeEntry, WorktreeSettings,
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

    const status = await this.git.run(
      requested.processPath,
      ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z'],
      {},
      signal,
    )
    if (status.exitCode !== 0) return classify(status)
    const reading = parseStatus(status.stdout)

    const refs = settings.includeRemoteBranches ? ['refs/heads', 'refs/remotes'] : ['refs/heads']
    const branchOutcome = await this.git.run(
      requested.processPath,
      [
        'for-each-ref',
        `--format=${BRANCH_FORMAT}`,
        '--sort=-committerdate',
        // One more than the ceiling, so the reading can say it truncated instead of silently
        // handing back a list that happens to stop at a round number.
        `--count=${String(settings.maxBranches + 1)}`,
        ...refs,
      ],
      {},
      signal,
    )
    if (branchOutcome.exitCode !== 0) return classify(branchOutcome)
    const parsed = parseBranches(branchOutcome.stdout, branchWorktreeIndex(worktrees))
    const branchesTruncated = parsed.length > settings.maxBranches
    const branches = branchesTruncated ? parsed.slice(0, settings.maxBranches) : parsed

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
      branches: this.orderBranches(branches),
      branchesTruncated,
      worktrees,
      readAt: Date.now(),
    }
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

    const argv = request.checkout
      ? ['switch', '--create', request.branch, ...start === undefined ? [] : [start.value]]
      : ['branch', request.branch, ...start === undefined ? [] : [start.value]]
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
    const argv = ['branch', request.force ? '-D' : '-d', request.branch]
    return settle(await this.git.run(cwd, argv, {}, signal))
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
    const argv = ['branch', '-m', request.branch, request.name]
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
    //   detach          `worktree add --detach <path> <commit-ish>`
    //   create branch   `worktree add -b <new> <path> [<start-point>]`
    //   existing branch `worktree add <path> <branch>`
    const argv = ['worktree', 'add']
    if (request.detach) {
      // The commit-ish is proved rather than name-checked: a detached worktree may sit on a tag, a
      // sha, or `HEAD~3`, none of which is a branch name.
      const start = await this.resolveStartPoint(cwd, request.startPoint ?? request.branch, signal)
      if (start === undefined) return fail('invalid-request', 'a detached worktree needs a commit to check out')
      if ('ok' in start) return start
      argv.push('--detach', target.value.processPath, start.value)
    } else if (request.createBranch) {
      if (await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)) {
        return fail('refused', `a branch named "${request.branch}" already exists`)
      }
      const start = await this.resolveStartPoint(cwd, request.startPoint, signal)
      if (start !== undefined && 'ok' in start) return start
      argv.push('-b', request.branch, target.value.processPath)
      if (start !== undefined) argv.push(start.value)
    } else {
      if (!await this.hasRef(cwd, `refs/heads/${request.branch}`, signal)) {
        return fail('not-found', `no local branch named "${request.branch}"`)
      }
      const holder = branchWorktreeIndex(prepared.value.worktrees).get(request.branch)
      if (holder !== undefined) {
        return fail('refused', `"${request.branch}" is already checked out at ${holder}`)
      }
      argv.push(target.value.processPath, request.branch)
    }

    const outcome = await this.git.run(cwd, argv, {}, signal)
    if (outcome.exitCode !== 0) return classify(outcome)
    // Re-resolved after the fact: git canonicalizes the destination itself, and the path it settled
    // on is what a workspace must be registered under for the two to refer to one directory.
    const created = await resolvePath(this.ctx, target.value.processPath, signal)
    return {
      ok: true,
      path: created.ok ? created.value.processPath : target.value.processPath,
      ...request.detach ? {} : { branch: request.branch },
      detail: summarize(outcome),
    }
  }

  /**
   * Remove a worktree.
   * @param request - the worktree path, and whether to remove one with uncommitted work.
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
    const argv = ['worktree', 'remove', ...request.force ? ['--force'] : [], entry.path]
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
      ? ['worktree', 'lock', ...reason === '' ? [] : ['--reason', reason], entry.path]
      : ['worktree', 'unlock', entry.path]
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
