/**
 * A Host context backed by the real filesystem and the real `git`, for specs that must prove what a
 * repository ends up looking like rather than which argument list was built.
 *
 * Only the two capabilities the operations layer reads are provided — `fs` and `subprocess` — and
 * each is the smallest faithful rendering of its seam: `subprocess.spawn` honours the abort signal
 * and collects both streams, `fs.resolve` canonicalizes through `realpath` the way the harness's
 * local backend does. Every git process, including the ones that build fixtures, runs with system
 * and global config switched off, so a developer's own `~/.gitconfig` can neither break a spec nor
 * make one pass.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { GitClient } from '../../src/host/git.ts'
import { WorktreeOperations } from '../../src/host/operations.ts'
import type { WorktreeSettings } from '../../src/host/types.ts'

/** The environment every git process in these specs runs under. */
export const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Spec',
  GIT_AUTHOR_EMAIL: 'spec@example.invalid',
  GIT_COMMITTER_NAME: 'Spec',
  GIT_COMMITTER_EMAIL: 'spec@example.invalid',
  // `git submodule add` from a local path is refused by default since 2.38.1.
  GIT_ALLOW_PROTOCOL: 'file',
})

/** The settings section the specs run with; each spec overrides only what it is about. */
export const SETTINGS: WorktreeSettings = Object.freeze({
  showChip: true,
  worktreePathTemplate: '{repoParent}/{repo}-worktrees/{branch}',
  branchPrefix: '',
  registerWorkspace: true,
  openSession: true,
  includeRemoteBranches: true,
  maxBranches: 200,
  refreshIntervalMs: 15_000,
  gitTimeoutMs: 20_000,
  networkTimeoutMs: 120_000,
  maxOutputBytes: 1_048_576,
  graceMs: 1_000,
  confirmDestructive: true,
})

/** Merged environment for a fixture or spawned git. */
const environment = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv =>
  ({ ...process.env, ...GIT_ENV, ...extra })

/**
 * Run git synchronously to build or inspect a fixture.
 * @param cwd - directory to run in.
 * @param args - arguments after `git`.
 * @returns trimmed stdout.
 */
export function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', args, { cwd, env: environment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * Create a scratch directory, canonicalized so paths compare equal to what git prints.
 * @param label - a readable prefix.
 * @returns the directory.
 */
export function scratch(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `dsh-worktree-${label}-`)))
}

/**
 * Remove a scratch directory and everything under it.
 * @param directory - what {@link scratch} returned.
 */
export function discard(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}

/**
 * Initialise a repository with one commit on `main`.
 * @param root - the scratch directory to create it under.
 * @param name - the repository directory name.
 * @returns the repository path.
 */
export function initRepository(root: string, name = 'repo'): string {
  const path = join(root, name)
  git(root, 'init', '--quiet', '--initial-branch=main', path)
  writeFileSync(join(path, 'README.md'), 'hello\n')
  git(path, 'add', 'README.md')
  git(path, 'commit', '--quiet', '-m', 'initial')
  return path
}

/**
 * Commit one file change on the current branch.
 * @param repository - the worktree to commit in.
 * @param file - file name relative to the worktree.
 * @param content - the new content.
 * @returns the new commit's full object name.
 */
export function commitFile(repository: string, file: string, content: string): string {
  writeFileSync(join(repository, file), content)
  git(repository, 'add', file)
  git(repository, 'commit', '--quiet', '-m', `change ${file}`)
  return git(repository, 'rev-parse', 'HEAD')
}

/**
 * Resolve a path the way the local filesystem backend does: canonical when it exists, otherwise
 * the canonical nearest ancestor joined with the rest.
 * @param path - an absolute path.
 * @returns the canonical spelling.
 */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(canonical(parent), basename(path))
}

/**
 * One collect-mode reader over captured text.
 * @param chunks - the stream's chunks, appended as they arrive.
 * @returns the offset reader the seam hands out.
 */
function reader(chunks: readonly Buffer[]): { readFrom: (offset: number) => { text: string } } {
  return { readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8') }) }
}

/** What {@link hostContext} can be told to do differently from a faithful backend. */
export interface HostOptions {
  /**
   * Intercept one spawn before it starts; answer a canned outcome to stand in for the process.
   * @param argv - the full argument vector, executable first.
   * @param signal - the spawn's combined signal.
   * @returns an outcome to return instead of spawning, or undefined to spawn for real.
   */
  readonly intercept?: (argv: readonly string[], signal: AbortSignal) =>
    { exitCode: number | null; stdout?: string; stderr?: string } | undefined
}

/**
 * Build a Host context carrying real `fs` and `subprocess` capabilities.
 * @param options - spawn interception, for the few specs that need a process to misbehave.
 * @returns the context, cast to the cordis type the operations layer is declared against.
 */
export function hostContext(options: HostOptions = {}): Context {
  const executable = realpathSync(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim())
  const fs = {
    resolve: async (path: string) => canonical(path),
    processPath: (target: string) => target,
    stat: async (target: string) => {
      if (!existsSync(target)) return undefined
      return { type: statSync(target).isDirectory() ? 'directory' : 'file' }
    },
    listDir: async (target: string) => readdirSync(target).map(name => ({ name })),
  }
  const subprocess = {
    resolveExecutable: async (command: string) => {
      if (command !== 'git') throw new Error(`not resolvable: ${command}`)
      return executable
    },
    spawn: (spec: {
      argv: readonly string[]
      cwd: string
      signal: AbortSignal
      env?: Record<string, string>
    }) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const canned = options.intercept?.(spec.argv, spec.signal)
      if (canned !== undefined) {
        stdout.push(Buffer.from(canned.stdout ?? ''))
        stderr.push(Buffer.from(canned.stderr ?? ''))
        return {
          collected: { stdout: reader(stdout), stderr: reader(stderr) },
          done: Promise.resolve({ exitCode: canned.exitCode, signal: null }),
        }
      }
      const [command, ...args] = spec.argv
      const child = spawn(command ?? executable, args, {
        cwd: spec.cwd,
        env: environment(spec.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: spec.signal,
      })
      child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
      const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
        // An aborted spawn reports an AbortError here before `close`; the outcome is still the
        // process's own exit facts, which is what the seam's `done` carries.
        child.on('error', () => undefined)
        child.on('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
      })
      return { collected: { stdout: reader(stdout), stderr: reader(stderr) }, done }
    },
  }
  const services: Record<string, unknown> = { fs, subprocess }
  return { get: (name: string) => services[name] } as unknown as Context
}

/** An operations layer over a real repository, plus the client it runs git through. */
export interface Harness {
  readonly git: GitClient
  readonly operations: WorktreeOperations
}

/**
 * Build the Host's operations layer over {@link hostContext}.
 * @param settings - overrides of {@link SETTINGS}.
 * @param options - spawn interception.
 * @returns the git client and the operations layer.
 */
export function harness(settings: Partial<WorktreeSettings> = {}, options: HostOptions = {}): Harness {
  const ctx = hostContext(options)
  const resolved = { ...SETTINGS, ...settings }
  const client = new GitClient(ctx, () => resolved)
  return { git: client, operations: new WorktreeOperations(ctx, client, () => resolved) }
}
