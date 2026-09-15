/**
 * The per-row action menu shared by both popovers.
 *
 * The menu is portaled to the document body and positioned from the trigger's own rectangle, because
 * the popover clips its content and the list inside it scrolls: a menu rendered in the row would be
 * cut off by one container or the other.
 *
 * Portaling costs one thing, and it has to be paid back. The popover decides what is a click outside
 * itself by DOM containment, and a body-level menu is never contained — so it carries the
 * `data-worktree-portal` marker the popover checks before closing. Without that, pointerdown on a
 * menu item closes the popover, React unmounts the item, and the click lands on nothing.
 * @module @achasoft/dsh-worktree/client/RowMenu
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconEllipsisOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './surface.module.css'

/** One entry of the menu. */
export interface RowMenuItem {
  /** Stable identity within the menu. */
  readonly id: string
  /** The row's copy. */
  readonly label: string
  /** Run on activation; the menu closes first. */
  readonly onSelect: () => void
  /** Render in the destructive tint. */
  readonly danger?: boolean
  /** Present but unusable. */
  readonly disabled?: boolean
  /** Why the entry is unusable, shown as its tooltip; only read while {@link disabled}. */
  readonly reason?: string
}

/** Gap between the trigger and the menu, matching the popover's own offset from the chip. */
const GAP = 4

/** Viewport margin the menu keeps, so it never sits flush against an edge. */
const MARGIN = 8

/**
 * Render a trigger button that opens a floating action menu.
 * @param props.label - accessible name of the trigger.
 * @param props.items - the menu entries; an empty list renders no trigger at all.
 * @returns the trigger, plus the menu while it is open.
 */
export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Layout effect, not effect: the menu is measured and moved before paint, so it never appears at
  // the top-left corner for one frame on its way to the trigger.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (trigger === null || menu === null) return
    const anchor = trigger.getBoundingClientRect()
    const box = menu.getBoundingClientRect()
    const belowFits = anchor.bottom + GAP + box.height <= window.innerHeight - MARGIN
    setPosition({
      top: belowFits ? anchor.bottom + GAP : Math.max(MARGIN, anchor.top - GAP - box.height),
      left: Math.min(
        Math.max(MARGIN, anchor.right - box.width),
        Math.max(MARGIN, window.innerWidth - MARGIN - box.width),
      ),
    })
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Stopped here so one Escape closes the menu and leaves the popover behind it open, rather
      // than collapsing the whole surface in a single keystroke.
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    // Capture phase: a scroll inside the popover's list would otherwise leave the menu behind,
    // pointing at a row that has moved.
    const onScroll = (): void => { setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={css.iconButton}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          // The row behind this control is itself a button; without this the menu would open and
          // the row would act in the same click.
          event.stopPropagation()
          setPosition(null)
          setOpen(!open)
        }}
      >
        <IconEllipsisOutline16 />
      </button>
      {open && createPortal((
        <div
          ref={menuRef}
          className={css.menu}
          role="menu"
          aria-label={label}
          // The marker the popover's outside-click check looks for. Without it, this menu — which
          // lives in the body rather than in the popover's subtree — reads as a click outside, the
          // popover closes on pointerdown, and the item is unmounted before the click reaches it.
          data-worktree-portal="menu"
          // Hidden until measured, so the first paint is already in the right place.
          style={position === null
            ? { top: 0, left: 0, visibility: 'hidden' }
            : { top: position.top, left: position.left }}
        >
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.danger === true ? css.menuItemDanger : css.menuItem}
              disabled={item.disabled === true}
              {...item.disabled === true && item.reason !== undefined ? { title: item.reason } : {}}
              onClick={(event) => {
                event.stopPropagation()
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ), document.body)}
    </>
  )
}
