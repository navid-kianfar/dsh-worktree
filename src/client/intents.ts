/**
 * The worktree this surface created for a blank session, remembered until the session has a name.
 *
 * **Legacy.** Builds before the first-send gate created the worktree the moment the box was ticked,
 * on a provisional branch, and recorded it here. The current build names the branch when it creates
 * the worktree (see `./SendGate.tsx`) and writes no intents; this store is still read so that a
 * worktree an earlier build left behind in this browser gets its branch renamed as promised.
 *
 * A worktree has to exist before a session can be pointed at it, but the name that describes the
 * task only exists once someone has typed a prompt — so the new-session surface creates the worktree
 * on a provisional branch and this store is the thread back to it: which workspace it became, which
 * workspace the session came from, and whether the branch has been renamed yet. The rename itself
 * happens in the session header's seat (the only place that can see the draft), and this is what the
 * two seats share.
 *
 * Browser-local and persisted, because the window in which an intent is needed — between creating a
 * worktree and naming its branch — spans a page reload: the harness reloads the page on every client
 * rebuild, and losing the intent there would leave the checkbox unticked while the session is still
 * in the provisional worktree, so ticking it again would create a second one. Nothing else here is
 * durable state the Host owns — the worktree and the branch are on disk and the workspace is in the
 * registry — so the persisted copy is exactly this memory and nothing more.
 * @module @achasoft/dsh-worktree/client/intents
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

/** Where the intents are persisted; versioned so a shape change can be ignored rather than misread. */
const STORAGE_KEY = 'dsh.worktree.intents.v1'

/** One worktree created for a blank session, and what is still owed to it. */
export interface WorktreeIntent {
  /** The Workspace the worktree's directory was adopted as. */
  readonly workspaceId: WorkspaceId
  /** The Workspace the session was in before the worktree was created; where unchecking returns. */
  readonly baseWorkspaceId: WorkspaceId
  /** Absolute worktree directory, as git created it. */
  readonly path: string
  /** The branch currently checked out there; rewritten by {@link WorktreeIntentStore.markNamed}. */
  readonly branch: string
  /** True once the branch has been renamed from a prompt, which is what stops the second ask. */
  readonly named: boolean
}

/** The observable store the two seats share. */
export interface WorktreeIntentStore {
  /**
   * Subscribe to changes.
   * @param listener - called after every mutation.
   * @returns unsubscribe.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Read the current intents.
   *
   * Identity-stable between mutations, which is what lets a component read it through
   * `useSyncExternalStore` without looping.
   * @returns the intents, newest last.
   */
  getSnapshot: () => readonly WorktreeIntent[]
  /**
   * Record a new intent, replacing any intent for the same workspace.
   * @param intent - the intent to record.
   */
  set: (intent: WorktreeIntent) => void
  /**
   * Record that a branch has been named from a prompt.
   * @param workspaceId - the intent's worktree workspace.
   * @param branch - the branch's new name.
   */
  markNamed: (workspaceId: WorkspaceId, branch: string) => void
  /**
   * Drop one intent, after the worktree is gone or the session has moved on.
   * @param workspaceId - the intent's worktree workspace.
   */
  forget: (workspaceId: WorkspaceId) => void
}

/**
 * Read the persisted intents.
 *
 * Every failure mode answers `[]`: private-mode storage that throws, a value another version wrote,
 * a half-written record. A lost intent costs a second click; a crash at module load would cost the
 * whole plugin, so nothing here is allowed to propagate.
 * @returns the recorded intents, or none.
 */
function hydrate(): readonly WorktreeIntent[] {
  if (typeof localStorage === 'undefined') return Object.freeze([])
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return Object.freeze([])
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return Object.freeze([])
    const intents = parsed.filter((entry): entry is WorktreeIntent => {
      if (entry === null || typeof entry !== 'object') return false
      const candidate = entry as Partial<WorktreeIntent>
      return typeof candidate.workspaceId === 'string'
        && typeof candidate.baseWorkspaceId === 'string'
        && typeof candidate.path === 'string'
        && typeof candidate.branch === 'string'
        && typeof candidate.named === 'boolean'
    })
    return Object.freeze(intents)
  } catch {
    return Object.freeze([])
  }
}

/**
 * Build one intent store.
 * @returns a store seeded from whatever the last page left behind.
 */
export function createWorktreeIntentStore(): WorktreeIntentStore {
  const listeners = new Set<() => void>()
  let snapshot: readonly WorktreeIntent[] = hydrate()

  /**
   * Publish one new snapshot, wake every listener, and persist it.
   * @param next - the new intents.
   */
  const publish = (next: readonly WorktreeIntent[]): void => {
    snapshot = Object.freeze(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // Storage being full or refused is not a reason to stop working in memory.
    }
    for (const listener of listeners) listener()
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    set: (intent) => {
      publish([...snapshot.filter(entry => entry.workspaceId !== intent.workspaceId), intent])
    },
    markNamed: (workspaceId, branch) => {
      publish(snapshot.map(entry => entry.workspaceId === workspaceId
        ? { ...entry, branch, named: true }
        : entry))
    },
    forget: (workspaceId) => {
      const next = snapshot.filter(entry => entry.workspaceId !== workspaceId)
      // Nothing to publish when the id was never recorded; the empty-array identity would otherwise
      // change and re-render every reader for a mutation that did nothing.
      if (next.length !== snapshot.length) publish(next)
    },
  }
}

/**
 * The process-wide store.
 *
 * A module singleton rather than a service because both readers live in this plugin and neither can
 * outlive the other: the hero seat writes it and the session-header seat reads it, and the module
 * system is the one lifetime they share.
 */
export const worktreeIntents: WorktreeIntentStore = createWorktreeIntentStore()
