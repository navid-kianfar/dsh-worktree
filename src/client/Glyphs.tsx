/**
 * The two glyphs this surface needs that the shared icon set does not carry.
 *
 * `IconBranchOutline16` from ui-primitives is a conversation-lineage mark, not a git branch, and
 * nothing there depicts a worktree at all — so these two are drawn here, on the same 16px grid and
 * 1.4px stroke as the shared set, and inherit `currentColor` like every other icon in the client.
 * @module @achasoft/dsh-worktree/client/Glyphs
 */

import type { SVGProps } from 'react'

/** Shared geometry: a 16px viewBox stroked in the current text color. */
const BASE: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

/**
 * The git branch mark: a trunk, a fork, and the two nodes it runs between.
 * @param props - passed through to the `svg` element.
 * @returns the icon.
 */
export function GitBranchGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="3.5" r="1.75" />
      <path d="M4.5 5.25v5.5" />
      <path d="M11.5 5.25v1.25a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 0-2.5 2.5" />
    </svg>
  )
}

/**
 * The worktree mark: one directory beside the two it was branched into.
 * @param props - passed through to the `svg` element.
 * @returns the icon.
 */
export function WorktreeGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="1.75" y="2.25" width="5" height="4.25" rx="1" />
      <rect x="9.25" y="2.25" width="5" height="4.25" rx="1" />
      <rect x="9.25" y="9.5" width="5" height="4.25" rx="1" />
      <path d="M4.25 6.5v3.25a1.5 1.5 0 0 0 1.5 1.5h3.5" />
    </svg>
  )
}
