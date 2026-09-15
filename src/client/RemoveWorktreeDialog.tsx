/**
 * The confirmation for removing a worktree, which first reads what the removal would delete.
 *
 * `git worktree remove` without `--force` refuses modified and untracked files, but deletes ignored
 * ones — a `.env`, a local build, credentials — without a word. The generic confirmation's typed gate
 * guards only the forced form, so on its own it let an unforced removal take those files with no
 * warning at all. This dialog asks the Host what the worktree holds, names the ignored entries, and
 * will not confirm until someone ticks that they may go. The Host enforces the same rule, so a file
 * that appears between the reading and the click is refused rather than silently deleted — and that
 * refusal makes the dialog read again.
 * @module @achasoft/dsh-worktree/client/RemoveWorktreeDialog
 */

import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { basenameOf } from '../shared/path.ts'
import type { GitFailure, WorktreeContents, WorktreeEntry } from '../host/types.ts'
import type { WorktreeCommands } from './contract.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import css from './surface.module.css'

/** What is known about the worktree's contents. */
type Inspection =
  | { readonly kind: 'pending' }
  | { readonly kind: 'done'; readonly contents: WorktreeContents }
  | { readonly kind: 'failed'; readonly reason: string }

/** What the removal confirmation needs. */
export interface RemoveWorktreeDialogProps {
  /** The worktree to remove. */
  entry: WorktreeEntry
  /** The bound git commands for the session's workspace. */
  commands: WorktreeCommands
  /** Whether this deployment requires the typed confirmation for a forced removal. */
  requireTyped: boolean
  /** The `worktree` namespace translate. */
  t: TranslateNS<'worktree'>
  /** The failure of the last attempt. */
  failure: GitFailure | null
  /** True while the removal is in flight. */
  busy: boolean
  /** Dismiss without acting. */
  onCancel: () => void
  /**
   * Remove the worktree.
   * @param force - whether the force switch was on.
   * @param discardIgnored - whether the ignored entries were acknowledged.
   */
  onConfirm: (force: boolean, discardIgnored: boolean) => void
}

/**
 * Render the removal confirmation.
 * @param props - the worktree, the commands to inspect it with, and the confirmation's callbacks.
 * @returns the dialog.
 */
export function RemoveWorktreeDialog(props: RemoveWorktreeDialogProps) {
  const { entry, commands, requireTyped, t, failure, busy, onCancel, onConfirm } = props
  const [inspection, setInspection] = useState<Inspection>({ kind: 'pending' })

  // Read on open, and again after a failed attempt: the Host refuses a removal over ignored files
  // that appeared since the last reading, and the fresh reading is what lets them be acknowledged.
  useEffect(() => {
    const controller = new AbortController()
    setInspection({ kind: 'pending' })
    void commands.inspectWorktree(entry.path, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setInspection(result.ok ? { kind: 'done', contents: result } : { kind: 'failed', reason: result.message })
    }, (reason: unknown) => {
      if (controller.signal.aborted) return
      setInspection({ kind: 'failed', reason: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { controller.abort() }
  }, [commands, entry.path, failure])

  const ignored = inspection.kind === 'done' ? inspection.contents.ignored : 0

  return (
    <ConfirmDialog
      title={t('worktrees.remove.title')}
      body={t('worktrees.remove.body', { path: entry.path })}
      details={<InspectionDetails inspection={inspection} t={t} />}
      {...ignored > 0 ? { acknowledgeLabel: t('worktrees.remove.ignored.confirm', { count: String(ignored) }) } : {}}
      pending={inspection.kind === 'pending'}
      forceLabel={t('worktrees.remove.force')}
      typedValue={basenameOf(entry.path)}
      requireTyped={requireTyped}
      confirmLabel={t('worktrees.remove.confirm')}
      t={t}
      failure={failure}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

/**
 * The facts under the confirmation's sentence.
 * @param props.inspection - what is known about the worktree's contents.
 * @param props.t - the `worktree` namespace translate.
 * @returns the reading's state, the ignored entries, and the uncommitted note, as applicable.
 */
function InspectionDetails({ inspection, t }: { inspection: Inspection; t: TranslateNS<'worktree'> }) {
  switch (inspection.kind) {
    case 'pending':
      return <p className={css.fieldHint}>{t('worktrees.remove.inspecting')}</p>
    case 'failed':
      return <p className={css.fieldHintWarn}>{t('worktrees.remove.inspectFailed', { reason: inspection.reason })}</p>
    case 'done': {
      const { contents } = inspection
      const uncommitted = contents.modified + contents.untracked
      const unnamed = contents.ignored - contents.ignoredPaths.length
      return (
        <>
          {contents.ignored > 0 && (
            <div className={css.field}>
              <p className={css.fieldHintWarn}>{t('worktrees.remove.ignored', { count: String(contents.ignored) })}</p>
              <ul className={css.pathList}>
                {contents.ignoredPaths.map(path => <li key={path} className={css.code}>{path}</li>)}
              </ul>
              {unnamed > 0 && (
                <p className={css.fieldHint}>{t('worktrees.remove.ignored.more', { count: String(unnamed) })}</p>
              )}
            </div>
          )}
          {uncommitted > 0 && (
            <p className={css.fieldHint}>{t('worktrees.remove.uncommitted', { count: String(uncommitted) })}</p>
          )}
        </>
      )
    }
  }
}
