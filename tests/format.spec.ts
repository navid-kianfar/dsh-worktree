import { describe, expect, it } from 'vitest'
import type { RepoState } from '../src/host/types.ts'
import {
  branchLabel, describeFailure, dirtyCount, elideMiddle, fuzzyScore, relativeAge, trackingLabel,
} from '../src/client/format.ts'

/** A clean repository on `main`, for the fields each case actually reads. */
const repo = (overrides: Partial<RepoState> = {}): RepoState => ({
  root: '/repo',
  worktreeRoot: '/repo',
  name: 'repo',
  branch: 'main',
  sha: 'abc1234',
  detached: false,
  unborn: false,
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  linked: false,
  ...overrides,
})

describe('elideMiddle', () => {
  it('leaves a name that fits alone', () => {
    expect(elideMiddle('main', 22)).toBe('main')
  })

  it('keeps both ends of a name that does not', () => {
    const elided = elideMiddle('feature/a-very-long-branch-name', 15)
    expect(elided).toBe('feature…ch-name')
  })

  it('leaves the name alone below the budget where eliding saves nothing', () => {
    expect(elideMiddle('abcdef', 4)).toBe('abcdef')
  })
})

describe('branchLabel', () => {
  it('names the branch when there is one', () => {
    expect(branchLabel(repo(), 'detached')).toBe('main')
  })

  it('falls back to the commit when HEAD is detached', () => {
    const state = { ...repo({ detached: true }), branch: undefined } as unknown as RepoState
    expect(branchLabel(state, 'detached')).toBe('abc1234')
  })

  it('uses the supplied label when there is neither', () => {
    const state = { ...repo({ detached: true }), branch: undefined, sha: undefined } as unknown as RepoState
    expect(branchLabel(state, 'detached')).toBe('detached')
  })
})

describe('dirtyCount', () => {
  it('sums the four counters', () => {
    expect(dirtyCount({ staged: 1, unstaged: 2, untracked: 3, conflicted: 4 })).toBe(10)
  })

  it('answers zero for a clean worktree', () => {
    expect(dirtyCount({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })).toBe(0)
  })
})

describe('trackingLabel', () => {
  it('is empty with no upstream', () => {
    expect(trackingLabel(undefined)).toBe('')
  })

  it('is empty when level with the upstream', () => {
    expect(trackingLabel({ upstream: 'origin/main', ahead: 0, behind: 0, gone: false })).toBe('')
  })

  it('is empty for a gone upstream, whose counters mean nothing', () => {
    expect(trackingLabel({ upstream: 'origin/old', ahead: 3, behind: 0, gone: true })).toBe('')
  })

  it('shows each counter that is non-zero', () => {
    expect(trackingLabel({ upstream: 'o/m', ahead: 2, behind: 0, gone: false })).toBe('↑2')
    expect(trackingLabel({ upstream: 'o/m', ahead: 0, behind: 1, gone: false })).toBe('↓1')
    expect(trackingLabel({ upstream: 'o/m', ahead: 2, behind: 1, gone: false })).toBe('↑2 ↓1')
  })
})

describe('relativeAge', () => {
  const now = 1_800_000_000_000

  it('buckets each unit at its threshold', () => {
    expect(relativeAge(now - 30_000, now)).toEqual({ unit: 'now', value: 0 })
    expect(relativeAge(now - 90_000, now)).toEqual({ unit: 'minutes', value: 1 })
    expect(relativeAge(now - 2 * 3_600_000, now)).toEqual({ unit: 'hours', value: 2 })
    expect(relativeAge(now - 3 * 86_400_000, now)).toEqual({ unit: 'days', value: 3 })
    expect(relativeAge(now - 70 * 86_400_000, now)).toEqual({ unit: 'months', value: 2 })
  })

  it('reads a future instant as now rather than as a negative age', () => {
    expect(relativeAge(now + 60_000, now)).toEqual({ unit: 'now', value: 0 })
  })

  it('reads an unusable instant as now', () => {
    expect(relativeAge(Number.NaN, now)).toEqual({ unit: 'now', value: 0 })
  })
})

describe('fuzzyScore', () => {
  it('matches every row on an empty query', () => {
    expect(fuzzyScore('feature/login', '')).toBe(0)
  })

  it('matches a subsequence, not only a substring', () => {
    expect(fuzzyScore('feature/login', 'flog')).toBeGreaterThan(0)
  })

  it('refuses a query whose characters are not all present in order', () => {
    expect(fuzzyScore('feature/login', 'zzz')).toBe(-1)
    expect(fuzzyScore('feature/login', 'nigol')).toBe(-1)
  })

  it('ignores case on both sides', () => {
    expect(fuzzyScore('Feature/Login', 'featurelogin')).toBeGreaterThan(0)
  })

  it('prefers a contiguous match over a scattered one', () => {
    expect(fuzzyScore('feature', 'feat')).toBeGreaterThan(fuzzyScore('foobarenat', 'feat'))
  })

  it('prefers a match that starts at the beginning', () => {
    expect(fuzzyScore('login-page', 'log')).toBeGreaterThan(fuzzyScore('page-login', 'log'))
  })
})

describe('describeFailure', () => {
  it('gives every classified code its own sentence', () => {
    const codes = [
      'no-filesystem', 'no-subprocess', 'no-git', 'not-a-repository', 'path-denied', 'not-found',
      'refused', 'git-failed', 'timeout', 'cancelled', 'invalid-request',
    ] as const
    const sentences = codes.map(code => describeFailure(code))
    expect(new Set(sentences).size).toBe(codes.length)
    expect(sentences.every(sentence => sentence !== '')).toBe(true)
  })
})
