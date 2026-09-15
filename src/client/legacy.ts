/**
 * Browser state earlier builds of this plugin left behind, removed once on load.
 *
 * Builds before the first-send gate recorded each worktree they created on a provisional branch in
 * `localStorage`, and a session-header watcher renamed that branch from the session's draft. Nothing
 * has written those records since the gate began naming the branch at creation, and the watcher is
 * gone — but a record left in a browser would outlive both, so the key is deleted rather than
 * ignored.
 * @module @achasoft/dsh-worktree/client/legacy
 */

/** The key the removed worktree-intent store persisted under. */
export const LEGACY_INTENTS_KEY = 'dsh.worktree.intents.v1'

/**
 * Delete the legacy worktree-intent records.
 * @param storage - the page's `localStorage`, or undefined where there is none.
 * @returns true when the key was removed or was never there, false when storage refused access.
 */
export function forgetLegacyIntents(storage: Pick<Storage, 'removeItem'> | undefined): boolean {
  if (storage === undefined) return true
  try {
    storage.removeItem(LEGACY_INTENTS_KEY)
    return true
  } catch (error) {
    // Storage that refuses access (a sandboxed frame, blocked site data) throws a SecurityError. It
    // is handled by reporting it: with no access, the stale record is also unreachable to anything,
    // and failing the plugin's load over a clean-up would cost every seat.
    if (error instanceof Error) return false
    throw error
  }
}
