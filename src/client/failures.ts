/**
 * The two kinds of failure the chip and the new-session pill hold, and how long to wait before
 * asking again after one.
 *
 * A READING failure and a MUTATION failure are different facts with different lifetimes. A reading
 * that failed is superseded by the next reading, so the next success clears it. A mutation that
 * failed — git refusing a checkout because local changes would be overwritten — is an answer to
 * something a person did, and it must stay in front of them until they act on it: close the
 * dropdown, or try again. Holding both in one slot let the next background poll's success wipe the
 * refusal a moment after it appeared.
 * @module @achasoft/dsh-worktree/client/failures
 */

import type { GitFailure } from '../host/types.ts'

/** Both failures, each cleared by its own events. */
export interface FailureState {
  /** The last repository reading's failure; cleared by the next successful reading. */
  readonly reading: GitFailure | null
  /** The last mutation's failure; cleared only when the person acts. */
  readonly mutation: GitFailure | null
}

/** Something that happened to a reading or a mutation. */
export type FailureEvent =
  | { readonly kind: 'read-succeeded' }
  | { readonly kind: 'read-failed'; readonly failure: GitFailure }
  | { readonly kind: 'mutation-started' }
  | { readonly kind: 'mutation-succeeded' }
  | { readonly kind: 'mutation-failed'; readonly failure: GitFailure }
  /** The person closed the surface the failure was shown in. */
  | { readonly kind: 'dismissed' }
  /** A different directory is being read; nothing about the previous one applies. */
  | { readonly kind: 'reset' }

/** Neither kind of failure. */
export const NO_FAILURES: FailureState = Object.freeze({ reading: null, mutation: null })

/**
 * Apply one event.
 * @param state - the current failures.
 * @param event - what happened.
 * @returns the next failures; the same object when nothing changed, so a render can bail out.
 */
export function reduceFailures(state: FailureState, event: FailureEvent): FailureState {
  switch (event.kind) {
    case 'read-succeeded':
      return state.reading === null ? state : { ...state, reading: null }
    case 'read-failed':
      return { ...state, reading: event.failure }
    // Starting a mutation is the person acting on the last refusal — retrying it or doing something
    // else — so the refusal goes, and whatever this attempt answers takes its place.
    case 'mutation-started':
    case 'mutation-succeeded':
    case 'dismissed':
      return state.mutation === null ? state : { ...state, mutation: null }
    case 'mutation-failed':
      return { ...state, mutation: event.failure }
    case 'reset':
      return NO_FAILURES
    default:
      return assertNever(event)
  }
}

/**
 * The failure to draw: a mutation's refusal outranks a reading's, because it answers the last thing
 * the person did.
 * @param state - the current failures.
 * @returns the failure to show, or null.
 */
export function shownFailure(state: FailureState): GitFailure | null {
  return state.mutation ?? state.reading
}

/** First retry delay after a failed probe or reading. */
const RETRY_BASE_MS = 1_000

/** The longest a retry is ever put off. */
const RETRY_CEILING_MS = 30_000

/**
 * How long to wait before retry number `attempt` (0-based): doubling from one second, capped at
 * thirty, so a Host that is briefly unreachable is asked again quickly and one that stays down is
 * not asked every second forever.
 * @param attempt - how many retries have already been made.
 * @returns the delay in milliseconds.
 */
export function retryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt, 16))
  return Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** exponent)
}

/**
 * Fail loudly on an event kind this reducer does not know.
 * @param value - the unhandled event.
 * @returns never.
 * @throws Error always.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled failure event: ${JSON.stringify(value)}`)
}
