/**
 * Every fixture here is real output, captured from git 2.50 against a scratch repository built for
 * the case it covers — a rename, a locked worktree, a gone upstream. A parser tested against
 * hand-written strings only proves it reads what its author imagined git prints.
 */
import { describe, expect, it } from 'vitest'
import {
  FIELD_SEPARATOR, IGNORED_SAMPLE, RECORD_SEPARATOR, branchWorktreeIndex, countBranchRecords,
  parseBranches, parseContents, parseFilterDrivers, parseStatus, parseTracking, parseWorktrees,
  worktreeConfigEnabled,
} from '../src/host/parse.ts'

/** Assemble one `for-each-ref` record the way `BRANCH_FORMAT` writes it. */
const record = (...fields: readonly string[]): string =>
  `${fields.join(FIELD_SEPARATOR)}${RECORD_SEPARATOR}\n`

describe('parseTracking', () => {
  it('answers undefined for a branch that tracks nothing', () => {
    expect(parseTracking('', '')).toBeUndefined()
  })

  it('reads a level upstream as zero on both counters', () => {
    expect(parseTracking('origin/main', '')).toEqual({
      upstream: 'origin/main', ahead: 0, behind: 0, gone: false,
    })
  })

  it('reads both counters from a diverged summary', () => {
    expect(parseTracking('origin/main', 'ahead 2, behind 1')).toEqual({
      upstream: 'origin/main', ahead: 2, behind: 1, gone: false,
    })
  })

  it('reads each counter alone', () => {
    expect(parseTracking('origin/main', 'ahead 3')).toMatchObject({ ahead: 3, behind: 0 })
    expect(parseTracking('origin/main', 'behind 4')).toMatchObject({ ahead: 0, behind: 4 })
  })

  it('reads a deleted upstream', () => {
    expect(parseTracking('origin/old', 'gone')).toMatchObject({ gone: true })
  })
})

describe('parseBranches', () => {
  const stdout = record(
    'refs/heads/feature/login', 'feature/login', '6586b6c', '', '', '1787720092', 'T', ' ', '',
    'first commit',
  ) + record(
    'refs/heads/main', 'main', '6586b6c', 'origin/main', 'ahead 1', '1787720092', 'T', '*', '',
    'first commit',
  ) + record(
    'refs/remotes/origin/HEAD', 'origin/HEAD', '6586b6c', '', '', '1787720092', 'T', ' ',
    'refs/remotes/origin/main', '',
  ) + record(
    'refs/remotes/origin/main', 'origin/main', '6586b6c', '', '', '1787720092', 'T', ' ', '',
    'first commit',
  )

  it('reads every real branch and drops the symbolic ref', () => {
    const entries = parseBranches(stdout, new Map())
    expect(entries.map(entry => entry.name)).toEqual(['feature/login', 'main', 'origin/main'])
  })

  it('classifies local against remote by the full ref', () => {
    const entries = parseBranches(stdout, new Map())
    expect(entries.map(entry => entry.kind)).toEqual(['local', 'local', 'remote'])
  })

  it('marks the branch HEAD points at', () => {
    const entries = parseBranches(stdout, new Map())
    expect(entries.filter(entry => entry.current).map(entry => entry.name)).toEqual(['main'])
  })

  it('carries tracking, subject, author, and the committer time in milliseconds', () => {
    const main = parseBranches(stdout, new Map()).find(entry => entry.name === 'main')
    expect(main).toMatchObject({
      sha: '6586b6c',
      subject: 'first commit',
      author: 'T',
      committedAt: 1_787_720_092_000,
      tracking: { upstream: 'origin/main', ahead: 1, behind: 0, gone: false },
    })
  })

  it('leaves tracking absent for a branch with no upstream', () => {
    const entry = parseBranches(stdout, new Map()).find(item => item.name === 'feature/login')
    expect(entry).not.toHaveProperty('tracking')
  })

  it('attaches the worktree holding each branch', () => {
    const index = new Map([['feature/login', '/tmp/wt-login']])
    const entries = parseBranches(stdout, index)
    expect(entries.find(entry => entry.name === 'feature/login')?.checkedOutAt).toBe('/tmp/wt-login')
    expect(entries.find(entry => entry.name === 'main')).not.toHaveProperty('checkedOutAt')
  })

  it('rejoins a subject that happened to contain the field separator', () => {
    const odd = record(
      'refs/heads/x', 'x', 'abc1234', '', '', '1787720092', 'T', ' ', '',
      `left${FIELD_SEPARATOR}right`,
    )
    expect(parseBranches(odd, new Map())[0]?.subject).toBe(`left${FIELD_SEPARATOR}right`)
  })

  it('answers an empty list for empty output', () => {
    expect(parseBranches('', new Map())).toEqual([])
  })
})

