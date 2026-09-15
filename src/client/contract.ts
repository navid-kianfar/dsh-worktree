/**
 * The injected business faces of this plugin's two seats.
 *
 * Both are declared here rather than beside their components, because the registrations in
 * `./index.ts` build them and every component in the surface consumes them: one home keeps the two
 * sides of each face from drifting.
 * @module @achasoft/dsh-worktree/client/contract
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AddWorktreeRequest, AddWorktreeResult, CheckoutRequest, CreateBranchRequest, DeleteBranchRequest,
  LockWorktreeRequest, MutationResult, OverviewResult, RemoveWorktreeRequest, RenameBranchRequest,
  SuggestBranchNameResult, SuggestPathResult, WorktreeSettings, WorktreeView,
} from '../host/types.ts'

/** Every git operation the surface can start, with the workspace path already bound. */
export interface WorktreeCommands {
  /**
   * Read the repository the current session's workspace sits in.
   * @param signal - abandons the reading when a newer one supersedes it.
   * @returns the reading, or a classified failure.
   */
  overview: (signal?: AbortSignal) => Promise<OverviewResult>
  /**
   * Update remote-tracking refs and drop the ones whose remote branch is gone.
   * @returns git's summary, or a classified failure.
   */
  fetch: () => Promise<MutationResult>
  /**
   * Move the workspace's worktree onto a branch.
   * @param request - the branch, and whether to carry uncommitted changes.
   * @returns git's summary, or a classified failure.
   */
  checkout: (request: Omit<CheckoutRequest, 'workspacePath'>) => Promise<MutationResult>
  /**
   * Create a branch, optionally switching onto it.
   * @param request - the name, its start point, and whether to switch.
   * @returns git's summary, or a classified failure.
   */
  createBranch: (request: Omit<CreateBranchRequest, 'workspacePath'>) => Promise<MutationResult>
  /**
   * Delete a local branch.
   * @param request - the branch, and whether to delete an unmerged one.
   * @returns git's summary, or a classified failure.
   */
  deleteBranch: (request: Omit<DeleteBranchRequest, 'workspacePath'>) => Promise<MutationResult>
  /**
   * Rename a local branch.
   * @param request - the branch and its new name.
   * @returns git's summary, or a classified failure.
   */
  renameBranch: (request: Omit<RenameBranchRequest, 'workspacePath'>) => Promise<MutationResult>
  /**
   * Expand the configured path template for a branch and report what is already there.
   * @param branch - the branch the worktree would hold.
   * @param signal - abandons the suggestion when the typed branch name moves on.
   * @returns the suggestion, or a classified failure.
   */
  suggestPath: (branch: string, signal?: AbortSignal) => Promise<SuggestPathResult>
  /**
   * Add a worktree.
   * @param request - the destination, the branch, and how to check it out.
   * @returns the created worktree, or a classified failure.
   */
  addWorktree: (request: Omit<AddWorktreeRequest, 'workspacePath'>) => Promise<AddWorktreeResult>
  /**
   * Remove a worktree.
   * @param request - the worktree path, and whether to remove one holding uncommitted work.
   * @returns git's summary, or a classified failure.
   */
  removeWorktree: (request: Omit<RemoveWorktreeRequest, 'workspacePath'>) => Promise<MutationResult>
  /**
   * Lock or unlock a worktree.
   * @param request - the worktree path, the target state, and an optional lock reason.
   * @returns git's summary, or a classified failure.
   */
  lockWorktree: (request: Omit<LockWorktreeRequest, 'workspacePath'>) => Promise<MutationResult>
  /**
   * Drop the administrative records of worktrees whose directories are gone.
   * @returns git's summary, or a classified failure.
   */
  pruneWorktrees: () => Promise<MutationResult>
}

/** Injected business face of the session-header chip. */
export interface WorktreeChipInjected {
  /**
   * Read what this surface is allowed to draw and how often to re-read.
   * @param signal - abandons the probe when the seat unmounts.
   * @returns the capability view.
   */
  describeWorktree: (signal?: AbortSignal) => Promise<WorktreeView>
  /**
   * Bind every git operation to one workspace directory.
   * @param workspacePath - the workspace's canonical directory.
   * @returns the bound command set.
   */
  commandsFor: (workspacePath: string) => WorktreeCommands
  /**
   * Adopt a directory as a harness Workspace, and optionally open a session in it.
   *
   * The Host cannot do this half: Workspaces and sessions are browser-runtime domains, so creating
   * a worktree is a Host act and making it reachable from the sidebar is a client one.
   * @param path - the worktree directory.
   * @param openSession - open (or reuse) a session in the resulting Workspace.
   */
  adoptWorkspace: (path: string, openSession: boolean) => Promise<void>
  /**
   * Whether the Host can show a path in its file manager.
   *
   * False on a Host with no desktop (or a deployment without the Session Remote); the chip leaves the
   * reveal action out rather than offering one that cannot work.
   * @returns the Host's answer; rejects on a transport failure.
   */
  canRevealPath: () => Promise<boolean>
  /**
   * Show a directory in the Host's file manager.
   * @param path - the directory to reveal.
   * @returns after the Host's opener accepted the path; rejects when it cannot.
   */
  revealPath: (path: string) => Promise<void>
}

