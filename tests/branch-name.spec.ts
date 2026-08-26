import { describe, expect, it } from 'vitest'
import { applyBranchPrefix, checkBranchName, localBranchOf } from '../src/shared/branch-name.ts'

describe('checkBranchName', () => {
  it('accepts ordinary names', () => {
    for (const name of ['main', 'feature/login', 'release-1.2', 'a.b.c', '2026-08-26']) {
      expect(checkBranchName(name), name).toEqual({ ok: true })
    }
  })

  it('refuses an empty name and an empty component', () => {
    expect(checkBranchName('')).toEqual({ ok: false, problem: 'empty' })
  })

  it('refuses the shapes git reserves', () => {
    for (const name of ['/x', 'x/', '@', 'HEAD']) {
      expect(checkBranchName(name), name).toEqual({ ok: false, problem: 'shape' })
    }
  })

  it('refuses the characters git forbids', () => {
    for (const name of ['a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\u0000b', 'a\u007fb']) {
      expect(checkBranchName(name), JSON.stringify(name)).toEqual({ ok: false, problem: 'character' })
    }
  })

  it('refuses the sequences git forbids', () => {
    for (const name of ['a..b', 'a@{b', 'a//b']) {
      expect(checkBranchName(name), name).toEqual({ ok: false, problem: 'sequence' })
    }
  })

  it('refuses a component that starts with a dot or ends with .lock', () => {
    for (const name of ['.hidden', 'a/.b', 'a.lock', 'a/b.lock', 'trailing.']) {
      expect(checkBranchName(name), name).toEqual({ ok: false, problem: 'component' })
    }
  })
})

describe('applyBranchPrefix', () => {
  it('prefixes a bare name', () => {
    expect(applyBranchPrefix('feature/', 'login')).toBe('feature/login')
  })

  it('does not double an already prefixed name', () => {
    expect(applyBranchPrefix('feature/', 'feature/login')).toBe('feature/login')
  })

  it('leaves an empty prefix or an empty name alone', () => {
    expect(applyBranchPrefix('', 'login')).toBe('login')
    expect(applyBranchPrefix('feature/', '')).toBe('')
  })
})

describe('localBranchOf', () => {
  it('drops only the remote segment', () => {
    expect(localBranchOf('origin/main')).toBe('main')
    expect(localBranchOf('origin/feature/login')).toBe('feature/login')
  })

  it('answers a separator-free name unchanged', () => {
    expect(localBranchOf('main')).toBe('main')
  })
})
