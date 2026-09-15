/**
 * What the new-session toolbar has staged, and the hand-offs that carry it through the first send.
 *
 * Ticking "worktree" creates nothing. Like Claude Code, it only records that the next session in this
 * project should run in a fresh worktree, starting from the branch shown in the pill. The worktree is
 * made when the first prompt is sent, because that prompt is the only thing worth naming the branch
 * after — and unticking before then must leave nothing behind on disk.
 *
 * Three pieces of browser-local state live here, all shared between seats that cannot see each
 * other: the hero toolbar (root scope) that stages the choice, the send gate in the composer (session
 * scope) that acts on it, and the gate in the worktree's own blank session that sends the carried
 * draft once the switch lands. None of it is persisted: a staged choice is a gesture, not a fact, and
 * the worktree it becomes is on disk and in the Workspace registry.
 * @module @achasoft/dsh-worktree/client/staging
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

/** One project's staged new-session choice. */
export interface StagedSession {
  /** The project the choice belongs to. */
  readonly workspaceId: WorkspaceId
  /** Run the session in a new worktree created on first send. */
  readonly worktree: boolean
  /**
   * The branch the new worktree starts from. Absent means the repository's current branch, read at
   * send time rather than frozen when the box was ticked.
   */
  readonly baseBranch?: string
}

/** A small observable value with a stable snapshot identity between writes. */
interface Observable<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}

/**
 * Build an observable cell.
 * @param initial - the starting value.
 * @returns the cell and its setter.
 */
function cell<T>(initial: T): Observable<T> & { set: (next: T) => void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const staged = cell<ReadonlyMap<WorkspaceId, StagedSession>>(new Map())

/** The staged choice per project. */
export const stagedSessions = {
  subscribe: staged.subscribe,
  getSnapshot: staged.getSnapshot,
  /**
   * The staged choice for one project.
   * @param workspaceId - the project.
   * @returns the choice, or undefined when nothing is staged.
   */
  get: (workspaceId: WorkspaceId | undefined): StagedSession | undefined =>
    workspaceId === undefined ? undefined : staged.getSnapshot().get(workspaceId),
  /**
   * Merge a change into a project's staged choice.
   * @param workspaceId - the project.
   * @param patch - the fields to change.
   */
  update: (workspaceId: WorkspaceId, patch: Partial<Omit<StagedSession, 'workspaceId'>>): void => {
    const next = new Map(staged.getSnapshot())
    const current = next.get(workspaceId) ?? { workspaceId, worktree: false }
    next.set(workspaceId, { ...current, ...patch, workspaceId })
    staged.set(next)
  },
  /**
   * Put a whole staged choice back, e.g. after a first send that could not complete.
   * @param entry - the choice to restore.
   */
  restore: (entry: StagedSession): void => {
    const next = new Map(staged.getSnapshot())
    next.set(entry.workspaceId, entry)
    staged.set(next)
  },
  /**
   * Forget a project's staged choice.
   * @param workspaceId - the project.
   */
  clear: (workspaceId: WorkspaceId): void => {
    if (!staged.getSnapshot().has(workspaceId)) return
    const next = new Map(staged.getSnapshot())
    next.delete(workspaceId)
    staged.set(next)
  },
}

/** A carried first prompt that the worktree's session still owes a send. */
export interface PendingSend {
  /** The session the prompt was typed in; only its move may be completed. */
  readonly originSessionId: string
  /** Epoch ms after which the move is considered lost and the marker is void. */
  readonly expiresAt: number
}

/** How long a move to the worktree may take before its first send is abandoned. */
export const PENDING_SEND_TTL_MS = 30_000

const pending = cell<ReadonlyMap<WorkspaceId, PendingSend>>(new Map())

/**
 * Worktree workspaces whose carried first prompt has not been sent yet.
 *
 * The gate that created the worktree cannot send the prompt itself: the prompt belongs to the new
 * workspace's blank session, which only exists once the switch has landed and its composer holds
 * the carried draft. So it leaves a marker, and the gate mounted in that session sends and clears it.
 * A marker expires, so a move that never lands can never turn a later keystroke into a send.
 */
export const pendingSends = {
  subscribe: pending.subscribe,
  getSnapshot: pending.getSnapshot,
  /**
   * Mark a workspace as owing a send.
   * @param workspaceId - the worktree's workspace.
   * @param originSessionId - the session the prompt was typed in.
   * @param now - epoch ms.
   */
  add: (workspaceId: WorkspaceId, originSessionId: string, now: number): void => {
    const next = new Map(pending.getSnapshot())
    next.set(workspaceId, { originSessionId, expiresAt: now + PENDING_SEND_TTL_MS })
    pending.set(next)
  },
  /**
   * Whether a live (unexpired) marker exists for a workspace.
   * @param workspaceId - the worktree's workspace.
   * @param now - epoch ms.
   * @returns true while the marker is present and unexpired.
   */
  has: (workspaceId: WorkspaceId, now: number): boolean => {
    const entry = pending.getSnapshot().get(workspaceId)
    return entry !== undefined && entry.expiresAt > now
  },
  /**
   * Take a workspace's marker, if it has a live one. An expired marker is removed and not granted.
   * @param workspaceId - the worktree's workspace.
   * @param now - epoch ms.
   * @returns true when a live marker was present and is now consumed.
   */
  take: (workspaceId: WorkspaceId, now: number): boolean => {
    const entry = pending.getSnapshot().get(workspaceId)
    if (entry === undefined) return false
    const next = new Map(pending.getSnapshot())
    next.delete(workspaceId)
    pending.set(next)
    return entry.expiresAt > now
  },
}

let picker: ((workspaceId: WorkspaceId) => void) | undefined

/**
 * The hero toolbar's workspace pick, reachable from the composer.
 *
 * Picking through the hero owner is what carries the draft and its attachments into the target
 * workspace's blank session, so the gate borrows it rather than reimplementing the carry. The caller
 * must confirm the hero on screen is the one for its own session before picking.
 */
export const heroPicker = {
  /**
   * Publish or withdraw the current pick callback.
   * @param next - the owner's pick, or undefined when the toolbar unmounts.
   */
  set: (next: ((workspaceId: WorkspaceId) => void) | undefined): void => { picker = next },
  /** Whether a toolbar is mounted to pick through. */
  available: (): boolean => picker !== undefined,
  /**
   * Pick a workspace through the hero owner.
   * @param workspaceId - the workspace to move to.
   * @returns false when no toolbar is mounted to do it.
   */
  pick: (workspaceId: WorkspaceId): boolean => {
    if (picker === undefined) return false
    picker(workspaceId)
    return true
  },
}
