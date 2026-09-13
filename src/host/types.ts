/**
 * The `worktree` Remote namespace's wire contract: every value that crosses between the Host and the
 * browser half, plus the settings section both halves read.
 *
 * Every mutating endpoint answers with a value union rather than by throwing. The gateway erases a
 * business exception's classification, and this surface's next action depends on which class it was:
 * a dirty worktree refusing a checkout is a prompt to stash, an unresolvable branch is a typo, and a
 * missing `git` is a deployment fact none of the controls can act on at all.
 * @module @achasoft/dsh-worktree/host/types
 */

/** Deployment configuration for the worktree surface; the `worktree` settings section's own shape. */
export interface WorktreeSettings {
  /** Render the session-header chip. Off leaves the endpoints callable and the settings card intact. */
  readonly showChip: boolean
  /**
   * Where {@link AddWorktreeRequest} puts a worktree when the browser sends no explicit path.
   *
   * A path template expanded against the repository being acted on. Placeholders: `{repoRoot}` the
   * repository's own directory, `{repoParent}` its parent, `{repo}` its basename, `{branch}` the
   * branch name with `/` folded to `-`, `{branchPath}` the branch name with its slashes kept.
   * A relative result resolves against `{repoRoot}`.
   */
  readonly worktreePathTemplate: string
  /** Prefix offered for a newly created branch (`feature/`); empty offers none. */
  readonly branchPrefix: string
  /** Adopt a worktree directory as a harness Workspace when one is created or opened. */
  readonly registerWorkspace: boolean
  /** Open a session in the worktree's Workspace once it is adopted. Ignored when adoption is off. */
  readonly openSession: boolean
  /** Include remote-tracking branches in the branch list. */
  readonly includeRemoteBranches: boolean
  /** Upper bound on branches returned per reading; the reading reports when it truncated. */
  readonly maxBranches: number
  /** Browser re-read cadence for the chip, in ms; 0 leaves it to explicit refreshes. */
  readonly refreshIntervalMs: number
  /** Wall-clock bound for a local git invocation, in ms. */
  readonly gitTimeoutMs: number
  /** Wall-clock bound for a git invocation that talks to a remote, in ms. */
  readonly networkTimeoutMs: number
  /** In-memory cap per captured git stream, in bytes. */
  readonly maxOutputBytes: number
  /** TERM-to-KILL grace when a git invocation is terminated, in ms. */
  readonly graceMs: number
  /** Require a typed confirmation in the browser before a force-delete or force-remove. */
  readonly confirmDestructive: boolean
}

/** Whether git can answer on this Host, and what the browser is allowed to draw. */
export interface WorktreeView {
  /** True when a `git` executable resolved on the Host process PATH. */
  readonly gitAvailable: boolean
  /** `git --version` output when one was read. */
  readonly gitVersion?: string
  /** Why git cannot answer; present exactly when {@link gitAvailable} is false. */
  readonly reason?: string
  /** Mirrors {@link WorktreeSettings.showChip}. */
  readonly showChip: boolean
  /** Mirrors {@link WorktreeSettings.registerWorkspace}. */
  readonly registerWorkspace: boolean
  /** Mirrors {@link WorktreeSettings.openSession}. */
  readonly openSession: boolean
  /** Mirrors {@link WorktreeSettings.branchPrefix}. */
  readonly branchPrefix: string
  /** Mirrors {@link WorktreeSettings.refreshIntervalMs}. */
  readonly refreshIntervalMs: number
  /** Mirrors {@link WorktreeSettings.confirmDestructive}. */
  readonly confirmDestructive: boolean
}

/** Why a git request could not be answered. */
export type GitFailureCode =
  /** This deployment composes no filesystem provider. */
  | 'no-filesystem'
  /** No subprocess provider, so nothing can run `git`. */
  | 'no-subprocess'
  /** `git` did not resolve on the Host process PATH. */
  | 'no-git'
  /** The requested directory exists but is not inside a git repository. */
  | 'not-a-repository'
  /** The path does not exist, is not a directory, or was refused by the filesystem provider. */
  | 'path-denied'
  /** The request named a branch, worktree, or path this repository does not have. */
  | 'not-found'
  /** The request is well formed but the repository's current state refuses it. */
  | 'refused'
  /** git ran and exited non-zero for a reason none of the above classifies. */
  | 'git-failed'
  /** The invocation exceeded its configured wall-clock bound. */
  | 'timeout'
  /** The caller abandoned the request before git finished. */
  | 'cancelled'
  /** The request itself is malformed — an unusable branch name or a relative path. */
  | 'invalid-request'

/** One classified failure, carried as a value by every endpoint below. */
export interface GitFailure {
  readonly ok: false
  readonly code: GitFailureCode
  readonly message: string
}