/**
 * Injected business face of the new-session hero surface.
 *
 * Its own face because this seat is where a session is *placed* rather than where an existing one is
 * inspected: it chooses directories from the Host and adopts them as Workspaces. Creating the
 * worktree on first send belongs to the composer's gate (see {@link WorktreeSendGateInjected}).
 */
export interface WorktreeHeroInjected {
  /**
   * Read what this surface is allowed to draw and how often to re-read.
   * @param signal - abandons the probe when the seat unmounts.
   * @returns the capability view.
   */
  describeWorktree: (signal?: AbortSignal) => Promise<WorktreeView>
  /**
   * Bind every git operation to one workspace directory.
   * @param workspacePath - the workspace's canonical directory.
   * @returns the bound command set.
   */
  commandsFor: (workspacePath: string) => WorktreeCommands
  /**
   * Open the Host's own directory chooser.
   *
   * Reached through `ctx.uiWorkspace` rather than through the directory-flow slot: this plugin
   * shadows the hero picker's registration, and a slot occupant may only render child holes its own
   * registration declared — which is exactly the hole `ui-workspace` still owns. The composed
   * native/browse chooser is the same interaction either way.
   * @returns the chosen absolute path, or null when the operator cancelled.
   */
  pickDirectory: () => Promise<string | null>
  /**
   * Adopt a directory as a harness Workspace.
   * @param path - the directory to adopt.
   * @returns the Workspace's id, which is what selecting it needs.
   */
  createWorkspace: (path: string) => Promise<WorkspaceId>
}

/**
 * Injected business face of the composer's first-send gate.
 *
 * Besides git, it needs harness facilities that no standard kit hands a slot: whether a trigger
 * menu would take Enter, which session is on screen (the move must only ever carry this session's
 * draft), the composer block that stops input while the worktree is made, the composer's notice line
 * for a failure, and removing a Workspace again when an attempt is rolled back.
 */
export interface WorktreeSendGateInjected extends WorktreeNamingInjected {
  /**
   * Adopt a directory as a Workspace.
   * @param path - absolute directory.
   * @returns the Workspace's id (an existing one when the directory was adopted before).
   */
  createWorkspace: (path: string) => Promise<WorkspaceId>
  /**
   * Remove a Workspace from the registry, for undoing one this gate adopted.
   * @param workspaceId - the Workspace.
   * @returns settlement after the Host accepts it.
   */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Whether this session's `/` or `@` menu would take Enter: open with a highlighted row, which is
   * exactly when the harness keymap picks from the menu instead of sending.
   * @param sessionId - the session.
   * @returns true when Enter belongs to the menu.
   */
  menuClaimsEnter: (sessionId: string) => boolean
  /**
   * The session currently on screen.
   * @returns its id, or undefined when none is selected.
   */
  currentSession: () => string | undefined
  /**
   * Raise or clear this session's composer block.
   * @param sessionId - the session.
   * @param reason - the placeholder to show, or undefined to clear the block.
   */
  block: (sessionId: string, reason: string | undefined) => void
  /**
   * Show an error in the session's composer notice line.
   * @param sessionId - the session.
   * @param text - the message.
   */
  notify: (sessionId: string, text: string) => void
}

/**
 * Injected business face of the session header's naming watcher.
 *
 * Its own face rather than the chip's because it is a different job on the same repository: the chip
 * shows and switches, this one renames the branch a new-session worktree was created on.
 */
export interface WorktreeNamingInjected {
  /**
   * Read the capability view, which carries the branch prefix the name is completed with.
   * @param signal - abandons the probe when the seat unmounts.
   * @returns the capability view.
   */
  describeWorktree: (signal?: AbortSignal) => Promise<WorktreeView>
  /**
   * Bind every git operation to one workspace directory.
   * @param workspacePath - the workspace's canonical directory.
   * @returns the bound command set.
   */
  commandsFor: (workspacePath: string) => WorktreeCommands
  /**
   * Rename a Workspace's display title, so the switcher shows the branch rather than the directory
   * the provisional name produced.
   * @param workspaceId - the Workspace to rename.
   * @param title - the new title.
   * @returns settlement after the Host accepts it.
   */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /**
   * Ask the Host's model for a branch name describing one prompt.
   * @param prompt - the prompt to name from.
   * @returns the suggestion, or a classified failure.
   */
  suggestBranchName: (prompt: string) => Promise<SuggestBranchNameResult>
}

/** Injected business face of the worktree settings card. */
export interface WorktreeSettingsInjected {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** The bound `worktree` settings scope: resolved value, layers, revision, and writability. */
    worktreeSettings: SettingsScope<WorktreeSettings>
  }
  /**
   * Read the Host's capability view for the card's status line.
   * @param signal - abandons the probe when the card unmounts.
   * @returns the capability view.
   */
  describeWorktree: (signal?: AbortSignal) => Promise<WorktreeView>
  /**
   * Store one field of the `worktree` section; the bound scope owns revision fencing.
   * @param field - the field name inside the namespace.
   * @param value - the JSON-shaped value the control produced.
   * @returns settlement after the write.
   */
  setField: (field: string, value: unknown) => Promise<void>
}
