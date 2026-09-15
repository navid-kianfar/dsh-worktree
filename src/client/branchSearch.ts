/**
 * The branch switcher's search decisions, kept out of the component so they can be pinned.
 *
 * The switcher filters the reading it holds, and a reading stops at the configured branch ceiling.
 * Past that ceiling the Host is asked too, and its matches are merged in — which is what makes the
 * "search to reach the rest" notice true, and what stops the list offering to create a branch that
 * already exists beyond the cap.
 * @module @achasoft/dsh-worktree/client/branchSearch
 */

import type { BranchEntry } from '../host/types.ts'

/** How long typing must pause before the Host is asked. */
export const SEARCH_DEBOUNCE_MS = 250

/** What the Host search has answered for the text in the field. */
export type HostSearch =
  /** No Host search applies: the reading is complete, or nothing is typed. */
  | { readonly kind: 'idle' }
  /** Asked, not answered yet. */
  | { readonly kind: 'pending'; readonly query: string }
  /** Answered for this query. */
  | { readonly kind: 'done'; readonly query: string; readonly branches: readonly BranchEntry[] }
  /** The search failed; the capped reading is all there is. */
  | { readonly kind: 'failed'; readonly query: string }

/**
 * Whether the Host must be asked for a query.
 * @param truncated - whether the held reading was cut at the ceiling.
 * @param query - the text in the search field.
 * @returns true when a match could exist that the held reading does not contain.
 */
export function needsHostSearch(truncated: boolean, query: string): boolean {
  return truncated && query.trim() !== ''
}

/**
 * The branches to list: the held reading's matches, then any the Host found that it did not hold.
 * @param matched - the held reading's matches, already ordered by match quality.
 * @param search - the Host search state.
 * @param query - the text in the search field.
 * @returns the merged list, without duplicates.
 */
export function mergeMatches(
  matched: readonly BranchEntry[], search: HostSearch, query: string,
): readonly BranchEntry[] {
  if (search.kind !== 'done' || search.query !== query.trim()) return matched
  const held = new Set(matched.map(entry => entry.ref))
  const extra = search.branches.filter(entry => !held.has(entry.ref))
  return extra.length === 0 ? matched : [...matched, ...extra]
}

/**
 * Whether "New branch" may be offered for a name.
 *
 * Only once no branch is known to carry it — and, when the reading was truncated, only once the Host
 * search for this exact text has answered: before that, a branch of that name may well exist past
 * the ceiling, and offering to create it would be offering a refusal.
 * @param facts - the proposed name and what is known about existing branches.
 * @returns true when the create row may be shown.
 */
export function mayOfferCreate(facts: {
  readonly typed: string
  readonly proposed: string
  readonly nameUsable: boolean
  readonly known: readonly BranchEntry[]
  readonly truncated: boolean
  readonly search: HostSearch
}): boolean {
  const { typed, proposed, nameUsable, known, truncated, search } = facts
  if (typed === '' || !nameUsable) return false
  if (known.some(entry => entry.name === proposed || entry.name === typed)) return false
  if (!truncated) return true
  return search.kind === 'done' && search.query === typed
}

/** What Enter in the search field does. */
export type EnterAction =
  | { readonly kind: 'checkout'; readonly branch: string }
  | { readonly kind: 'create'; readonly branch: string }
  | { readonly kind: 'none' }

/**
 * Decide what Enter in the search field does.
 *
 * Nothing while an input method is composing — the Enter that confirms a candidate is not a request
 * to switch branches, and browsers report it either through `isComposing` or, in older engines,
 * through the legacy key code 229 — and nothing while an operation is running, since a second
 * checkout started over the first is a request the person never made.
 * @param facts - the key event's facts and the list's state.
 * @returns the action to take.
 */
export function enterAction(facts: {
  readonly key: string
  readonly isComposing: boolean
  readonly keyCode: number
  readonly busy: boolean
  readonly first: BranchEntry | undefined
  readonly offersCreate: boolean
  readonly proposed: string
}): EnterAction {
  if (facts.key !== 'Enter' || facts.isComposing || facts.keyCode === COMPOSITION_KEY_CODE || facts.busy) {
    return { kind: 'none' }
  }
  if (facts.first !== undefined && !facts.first.current) return { kind: 'checkout', branch: facts.first.name }
  if (facts.offersCreate) return { kind: 'create', branch: facts.proposed }
  return { kind: 'none' }
}

/** The key code browsers report for a key event that belongs to an input method's composition. */
const COMPOSITION_KEY_CODE = 229