describe('parseWorktrees', () => {
  // Captured from `git worktree list --porcelain -z` with the second worktree locked.
  const zOutput = [
    'worktree /private/tmp/wtfix/repo', 'HEAD 6586b6ccc8fcbd895671e05ae84a96f3dfd51fea',
    'branch refs/heads/main', '',
    'worktree /private/tmp/wtfix/wt-login', 'HEAD 6586b6ccc8fcbd895671e05ae84a96f3dfd51fea',
    'branch refs/heads/feature/login', 'locked held for review', '',
  ].join('\0')

  it('reads both worktrees, main first', () => {
    const entries = parseWorktrees(zOutput, '\0', '/private/tmp/wtfix/repo')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      path: '/private/tmp/wtfix/repo',
      sha: '6586b6c',
      branch: 'main',
      main: true,
      current: true,
      locked: false,
      prunable: false,
    })
  })

  it('reads the lock and its reason', () => {
    const entries = parseWorktrees(zOutput, '\0', '/private/tmp/wtfix/repo')
    expect(entries[1]).toMatchObject({
      path: '/private/tmp/wtfix/wt-login',
      branch: 'feature/login',
      locked: true,
      lockReason: 'held for review',
      main: false,
      current: false,
    })
  })

  it('reads the newline-separated form identically', () => {
    const plain = zOutput.replaceAll('\0', '\n')
    expect(parseWorktrees(plain, '\n', '/private/tmp/wtfix/repo'))
      .toEqual(parseWorktrees(zOutput, '\0', '/private/tmp/wtfix/repo'))
  })

  it('reads the valueless attributes and a prunable reason', () => {
    const output = [
      'worktree /repo', 'bare', '',
      'worktree /gone', 'HEAD 6586b6ccc8fcbd895671e05ae84a96f3dfd51fea', 'detached',
      'prunable gitdir file points to non-existent location', '',
    ].join('\0')
    const entries = parseWorktrees(output, '\0', '/repo')
    expect(entries[0]).toMatchObject({ bare: true, main: true })
    expect(entries[0]).not.toHaveProperty('branch')
    expect(entries[1]).toMatchObject({
      detached: true,
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    })
  })

  it('ignores an attribute it does not know', () => {
    const output = ['worktree /repo', 'HEAD abc', 'somethingNew value', ''].join('\0')
    expect(parseWorktrees(output, '\0', '/repo')).toHaveLength(1)
  })

  it('answers an empty list for empty output', () => {
    expect(parseWorktrees('', '\0', '/repo')).toEqual([])
  })
})

describe('branchWorktreeIndex', () => {
  it('maps each checked-out branch to its worktree', () => {
    const index = branchWorktreeIndex(parseWorktrees(
      ['worktree /repo', 'branch refs/heads/main', '',
        'worktree /wt', 'branch refs/heads/feature/login', ''].join('\0'),
      '\0',
      '/repo',
    ))
    expect([...index]).toEqual([['main', '/repo'], ['feature/login', '/wt']])
  })

  it('skips a detached worktree, which holds no branch', () => {
    const index = branchWorktreeIndex(parseWorktrees(
      ['worktree /repo', 'HEAD abc', 'detached', ''].join('\0'), '\0', '/repo',
    ))
    expect(index.size).toBe(0)
  })
})

