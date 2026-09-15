/**
 * The `git` invocation layer: locating the executable, running one command under this plugin's
 * configured bounds, and turning a non-zero exit into a classified failure.
 *
 * The harness has no git capability, so a repository is reached the only way available to a plugin —
 * by running `git` through `ctx.subprocess` and reading its machine formats. Every argument list is
 * assembled from fixed literals plus values this Host resolved itself; browser text becomes a `git`
 * argument only after the endpoint has proved what it names.
 * @module @achasoft/dsh-worktree/host/git
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandUnavailableError, resolveCommand, runCommand, type CommandOutcome } from './run.ts'
import type { GitFailure, GitFailureCode, WorktreeSettings } from './types.ts'

/**
 * The git release that made `git worktree list --porcelain -z` available.
 *
 * Below it the plain newline-separated form is read instead, which loses nothing except safety
 * around a worktree path or lock reason containing a newline. The same release added the `locked`
 * and `prunable` attributes, so an older git simply reports neither and the listing stays correct.
 */
const Z_LISTING_SINCE: readonly [number, number] = [2, 36]

/** `git version 2.50.1 (Apple Git-155)` — the two leading numbers are all this plugin reads. */
const VERSION = /\bversion (\d+)\.(\d+)/u

/** The one diagnostic for a Host whose PATH holds no git. */
const NO_GIT = 'git is not installed, or not on this Host process PATH'

/**
 * Configuration every invocation this client makes is run under, ahead of the subcommand.
 *
 * `core.fsmonitor` names a program git runs whenever it consults the index — `status`, `switch`,
 * `worktree add` — and it is read from the repository's own `.git/config`. This surface reads a
 * repository the moment a folder is selected and again on every poll, so honouring it would let a
 * folder someone merely opened execute a program of its choosing. Switching it off costs only the
 * speed-up a monitor gives, and it is passed on the command line because that scope outranks every
 * config file and is inherited by any git process git itself spawns (a submodule's, for instance).
 * Filter drivers are the other program a reading can reach; `WorktreeOperations` neutralises those
 * per repository, because their names are only known once the repository's config has been read.
 */
const INVOCATION_CONFIG: readonly string[] = Object.freeze(['-c', 'core.fsmonitor=false'])

/** Compose one classified failure. */
export function fail(code: GitFailureCode, message: string): GitFailure {
  return { ok: false, code, message }
}

/** First non-empty line of git's stderr — the part worth putting in front of a person. */
export function stderrLine(outcome: CommandOutcome): string {
  const line = [...outcome.stderr.split('\n'), ...outcome.stdout.split('\n')]
    .map(part => part.replace(/^(?:fatal|error): /u, '').trim())
    .find(part => part !== '')
  return line ?? `git exited with code ${String(outcome.exitCode)}`
}

/**
 * Phrases git prints that name a state the repository is refusing from, rather than an input error.
 *
 * Matching on git's own English is the only classification available — porcelain commands report
 * these as prose — so the list is kept to substrings git has printed unchanged for many releases,
 * and anything unmatched falls through to the generic `git-failed` with git's line attached.
 */
const REFUSED = [
  'is already checked out at',
  'is already used by worktree',
  'already exists',
  'would be overwritten',
  'not fully merged',
  'contains modified or untracked files',
  'is locked',
  'is not locked',
  'cannot lock',
  'is dirty',
  'you have unstaged changes',
  'your local changes',
  'needs a single revision',
  'cannot force update the branch',
  'is used by worktree at',
]

/** Phrases naming something the repository does not have. */
const NOT_FOUND = [
  'did not match any file',
  'invalid reference',
  'unknown revision',
  'not a valid ref',
  'no such branch',
  'not a working tree',
  'is not a working tree',
  'couldn\'t find remote ref',
  'not found',
]

/**
 * Turn a non-zero exit into the failure a caller should return.
 * @param outcome - the finished command.
 * @returns the classified failure.
 */
export function classify(outcome: CommandOutcome): GitFailure {
  if (outcome.timedOut) return fail('timeout', 'git did not finish within its configured timeout')
  if (outcome.aborted) return fail('cancelled', 'the request was abandoned before git finished')
  const message = stderrLine(outcome)
  const lowered = message.toLowerCase()
  if (lowered.includes('not a git repository')) return fail('not-a-repository', message)
  // Refusal is tested before absence: `fatal: 'x' is already checked out at …` also contains a
  // phrase from the absence list on some releases, and the state is the more actionable reading.
  if (REFUSED.some(phrase => lowered.includes(phrase))) return fail('refused', message)
  if (NOT_FOUND.some(phrase => lowered.includes(phrase))) return fail('not-found', message)
  return fail('git-failed', message)
}

/** One invocation's disposition beyond its argument list. */
export interface RunOptions {
  /** Use {@link WorktreeSettings.networkTimeoutMs} instead of the local bound. */
  readonly network?: boolean
}

/**
 * Runs `git` for one Host. A single instance serves every request: the resolved executable and the
 * version read from it are cached across calls and dropped whenever a lookup fails, so installing
 * git after the harness started needs no restart.
 */
export class GitClient {
  private executable: string | undefined
  private version: string | undefined
  private release: readonly [number, number] | undefined
  /**
   * The in-flight (or settled) version probe.
   *
   * The promise is memoized rather than a done-flag, because two requests arriving together must
   * both WAIT for the reading: a flag set before the await would let the second caller reach
   * {@link supportsNulListing} while the release is still unknown and silently take the fallback.
   */
  private probe: Promise<void> | undefined

