/**
 * The confirmation every destructive action goes through: deleting a branch, removing a worktree.
 *
 * Two gates, and they are separate on purpose. The force switch changes WHAT git is asked to do —
 * `-D` instead of `-d`, `--force` instead of a plain remove — and is off until someone turns it on.
 * The typed confirmation changes nothing about the command; it only makes the forced form take a
 * deliberate act, and a deployment that does not want that friction turns it off in settings.
 * @module @achasoft/dsh-worktree/client/ConfirmDialog
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitFailure } from '../host/types.ts'
import { FailureStrip } from './FailureStrip.tsx'
import css from './surface.module.css'

/** What one confirmation asks about. */
export interface ConfirmDialogProps {
  /** Dialog heading. */
  title: string
  /** The sentence explaining what will happen. */
  body: ReactNode
  /** Copy of the force switch; absent offers no force. */
  forceLabel?: string
  /** The value someone must type when the deployment requires it and force is on. */
  typedValue: string
  /** Whether this deployment requires the typed confirmation for a forced action. */
  requireTyped: boolean
  /** Copy of the confirming button. */
  confirmLabel: string
  /** The `worktree` namespace translate. */
  t: TranslateNS<'worktree'>
  /** The failure of the last attempt, kept on screen while the dialog stays open. */
  failure: GitFailure | null
  /** True while the action is in flight. */
  busy: boolean
  /** Dismiss without acting. */
  onCancel: () => void
  /**
   * Run the action.
   * @param force - whether the force switch was on.
   */
  onConfirm: (force: boolean) => void
}

/**
 * Render the confirmation.
 * @param props - what is being confirmed, and how strictly.
 * @returns the dialog.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    title, body, forceLabel, typedValue, requireTyped, confirmLabel, t, failure, busy,
    onCancel, onConfirm,
  } = props
  const [force, setForce] = useState(false)
  const [typed, setTyped] = useState('')
  const fieldId = useId()

  // Turning force back off drops whatever was typed for it: the confirmation belongs to the forced
  // form, and leaving it filled would let a second toggle skip the gate it was typed for.
  useEffect(() => {
    if (!force) setTyped('')
  }, [force])

  const gated = requireTyped && force
  const ready = !busy && (!gated || typed === typedValue)

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      closeLabel={t('confirm.cancel')}
      footer={(
        <div className={css.dialogFooter}>
          <button type="button" className={css.buttonGhost} onClick={onCancel} disabled={busy}>
            {t('confirm.cancel')}
          </button>
          <button
            type="button"
            className={css.buttonDanger}
            disabled={!ready}
            onClick={() => { onConfirm(force) }}
          >
            {confirmLabel}
          </button>
        </div>
      )}
    >
      <div className={css.form}>
        <p className={css.dialogText}>{body}</p>

        <FailureStrip failure={failure} t={t} />

        {forceLabel !== undefined && (
          <label className={css.toggleRow}>
            <input
              id={`${fieldId}-force`}
              type="checkbox"
              role="switch"
              className={css.switch}
              checked={force}
              disabled={busy}
              onChange={(event) => { setForce(event.target.checked) }}
            />
            <span className={css.toggleText}>
              <span className={css.fieldLabel}>{forceLabel}</span>
            </span>
          </label>
        )}

        {gated && (
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor={`${fieldId}-typed`}>
              {t('confirm.typed', { value: typedValue })}
            </label>
            <input
              id={`${fieldId}-typed`}
              type="text"
              className={css.input}
              value={typed}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => { setTyped(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && ready) onConfirm(force)
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}
