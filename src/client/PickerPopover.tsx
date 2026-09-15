/**
 * A searchable picker anchored to a toolbar chip: a filter field, the matching rows, and an optional
 * action row pinned under them.
 *
 * Both new-session dropdowns are this shape — projects with "Browse for folder…" underneath, and
 * branches — so they share one keyboard model: typing filters, the arrow keys move through the
 * matches and the action row, Enter picks, Escape closes. The panel is portaled and fixed-positioned
 * because the hero toolbar sits inside the conversation's scroll container, which would clip an
 * in-place popover.
 * @module @achasoft/dsh-worktree/client/PickerPopover
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconCheckOutline14, IconSearchOutline16, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { matchScore } from './format.ts'
import css from './surface.module.css'

/** One selectable row. */
export interface PickerRow {
  /** Stable identity, handed back on pick. */
  readonly id: string
  /** The text shown and matched against. */
  readonly label: string
  /** Secondary text shown after the label, also matched. */
  readonly detail?: string
  /** Leading glyph. */
  readonly icon?: ReactNode
  /** Shown with a trailing check. */
  readonly selected?: boolean
}

/** The action row pinned below the list. */
export interface PickerAction {
  readonly label: string
  readonly icon?: ReactNode
  readonly onSelect: () => void
}

/** Props for {@link PickerPopover}. */
export interface PickerPopoverProps {
  readonly open: boolean
  /** The chip the panel is placed under; clicks on it are left to the chip's own toggle. */
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly onClose: () => void
  readonly rows: readonly PickerRow[]
  readonly onPick: (id: string) => void
  readonly placeholder: string
  readonly ariaLabel: string
  readonly emptyText: string
  readonly action?: PickerAction
  /** A failure to show above the list, e.g. a checkout git refused. */
  readonly error?: string | null
  /** Disable picking while an operation runs. */
  readonly busy?: boolean
}

/** Gap between the chip and the panel, and the clearance kept from each viewport edge. */
const GAP = 6
const MARGIN = 12

/**
 * Render the anchored, searchable picker.
 * @param props - see {@link PickerPopoverProps}.
 * @returns the portaled panel while open, otherwise nothing.
 */
export function PickerPopover(props: PickerPopoverProps) {
  const { open, anchorRef, onClose, rows, onPick, placeholder, ariaLabel, emptyText, action, error, busy } = props
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: GAP, margin: MARGIN })

  // Every opening starts from an empty filter on the current row, the way a fresh menu reads.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const selected = rows.findIndex(row => row.selected === true)
    setActive(selected < 0 ? 0 : selected)
    // Focus after the portal has mounted and been placed.
    const frame = requestAnimationFrame(() => { inputRef.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
    // `rows` is read for the initial highlight only; re-running on every rows change would reset a
    // filter mid-typing whenever a background refresh lands.
  }, [open])

  const matched = useMemo(() => {
    const needle = query.trim()
    if (needle === '') return rows
    const lower = needle.toLowerCase()
    return rows
      .map(row => ({ row, score: matchScore(row, needle, lower) }))
      .filter(entry => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.row)
  }, [rows, query])

  const count = matched.length + (action === undefined ? 0 : 1)

  useEffect(() => { setActive(index => (count === 0 ? 0 : Math.min(index, count - 1))) }, [count])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target === null) return
      if (panelRef.current?.contains(target) === true) return
      // The chip toggles itself; closing here too would reopen it on the same click.
      if (anchorRef.current?.contains(target) === true) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open, anchorRef, onClose])

  if (!open) return null

  const choose = (index: number): void => {
    if (busy === true) return
    if (index < matched.length) {
      const row = matched[index]
      if (row !== undefined) onPick(row.id)
      return
    }
    action?.onSelect()
  }

  return createPortal(
    <div
      ref={panelRef}
      className={css.picker}
      role="dialog"
      aria-label={ariaLabel}
      style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
        if (count === 0) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => (index + 1) % count); return }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index - 1 + count) % count); return }
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); choose(active) }
      }}
    >
      <div className={css.pickerSearch}>
        <IconSearchOutline16 size={14} className={css.pickerSearchIcon} />
        <input
          ref={inputRef}
          className={css.pickerSearchInput}
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => { setQuery(event.target.value); setActive(0) }}
        />
      </div>

      {error != null && error !== '' && <p className={css.pickerError} role="alert">{error}</p>}

      <ul className={css.pickerList} role="listbox" aria-label={ariaLabel}>
        {matched.map((row, index) => (
          <li key={row.id} role="option" aria-selected={row.selected === true}>
            <button
              type="button"
              className={css.pickerRow}
              data-active={index === active || undefined}
              disabled={busy}
              onMouseEnter={() => { setActive(index) }}
              onClick={() => { choose(index) }}
            >
              {row.icon !== undefined && <span className={css.pickerIcon}>{row.icon}</span>}
              <span className={css.pickerLabel}>{row.label}</span>
              {row.detail !== undefined && <span className={css.pickerDetail}>{row.detail}</span>}
              {row.selected === true && <IconCheckOutline14 className={css.pickerCheck} />}
            </button>
          </li>
        ))}
        {matched.length === 0 && <li className={css.pickerEmpty}>{emptyText}</li>}
      </ul>

      {action !== undefined && (
        <div className={css.pickerFooter}>
          <button
            type="button"
            className={css.pickerRow}
            data-active={active === matched.length || undefined}
            disabled={busy}
            onMouseEnter={() => { setActive(matched.length) }}
            onClick={() => { action.onSelect() }}
          >
            {action.icon !== undefined && <span className={css.pickerIcon}>{action.icon}</span>}
            <span className={css.pickerLabel}>{action.label}</span>
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