/** Which directory a reading or mutation applies to. */
export interface RepoRequest {
  /** Absolute directory anywhere inside the repository (a workspace root). */
  readonly workspacePath: string
}

/** Where a branch's tip sits relative to the branch it tracks. */
export interface TrackingState {
  /** Short upstream ref (`origin/main`). */
  readonly upstream: string
  /** Commits on this branch that the upstream does not have. */
  readonly ahead: number
  /** Commits on the upstream that this branch does not have. */
  readonly behind: number
  /** True when the upstream ref itself is gone (`[origin/x: gone]`). */
  readonly gone: boolean
}

/** One branch as the switcher lists it. */
export interface BranchEntry {
  /** Short name: `main`, `feature/x`, or `origin/main` for a remote-tracking branch. */
  readonly name: string
  /** Full ref (`refs/heads/main`), which is what disambiguates a local from a remote of one name. */
  readonly ref: string
  /** Whether this is a local branch or a remote-tracking one. */
  readonly kind: 'local' | 'remote'
  /** True for the branch HEAD currently points at in the requested worktree. */
  readonly current: boolean
  /** Upstream tracking, absent when the branch tracks nothing (always absent for a remote). */
  readonly tracking?: TrackingState
  /** Abbreviated tip commit. */
  readonly sha: string
  /** Tip commit subject. */
  readonly subject: string
  /** Tip commit author name. */
  readonly author: string
  /** Tip commit time, epoch milliseconds. */
  readonly committedAt: number
  /**
   * Absolute path of the worktree that has this branch checked out, when one does.
   *
   * The single most useful fact in the list: git refuses to check a branch out twice, so this is the
   * difference between a row the browser offers to switch to and a row it offers to jump to.
   */
  readonly checkedOutAt?: string
}

/** One entry of `git worktree list`. */
export interface WorktreeEntry {
  /** Absolute worktree directory. */
  readonly path: string
  /** Abbreviated commit HEAD points at; absent for a worktree with an unborn HEAD. */
  readonly sha?: string
  /** Short branch name, absent when HEAD is detached or unborn. */
  readonly branch?: string
  /** True for the repository's bare main worktree. */
  readonly bare: boolean
  /** True when HEAD points straight at a commit. */
  readonly detached: boolean
  /** True when the worktree is locked against pruning and removal. */
  readonly locked: boolean
  /** Operator-supplied lock reason, when the lock carried one. */
  readonly lockReason?: string
  /** True when git considers the worktree removable by `prune`. */
  readonly prunable: boolean
  /** git's own reason for calling it prunable. */
  readonly prunableReason?: string
  /** True for the worktree the request's `workspacePath` sits inside. */
  readonly current: boolean
  /** True for the main worktree — the one holding the repository, which cannot be removed. */
  readonly main: boolean
}

/** Uncommitted work in the requested worktree, which is what refuses a checkout. */
export interface DirtyState {
  /** Paths with staged changes. */
  readonly staged: number
  /** Tracked paths with unstaged changes. */
  readonly unstaged: number
  /** Untracked paths. */
  readonly untracked: number
  /** Paths with unresolved merge conflicts. */
  readonly conflicted: number
}

/** The repository as the requested directory sees it. */
export interface RepoState {
  /** Absolute path of the repository's main worktree (or of the `.git` directory when bare). */
  readonly root: string
  /** Absolute path of the worktree the request landed in. */
  readonly worktreeRoot: string
  /** Repository directory basename, which is what names it in the UI. */
  readonly name: string
  /** Current branch, absent when HEAD is detached or unborn. */
  readonly branch?: string
  /** Abbreviated commit HEAD points at; absent before the first commit. */
  readonly sha?: string
  /** True when HEAD points straight at a commit. */
  readonly detached: boolean
  /** True before the first commit, when HEAD names a branch that does not exist yet. */
  readonly unborn: boolean
  /** Tracking state of the current branch, absent when it tracks nothing. */
  readonly tracking?: TrackingState
  /** Uncommitted work in the requested worktree. */
  readonly dirty: DirtyState
  /** True when {@link worktreeRoot} is a linked worktree rather than the repository's own. */
  readonly linked: boolean
}

/** Everything the chip and both popovers draw, from one reading. */
export interface OverviewSuccess {
  readonly ok: true
  /** Where HEAD is, and whether anything is uncommitted. */
  readonly repo: RepoState
  /** Local branches first, then remote-tracking ones when the settings include them. */
  readonly branches: readonly BranchEntry[]
  /** True when {@link WorktreeSettings.maxBranches} cut the list. */
  readonly branchesTruncated: boolean
  /** Every worktree of the repository, main worktree first. */
  readonly worktrees: readonly WorktreeEntry[]
  /** When this reading was taken, epoch milliseconds. */
  readonly readAt: number
}

/** One repository reading, or the reason there is none. */
export type OverviewResult = OverviewSuccess | GitFailure

