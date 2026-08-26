/**
 * Pure display helpers for the worktree surface: how a reading becomes the few characters a chip has
 * room for, and how a git failure becomes a sentence.
 * @module @achasoft/dsh-worktree/client/format
 */

import type { DirtyState, GitFailureCode, RepoState, TrackingState } from '../host/types.ts'

/** Longest branch name the chip shows before eliding its middle. */
const CHIP_BRANCH_MAX = 22

/**
 * Shorten a branch name for the chip, keeping both ends.
 *
 * The middle is what elides because both ends carry meaning: `feature/` says which namespace and the
 * tail says which branch, while the part between them is the least identifying.
 * @param name - the branch name.
 * @param max - the character budget; below 5 the name is returned unchanged, since an ellipsis plus
 * two characters is no shorter than the name it replaces.
 * @returns the name, elided in the middle when it does not fit.
 */
export function elideMiddle(name: string, max: number = CHIP_BRANCH_MAX): string {
  if (max < 5 || name.length <= max) return name
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}

/** What the chip's branch segment says, given HEAD's three possible states. */
export function branchLabel(repo: RepoState, detachedLabel: string): string {
  if (repo.branch !== undefined) return repo.branch
  if (repo.detached) return repo.sha ?? detachedLabel
  return detachedLabel
}

/** Total number of paths with any uncommitted state. */
export function dirtyCount(dirty: DirtyState): number {
  return dirty.staged + dirty.unstaged + dirty.untracked + dirty.conflicted
}

/** One `↑2 ↓1` summary, or empty when the branch is level with (or has no) upstream. */
export function trackingLabel(tracking: TrackingState | undefined): string {
  if (tracking === undefined || tracking.gone) return ''
  const parts: string[] = []
  if (tracking.ahead > 0) parts.push(`↑${String(tracking.ahead)}`)
  if (tracking.behind > 0) parts.push(`↓${String(tracking.behind)}`)
  return parts.join(' ')
}

/** How long ago a commit landed, as a value the caller renders through its own dictionary. */
export interface RelativeAge {
  /** Which dictionary row to use. */
  readonly unit: 'now' | 'minutes' | 'hours' | 'days' | 'months'
  /** The quantity for that row; 0 for `now`. */
  readonly value: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY

/**
 * Bucket an instant into the coarsest unit that still says something.
 * @param at - the instant, epoch milliseconds.
 * @param now - the current instant, epoch milliseconds.
 * @returns the unit and quantity to render; a future instant reads as `now`.
 */
export function relativeAge(at: number, now: number): RelativeAge {
  const elapsed = now - at
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return { unit: 'now', value: 0 }
  if (elapsed < HOUR) return { unit: 'minutes', value: Math.floor(elapsed / MINUTE) }
  if (elapsed < DAY) return { unit: 'hours', value: Math.floor(elapsed / HOUR) }
  if (elapsed < MONTH) return { unit: 'days', value: Math.floor(elapsed / DAY) }
  return { unit: 'months', value: Math.floor(elapsed / MONTH) }
}

/**
 * Rank one branch or worktree row against a query, for the switcher's filter box.
 *
 * A subsequence match rather than a substring one, so `fx` finds `feature/x`; the score prefers
 * matches that start earlier and stay contiguous, which is what puts the obvious answer on top.
 * @param haystack - the row's searchable text.
 * @param needle - the query as typed.
 * @returns a score where higher is better, or -1 when the row does not match at all.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (needle === '') return 0
  const text = haystack.toLowerCase()
  const query = needle.toLowerCase()
  let score = 0
  let at = -1
  let previous = -2
  for (const character of query) {
    at = text.indexOf(character, at + 1)
    if (at < 0) return -1
    // Contiguity is worth more than position: `feat` inside `feature/x` should beat four scattered
    // letters that happen to appear earlier.
    score += at === previous + 1 ? 8 : 1
    if (at === 0) score += 4
    previous = at
  }
  return score
}

/**
 * Operator-facing copy for one git failure.
 *
 * Error surfaces stay English by repository policy, so these are literals rather than dictionary
 * keys — and each is a sentence about what to do, with git's own line shown beside it by the caller.
 * @param code - the classified failure from the Host.
 * @returns a short operator-facing line.
 */
export function describeFailure(code: GitFailureCode): string {
  switch (code) {
    case 'no-filesystem': return 'this deployment composes no filesystem provider'
    case 'no-subprocess': return 'this deployment composes no subprocess provider, so nothing can run git'
    case 'no-git': return 'git is not installed on the host, or is not on its PATH'
    case 'not-a-repository': return 'this workspace is not inside a git repository'
    case 'path-denied': return 'the host refused that path'
    case 'not-found': return 'git has no such branch, worktree, or commit'
    case 'refused': return 'git refused: the repository is in a state that will not allow it'
    case 'git-failed': return 'git reported an error'
    case 'timeout': return 'git did not finish in time'
    case 'cancelled': return 'the request was cancelled'
    case 'invalid-request': return 'that value is not usable'
  }
}
