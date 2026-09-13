/**
 * Turning prose into a branch-name component, shared by both halves.
 *
 * A pure vocabulary rather than a host detail: the Host uses it as the deterministic answer when no
 * model is configured (and as the answer the model's reply is reduced through either way), and the
 * browser uses the same rules to show what a name will look like before anything is created. One
 * implementation is what keeps the preview and the result from disagreeing.
 *
 * Unicode letters and digits are kept rather than ASCII-folded, so a prompt written in Chinese,
 * Greek, or Cyrillic still yields a name drawn from its own words instead of an empty string.
 * @module @achasoft/dsh-worktree/shared/name
 */

/** Longest name this vocabulary will produce. */
export const MAX_BRANCH_NAME_CHARS = 48

/** Most words kept from one prompt; a longer prompt describes more than a name can carry. */
const MAX_NAME_WORDS = 6

/**
 * Reduce arbitrary text to a lower-case, hyphen-separated name.
 *
 * Runs of anything that is not a letter or a digit collapse to one hyphen, which is what makes the
 * result safe as a git ref component without a second validation pass. Only the first line is read:
 * a model asked for one line sometimes answers with two, and the second is never the name.
 * @param text - model output or a raw prompt.
 * @returns the name, possibly empty when the text carries no letters or digits at all.
 */
export function slugify(text: string): string {
  const firstLine = text.split(/\r?\n/u)[0] ?? ''
  const words = firstLine
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(word => word !== '')
  const kept: string[] = []
  for (const word of words) {
    if (kept.length >= MAX_NAME_WORDS) break
    // One unbroken run (a long CJK phrase, a URL-shaped token) can exceed the whole budget on its
    // own; truncating it is better than dropping the only word the prompt had.
    const clipped = word.length > MAX_BRANCH_NAME_CHARS ? word.slice(0, MAX_BRANCH_NAME_CHARS) : word
    const next = [...kept, clipped].join('-')
    if (next.length > MAX_BRANCH_NAME_CHARS) {
      if (kept.length === 0) kept.push(clipped)
      break
    }
    kept.push(clipped)
  }
  return kept.join('-').replace(/^-+|-+$/gu, '')
}
