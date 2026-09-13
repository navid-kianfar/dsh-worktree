/**
 * The worktree surface's Consumer half on the Host: one Remote namespace the browser drives git
 * through, and the settings section that owns the deployment's preferences.
 *
 * This half exists because the browser structurally cannot do the work. Reading a repository means
 * running `git` and parsing its machine formats, and creating a worktree means writing a directory
 * on the Host — neither is reachable from a page. What crosses the wire is therefore already
 * classified: parsed readings, and mutation outcomes carrying git's own summary line.
 *
 * Nothing here is model-facing. Which branch a person is on is operator context that never enters a
 * prompt, so the capability adds no tool, no prompt contribution, and no session event.
 * @module @achasoft/dsh-worktree/host
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { GitClient, fail } from './git.ts'
import { suggestBranchName } from './naming.ts'
import { WorktreeOperations } from './operations.ts'
import { CommandUnavailableError } from './run.ts'
import type {
  AddWorktreeRequest, AddWorktreeResult, CheckoutRequest, CreateBranchRequest, DeleteBranchRequest,
  GitFailure, LockWorktreeRequest, MutationResult, OverviewResult, RemoveWorktreeRequest,
  RenameBranchRequest, RepoRequest, SuggestBranchNameRequest, SuggestBranchNameResult,
  SuggestPathRequest, SuggestPathResult, WorktreeSettings, WorktreeView,
} from './types.ts'

export type * from './types.ts'

/**
 * The settings namespace both halves of this plugin address; the browser card joins on it.
 *
 * Hyphen-free here only because the plugin's name is one word: settings namespaces are a kebab-case
 * grammar, while the Remote namespace below is read as `ctx.remote.worktree.…` and so must be an
 * identifier. The two spellings coincide for this plugin and are still declared separately, because
 * they are fixed by different grammars.
 */
export const WORKTREE_SETTINGS_NAMESPACE = settingsNamespace('worktree')

/** Deployment configuration for the worktree surface; the `worktree` settings section's own shape. */
export type Config = WorktreeSettings

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktree: WorktreeService
  }
}

/**
 * Reject a section this service could not act on, for the constraints its schema cannot express.
 *
 * Called from the constructor as well as from the settings hook, and that is the point: the settings
 * seam is optional, so a composition without it would never run the hook — and these constraints
 * come straight off the composition file, where being wrong is a load-time mistake that must fail
 * loudly rather than a running deployment that quietly puts worktrees somewhere surprising.
 * @param value - the resolved section, schema-valid by construction.
 */
function validateConfig(value: Config): void {
  if (value.worktreePathTemplate.trim() === '') {
    throw new Error('worktree: worktreePathTemplate must not be empty; it is what names a new worktree\'s directory')
  }
  if (!value.worktreePathTemplate.includes('{branch}')
    && !value.worktreePathTemplate.includes('{branchPath}')) {
    throw new Error(
      `worktree: worktreePathTemplate "${value.worktreePathTemplate}" contains neither {branch} nor`
      + ' {branchPath}, so every worktree would expand to the same directory and only the first could be created',
    )
  }
  if (value.networkTimeoutMs < value.gitTimeoutMs) {
    throw new Error(
      `worktree: networkTimeoutMs (${value.networkTimeoutMs}) below gitTimeoutMs (${value.gitTimeoutMs})`
      + ' would give a fetch that contacts a remote less time than a local reading',
    )
  }
  if (value.openSession && !value.registerWorkspace) {
    throw new Error(
      'worktree: openSession requires registerWorkspace; a session is opened in a Workspace, so there'
      + ' is nowhere to open one when the worktree is never adopted',
    )
  }
}

/** Host-side git endpoint and worktree-surface settings owner. */
export class WorktreeService extends TypertRemoteService {
  /** Loader validation for the surface's flags, the path template, and the four bounds. */
  static Config: z<Config> = z.object({
    showChip: z.boolean().required(),
    worktreePathTemplate: z.string().required(),
    branchPrefix: z.string(),
    registerWorkspace: z.boolean().required(),
    openSession: z.boolean().required(),
    includeRemoteBranches: z.boolean().required(),
    maxBranches: z.number().step(1).min(1).required(),
    refreshIntervalMs: z.number().step(1).min(0).required(),
    gitTimeoutMs: z.number().step(1).min(1_000).required(),
    networkTimeoutMs: z.number().step(1).min(1_000).required(),
    maxOutputBytes: z.number().step(1).min(4_096).required(),
    graceMs: z.number().step(1).min(1).required(),
    confirmDestructive: z.boolean().required(),
  })

  private source: () => Config
  private readonly git: GitClient
  private readonly operations: WorktreeOperations

