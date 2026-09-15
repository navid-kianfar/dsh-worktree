/**
 * The browser half's decisions that used to be buried in components: which failure survives a poll,
 * when to ask again, what Enter in the branch search does, what the switcher lists past the branch
 * ceiling, how the settings card stores a dependent pair, and the legacy record removed on load.
 */
import { describe, expect, it } from 'vitest'
import type { BranchEntry, GitFailure } from '../src/host/types.ts'
import {
  NO_FAILURES, reduceFailures, retryDelayMs, shownFailure, type FailureState,
} from '../src/client/failures.ts'
import { enterAction, mayOfferCreate, mergeMatches, needsHostSearch } from '../src/client/branchSearch.ts'
import {
  SettingsWriteRefused, createFieldWriter, registerWorkspaceWrites, type WritableScope,
} from '../src/client/settingsWrites.ts'
import { LEGACY_INTENTS_KEY, forgetLegacyIntents } from '../src/client/legacy.ts'

const refused: GitFailure = { ok: false, code: 'refused', message: 'your local changes would be overwritten' }
const timeout: GitFailure = { ok: false, code: 'timeout', message: 'git did not finish' }

describe('reduceFailures', () => {
  it('keeps a refused checkout on screen through the next successful background reading', () => {
    let state: FailureState = NO_FAILURES
    state = reduceFailures(state, { kind: 'mutation-started' })
    state = reduceFailures(state, { kind: 'mutation-failed', failure: refused })
    state = reduceFailures(state, { kind: 'read-succeeded' })
    expect(shownFailure(state)).toBe(refused)
  })

  it('drops the refusal when the person closes the dropdown or tries again', () => {
    const failed = reduceFailures(NO_FAILURES, { kind: 'mutation-failed', failure: refused })
    expect(shownFailure(reduceFailures(failed, { kind: 'dismissed' }))).toBeNull()
    expect(shownFailure(reduceFailures(failed, { kind: 'mutation-started' }))).toBeNull()
  })

  it('clears a reading failure on the next successful reading, and prefers a refusal while both stand', () => {
    const both = reduceFailures(
      reduceFailures(NO_FAILURES, { kind: 'read-failed', failure: timeout }),
      { kind: 'mutation-failed', failure: refused },
    )
    expect(shownFailure(both)).toBe(refused)
    expect(reduceFailures(both, { kind: 'read-succeeded' }).reading).toBeNull()
    expect(reduceFailures(both, { kind: 'reset' })).toEqual(NO_FAILURES)
  })

  it('answers the same state when an event changes nothing, so a render can bail out', () => {
    expect(reduceFailures(NO_FAILURES, { kind: 'read-succeeded' })).toBe(NO_FAILURES)
    expect(reduceFailures(NO_FAILURES, { kind: 'dismissed' })).toBe(NO_FAILURES)
  })

  it('fails loudly on an event it does not know', () => {
    expect(() => reduceFailures(NO_FAILURES, { kind: 'other' } as never)).toThrow(/unhandled/u)
  })
})

describe('retryDelayMs', () => {
  it('doubles from one second and stops at thirty', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(retryDelayMs(-3)).toBe(1_000)
  })
})

/** A branch entry with the fields the search decisions read. */
const branch = (name: string, overrides: Partial<BranchEntry> = {}): BranchEntry => ({
  name,
  ref: `refs/heads/${name}`,
  kind: 'local',
  current: false,
  sha: 'abc1234',
  subject: '',
  author: 'T',
  committedAt: 0,
  ...overrides,
})

describe('enterAction', () => {
  const facts = { key: 'Enter', isComposing: false, keyCode: 13, busy: false, first: branch('main'), offersCreate: false, proposed: 'x' }

  it('switches to the first match on a plain Enter', () => {
    expect(enterAction(facts)).toEqual({ kind: 'checkout', branch: 'main' })
  })

  it('does nothing for the Enter that confirms an input-method candidate', () => {
    expect(enterAction({ ...facts, isComposing: true })).toEqual({ kind: 'none' })
    expect(enterAction({ ...facts, keyCode: 229 })).toEqual({ kind: 'none' })
  })

  it('does nothing while an operation is running', () => {
    expect(enterAction({ ...facts, busy: true })).toEqual({ kind: 'none' })
  })

  it('creates the proposed branch when nothing switchable matched, and ignores other keys', () => {
    expect(enterAction({ ...facts, first: undefined, offersCreate: true })).toEqual({ kind: 'create', branch: 'x' })
    expect(enterAction({ ...facts, first: branch('main', { current: true }) })).toEqual({ kind: 'none' })
    expect(enterAction({ ...facts, key: 'a' })).toEqual({ kind: 'none' })
  })
})

