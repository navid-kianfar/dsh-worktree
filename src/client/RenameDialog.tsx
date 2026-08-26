/**
 * The branch rename dialog.
 *
 * The name is checked against the same rules the Host applies before it spawns git, so the submit
 * control is unusable for a name git would refuse and the reason is on screen while it is typed —
 * rather than arriving as a `fatal:` line after the fact.
 * @module @achasoft/dsh-worktree/client/RenameDialog
 */

import { useId, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { checkBranchName } from '../shared/branch-name.ts'
import type { GitFailure } from '../host/types.ts'
import { FailureStrip } from './FailureStrip.tsx'
import css from './surface.module.css'

/** What the rename dialog is renaming. */
export interface RenameDialogProps {
  /** The branch as it is named now, which is also the field's initial value. */
  branch: string
  /** The `worktree` namespace translate. */
  t: TranslateNS<'worktree'>
  /** The failure of the last attempt, kept on screen while the dialog stays open. */
  failure: GitFailure | null
  /** True while the rename is in flight. */
  busy: boolean
  /** Dismiss without renaming. */
  onCancel: () => void
  /**
   * Perform the rename.
   * @param name - the new branch name.
   */
  onSubmit: (name: string) => void
}

/**
 * Render the rename dialog.
 * @param props - the branch and the two ways out.
 * @returns the dialog.
 */
export function RenameDialog({ branch, t, failure, busy, onCancel, onSubmit }: RenameDialogProps) {
  const [name, setName] = useState(branch)
  const fieldId = useId()
  const trimmed = name.trim()
  const verdict = checkBranchName(trimmed)
  const ready = !busy && verdict.ok && trimmed !== branch

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('branches.rename.title')}
      closeLabel={t('confirm.cancel')}
      footer={(
        <div className={css.dialogFooter}>
          <button type="button" className={css.buttonGhost} onClick={onCancel} disabled={busy}>
            {t('confirm.cancel')}
          </button>
          <button
            type="button"
            className={css.buttonPrimary}
            disabled={!ready}
            onClick={() => { onSubmit(trimmed) }}
          >
            {t('confirm.confirm')}
          </button>
        </div>
      )}
    >
      <div className={css.form}>
        <FailureStrip failure={failure} t={t} />
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor={fieldId}>{t('branches.rename.label')}</label>
          <input
            id={fieldId}
            type="text"
            className={verdict.ok || trimmed === '' ? css.input : css.inputInvalid}
            value={name}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            {...verdict.ok || trimmed === '' ? {} : { 'aria-invalid': true }}
            onChange={(event) => { setName(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ready) onSubmit(trimmed)
            }}
          />
          {!verdict.ok && trimmed !== '' && (
            <p className={css.fieldHintError}>{t(`branchName.${verdict.problem}`)}</p>
          )}
        </div>
      </div>
    </Modal>
  )
}