  /**
   * @param ctx - Host context; the filesystem and subprocess capabilities are read optionally per
   * request, so a deployment missing either still serves a view that says which one.
   * @param config - the composition-layer preferences.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktree')
    validateConfig(config)
    this.source = () => config
    this.git = new GitClient(ctx, () => this.source())
    this.operations = new WorktreeOperations(ctx, this.git, () => this.source())
    installSettingsSection(ctx, WORKTREE_SETTINGS_NAMESPACE, WorktreeService.Config, config, {
      setSource: (current) => { this.source = current },
      // Nothing is derived from the section: every field is read inside a call, so a committed
      // change reaches the next request with no registration to rebuild.
      onChange: () => {},
      validate: validateConfig,
    })
  }

  /**
   * Report whether git can answer here, and echo the preferences the browser draws itself from.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the capability view; `gitAvailable: false` carries the reason.
   */
  @Remote('describe')
  async describe(signal: AbortSignal): Promise<WorktreeView> {
    const config = this.source()
    const preferences = {
      showChip: config.showChip,
      registerWorkspace: config.registerWorkspace,
      openSession: config.openSession,
      branchPrefix: config.branchPrefix,
      refreshIntervalMs: config.refreshIntervalMs,
      confirmDestructive: config.confirmDestructive,
    }
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      return {
        gitAvailable: false,
        reason: 'no filesystem capability is mounted: this deployment composes no @deepseek-ai/dsh-fs provider',
        ...preferences,
      }
    }
    // The version probe needs a directory that exists in the backend's execution world, and the
    // backend's own base is the one directory guaranteed to.
    const base = fs.processPath(await fs.resolve('.', { signal }))
    const state = await this.git.describe(base, signal)
    return {
      gitAvailable: state.available,
      ...state.version === undefined ? {} : { gitVersion: state.version },
      ...state.reason === undefined ? {} : { reason: state.reason },
      ...preferences,
    }
  }

  /**
   * Read one workspace's repository: where HEAD is, what is uncommitted, every branch, every worktree.
   * @param request - the workspace directory to read.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the reading, or a classified failure.
   */
  @Remote('overview')
  async overview(request: RepoRequest, signal: AbortSignal): Promise<OverviewResult> {
    return guard(() => this.operations.overview(request, signal))
  }

  /**
   * Update remote-tracking refs and drop the ones whose remote branch is gone.
   * @param request - the workspace directory whose repository to fetch.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('fetch')
  async fetch(request: RepoRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.fetch(request, signal))
  }

  /**
   * Move the workspace's worktree onto a branch, creating the local branch for a remote one.
   * @param request - the branch to switch to, and whether to carry uncommitted changes.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('checkout')
  async checkout(request: CheckoutRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.checkout(request, signal))
  }

  /**
   * Create a branch, optionally moving the workspace's worktree onto it.
   * @param request - the name, its start point, and whether to switch.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('createBranch')
  async createBranch(request: CreateBranchRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.createBranch(request, signal))
  }

  /**
   * Delete a local branch.
   * @param request - the branch, and whether to delete an unmerged one.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('deleteBranch')
  async deleteBranch(request: DeleteBranchRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.deleteBranch(request, signal))
  }

  /**
   * Rename a local branch.
   * @param request - the branch and its new name.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('renameBranch')
  async renameBranch(request: RenameBranchRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.renameBranch(request, signal))
  }

  /**
   * Suggest a branch name for the task one prompt describes.
   *
   * The only endpoint here that is not about a repository: the new-session surface creates a worktree
   * before the prompt exists, so the name arrives after the fact from this call. A deployment with no
   * model mounted answers with the deterministic slug rather than failing.
   * @param request - the prompt to name from.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the suggested name, or a classified failure for an unusable prompt.
   */
  @Remote('suggestBranchName')
  async suggestBranchName(
    request: SuggestBranchNameRequest, signal: AbortSignal,
  ): Promise<SuggestBranchNameResult> {
    return suggestBranchName(this.ctx, request.prompt, signal)
  }

  /**
   * Expand the configured path template for one branch and report what is already there.
   * @param request - the repository and the branch the worktree would hold.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the suggestion, or a classified failure.
   */
  @Remote('suggestPath')
  async suggestPath(request: SuggestPathRequest, signal: AbortSignal): Promise<SuggestPathResult> {
    return guard(() => this.operations.suggestPath(request, signal))
  }

  /**
   * Add a worktree for a new or existing branch, or for a bare commit.
   * @param request - the destination, the branch, and how to check it out.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the created worktree, or a classified failure.
   */
  @Remote('addWorktree')
  async addWorktree(request: AddWorktreeRequest, signal: AbortSignal): Promise<AddWorktreeResult> {
    return guard(() => this.operations.addWorktree(request, signal))
  }

  /**
   * Remove a worktree.
   * @param request - the worktree path, and whether to remove one holding uncommitted work.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('removeWorktree')
  async removeWorktree(request: RemoveWorktreeRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.removeWorktree(request, signal))
  }

  /**
   * Lock or unlock a worktree against pruning and removal.
   * @param request - the worktree path, the target state, and an optional lock reason.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('lockWorktree')
  async lockWorktree(request: LockWorktreeRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.lockWorktree(request, signal))
  }

  /**
   * Drop the administrative records of worktrees whose directories are gone.
   * @param request - the workspace directory whose repository to prune.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns git's summary, or a classified failure.
   */
  @Remote('pruneWorktrees')
  async pruneWorktrees(request: RepoRequest, signal: AbortSignal): Promise<MutationResult> {
    return guard(() => this.operations.pruneWorktrees(request, signal))
  }
}

/**
 * Run one operation, turning the two capability absences into the failures the browser draws.
 *
 * These are thrown rather than returned inside the operations layer because they are not outcomes of
 * a git command — they are the discovery, part way through, that nothing on this Host can run one.
 * Folding them in here keeps every endpoint answering with the same union.
 * @param operation - the operations-layer call.
 * @returns the operation's own result, or the classified capability failure.
 */
async function guard<T>(operation: () => Promise<T | GitFailure>): Promise<T | GitFailure> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CommandUnavailableError) {
      return fail(error.code, error.message)
    }
    throw error
  }
}

export default WorktreeService
