/**
 * The operations layer against real temporary repositories.
 *
 * Every case here is about what a repository looks like AFTER a request — which branches survive,
 * whether a file was deleted, whether a program ran — because each finding these specs pin was a
 * request that built a plausible argument list and did the wrong thing to the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commitFile, discard, git, harness, initRepository, scratch,
} from './support/git-host.ts'

let root: string
let repo: string

beforeEach(() => {
  root = scratch('ops')
  repo = initRepository(root)
})

afterEach(() => { discard(root) })

/** Local branch names, sorted. */
const branches = (cwd: string): string[] =>
  git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort()

describe('option-shaped branch names never reach git', () => {
  it('refuses a rename onto a name git would read as an option, leaving both branches intact', async () => {
    git(repo, 'branch', 'feature')
    const { operations } = harness()
    const result = await operations.renameBranch({ workspacePath: repo, branch: 'feature', name: '-f' })
    expect(result).toMatchObject({ ok: false, code: 'invalid-request' })
    // `git branch -m feature -f` would have force-renamed the CURRENT branch over `feature`.
    expect(branches(repo)).toEqual(['feature', 'main'])
  })

  it('refuses to create a branch called -D, which `git branch -D main` would have deleted main with', async () => {
    git(repo, 'branch', 'other')
    git(repo, 'switch', '--quiet', 'other')
    const { operations } = harness()
    const result = await operations.createBranch({
      workspacePath: repo, branch: '-D', startPoint: 'main', checkout: false,
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(branches(repo)).toEqual(['main', 'other'])
  })

  it('refuses option-shaped values on every endpoint that names a branch or a commit', async () => {
    const { operations } = harness()
    const base = { workspacePath: repo }
    const outcomes = await Promise.all([
      operations.checkout({ ...base, branch: '--orphan', carryChanges: false }),
      operations.deleteBranch({ ...base, branch: '-D', force: false }),
      operations.renameBranch({ ...base, branch: '-m', name: 'x' }),
      operations.createBranch({ ...base, branch: 'ok', startPoint: '--all', checkout: false }),
      operations.addWorktree({ ...base, branch: '-b', createBranch: true, detach: false, path: join(root, 'wt-a') }),
      operations.addWorktree({ ...base, branch: 'x', createBranch: false, detach: true, startPoint: '-q', path: join(root, 'wt-b') }),
    ])
    for (const outcome of outcomes) expect(outcome).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(branches(repo)).toEqual(['main'])
  })

  it('still creates, renames, switches to, and deletes an ordinary branch', async () => {
    const { operations } = harness()
    const base = { workspacePath: repo }
    expect(await operations.createBranch({ ...base, branch: 'a-b', startPoint: 'main', checkout: false }))
      .toMatchObject({ ok: true })
    expect(await operations.renameBranch({ ...base, branch: 'a-b', name: 'feature/a-b' })).toMatchObject({ ok: true })
    expect(await operations.checkout({ ...base, branch: 'feature/a-b', carryChanges: false })).toMatchObject({ ok: true })
    expect(git(repo, 'branch', '--show-current')).toBe('feature/a-b')
    expect(await operations.checkout({ ...base, branch: 'main', carryChanges: false })).toMatchObject({ ok: true })
    expect(await operations.deleteBranch({ ...base, branch: 'feature/a-b', force: false })).toMatchObject({ ok: true })
    expect(branches(repo)).toEqual(['main'])
  })
})

describe('automatic readings run no program the repository configures', () => {
  /**
   * A script that records that it ran, and then behaves like the program it replaces.
   * @param name - file name under the scratch root.
   * @param body - shell to run after recording.
   * @returns the script path and the marker it writes.
   */
  const tripwire = (name: string, body: string): { script: string; marker: string } => {
    const marker = join(root, `${name}.ran`)
    const script = join(root, `${name}.sh`)
    writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\n${body}\n`)
    chmodSync(script, 0o755)
    return { script, marker }
  }

  it('does not execute core.fsmonitor or a filter driver while reading, even for a racily clean file', async () => {
    const fsmonitor = tripwire('fsmonitor', 'exit 0')
    const clean = tripwire('clean', 'cat')
    const processFilter = tripwire('process', 'exit 1')
    writeFileSync(join(repo, '.gitattributes'), 'a.txt filter=evil\nb.txt filter=long\n')
    writeFileSync(join(repo, 'a.txt'), 'same\n')
    writeFileSync(join(repo, 'b.txt'), 'same\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'attributes')
    git(repo, 'config', 'core.fsmonitor', fsmonitor.script)
    git(repo, 'config', 'filter.evil.clean', clean.script)
    git(repo, 'config', 'filter.long.process', processFilter.script)
    // Same size, new mtime: git must re-read the content to decide, which is when a filter runs.
    writeFileSync(join(repo, 'a.txt'), 'same\n')
    writeFileSync(join(repo, 'b.txt'), 'same\n')

    const { operations } = harness()
    const first = await operations.overview({ workspacePath: repo })
    const second = await operations.overview({ workspacePath: repo })
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })
    expect(existsSync(fsmonitor.marker)).toBe(false)
    expect(existsSync(clean.marker)).toBe(false)
    expect(existsSync(processFilter.marker)).toBe(false)

    // The control: the fixture is live, so an unguarded `git status` runs them — and fails, because
    // the process tripwire exits without speaking the filter protocol.
    expect(() => git(repo, 'status', '--porcelain')).toThrow()
    expect(existsSync(fsmonitor.marker)).toBe(true)
    expect(existsSync(processFilter.marker) || existsSync(clean.marker)).toBe(true)
  })

  it('does not execute a filter driver configured inside a submodule', async () => {
    const clean = tripwire('sub-clean', 'cat')
    const upstream = initRepository(root, 'upstream')
    writeFileSync(join(upstream, '.gitattributes'), 'a.txt filter=evil\n')
    writeFileSync(join(upstream, 'a.txt'), 'same\n')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '--quiet', '-m', 'attributes')
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', upstream, 'sub')
    git(repo, 'commit', '--quiet', '-m', 'submodule')
    git(join(repo, 'sub'), 'config', 'filter.evil.clean', clean.script)
    writeFileSync(join(repo, 'sub', 'a.txt'), 'same\n')

    const { operations } = harness()
    expect(await operations.overview({ workspacePath: repo })).toMatchObject({ ok: true })
    expect(existsSync(clean.marker)).toBe(false)
  })

  it('does not execute a filter driver set in per-worktree config of a linked worktree', async () => {
    const clean = tripwire('wt-clean', 'cat')
    writeFileSync(join(repo, '.gitattributes'), 'a.txt filter=evil\n')
    writeFileSync(join(repo, 'a.txt'), 'same\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'attributes')
    const linked = join(root, 'linked')
    git(repo, 'worktree', 'add', '--quiet', '-b', 'linked', linked)
    git(repo, 'config', 'extensions.worktreeConfig', 'true')
    git(linked, 'config', '--worktree', 'filter.evil.clean', clean.script)
    writeFileSync(join(linked, 'a.txt'), 'same\n')

    const { operations } = harness()
    expect(await operations.overview({ workspacePath: linked })).toMatchObject({ ok: true })
    expect(await operations.inspectWorktree({ workspacePath: repo, path: linked })).toMatchObject({ ok: true })
    expect(existsSync(clean.marker)).toBe(false)
  })

  it('refuses to read a repository whose filter driver name cannot be neutralised', async () => {
    git(repo, 'config', 'filter.a=b.clean', 'true')
    const { operations } = harness()
    expect(await operations.overview({ workspacePath: repo })).toMatchObject({ ok: false, code: 'refused' })
  })

  it('still counts changes in the repository itself', async () => {
    writeFileSync(join(repo, 'README.md'), 'changed\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    const { operations } = harness()
    const result = await operations.overview({ workspacePath: repo })
    expect(result).toMatchObject({ ok: true, repo: { dirty: { unstaged: 1, untracked: 1 } } })
  })
})

describe('removing a worktree', () => {
  const addWorktree = (branch: string): string => {
    const path = join(root, `wt-${branch}`)
    git(repo, 'worktree', 'add', '--quiet', '-b', branch, path)
    return path
  }

  it('reports the ignored and untracked files a removal would delete', async () => {
    writeFileSync(join(repo, '.gitignore'), '.env\nbuild/\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '--quiet', '-m', 'ignore')
    const path = addWorktree('topic')
    writeFileSync(join(path, '.env'), 'SECRET=1\n')
    mkdirSync(join(path, 'build'))
    writeFileSync(join(path, 'build', 'out.js'), '1\n')
    writeFileSync(join(path, 'notes.txt'), 'untracked\n')

    const { operations } = harness()
    const report = await operations.inspectWorktree({ workspacePath: repo, path })
    expect(report).toMatchObject({ ok: true, ignored: 2, untracked: 1, modified: 0 })
    expect(report.ok && [...report.ignoredPaths].sort()).toEqual(['.env', 'build/'])
  })

  it('refuses to delete ignored files unless the request says to, and removes the worktree when it does', async () => {
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '--quiet', '-m', 'ignore')
    const path = addWorktree('topic')
    writeFileSync(join(path, '.env'), 'SECRET=1\n')

    const { operations } = harness()
    const refused = await operations.removeWorktree({ workspacePath: repo, path, force: false })
    expect(refused).toMatchObject({ ok: false, code: 'refused' })
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n')

    const removed = await operations.removeWorktree({ workspacePath: repo, path, force: false, discardIgnored: true })
    expect(removed).toMatchObject({ ok: true })
    expect(existsSync(path)).toBe(false)
  })

  it('removes a clean worktree without any acknowledgement', async () => {
    const path = addWorktree('topic')
    const { operations } = harness()
    expect(await operations.removeWorktree({ workspacePath: repo, path, force: false })).toMatchObject({ ok: true })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses to remove the worktree the request itself is working in', async () => {
    const path = addWorktree('topic')
    const { operations } = harness()
    const result = await operations.removeWorktree({ workspacePath: path, path, force: true, discardIgnored: true })
    expect(result).toMatchObject({ ok: false, code: 'refused' })
    expect(existsSync(path)).toBe(true)
  })
})

describe('branch listing past the ceiling', () => {
  /** Give the repository an `origin` whose HEAD symref points at its newest branch. */
  const withOrigin = (): void => {
    const origin = join(root, 'origin.git')
    git(root, 'clone', '--quiet', '--bare', repo, origin)
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'fetch', '--quiet', 'origin')
    git(repo, 'remote', 'set-head', 'origin', 'main')
  }

  it('reports truncation even when the symbolic origin/HEAD took one of the counted slots', async () => {
    withOrigin()
    // Newest first: main and origin/main share the newest date, origin/HEAD sorts beside them.
    git(repo, 'branch', 'older-1', 'main')
    git(repo, 'branch', 'older-2', 'main')
    const { operations } = harness({ maxBranches: 3 })
    const result = await operations.overview({ workspacePath: repo })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Four real branches (main, older-1, older-2, origin/main) and a ceiling of three.
    expect(result.branches).toHaveLength(3)
    expect(result.branchesTruncated).toBe(true)
  })

  it('does not report truncation when everything fit', async () => {
    withOrigin()
    const { operations } = harness({ maxBranches: 3 })
    const result = await operations.overview({ workspacePath: repo })
    expect(result).toMatchObject({ ok: true, branchesTruncated: false })
  })

  it('finds a branch the capped reading left out by searching for it', async () => {
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) git(repo, 'branch', name)
    git(repo, 'branch', 'feature/Login-flow')
    const { operations } = harness({ maxBranches: 2 })
    const overview = await operations.overview({ workspacePath: repo })
    expect(overview.ok && overview.branches.some(entry => entry.name === 'feature/Login-flow')).toBe(false)

    const found = await operations.searchBranches({ workspacePath: repo, query: 'login' })
    expect(found).toMatchObject({ ok: true, truncated: false })
    expect(found.ok && found.branches.map(entry => entry.name)).toEqual(['feature/Login-flow'])
  })

  it('treats glob characters in a search as text rather than as a pattern', async () => {
    git(repo, 'branch', 'feature')
    const { operations } = harness()
    const found = await operations.searchBranches({ workspacePath: repo, query: '*' })
    expect(found).toMatchObject({ ok: true, branches: [] })
  })
})

describe('deleting a branch only while it is still where it was created', () => {
  it('deletes an unmerged branch whose tip is unchanged, where a plain delete is refused', async () => {
    git(repo, 'switch', '--quiet', '--create', 'develop')
    commitFile(repo, 'develop.txt', 'unmerged\n')
    git(repo, 'switch', '--quiet', 'main')
    const { operations } = harness()
    const created = await operations.addWorktree({
      workspacePath: repo, branch: 'gate-x', createBranch: true, startPoint: 'develop', detach: false,
      path: join(root, 'wt-gate'),
    })
    expect(created).toMatchObject({ ok: true, sha: git(repo, 'rev-parse', 'develop') })
    if (!created.ok) return
    expect(await operations.removeWorktree({ workspacePath: repo, path: created.path, force: false }))
      .toMatchObject({ ok: true })

    // The finding: `-d` refuses because develop is not merged into HEAD, leaving the branch behind.
    expect(await operations.deleteBranch({ workspacePath: repo, branch: 'gate-x', force: false }))
      .toMatchObject({ ok: false, code: 'refused' })
    const deleted = await operations.deleteBranch({
      workspacePath: repo, branch: 'gate-x', force: false, expectedTip: created.sha ?? '',
    })
    expect(deleted).toMatchObject({ ok: true })
    expect(branches(repo)).toEqual(['develop', 'main'])
  })

  it('keeps a branch that gained a commit since, and refuses a tip that is not an object name', async () => {
    const { operations } = harness()
    const path = join(root, 'wt-moved')
    const created = await operations.addWorktree({
      workspacePath: repo, branch: 'moved', createBranch: true, detach: false, path,
    })
    if (!created.ok) throw new Error(created.message)
    commitFile(path, 'work.txt', 'work\n')
    git(repo, 'worktree', 'remove', path)

    expect(await operations.deleteBranch({
      workspacePath: repo, branch: 'moved', force: false, expectedTip: created.sha ?? '',
    })).toMatchObject({ ok: false, code: 'refused' })
    expect(await operations.deleteBranch({
      workspacePath: repo, branch: 'moved', force: false, expectedTip: 'main',
    })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(branches(repo)).toEqual(['main', 'moved'])
  })
})

describe('the version probe', () => {
  it('reads the version again after a cancelled probe instead of caching the failure', async () => {
    const { git: client } = harness()
    const aborted = new AbortController()
    aborted.abort()
    await client.describe(repo, aborted.signal)
    expect(client.supportsNulListing()).toBe(false)

    const state = await client.describe(repo)
    expect(state.version).toMatch(/^git version/u)
    expect(client.supportsNulListing()).toBe(true)
  })

  it('reads the version again after a probe that timed out', async () => {
    let calls = 0
    const { git: client } = harness({}, {
      intercept: (argv) => {
        if (argv[1] !== '--version') return undefined
        calls += 1
        // A killed process: no exit code, which is what the timeout escalation leaves behind.
        return calls === 1 ? { exitCode: null } : undefined
      },
    })
    await client.describe(repo)
    expect(client.supportsNulListing()).toBe(false)
    await client.describe(repo)
    expect(calls).toBe(2)
    expect(client.supportsNulListing()).toBe(true)
  })
})
