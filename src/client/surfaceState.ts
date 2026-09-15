/**
 * The two decisions about WHETHER and HOW the worktree surface draws, kept apart from the components
 * that act on them.
 *
 * Both are pure because both are easy to get subtly wrong and impossible to see in a unit test once
 * they are buried in a render: the pill's state is a four-way fold over three independently arriving
 * readings, and "has this session started" mirrors a phase rule the conversation shell computes but
 * does not hand to a dock entry.
 * @module @achasoft/dsh-worktree/client/surfaceState
 */

import type { GitFailure, OverviewSuccess, WorktreeView } from '../host/types.ts'

/** Why the new-session pill is drawn disabled. */
export type HeroPillUnsupported =
  /** The project folder is not inside a git repository. */
  | { readonly reason: 'not-a-repository' }
  /** git (or the subprocess / filesystem capability it needs) cannot run on the Host. */
  | { readonly reason: 'unavailable'; readonly detail?: string }
  /** The deployment switched the worktree surface off (`showChip: false`). */
  | { readonly reason: 'switched-off' }

/**
 * What the new-session pill shows.
 *
 * - `absent` — no project is selected, so there is no row position to hold.
 * - `loading` — the capability probe or the first reading has not landed: a neutral placeholder that
 *   holds the pill's place, so the row does not jump when the answer arrives.
 * - `unsupported` — drawn, disabled, and saying "no git", with the reason as its tooltip.
 * - `error` — drawn, disabled, and saying "git error", with the failure's message as its tooltip:
 *   the probe or the first reading failed for a reason that may pass, and is being retried.
 * - `ready` — the working branch control and worktree checkbox.
 */
export type HeroPillState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loading' }
  | ({ readonly kind: 'unsupported' } & HeroPillUnsupported)
  | { readonly kind: 'error'; readonly detail: string }
  | { readonly kind: 'ready'; readonly overview: OverviewSuccess }

/** Failure codes that say git cannot run here at all, as opposed to this folder not being a repository. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['no-filesystem', 'no-subprocess', 'no-git', 'path-denied'])

/** The readings {@link heroPillState} folds. */
export interface HeroPillInputs {
  /** Whether a project is selected on the new-session screen. */
  readonly hasProject: boolean
  /** The capability view, or null before the probe answers. */
  readonly view: WorktreeView | null
  /** Why the last capability probe failed, while no view has been read; absent or null otherwise. */
  readonly viewError?: string | null
  /** The latest successful repository reading for the selected project, or null. */
  readonly overview: OverviewSuccess | null
  /**
   * The failure of the latest READING, or null. Never a mutation's: a refused checkout is shown in
   * the dropdown and says nothing about whether the pill can draw.
   */
  readonly failure: GitFailure | null
}

/**
 * Decide what the new-session pill shows.
 *
 * Order matters. The deployment's own answer (switched off, no git) outranks anything a reading
 * says, because it is the reason the reading failed. A reading failure with nothing read before it
 * outranks a missing view, because "not a repository" is already a complete answer — and any other
 * failure there (a timeout, git failing) is an error to show rather than a reading still on its way,
 * since a pill that says "loading" about a request that already failed never stops saying it. A
 * failed probe is the same. Only then is a missing reading treated as still loading — so a project
 * that is not a repository never flashes "loading" after it has been told, and a repository never
 * flashes "no git" before it has been read.
 * @param inputs - the selection and the three readings.
 * @returns the pill's state.
 */
export function heroPillState(inputs: HeroPillInputs): HeroPillState {
  const { hasProject, view, viewError, overview, failure } = inputs
  if (!hasProject) return { kind: 'absent' }
  if (view !== null && !view.showChip) return { kind: 'unsupported', reason: 'switched-off' }
  if (view !== null && !view.gitAvailable) {
    return { kind: 'unsupported', reason: 'unavailable', ...view.reason === undefined ? {} : { detail: view.reason } }
  }
  if (failure !== null && overview === null) {
    if (failure.code === 'not-a-repository') return { kind: 'unsupported', reason: 'not-a-repository' }
    if (UNAVAILABLE_CODES.has(failure.code)) {
      return { kind: 'unsupported', reason: 'unavailable', detail: failure.message }
    }
    return { kind: 'error', detail: failure.message }
  }
  if (view === null && viewError !== undefined && viewError !== null) return { kind: 'error', detail: viewError }
  if (view === null || overview === null) return { kind: 'loading' }
  return { kind: 'ready', overview }
}

/**
 * The session facts the conversation shell decides its phase from.
 *
 * Declared locally and structurally rather than imported: the dock seat's owner share is typed as
 * the installed harness's `SessionSnapshot`, which a checkout this package compiles against may
 * spell differently. Every field is optional so an older snapshot reads as "not started" instead of
 * failing to type-check.
 */
export interface SessionPhaseFacts {
  readonly blank?: boolean
  readonly awaitingFirstTurn?: boolean
  readonly running?: boolean
  readonly promptAttempted?: boolean
}

/**
 * Whether a session has left the blank new-session screen.
 *
 * Mirrors the shell's `conversationPhase` in `@deepseek-ai/dsh-client-ui-conversation` (installed
 * 0.1.5-rc.2, `lib/client.js`): the phase is `active` when a conversation target is active, the
 * session holds turns and is not awaiting its first one, or it is running; `engaging` once a prompt
 * was attempted; `blank` otherwise. The shell shows its hero — which already carries this plugin's
 * branch and worktree pill — only in the blank phase, so every other phase is where the composer
 * row takes over.
 * @param session - the session snapshot, or undefined before one is bound.
 * @param activeTargets - how many conversation targets are active.
 * @returns true once the session is past blank.
 */
export function sessionStarted(session: SessionPhaseFacts | undefined, activeTargets: number): boolean {
  if (session === undefined) return false
  return activeTargets > 0
    || (session.blank === false && session.awaitingFirstTurn !== true)
    || session.running === true
    || session.promptAttempted === true
}
