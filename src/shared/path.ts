/**
 * Separator-agnostic path arithmetic, shared by both halves.
 *
 * `node:path` is deliberately unused. The Host's filesystem provider may execute in a different
 * world than the Node process hosting it (a POSIX sandbox driven from Windows), and the browser half
 * has no `node:path` at all — so the few operations this plugin needs are done here against both
 * separators and handed to `ctx.fs.resolve` for real canonicalization.
 * @module @achasoft/dsh-worktree/shared/path
 */

/** Either separator, for splitting a path whose execution world is not known here. */
const SEPARATORS = /[\\/]/u

/** A Windows drive prefix (`C:`), which is absolute only together with a following separator. */
const DRIVE = /^[A-Za-z]:$/u

/**
 * Report whether a path is absolute in either world.
 * @param path - the path to test.
 * @returns true for a POSIX root path, a UNC path, or a drive-qualified Windows path.
 */
export function isAbsolutePath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\')) return true
  return path.length >= 3 && DRIVE.test(path.slice(0, 2)) && SEPARATORS.test(path.charAt(2))
}

/**
 * Split a path into its non-empty segments, dropping the root.
 * @param path - the path to split.
 * @returns the segments, in order.
 */
function segmentsOf(path: string): string[] {
  return path.split(SEPARATORS).filter(segment => segment !== '')
}

/**
 * The last segment of a path.
 * @param path - the path to read.
 * @returns the final segment, or the path itself when it has none (a bare root).
 */
export function basenameOf(path: string): string {
  const segments = segmentsOf(path)
  return segments.at(-1) ?? path
}

/**
 * The directory containing a path.
 *
 * A path with a single segment under its root answers the root itself, and a root answers itself —
 * so repeated application terminates rather than climbing past the top.
 * @param path - the absolute path to read.
 * @returns the parent directory, keeping the input's own root spelling.
 */
export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  // A path that was nothing but separators trims to empty; answering the root it named is what makes
  // the walk terminate instead of stepping off the top into ''.
  if (trimmed === '') return path === '' ? '' : path.charAt(0)
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return trimmed
  // A cut at index 0 is the POSIX root; keeping the separator is what makes `/a` answer `/`.
  if (cut === 0) return trimmed.charAt(0)
  const head = trimmed.slice(0, cut)
  return DRIVE.test(head) ? `${head}${trimmed.charAt(cut)}` : head
}

/**
 * Join path parts with `/`, collapsing separators between them.
 *
 * `/` rather than the platform separator on purpose: Windows accepts it everywhere this plugin sends
 * a path (git's command line and `ctx.fs.resolve`), and picking it unconditionally keeps the result
 * identical no matter which world composed the template.
 * @param parts - path parts; empty parts are dropped.
 * @returns the joined path, keeping the first part's leading separator.
 */
export function joinPath(...parts: readonly string[]): string {
  const kept = parts.filter(part => part !== '')
  if (kept.length === 0) return ''
  const [head, ...rest] = kept as [string, ...string[]]
  const tail = rest.map(part => part.replace(/^[\\/]+/u, '').replace(/[\\/]+$/u, '')).filter(part => part !== '')
  const base = head.replace(/[\\/]+$/u, '')
  // A bare POSIX root trims to '' above; restoring it here keeps `/` + `a` at `/a` rather than `a`.
  const root = base === '' && head !== '' ? '/' : base
  if (tail.length === 0) return root
  return root.endsWith('/') || root.endsWith('\\') ? `${root}${tail.join('/')}` : `${root}/${tail.join('/')}`
}

/** The substitutions {@link expandPathTemplate} understands. */
export interface PathTemplateVars {
  /** The repository's main worktree directory. */
  readonly repoRoot: string
  /** The directory containing {@link repoRoot}. */
  readonly repoParent: string
  /** {@link repoRoot}'s basename. */
  readonly repo: string
  /** Branch name with `/` folded to `-`, so a namespaced branch stays one directory. */
  readonly branch: string
  /** Branch name with its slashes kept, so a namespaced branch nests. */
  readonly branchPath: string
}

/** Every placeholder name the template grammar accepts. */
const PLACEHOLDER = /\{(repoRoot|repoParent|repo|branchPath|branch)\}/gu

/**
 * Expand a worktree path template against one repository and branch.
 *
 * A template that expands to a relative path is resolved against `repoRoot`, which is what makes
 * `../{repo}-worktrees/{branch}` — the shape most people write — mean the obvious thing.
 * @param template - the configured template.
 * @param vars - the repository and branch to expand against.
 * @returns the expanded path; absolute unless `repoRoot` itself is relative.
 */
export function expandPathTemplate(template: string, vars: PathTemplateVars): string {
  const expanded = template.replace(PLACEHOLDER, (_, name: keyof PathTemplateVars) => vars[name])
  return isAbsolutePath(expanded) ? expanded : joinPath(vars.repoRoot, expanded)
}

/**
 * Fold a branch name into one path segment.
 * @param branch - the branch name.
 * @returns the name with every separator run replaced by a single `-`.
 */
export function flattenBranch(branch: string): string {
  return branch.replace(/[\\/]+/gu, '-')
}

/**
 * Shorten an absolute path for display by collapsing a leading home directory.
 * @param path - the path to shorten.
 * @param home - the home directory to collapse, when one is known.
 * @returns the path with `~` in place of `home`, or the path unchanged.
 */
export function abbreviatePath(path: string, home: string | undefined): string {
  if (home === undefined || home === '' || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  if (rest === '') return '~'
  return SEPARATORS.test(rest.charAt(0)) ? `~${rest}` : path
}
