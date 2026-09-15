/**
 * The staged new-session choice and the first-send hand-offs: what the hero toolbar records, what
 * the send gate consumes, and the branch-name de-duplication it applies before creating a worktree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { PENDING_SEND_TTL_MS, heroPicker, pendingSends, stagedSessions } from '../src/client/staging.ts'
import { freeBranchName } from '../src/client/SendGate.tsx'
import { matchScore } from '../src/client/format.ts'

const A = 'ws-a' as WorkspaceId
const B = 'ws-b' as WorkspaceId

const NOW = 1_800_000_000_000

afterEach(() => {
  stagedSessions.clear(A)
  stagedSessions.clear(B)
  pendingSends.take(A, NOW)
  pendingSends.take(B, NOW)
  heroPicker.set(undefined)
})

describe('stagedSessions', () => {
  it('stages per project and merges changes', () => {
    stagedSessions.update(A, { worktree: true })
    stagedSessions.update(A, { baseBranch: 'develop' })
    expect(stagedSessions.get(A)).toEqual({ workspaceId: A, worktree: true, baseBranch: 'develop' })
    expect(stagedSessions.get(B)).toBeUndefined()
    expect(stagedSessions.get(undefined)).toBeUndefined()
  })

  it('forgets a project on clear, leaving nothing staged', () => {
    stagedSessions.update(A, { worktree: true, baseBranch: 'main' })
    stagedSessions.clear(A)
    expect(stagedSessions.get(A)).toBeUndefined()
  })

  it('notifies subscribers and keeps the snapshot stable between writes', () => {
    const listener = vi.fn()
    const unsubscribe = stagedSessions.subscribe(listener)
    const before = stagedSessions.getSnapshot()
    expect(stagedSessions.getSnapshot()).toBe(before)
    stagedSessions.update(A, { worktree: true })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(stagedSessions.getSnapshot()).not.toBe(before)
    stagedSessions.clear(B)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('pendingSends', () => {
  it('is consumed exactly once', () => {
    pendingSends.add(A, 'session-1', NOW)
    expect(pendingSends.has(A, NOW + 1)).toBe(true)
    expect(pendingSends.take(A, NOW + 1)).toBe(true)
    expect(pendingSends.take(A, NOW + 1)).toBe(false)
    expect(pendingSends.has(A, NOW + 1)).toBe(false)
  })

  it('expires, so a move that never landed cannot turn a later keystroke into a send', () => {
    pendingSends.add(A, 'session-1', NOW)
    const late = NOW + PENDING_SEND_TTL_MS + 1
    expect(pendingSends.has(A, late)).toBe(false)
    // Still present for its creator to reclaim, but not granted to a consumer.
    expect(pendingSends.getSnapshot().has(A)).toBe(true)
    expect(pendingSends.take(A, late)).toBe(false)
    expect(pendingSends.getSnapshot().has(A)).toBe(false)
  })
})

describe('stagedSessions.restore', () => {
  it('puts back a whole staged choice after a failed first send', () => {
    stagedSessions.restore({ workspaceId: A, worktree: true, baseBranch: 'develop' })
    expect(stagedSessions.get(A)).toEqual({ workspaceId: A, worktree: true, baseBranch: 'develop' })
  })
})

describe('heroPicker', () => {
  it('reports when no toolbar is mounted to pick through', () => {
    expect(heroPicker.available()).toBe(false)
    expect(heroPicker.pick(A)).toBe(false)
    const pick = vi.fn()
    heroPicker.set(pick)
    expect(heroPicker.available()).toBe(true)
    expect(heroPicker.pick(A)).toBe(true)
    expect(pick).toHaveBeenCalledWith(A)
  })
})

describe('freeBranchName', () => {
  it('keeps a free name and numbers a taken one', () => {
    expect(freeBranchName('fix-login', new Set(['main']))).toBe('fix-login')
    expect(freeBranchName('fix-login', new Set(['fix-login']))).toBe('fix-login-2')
    expect(freeBranchName('fix-login', new Set(['fix-login', 'fix-login-2']))).toBe('fix-login-3')
  })
})

describe('matchScore', () => {
  const project = (label: string, detail: string) => ({ id: label, label, detail })

  it('matches names fuzzily and paths only as a substring', () => {
    const score = (row: ReturnType<typeof project>, needle: string) => matchScore(row, needle, needle.toLowerCase())
    const demo = project('wt-demo-repo', '/private/tmp/wt-demo-repo')
    const smg = project('smg.core.platform.identity', '/Users/aslan_nejad/Desktop/DEV/smg/snap-muse/smg.core.platform.identity')
    expect(score(demo, 'demo')).toBeGreaterThan(0)
    // Every letter of "demo" occurs in order somewhere in this path; that must not count as a match.
    expect(score(smg, 'demo')).toBe(-1)
    expect(score(smg, 'snap-muse')).toBe(1)
    expect(score(demo, 'demo')).toBeGreaterThan(score(smg, 'snap-muse'))
  })
})
