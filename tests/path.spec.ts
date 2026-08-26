import { describe, expect, it } from 'vitest'
import {
  abbreviatePath, basenameOf, expandPathTemplate, flattenBranch, isAbsolutePath, joinPath, parentOf,
} from '../src/shared/path.ts'

describe('isAbsolutePath', () => {
  it('accepts POSIX and UNC roots', () => {
    expect(isAbsolutePath('/a/b')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
  })

  it('accepts a drive only when a separator follows it', () => {
    expect(isAbsolutePath('C:/a')).toBe(true)
    expect(isAbsolutePath('C:\\a')).toBe(true)
    expect(isAbsolutePath('C:a')).toBe(false)
    expect(isAbsolutePath('C:')).toBe(false)
  })

  it('rejects relative paths', () => {
    expect(isAbsolutePath('a/b')).toBe(false)
    expect(isAbsolutePath('../a')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })
})

describe('basenameOf', () => {
  it('reads the last segment in either separator', () => {
    expect(basenameOf('/a/b/c')).toBe('c')
    expect(basenameOf('C:\\a\\b')).toBe('b')
  })

  it('ignores a trailing separator', () => {
    expect(basenameOf('/a/b/')).toBe('b')
  })

  it('answers the input for a root with no segments', () => {
    expect(basenameOf('/')).toBe('/')
  })
})

describe('parentOf', () => {
  it('drops the last segment', () => {
    expect(parentOf('/a/b/c')).toBe('/a/b')
    expect(parentOf('/a/b/c/')).toBe('/a/b')
  })

  it('keeps the POSIX root rather than emptying it', () => {
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/')).toBe('/')
  })

  it('keeps a Windows drive root together with its separator', () => {
    expect(parentOf('C:\\a')).toBe('C:\\')
    expect(parentOf('C:/a/b')).toBe('C:/a')
  })
})

describe('joinPath', () => {
  it('collapses separators between parts', () => {
    expect(joinPath('/a/', '/b/', 'c')).toBe('/a/b/c')
  })

  it('keeps a bare root joinable', () => {
    expect(joinPath('/', 'a')).toBe('/a')
  })

  it('drops empty parts', () => {
    expect(joinPath('/a', '', 'b')).toBe('/a/b')
  })

  it('answers the root alone when nothing follows it', () => {
    expect(joinPath('/a/')).toBe('/a')
    expect(joinPath()).toBe('')
  })
})

describe('flattenBranch', () => {
  it('folds every separator run into one dash', () => {
    expect(flattenBranch('feature/login')).toBe('feature-login')
    expect(flattenBranch('a//b')).toBe('a-b')
  })

  it('leaves a name without separators alone', () => {
    expect(flattenBranch('main')).toBe('main')
  })
})

describe('expandPathTemplate', () => {
  const vars = {
    repoRoot: '/home/dev/app',
    repoParent: '/home/dev',
    repo: 'app',
    branch: 'feature-login',
    branchPath: 'feature/login',
  }

  it('expands every placeholder', () => {
    expect(expandPathTemplate('{repoParent}/{repo}-worktrees/{branch}', vars))
      .toBe('/home/dev/app-worktrees/feature-login')
  })

  it('lets branchPath nest a namespaced branch', () => {
    expect(expandPathTemplate('{repoParent}/wt/{branchPath}', vars)).toBe('/home/dev/wt/feature/login')
  })

  it('resolves a relative result against the repository root', () => {
    expect(expandPathTemplate('../trees/{branch}', vars)).toBe('/home/dev/app/../trees/feature-login')
  })

  it('leaves an unknown placeholder in place', () => {
    expect(expandPathTemplate('/tmp/{nope}/{branch}', vars)).toBe('/tmp/{nope}/feature-login')
  })
})

describe('abbreviatePath', () => {
  it('collapses a leading home directory', () => {
    expect(abbreviatePath('/home/dev/app', '/home/dev')).toBe('~/app')
    expect(abbreviatePath('/home/dev', '/home/dev')).toBe('~')
  })

  it('leaves a merely prefix-shaped match alone', () => {
    expect(abbreviatePath('/home/devil/app', '/home/dev')).toBe('/home/devil/app')
  })

  it('leaves the path alone without a home to collapse', () => {
    expect(abbreviatePath('/home/dev/app', undefined)).toBe('/home/dev/app')
    expect(abbreviatePath('/home/dev/app', '')).toBe('/home/dev/app')
  })
})