describe('branch search past the ceiling', () => {
  it('asks the Host only when the reading was cut and something is typed', () => {
    expect(needsHostSearch(true, 'log')).toBe(true)
    expect(needsHostSearch(true, '  ')).toBe(false)
    expect(needsHostSearch(false, 'log')).toBe(false)
  })

  it('appends the Host matches the held reading lacks, once, and only for the text they answer', () => {
    const held = [branch('login')]
    const found = [branch('login'), branch('feature/login-flow')]
    expect(mergeMatches(held, { kind: 'done', query: 'login', branches: found }, 'login').map(entry => entry.name))
      .toEqual(['login', 'feature/login-flow'])
    expect(mergeMatches(held, { kind: 'done', query: 'log', branches: found }, 'login')).toBe(held)
    expect(mergeMatches(held, { kind: 'pending', query: 'login' }, 'login')).toBe(held)
  })

  it('does not offer to create a branch until a truncated reading has been searched for that name', () => {
    const base = { typed: 'old-topic', proposed: 'old-topic', nameUsable: true, known: [], truncated: true }
    expect(mayOfferCreate({ ...base, search: { kind: 'pending', query: 'old-topic' } })).toBe(false)
    expect(mayOfferCreate({ ...base, search: { kind: 'failed', query: 'old-topic' } })).toBe(false)
    expect(mayOfferCreate({ ...base, search: { kind: 'done', query: 'old-topic', branches: [] } })).toBe(true)
    expect(mayOfferCreate({ ...base, known: [branch('old-topic')], search: { kind: 'done', query: 'old-topic', branches: [] } }))
      .toBe(false)
    expect(mayOfferCreate({ ...base, truncated: false, search: { kind: 'idle' } })).toBe(true)
    expect(mayOfferCreate({ ...base, nameUsable: false, truncated: false, search: { kind: 'idle' } })).toBe(false)
  })
})

/**
 * A settings scope that behaves like the installed one: writes run in order, the Host validates the
 * resolved section after each mutation, and a refused mutation reloads Host state and RESOLVES.
 */
function fakeScope(options: { atomic: boolean }): WritableScope & { stored: Record<string, unknown> } {
  const stored: Record<string, unknown> = { registerWorkspace: true, openSession: true, maxBranches: 200 }
  let tail = Promise.resolve()
  const apply = (ops: ReadonlyArray<{ path: string[]; value: unknown }>): Promise<void> => {
    const run = tail.then(() => {
      const next = { ...stored }
      for (const op of ops) next[op.path[0] ?? ''] = op.value
      // The Host's cross-field rule: a refused section is simply not stored.
      if (next['openSession'] === true && next['registerWorkspace'] === false) return
      Object.assign(stored, next)
    })
    tail = run
    return run
  }
  return {
    stored,
    getSnapshot: () => ({ value: { ...stored } }),
    set: (field, value) => apply([{ path: [field], value }]),
    ...options.atomic ? { mutate: (ops) => apply(ops) } : {},
  }
}

describe('registerWorkspaceWrites', () => {
  it('clears openSession before registerWorkspace, so every intermediate section is valid', () => {
    expect(registerWorkspaceWrites(false, true)).toEqual([['openSession', false], ['registerWorkspace', false]])
    expect(registerWorkspaceWrites(false, false)).toEqual([['registerWorkspace', false]])
    expect(registerWorkspaceWrites(true, false)).toEqual([['registerWorkspace', true]])
  })

  for (const atomic of [false, true]) {
    it(`turns both off through a ${atomic ? 'mutating' : 'field-by-field'} scope`, async () => {
      const scope = fakeScope({ atomic })
      await createFieldWriter(scope)(registerWorkspaceWrites(false, true))
      expect(scope.stored).toMatchObject({ registerWorkspace: false, openSession: false })
    })
  }

  it('reports the refusal the old order produced instead of resolving as if it had worked', async () => {
    const scope = fakeScope({ atomic: false })
    const write = createFieldWriter(scope)
    const wrongOrder = write([['registerWorkspace', false], ['openSession', false]])
    await expect(wrongOrder).rejects.toThrow(SettingsWriteRefused)
    // The half-landed state the finding described: registration still on, sessions off.
    expect(scope.stored).toMatchObject({ registerWorkspace: true, openSession: false })
    await expect(createFieldWriter(fakeScope({ atomic: true }))([['registerWorkspace', false]]))
      .rejects.toThrow(/registerWorkspace/u)
  })

  it('verifies a burst of writes once, at its last settlement', async () => {
    const scope = fakeScope({ atomic: true })
    const write = createFieldWriter(scope)
    const first = write([['maxBranches', 2]])
    const second = write([['maxBranches', 20]])
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(scope.stored['maxBranches']).toBe(20)
  })

  it('passes a transport failure through', async () => {
    const write = createFieldWriter({
      getSnapshot: () => ({ value: {} }),
      set: () => Promise.reject(new Error('socket closed')),
    })
    await expect(write([['showChip', false]])).rejects.toThrow('socket closed')
  })
})

describe('forgetLegacyIntents', () => {
  it('removes the stale record, and tolerates storage that is absent or refuses access', () => {
    const removed: string[] = []
    expect(forgetLegacyIntents({ removeItem: (key) => { removed.push(key) } })).toBe(true)
    expect(removed).toEqual([LEGACY_INTENTS_KEY])
    expect(forgetLegacyIntents(undefined)).toBe(true)
    expect(forgetLegacyIntents({ removeItem: () => { throw new Error('SecurityError') } })).toBe(false)
  })
})
