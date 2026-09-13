/**
 * `@achasoft/dsh-worktree` root entry — two roles in one module, because the client module system
 * requires them together.
 *
 * **As a plugin**, this is the worktree surface's node half. The apply is empty: the browser half
 * ships via `exports["./client"]` and is discovered through the package's `dsh.client` declaration.
 * That discovery resolves `<loader row name>/package.json`, so the row naming this plugin must be
 * the BARE package name — a subpath row (`.../host`) resolves nothing and the header seat is
 * silently never served.
 *
 * **As a library**, it re-exports the wire contract and the three pure vocabularies both halves
 * share, so another package can type against the `worktree` namespace without depending on the Host
 * endpoint or the browser surface.
 * @module @achasoft/dsh-worktree
 */

export type * from './host/types.ts'
export type { BranchNameProblem, BranchNameVerdict } from './shared/branch-name.ts'
export type { PathTemplateVars } from './shared/path.ts'
export { applyBranchPrefix, checkBranchName, localBranchOf } from './shared/branch-name.ts'
export { MAX_BRANCH_NAME_CHARS, slugify } from './shared/name.ts'
export {
  abbreviatePath, basenameOf, expandPathTemplate, flattenBranch, isAbsolutePath, joinPath, parentOf,
} from './shared/path.ts'

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
