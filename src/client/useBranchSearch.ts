/**
 * Ask the Host for branches past the reading's ceiling while someone types in a branch search.
 *
 * Shared by both branch lists — the session row's switcher and the new-session pill's dropdown —
 * because both filter a reading that stops at the configured ceiling, and both would otherwise find
 * nothing for a branch that exists past it. The decisions themselves live in `./branchSearch.ts`.
 * @module @achasoft/dsh-worktree/client/useBranchSearch
 */

import { useEffect, useState } from 'react'
import type { SearchBranchesResult } from '../host/types.ts'
import { SEARCH_DEBOUNCE_MS, needsHostSearch, type HostSearch } from './branchSearch.ts'

/**
 * Track the Host search for the text in a branch search field.
 * @param truncated - whether the held reading was cut at the ceiling.
 * @param query - the text in the field.
 * @param search - the bound `searchBranches` command, or null when there is no repository; must be
 * identity-stable, since the search re-runs when it changes.
 * @returns what the Host has answered for the current text.
 */
export function useBranchSearch(
  truncated: boolean,
  query: string,
  search: ((query: string, signal: AbortSignal) => Promise<SearchBranchesResult>) | null,
): HostSearch {
  const [state, setState] = useState<HostSearch>({ kind: 'idle' })
  const typed = query.trim()

  useEffect(() => {
    if (search === null || !needsHostSearch(truncated, typed)) {
      setState({ kind: 'idle' })
      return undefined
    }
    const controller = new AbortController()
    setState({ kind: 'pending', query: typed })
    // Debounced, and abandoned when the text moves on, so a word typed quickly is one request.
    const timer = setTimeout(() => {
      void search(typed, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setState(result.ok
          ? { kind: 'done', query: typed, branches: result.branches }
          : { kind: 'failed', query: typed })
      }, () => {
        if (!controller.signal.aborted) setState({ kind: 'failed', query: typed })
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [truncated, typed, search])

  return state
}
