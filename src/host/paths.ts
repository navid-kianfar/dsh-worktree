/**
 * Path resolution for every endpoint that takes a path from the browser.
 *
 * A browser-supplied path is untrusted input at a process boundary, so each one is resolved through
 * `ctx.fs` before any git invocation sees it; `..` and symlinks are handled by the filesystem's own
 * canonicalization rather than by string arithmetic here.
 *
 * Containment is deliberately NOT enforced against the workspace. A linked worktree's whole purpose
 * is to sit outside the repository it belongs to, so the check that matters is git's: a worktree
 * path is accepted only when git itself reports it in `git worktree list`, and the one path that
 * skips that check — a new worktree's destination — must be absent, which is the strongest statement
 * available about a directory that does not exist yet.
 * @module @achasoft/dsh-worktree/host/paths
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { GitFailure } from './types.ts'

/** A resolved path plus the canonical spelling a subprocess can open. */
export interface ResolvedPath {
  /** The canonical target. */
  readonly target: FsTarget
  /** Absolute path in the filesystem backend's execution world. */
  readonly processPath: string
  /** True when something exists at the path. */
  readonly exists: boolean
  /** True when it exists and is a directory. */
  readonly directory: boolean
}

/** Either a usable path or the failure to return in its place. */
export type PathOutcome =
  | { readonly ok: true; readonly value: ResolvedPath }
  | { readonly ok: false; readonly failure: GitFailure }

/** The one diagnostic for a deployment that composes no filesystem provider. */
const NO_FILESYSTEM =
  'no filesystem capability is mounted: this deployment composes no @deepseek-ai/dsh-fs provider'

/**
 * Phrase one resolution failure without leaking a stack.
 * @param error - whatever the backend threw.
 * @param path - the path that was being resolved.
 * @returns a single-line operator diagnostic.
 */
function describe(error: unknown, path: string): string {
  return `cannot resolve ${path}: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Resolve one absolute path, whether or not anything exists at it.
 *
 * A missing path is a success here, because a new worktree's destination is required to be missing;
 * callers that need an existing directory read {@link ResolvedPath.directory}.
 * @param ctx - Host context carrying the optional filesystem capability.
 * @param path - absolute path supplied by the browser.
 * @param signal - cancellation for the backend round-trips.
 * @returns the canonical path and what is at it, or the failure to return.
 */
export async function resolvePath(
  ctx: Context, path: string, signal?: AbortSignal,
): Promise<PathOutcome> {
  const fs = ctx.get('fs')
  if (fs === undefined) {
    return { ok: false, failure: { ok: false, code: 'no-filesystem', message: NO_FILESYSTEM } }
  }
  let target: FsTarget
  try {
    // Spread rather than `{ signal }`: under `exactOptionalPropertyTypes` an explicit `undefined` is
    // not the same as an absent optional, and the seam's option is declared as the latter.
    target = await fs.resolve(path, { ...signal === undefined ? {} : { signal } })
  } catch (error) {
    return { ok: false, failure: { ok: false, code: 'path-denied', message: describe(error, path) } }
  }
  const info = await fs.stat(target, signal)
  return {
    ok: true,
    value: {
      target,
      processPath: fs.processPath(target),
      exists: info !== undefined,
      directory: info?.type === 'directory',
    },
  }
}

/**
 * Resolve one absolute path that must already be a directory.
 * @param ctx - Host context carrying the optional filesystem capability.
 * @param path - absolute directory path supplied by the browser.
 * @param signal - cancellation for the backend round-trips.
 * @returns the canonical directory, or the failure to return.
 */
export async function resolveDirectory(
  ctx: Context, path: string, signal?: AbortSignal,
): Promise<PathOutcome> {
  const outcome = await resolvePath(ctx, path, signal)
  if (!outcome.ok) return outcome
  if (!outcome.value.directory) {
    return {
      ok: false,
      failure: { ok: false, code: 'path-denied', message: `${path} is not a directory` },
    }
  }
  return outcome
}

/**
 * Report whether a directory holds no entries.
 * @param ctx - Host context carrying the optional filesystem capability.
 * @param resolved - an existing directory resolved through {@link resolvePath}.
 * @param signal - cancellation for the listing.
 * @returns true when the listing is empty.
 */
export async function isEmptyDirectory(
  ctx: Context, resolved: ResolvedPath, signal?: AbortSignal,
): Promise<boolean> {
  const fs = ctx.get('fs')
  /* v8 ignore next -- the caller resolved `resolved` through the same service moments earlier. */
  if (fs === undefined) return false
  try {
    return (await fs.listDir(resolved.target, signal)).length === 0
  } catch {
    // An unreadable directory is not an empty one, and the only caller uses this to decide whether
    // to offer a path as reusable — so refusing to offer it is the right answer either way.
    return false
  }
}