describe('parseStatus', () => {
  // Captured from `git status --porcelain=v2 --branch --untracked-files=normal -z`.
  const staged = [
    '# branch.oid 6586b6ccc8fcbd895671e05ae84a96f3dfd51fea',
    '# branch.head main',
    '1 MM N... 100644 100644 100644 7898192 422c2b7 a.txt',
    '? untracked.txt',
    '',
  ].join('\0')

  it('reads HEAD and the counts', () => {
    const reading = parseStatus(staged)
    expect(reading.header).toEqual({ branch: 'main', sha: '6586b6ccc8', detached: false, unborn: false })
    expect(reading.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicted: 0 })
  })

  it('counts a rename once and does not read its original path as a record', () => {
    const renamed = [
      '# branch.oid 6586b6ccc8fcbd895671e05ae84a96f3dfd51fea',
      '# branch.head main',
      '2 RM N... 100644 100644 100644 7898192 422c2b7 R50 renamed.txt',
      'a.txt',
      '? untracked.txt',
      '',
    ].join('\0')
    expect(parseStatus(renamed).dirty).toEqual({
      staged: 1, unstaged: 1, untracked: 1, conflicted: 0,
    })
  })

  it('counts an unmerged path as conflicted only', () => {
    const conflicted = [
      '# branch.head main',
      '1 M. N... 100644 100644 100644 7898192 422c2b7 clean.txt',
      'u UU N... 100644 100644 100644 100644 a b c d both.txt',
      '',
    ].join('\0')
    expect(parseStatus(conflicted).dirty).toEqual({
      staged: 1, unstaged: 0, untracked: 0, conflicted: 1,
    })
  })

  it('ignores an ignored path', () => {
    const ignored = ['# branch.head main', '! build/', ''].join('\0')
    expect(parseStatus(ignored).dirty.untracked).toBe(0)
  })

  it('reads a detached HEAD', () => {
    const detached = [
      '# branch.oid 6586b6ccc8fcbd895671e05ae84a96f3dfd51fea', '# branch.head (detached)', '',
    ].join('\0')
    expect(parseStatus(detached).header).toMatchObject({ detached: true, unborn: false })
    expect(parseStatus(detached).header).not.toHaveProperty('branch')
  })

  it('reads an unborn branch', () => {
    const unborn = ['# branch.oid (initial)', '# branch.head main', ''].join('\0')
    expect(parseStatus(unborn).header).toMatchObject({ branch: 'main', unborn: true })
    expect(parseStatus(unborn).header).not.toHaveProperty('sha')
  })

  it('reads the ahead/behind counters', () => {
    const tracked = [
      '# branch.oid 6586b6ccc8fcbd895671e05ae84a96f3dfd51fea',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '',
    ].join('\0')
    expect(parseStatus(tracked).header.tracking).toEqual({
      upstream: 'origin/main', ahead: 2, behind: 1, gone: false,
    })
  })

  it('reads a named upstream with no counters as gone', () => {
    const gone = [
      '# branch.head main', '# branch.upstream origin/old', '',
    ].join('\0')
    expect(parseStatus(gone).header.tracking).toEqual({
      upstream: 'origin/old', ahead: 0, behind: 0, gone: true,
    })
  })

  it('reads a level upstream as present and not gone', () => {
    const level = [
      '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0', '',
    ].join('\0')
    expect(parseStatus(level).header.tracking).toMatchObject({ ahead: 0, behind: 0, gone: false })
  })

  it('reads a clean repository', () => {
    const clean = ['# branch.oid abc', '# branch.head main', ''].join('\0')
    expect(parseStatus(clean).dirty).toEqual({
      staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
    })
  })
})

describe('countBranchRecords', () => {
  it('counts the symbolic refs parseBranches drops, which is what --count counted', () => {
    const stdout = record('refs/heads/main', 'main', 'a', '', '', '1', 'T', '*', '', 's')
      + record('refs/remotes/origin/HEAD', 'origin/HEAD', 'a', '', '', '1', 'T', ' ', 'refs/remotes/origin/main', '')
    expect(countBranchRecords(stdout)).toBe(2)
    expect(parseBranches(stdout, new Map())).toHaveLength(1)
    expect(countBranchRecords('')).toBe(0)
  })
})

describe('parseFilterDrivers', () => {
  it('reads each driver name once, keeping its case and any dots inside it', () => {
    // `git config --null --get-regexp` output: `<key>\n<value>\0`.
    const stdout = 'filter.Evil.clean\n/tmp/x\0filter.Evil.process\n/tmp/y\0filter.a.b.clean\ncat\0'
      + 'extensions.worktreeconfig\ntrue\0'
    expect(parseFilterDrivers(stdout)).toEqual(['Evil', 'a.b'])
  })

  it('answers none for empty output', () => {
    expect(parseFilterDrivers('')).toEqual([])
  })
})

describe('worktreeConfigEnabled', () => {
  it('reads git booleans, a valueless key as true, and the last value as the one in force', () => {
    expect(worktreeConfigEnabled('extensions.worktreeconfig\ntrue\0')).toBe(true)
    expect(worktreeConfigEnabled('extensions.worktreeconfig\0')).toBe(true)
    expect(worktreeConfigEnabled('extensions.worktreeconfig\nYes\0')).toBe(true)
    expect(worktreeConfigEnabled('extensions.worktreeconfig\ntrue\0extensions.worktreeconfig\nfalse\0')).toBe(false)
    expect(worktreeConfigEnabled('filter.x.clean\ncat\0')).toBe(false)
  })
})

describe('parseContents', () => {
  it('counts modified, untracked, and ignored entries, and names the ignored ones', () => {
    const stdout = [
      '1 .M N... 100644 100644 100644 abc abc README.md',
      '2 R. N... 100644 100644 100644 abc abc R100 new.md',
      'old.md',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? notes.txt',
      '! .env',
      '! build/',
      '',
    ].join('\0')
    expect(parseContents(stdout)).toEqual({
      modified: 3, untracked: 1, ignored: 2, ignoredPaths: ['.env', 'build/'],
    })
  })

  it('keeps counting ignored entries past the sample it names', () => {
    const stdout = Array.from({ length: IGNORED_SAMPLE + 5 }, (_, index) => `! f${String(index)}`).join('\0')
    const reading = parseContents(stdout)
    expect(reading.ignored).toBe(IGNORED_SAMPLE + 5)
    expect(reading.ignoredPaths).toHaveLength(IGNORED_SAMPLE)
  })
})
