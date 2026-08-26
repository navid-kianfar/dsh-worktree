/**
 * `git check-ref-format --branch` in pure form, shared by both halves.
 *
 * The Host validates before spawning git so a malformed name never becomes an argument, and the
 * browser validates while someone types so the Create control can say why it is disabled. One
 * implementation keeps the two answers from disagreeing — a name the browser accepts and the Host
 * then refuses is the worst of the three possible outcomes.
 *
 * The rules mirror `git-check-ref-format(1)` for the `--branch` case (a single-level name is allowed
 * and `refs/heads/` is implied). Refusing a name git would accept only costs a rename; accepting one
 * git refuses puts a raw error in front of someone who was told the name was fine.
 * @module @achasoft/dsh-worktree/shared/branch-name
 */

/** Why a branch name was refused, as a reason code the caller turns into copy. */
export type BranchNameProblem =
  /** Empty, or only separators. */
  | 'empty'
  /** Contains a character git refuses: whitespace, control, or one of ` ~^:?*[\`. */
  | 'character'
  /** Contains `..`, `@{`, or a `//` run. */
  | 'sequence'
  /** A component starts with `.`, or ends with `.` or `.lock`. */
  | 'component'
  /** Begins or ends with `/`, or is exactly `@` or `HEAD`. */
  | 'shape'

/** A branch name's verdict. */
export type BranchNameVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: BranchNameProblem }

/**
 * Characters git refuses anywhere in a ref name: everything through space, DEL, and the seven
 * revision-grammar characters `~ ^ : ? * [` and backslash.
 */
const FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/u

/**
 * Check a proposed branch name.
 * @param name - the name as typed, without a `refs/heads/` prefix.
 * @returns whether git would accept it, and the first rule it broke when it would not.
 */
export function checkBranchName(name: string): BranchNameVerdict {
  if (name === '') return { ok: false, problem: 'empty' }
  if (name.startsWith('/') || name.endsWith('/')) return { ok: false, problem: 'shape' }
  // `HEAD` is refused alongside `@` because `git switch` would read it as the symbolic ref rather
  // than as a branch, which makes every later operation on the branch ambiguous.
  if (name === '@' || name === 'HEAD') return { ok: false, problem: 'shape' }
  if (FORBIDDEN.test(name)) return { ok: false, problem: 'character' }
  if (name.includes('..') || name.includes('@{') || name.includes('//')) {
    return { ok: false, problem: 'sequence' }
  }
  if (name.endsWith('.')) return { ok: false, problem: 'component' }
  for (const component of name.split('/')) {
    if (component === '') return { ok: false, problem: 'empty' }
    if (component.startsWith('.') || component.endsWith('.lock')) {
      return { ok: false, problem: 'component' }
    }
  }
  return { ok: true }
}

/**
 * Apply a configured prefix to a typed branch name, without doubling it.
 * @param prefix - the configured prefix (`feature/`); empty applies none.
 * @param name - the name as typed.
 * @returns the prefixed name, or `name` unchanged when it already carries the prefix.
 */
export function applyBranchPrefix(prefix: string, name: string): string {
  if (prefix === '' || name === '' || name.startsWith(prefix)) return name
  return `${prefix}${name}`
}

/**
 * The local branch name a remote-tracking name implies.
 *
 * `refs/remotes/<remote>/<branch>` has exactly one remote segment, so `origin/feature/x` implies
 * `feature/x`: only the FIRST segment is dropped, because a branch name may contain slashes of its
 * own. The caller is responsible for having established that the input really is a remote-tracking
 * short name; a name without a separator answers itself.
 * @param name - a remote-tracking short name.
 * @returns the local branch name it implies.
 */
export function localBranchOf(name: string): string {
  const cut = name.indexOf('/')
  return cut < 0 ? name : name.slice(cut + 1)
}
