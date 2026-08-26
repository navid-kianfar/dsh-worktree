/**
 * The failure classifier reads git's own English, so every message here is one git actually prints.
 * A classification that drifts turns an actionable refusal into a generic error, which is exactly
 * the failure mode this file exists to catch.
 */
import { describe, expect, it } from 'vitest'
import { classify, fail, stderrLine } from '../src/host/git.ts'
import type { CommandOutcome } from '../src/host/run.ts'

/** A finished command; every case overrides only the fields it is about. */
const outcome = (overrides: Partial<CommandOutcome> = {}): CommandOutcome => ({
  exitCode: 1,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  ...overrides,
})

describe('fail', () => {
  it('composes the failure value every endpoint returns', () => {
    expect(fail('not-found', 'no such branch')).toEqual({
      ok: false, code: 'not-found', message: 'no such branch',
    })
  })
})

describe('stderrLine', () => {
  it('takes the first meaningful line and strips git\'s severity prefix', () => {
    expect(stderrLine(outcome({ stderr: "fatal: invalid reference: nope\n" }))).toBe('invalid reference: nope')
    expect(stderrLine(outcome({ stderr: "error: branch 'x' not found.\n" }))).toBe("branch 'x' not found.")
  })

  it('falls back to stdout when git said nothing on stderr', () => {
    expect(stderrLine(outcome({ stdout: 'Removing worktrees/x\n' }))).toBe('Removing worktrees/x')
  })

  it('names the exit code when git printed nothing at all', () => {
    expect(stderrLine(outcome({ exitCode: 128 }))).toBe('git exited with code 128')
  })
})

describe('classify', () => {
  it('reports a timeout and a cancellation before reading any output', () => {
    expect(classify(outcome({ timedOut: true, stderr: 'fatal: not a git repository' })).code).toBe('timeout')
    expect(classify(outcome({ aborted: true, stderr: 'fatal: not a git repository' })).code).toBe('cancelled')
  })

  it('reports a directory outside any repository', () => {
    const failure = classify(outcome({
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    }))
    expect(failure.code).toBe('not-a-repository')
  })

  it('reports the repository states git refuses from', () => {
    const messages = [
      "fatal: 'feature/login' is already checked out at '/tmp/wt'",
      "fatal: '/tmp/wt' is already used by worktree at '/tmp/wt'",
      "fatal: a branch named 'x' already exists",
      'error: Your local changes to the following files would be overwritten by checkout:',
      "error: the branch 'x' is not fully merged",
      "fatal: '/tmp/wt' contains modified or untracked files, use --force to delete it",
      "fatal: '/tmp/wt' is locked; use 'git worktree unlock'",
    ]
    for (const message of messages) {
      expect(classify(outcome({ stderr: message })).code, message).toBe('refused')
    }
  })

  it('reports what the repository does not have', () => {
    const messages = [
      'fatal: invalid reference: nope',
      "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.",
      "fatal: '/tmp/nope' is not a working tree",
      "error: couldn't find remote ref refs/heads/nope",
    ]
    for (const message of messages) {
      expect(classify(outcome({ stderr: message })).code, message).toBe('not-found')
    }
  })

  it('prefers the refusal reading when a message could be read either way', () => {
    // git 2.x phrases this one with both a state and an absence in the same line; the state is the
    // actionable half, so it must win.
    const failure = classify(outcome({
      stderr: "fatal: 'x' is already checked out at '/tmp/wt' and was not found here",
    }))
    expect(failure.code).toBe('refused')
  })

  it('falls back to the generic class with git\'s own line attached', () => {
    const failure = classify(outcome({ stderr: 'fatal: unable to write new index file' }))
    expect(failure).toEqual({
      ok: false, code: 'git-failed', message: 'unable to write new index file',
    })
  })
})