/** A mutation that succeeded, with whatever git said about it worth showing. */
export interface MutationSuccess {
  readonly ok: true
  /** git's own summary line, already trimmed; empty when git printed nothing. */
  readonly detail: string
}

/** One mutation's outcome. */
export type MutationResult = MutationSuccess | GitFailure

/** Move the requested worktree's HEAD to a branch. */
export interface CheckoutRequest extends RepoRequest {
  /** Branch to switch to. A remote-tracking name (`origin/x`) creates the matching local branch. */
  readonly branch: string
  /**
   * Carry uncommitted changes across instead of refusing.
   *
   * `git switch --merge`, not `--force`: it merges local modifications into the target and refuses
   * on conflict, so no uncommitted work is ever discarded by this surface.
   */
  readonly carryChanges: boolean
}

/** Create a branch, optionally moving HEAD onto it. */
export interface CreateBranchRequest extends RepoRequest {
  /** Name for the new branch. */
  readonly branch: string
  /** Commit-ish the branch starts at; absent starts it at HEAD. */
  readonly startPoint?: string
  /** Switch the requested worktree onto the new branch. */
  readonly checkout: boolean
}

/** Delete a local branch. */
export interface DeleteBranchRequest extends RepoRequest {
  /** Local branch to delete. */
  readonly branch: string
  /** Delete even when the branch is not merged into its upstream or into HEAD. */
  readonly force: boolean
}

/** Rename a local branch. */
export interface RenameBranchRequest extends RepoRequest {
  /** Branch to rename. */
  readonly branch: string
  /** New name. */
  readonly name: string
}

/** Where a new worktree would go, and whether that path is usable. */
export interface SuggestPathRequest extends RepoRequest {
  /** Branch the worktree would hold; expands `{branch}` in the configured template. */
  readonly branch: string
}

/** The expanded default path plus what is already at it. */
export interface SuggestPathSuccess {
  readonly ok: true
  /** Absolute path the template expanded to. */
  readonly path: string
  /** True when something already exists there. */
  readonly exists: boolean
  /** True when it exists, is a directory, and holds no entries. */
  readonly emptyDirectory: boolean
}

/** One path suggestion, or the reason there is none. */
export type SuggestPathResult = SuggestPathSuccess | GitFailure

/** Add a worktree for a new or existing branch. */
export interface AddWorktreeRequest extends RepoRequest {
  /** Absolute directory for the worktree; absent expands the configured template. */
  readonly path?: string
  /** Branch to check out there. */
  readonly branch: string
  /** Create {@link branch} rather than checking out an existing one. */
  readonly createBranch: boolean
  /** Commit-ish the new branch starts at; only read when {@link createBranch}. */
  readonly startPoint?: string
  /** Check the worktree out with a detached HEAD instead of on a branch. */
  readonly detach: boolean
}

/** The created worktree. */
export interface AddWorktreeSuccess {
  readonly ok: true
  /** Absolute path git created the worktree at. */
  readonly path: string
  /** Branch checked out there, absent for a detached worktree. */
  readonly branch?: string
  /** git's own summary line. */
  readonly detail: string
}

/** One worktree creation's outcome. */
export type AddWorktreeResult = AddWorktreeSuccess | GitFailure

/**
 * Ask the deployment's model for a branch name that describes one prompt.
 *
 * Deliberately not a {@link RepoRequest}: naming is pure text work, and requiring a repository would
 * make the one caller — the new-session surface, which asks before any session exists — prove a
 * repository it has already proved to draw its own control.
 */
export interface SuggestBranchNameRequest {
  /** The human's prompt (or the composer draft) to name from. */
  readonly prompt: string
}

/** A git-legal short name for one prompt. */
export interface SuggestBranchNameSuccess {
  readonly ok: true
  /** The suggested name, before any configured `branchPrefix` is applied. */
  readonly name: string
  /** Who produced it: the deployment's model, or the deterministic prompt slug. */
  readonly source: 'model' | 'fallback'
  /** `provider/model` that answered, present exactly when {@link source} is `model`. */
  readonly model?: string
}

/** One naming suggestion, or the reason there is none. */
export type SuggestBranchNameResult = SuggestBranchNameSuccess | GitFailure

/** Remove a worktree. */
export interface RemoveWorktreeRequest extends RepoRequest {
  /** Absolute path of the worktree to remove. */
  readonly path: string
  /** Remove even with uncommitted changes or submodules present. */
  readonly force: boolean
}

/** Lock or unlock a worktree against pruning and removal. */
export interface LockWorktreeRequest extends RepoRequest {
  /** Absolute path of the worktree. */
  readonly path: string
  /** Target state: true locks, false unlocks. */
  readonly locked: boolean
  /** Operator note stored with the lock; only read when locking. */
  readonly reason?: string
}
