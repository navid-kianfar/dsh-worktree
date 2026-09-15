/**
 * What the new-session pill shows for each combination of readings, and when a session has left the
 * blank screen — the two decisions `surfaceState` keeps out of the components so they can be pinned.
 */
import { describe, expect, it } from 'vitest'
import type { GitFailure, OverviewSuccess, WorktreeView } from '../src/host/types.ts'
import { heroPillState, sessionStarted } from '../src/client/surfaceState.ts'

const VIEW: WorktreeView = {
  gitAvailable: true,
  gitVersion: 'git version 2.50.0',
  showChip: true,
  registerWorkspace: true,
  openSession: true,
  branchPrefix: '',
  refreshIntervalMs: 15000,
  confirmDestructive: true,
}

// Only identity matters to the fold; the reading's contents are never inspected.
const OVERVIEW = { ok: true } as unknown as OverviewSuccess

const failure = (code: GitFailure['code'], message: string = code): GitFailure => ({ ok: false, code, message })

describe('heroPillState', () => {
  it('is absent without a selected project, whatever the readings say', () => {
    expect(heroPillState({ hasProject: false, view: VIEW, overview: OVERVIEW, failure: null }))
      .toEqual({ kind: 'absent' })
  })

  it('holds a loading place until both the probe and the first reading have landed', () => {
    expect(heroPillState({ hasProject: true, view: null, overview: null, failure: null }).kind).toBe('loading')
    expect(heroPillState({ hasProject: true, view: VIEW, overview: null, failure: null }).kind).toBe('loading')
    expect(heroPillState({ hasProject: true, view: null, overview: OVERVIEW, failure: null }).kind).toBe('loading')
  })

  it('is ready with a repository reading, and stays ready through a failure that kept the reading', () => {
    expect(heroPillState({ hasProject: true, view: VIEW, overview: OVERVIEW, failure: null }))
      .toEqual({ kind: 'ready', overview: OVERVIEW })
    // A refused checkout is shown in the dropdown; it does not disable the pill.
    expect(heroPillState({ hasProject: true, view: VIEW, overview: OVERVIEW, failure: failure('refused') }).kind)
      .toBe('ready')
  })

  it('says "not a repository" as soon as the reading does, even before the probe answers', () => {
    expect(heroPillState({ hasProject: true, view: null, overview: null, failure: failure('not-a-repository') }))
      .toEqual({ kind: 'unsupported', reason: 'not-a-repository' })
  })

  it('reports git as unavailable from the probe, with its reason when it gave one', () => {
    expect(heroPillState({
      hasProject: true, view: { ...VIEW, gitAvailable: false, reason: 'git not on PATH' }, overview: null, failure: null,
    })).toEqual({ kind: 'unsupported', reason: 'unavailable', detail: 'git not on PATH' })
    expect(heroPillState({ hasProject: true, view: { ...VIEW, gitAvailable: false }, overview: null, failure: null }))
      .toEqual({ kind: 'unsupported', reason: 'unavailable' })
  })

  it('reports git as unavailable from a terminal reading failure', () => {
    for (const code of ['no-git', 'no-subprocess', 'no-filesystem', 'path-denied'] as const) {
      expect(heroPillState({ hasProject: true, view: null, overview: null, failure: failure(code, `${code}!`) }))
        .toEqual({ kind: 'unsupported', reason: 'unavailable', detail: `${code}!` })
    }
  })

  it('shows a git error, with its message, for a failed first reading instead of loading forever', () => {
    for (const code of ['timeout', 'git-failed', 'refused'] as const) {
      expect(heroPillState({ hasProject: true, view: VIEW, overview: null, failure: failure(code, `${code}!`) }))
        .toEqual({ kind: 'error', detail: `${code}!` })
    }
  })

  it('shows a git error when the capability probe itself failed, and loading while it is still retried', () => {
    expect(heroPillState({ hasProject: true, view: null, viewError: 'socket closed', overview: null, failure: null }))
      .toEqual({ kind: 'error', detail: 'socket closed' })
    expect(heroPillState({ hasProject: true, view: null, viewError: null, overview: null, failure: null }).kind)
      .toBe('loading')
  })

  it('lets the deployment switch outrank everything a reading says', () => {
    const off = { ...VIEW, showChip: false, gitAvailable: false }
    expect(heroPillState({ hasProject: true, view: off, overview: OVERVIEW, failure: null }))
      .toEqual({ kind: 'unsupported', reason: 'switched-off' })
    expect(heroPillState({ hasProject: true, view: { ...VIEW, gitAvailable: false }, overview: null, failure: failure('not-a-repository') }).kind)
      .toBe('unsupported')
  })
})

describe('sessionStarted', () => {
  const BLANK = { blank: true, awaitingFirstTurn: false, running: false, promptAttempted: false }

  it('is false for a blank session and before a session is bound', () => {
    expect(sessionStarted(BLANK, 0)).toBe(false)
    expect(sessionStarted(undefined, 3)).toBe(false)
  })

  it('is true once a prompt was attempted, the session runs, or a target is active', () => {
    expect(sessionStarted({ ...BLANK, promptAttempted: true }, 0)).toBe(true)
    expect(sessionStarted({ ...BLANK, running: true }, 0)).toBe(true)
    expect(sessionStarted(BLANK, 1)).toBe(true)
  })

  it('treats a session with history as started, but not one still awaiting its first turn', () => {
    expect(sessionStarted({ ...BLANK, blank: false }, 0)).toBe(true)
    expect(sessionStarted({ ...BLANK, blank: false, awaitingFirstTurn: true }, 0)).toBe(false)
  })

  it('reads an older snapshot without the phase fields as not started', () => {
    expect(sessionStarted({}, 0)).toBe(false)
  })
})
