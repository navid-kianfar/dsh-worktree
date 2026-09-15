/**
 * The confirmation every destructive action goes through: deleting a branch, removing a worktree.
 *
 * Up to three gates, and they are separate on purpose. The force switch changes WHAT git is asked to
 * do — `-D` instead of `-d`, `--force` instead of a plain remove — and is off until someone turns it
 * on. The typed confirmation changes nothing about the command; it only makes the forced form take a
 * deliberate act, and a deployment that does not want that friction turns it off in settings. The
 * acknowledgement is for a loss the force switch does not describe — a worktree's ignored files,
 * which git deletes even unforced — and is never switched off, because what it names is data no
 * commit can bring back.
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
  /** Facts shown under the sentence, such as the files a removal would delete. */
  details?: ReactNode
  /** Copy of a checkbox that must be ticked before confirming; absent requires none. */
  acknowledgeLabel?: string
  /** True while the facts the confirmation depends on are still being read; confirming waits. */
  pending?: boolean
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
   * @param acknowledged - whether the acknowledgement was ticked; false when none was asked for.
   */
  onConfirm: (force: boolean, acknowledged: boolean) => void
}

/**
 * Render the confirmation.
 * @param props - what is being confirmed, and how strictly.
 * @returns the dialog.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    title, body, details, acknowledgeLabel, pending = false, forceLabel, typedValue, requireTyped,
    confirmLabel, t, failure, busy, onCancel, onConfirm,
  } = props
  const [force, setForce] = useState(false)
  const [typed, setTyped] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const fieldId = useId()

  // Turning force back off drops whatever was typed for it: the confirmation belongs to the forced
  // form, and leaving it filled would let a second toggle skip the gate it was typed for.
  useEffect(() => {
    if (!force) setTyped('')
  }, [force])

  // A different acknowledgement — its copy names what it covers, so new facts change it — must be
  // ticked again rather than inherit the tick given for the old one.
  useEffect(() => { setAcknowledged(false) }, [acknowledgeLabel])

  const gated = requireTyped && force
  const ready = !busy && !pending
    && (!gated || typed === typedValue)
    && (acknowledgeLabel === undefined || acknowledged)
  const confirm = (): void => { onConfirm(force, acknowledgeLabel !== undefined && acknowledged) }

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
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </div>
      )}
    >
      <div className={css.form}>
        <p className={css.dialogText}>{body}</p>

        {details}

        <FailureStrip failure={failure} t={t} />

        {acknowledgeLabel !== undefined && (
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              className={css.heroCheckBox}
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => { setAcknowledged(event.target.checked) }}
            />
            <span className={css.toggleText}>
              <span className={css.fieldLabel}>{acknowledgeLabel}</span>
            </span>
          </label>
        )}

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
                if (event.key === 'Enter' && ready) confirm()
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}
