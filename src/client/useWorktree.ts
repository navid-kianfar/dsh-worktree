/**
 * The chip's data layer: one repository reading, refreshed on a cadence and after every mutation.
 *
 * The reading is deliberately whole rather than split per popover. Branches, worktrees, and HEAD are
 * one consistent picture — a branch row's "checked out at" comes from the worktree listing, and a
 * checkout changes all three — so taking them together is what stops the two popovers from
 * disagreeing about the same repository.
 * @module @achasoft/dsh-worktree/client/useWorktree
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitFailure, OverviewSuccess, WorktreeView } from '../host/types.ts'
import type { WorktreeCommands, WorktreeChipInjected } from './contract.ts'

/** Failures that will not clear on their own, so the chip stops polling against them. */
const TERMINAL_CODES: ReadonlySet<string> = new Set([
  'no-filesystem', 'no-subprocess', 'no-git', 'not-a-repository', 'path-denied',
])

/** What the chip and its popovers read. */
export interface WorktreeState {
  /** The capability view, or null before the first probe answers. */
  readonly view: WorktreeView | null
  /** The most recent successful reading, kept across a transient failure. */
  readonly overview: OverviewSuccess | null
  /** The failure of the last reading or mutation, cleared by the next success. */
  readonly failure: GitFailure | null
  /** True while a reading or a mutation is in flight. */
  readonly busy: boolean
  /** Re-read the repository now. */
  readonly refresh: () => void
  /**
   * Run one mutation, then re-read.
   * @param operation - the bound command to call.
   * @returns the operation's own success value, or null when it failed; the failure is on
   * {@link failure}. The value is returned rather than a flag because a caller often needs what the
   * Host produced — the path git settled a new worktree on, for instance.
   */
  readonly run: <T extends { ok: true }>(operation: () => Promise<T | GitFailure>) => Promise<T | null>
  /** Drop the current failure without re-reading — what a dialog's Cancel does. */
  readonly clearFailure: () => void
}

/**
 * Hold one workspace's repository reading for the lifetime of the seat.
 * @param describeWorktree - the capability probe from the injected face.
 * @param commands - the git operations bound to the current workspace, or null when there is none.
 * @returns the reading, its failure, and the two ways to advance it.
 */
export function useWorktree(
  describeWorktree: WorktreeChipInjected['describeWorktree'],
  commands: WorktreeCommands | null,
): WorktreeState {
  const [view, setView] = useState<WorktreeView | null>(null)
  const [overview, setOverview] = useState<OverviewSuccess | null>(null)
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const [busy, setBusy] = useState(false)
  // Bumping this re-runs the reading effect, which is what makes an explicit refresh and a
  // post-mutation refresh the same code path rather than two.
  const [generation, setGeneration] = useState(0)
  const aliveRef = useRef(true)
  // Read through a call rather than the field: an `await` can unmount this seat, but the compiler
  // narrows `aliveRef.current` after the first check and would treat every later one as dead code.
  const alive = (): boolean => aliveRef.current

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void describeWorktree(controller.signal).then((next) => {
      if (alive()) setView(next)
    }, () => {
      // A failed probe leaves `view` null, which renders exactly like a deployment that switched the
      // chip off: nothing at all. There is no partial state worth showing from a Host that did not
      // answer what this surface is allowed to draw.
    })
    return () => { controller.abort() }
  }, [describeWorktree])

  useEffect(() => {
    if (commands === null) {
      setOverview(null)
      setFailure(null)
      return undefined
    }
    const controller = new AbortController()
    setBusy(true)
    void commands.overview(controller.signal).then((result) => {
      if (!alive() || controller.signal.aborted) return
      setBusy(false)
      if (result.ok) {
        setOverview(result)
        setFailure(null)
        return
      }
      // The previous reading stays on screen through a transient failure: a timeout clears on the
      // next poll, and blanking the chip for it would be a worse answer than a slightly stale one.
      setFailure(result)
      if (TERMINAL_CODES.has(result.code)) setOverview(null)
    }, () => {
      // A transport failure is not a git failure. The reading is left as it was and the next poll
      // decides; surfacing it would put a wire error where a repository error belongs.
      if (alive() && !controller.signal.aborted) setBusy(false)
    })
    return () => { controller.abort() }
  }, [commands, generation])

  const refresh = useCallback((): void => { setGeneration(current => current + 1) }, [])
  const clearFailure = useCallback((): void => { setFailure(null) }, [])

  // Polling stops on a terminal failure: a workspace that is not a repository stays not a
  // repository, and re-asking every interval spends a request forever to be told the same thing.
  const halted = failure !== null && TERMINAL_CODES.has(failure.code)
  const interval = view?.refreshIntervalMs ?? 0
  useEffect(() => {
    if (commands === null || halted || interval <= 0) return undefined
    const timer = setInterval(refresh, interval)
    return () => { clearInterval(timer) }
  }, [commands, halted, interval, refresh])

  const run = useCallback(async <T extends { ok: true }>(
    operation: () => Promise<T | GitFailure>,
  ): Promise<T | null> => {
    setBusy(true)
    try {
      const result = await operation()
      if (!result.ok) {
        if (alive()) {
          setFailure(result)
          setBusy(false)
        }
        return null
      }
      if (alive()) {
        setFailure(null)
        // Refresh rather than patching the held reading: a checkout moves HEAD, changes which
        // branch each worktree holds, and can change what is uncommitted — re-reading is the only
        // way the three stay one consistent picture.
        refresh()
      }
      return result
    } catch (error) {
      if (alive()) {
        setFailure({
          ok: false,
          code: 'git-failed',
          message: error instanceof Error ? error.message : String(error),
        })
        setBusy(false)
      }
      return null
    }
  }, [refresh])

  return { view, overview, failure, busy, refresh, run, clearFailure }
}