  /**
   * @param ctx - Host context carrying the subprocess capability.
   * @param source - reads the current settings section; called per invocation so a committed change
   * reaches the next command with no registration to rebuild.
   */
  constructor(private readonly ctx: Context, private readonly source: () => WorktreeSettings) {}

  /**
   * Report whether git can answer on this Host.
   * @param cwd - an existing directory in the filesystem backend's execution world, which the
   * version probe runs in; the seam takes no relative or implicit working directory.
   * @param signal - cancellation for the lookup.
   * @returns availability plus the version string when one was read.
   */
  async describe(cwd: string, signal?: AbortSignal): Promise<{
    available: boolean
    version?: string
    reason?: string
  }> {
    let executable: string | undefined
    try {
      executable = await this.locate(signal)
      if (executable !== undefined) await this.probeVersion(executable, cwd, signal)
    } catch (error) {
      /* v8 ignore next -- only a missing subprocess capability reaches here. */
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (executable === undefined) return { available: false, reason: NO_GIT }
    return { available: true, ...this.version === undefined ? {} : { version: this.version } }
  }

  /**
   * Whether this Host's git supports the NUL-separated worktree listing.
   * @returns true from git {@link Z_LISTING_SINCE} onward; false when the version could not be read.
   */
  supportsNulListing(): boolean {
    const release = this.release
    if (release === undefined) return false
    const [major, minor] = release
    const [needMajor, needMinor] = Z_LISTING_SINCE
    return major > needMajor || (major === needMajor && minor >= needMinor)
  }

  /**
   * Run one git command in a directory.
   * @param cwd - canonical directory to run in.
   * @param argv - arguments after the executable.
   * @param options - invocation disposition.
   * @param signal - the caller's cancellation.
   * @returns exit facts and collected output.
   * @throws {CommandUnavailableError} when no subprocess capability is mounted or git is absent.
   */
  async run(
    cwd: string, argv: readonly string[], options: RunOptions = {}, signal?: AbortSignal,
  ): Promise<CommandOutcome> {
    const executable = await this.locate(signal)
    if (executable === undefined) {
      throw new CommandUnavailableError('no-git', NO_GIT)
    }
    // Before the command, not after: `supportsNulListing()` decides an argument of the very first
    // listing this client is asked for, so the version has to be known by then.
    await this.probeVersion(executable, cwd, signal)
    const settings = this.source()
    return runCommand(this.ctx, {
      argv: [executable, ...INVOCATION_CONFIG, ...argv],
      cwd,
      timeoutMs: options.network === true ? settings.networkTimeoutMs : settings.gitTimeoutMs,
      maxBytes: settings.maxOutputBytes,
      graceMs: settings.graceMs,
      // Every reading this plugin takes is a machine format, and a pager or a colored diff would
      // corrupt one. Locale is pinned because `classify` reads git's English.
      env: { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, signal)
  }

  /**
   * Resolve the executable once.
   * @param signal - cancellation for the lookup.
   * @returns the executable path, or undefined when git is absent.
   * @throws {CommandUnavailableError} when no subprocess capability is mounted.
   */
  private async locate(signal?: AbortSignal): Promise<string | undefined> {
    if (this.executable !== undefined) return this.executable
    const found = await resolveCommand(this.ctx, 'git', signal)
    if (found === undefined) return undefined
    this.executable = found
    return found
  }

  /**
   * Read `git --version` once and remember what it says.
   *
   * A failed probe leaves the release unknown, which {@link supportsNulListing} reads as
   * unsupported — the conservative answer, since the fallback listing works on every git.
   * @param executable - the resolved git path.
   * @param cwd - an existing directory in the backend's execution world to run the probe in.
   * @param signal - cancellation for the probe.
   */
  private async probeVersion(executable: string, cwd: string, signal?: AbortSignal): Promise<void> {
    this.probe ??= this.readVersion(executable, cwd, signal).catch(() => {
      // The version is an optimization and a `describe` nicety, never a correctness requirement, so
      // a probe that failed — a cancelled request, a transient spawn failure — is swallowed and its
      // memo cleared. The command that follows runs with the conservative fallback, and the next
      // request reads the version again.
      this.probe = undefined
    })
    return this.probe
  }

  /**
   * Run the version probe.
   * @param executable - the resolved git path.
   * @param cwd - an existing directory in the backend's execution world to run the probe in.
   * @param signal - cancellation for the probe.
   * @throws {Error} when the probe did not produce a reading — cancelled, timed out, or killed.
   * Throwing rather than returning is what lets {@link probeVersion} drop the memo: a probe that
   * resolved without a reading would stay memoized, and the NUL-separated listing would then stay
   * off for the life of the process because of one abandoned request.
   */
  private async readVersion(executable: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const settings = this.source()
    const outcome = await runCommand(this.ctx, {
      argv: [executable, '--version'],
      cwd,
      timeoutMs: settings.gitTimeoutMs,
      maxBytes: settings.maxOutputBytes,
      graceMs: settings.graceMs,
      env: { LC_ALL: 'C' },
    }, signal)
    if (outcome.exitCode !== 0 || outcome.timedOut || outcome.aborted) {
      throw new Error(classify(outcome).message)
    }
    this.version = outcome.stdout.trim()
    const parsed = VERSION.exec(this.version)
    if (parsed !== null) this.release = [Number(parsed[1]), Number(parsed[2])]
  }
}
