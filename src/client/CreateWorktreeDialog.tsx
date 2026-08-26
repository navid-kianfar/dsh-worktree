/**
 * The create-worktree dialog: a branch, a directory, and what to do with the result.
 *
 * The directory follows the branch name through the Host's own template expansion until someone
 * edits it, and then stops — an auto-filled field that overwrites a typed one is worse than no
 * suggestion at all. Whether the new directory is then adopted as a Workspace and opened is decided
 * here rather than assumed, because a worktree created to compare two branches is not necessarily
 * one you want to move the session into.
 * @module @achasoft/dsh-worktree/client/CreateWorktreeDialog
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { applyBranchPrefix, checkBranchName } from '../shared/branch-name.ts'
import { isAbsolutePath } from '../shared/path.ts'
import type { GitFailure, OverviewSuccess, WorktreeView } from '../host/types.ts'
import type { WorktreeCommands } from './contract.ts'
import { FailureStrip } from './FailureStrip.tsx'
import css from './surface.module.css'

/** How long the typed branch name must settle before the Host is asked to expand a path for it. */
const SUGGEST_DEBOUNCE_MS = 250

/** What the create dialog needs. */
export interface CreateWorktreeDialogProps {
  /** The current reading, which supplies the existing-branch choices. */
  overview: OverviewSuccess
  /** The capability view, which supplies the prefix and the two adoption defaults. */
  view: WorktreeView
  /** The git operations bound to the current workspace; only `suggestPath` is called from here. */
  commands: WorktreeCommands
  /** A branch to prefill, from a branch row's "New worktree for this branch". */
  initialBranch?: string
  /** The `worktree` namespace translate. */
  t: TranslateNS<'worktree'>
  /** The failure of the last attempt, kept on screen while the dialog stays open. */
  failure: GitFailure | null
  /** True while the creation is in flight. */
  busy: boolean
  /** Dismiss without creating. */
  onCancel: () => void
  /**
   * Create the worktree.
   * @param request - the branch, destination, and what to do with the result.
   */
  onSubmit: (request: {
    branch: string
    path: string
    createBranch: boolean
    startPoint: string | undefined
    register: boolean
    openSession: boolean
  }) => void
}

/**
 * Render the create-worktree dialog.
 * @param props - the reading, the capability view, and the two ways out.
 * @returns the dialog.
 */
export function CreateWorktreeDialog(props: CreateWorktreeDialogProps) {
  const { overview, view, commands, initialBranch, t, failure, busy, onCancel, onSubmit } = props

  // A prefilled branch always came from a row for a branch that already exists, so the dialog opens
  // on the mode that can act on it.
  const [creating, setCreating] = useState(initialBranch === undefined)
  const [branch, setBranch] = useState(initialBranch ?? '')
  const [startPoint, setStartPoint] = useState('')
  const [path, setPath] = useState('')
  const [pathEdited, setPathEdited] = useState(false)
  const [pathState, setPathState] = useState<{ exists: boolean; empty: boolean } | null>(null)
  const [register, setRegister] = useState(view.registerWorkspace)
  const [openSession, setOpenSession] = useState(view.openSession)
  const fieldId = useId()
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  /** Local branches no worktree already holds — the only ones an existing-branch worktree can use. */
  const available = useMemo(
    () => overview.branches.filter(entry => entry.kind === 'local' && entry.checkedOutAt === undefined),
    [overview.branches],
  )

  const typed = branch.trim()
  const effective = creating ? applyBranchPrefix(view.branchPrefix, typed) : typed
  const verdict = checkBranchName(effective)

  // The suggestion is asked of the Host rather than expanded here, because the template it expands
  // lives in the Host's settings and may name directories only the Host can resolve.
  useEffect(() => {
    if (pathEdited || !verdict.ok) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void commands.suggestPath(effective, controller.signal).then((result) => {
        if (!aliveRef.current || controller.signal.aborted || !result.ok) return
        setPath(result.path)
        setPathState({ exists: result.exists, empty: result.emptyDirectory })
      }, () => {
        // A suggestion that did not arrive leaves the field as it was; the person can type a path,
        // and the Host validates whatever is submitted either way.
      })
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [commands, effective, pathEdited, verdict.ok])

  const pathReady = path.trim() !== '' && isAbsolutePath(path.trim())
  const ready = !busy && verdict.ok && pathReady
    && (creating || available.some(entry => entry.name === effective))

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('create.title')}
      description={t('create.description')}
      closeLabel={t('create.cancel')}
      footer={(
        <div className={css.dialogFooter}>
          <button type="button" className={css.buttonGhost} onClick={onCancel} disabled={busy}>
            {t('create.cancel')}
          </button>
          <button
            type="button"
            className={css.buttonPrimary}
            disabled={!ready}
            onClick={() => {
              onSubmit({
                branch: effective,
                path: path.trim(),
                createBranch: creating,
                startPoint: creating && startPoint.trim() !== '' ? startPoint.trim() : undefined,
                register,
                openSession: register && openSession,
              })
            }}
          >
            {busy ? t('create.working') : t('create.submit')}
          </button>
        </div>
      )}
    >
      <div className={css.form}>
        <FailureStrip failure={failure} t={t} />

        <div className={css.field}>
          <span className={css.fieldLabel} id={`${fieldId}-mode`}>{t('create.mode')}</span>
          <span className={css.choice} role="group" aria-labelledby={`${fieldId}-mode`}>
            <button
              type="button"
              className={css.choiceOption}
              aria-pressed={creating}
              disabled={busy}
              onClick={() => {
                setCreating(true)
                setPathEdited(false)
              }}
            >
              {t('create.mode.new')}
            </button>
            <button
              type="button"
              className={css.choiceOption}
              aria-pressed={!creating}
              disabled={busy || available.length === 0}
              onClick={() => {
                setCreating(false)
                setPathEdited(false)
                // Landing on the mode with an empty select would leave the submit control unusable
                // for a reason nothing on screen explains, so the first choice is taken.
                if (!available.some(entry => entry.name === branch.trim())) {
                  setBranch(available[0]?.name ?? '')
                }
              }}
            >
              {t('create.mode.existing')}
            </button>
          </span>
        </div>

        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor={`${fieldId}-branch`}>
            {creating ? t('create.branch') : t('create.branch.select')}
          </label>
          {creating ? (
            <input
              id={`${fieldId}-branch`}
              type="text"
              className={verdict.ok || typed === '' ? css.input : css.inputInvalid}
              value={branch}
              placeholder={t('create.branch.placeholder')}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              {...verdict.ok || typed === '' ? {} : { 'aria-invalid': true }}
              onChange={(event) => { setBranch(event.target.value) }}
            />
          ) : (
            <select
              id={`${fieldId}-branch`}
              className={css.select}
              value={branch}
              disabled={busy}
              onChange={(event) => {
                setBranch(event.target.value)
                setPathEdited(false)
              }}
            >
              {available.map(entry => (
                <option key={entry.ref} value={entry.name}>{entry.name}</option>
              ))}
            </select>
          )}
          {creating && view.branchPrefix !== '' && typed !== '' && effective !== typed && (
            <p className={css.fieldHint}>
              <span className={css.code}>{effective}</span>
            </p>
          )}
          {!verdict.ok && typed !== '' && (
            <p className={css.fieldHintError}>{t(`branchName.${verdict.problem}`)}</p>
          )}
        </div>

        {creating && (
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor={`${fieldId}-start`}>{t('create.start')}</label>
            <input
              id={`${fieldId}-start`}
              type="text"
              className={css.input}
              value={startPoint}
              placeholder={overview.repo.branch ?? overview.repo.sha ?? ''}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => { setStartPoint(event.target.value) }}
            />
            <p className={css.fieldHint}>{t('create.start.hint')}</p>
          </div>
        )}

        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor={`${fieldId}-path`}>{t('create.path')}</label>
          <input
            id={`${fieldId}-path`}
            type="text"
            className={pathReady || path === '' ? css.input : css.inputInvalid}
            value={path}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setPath(event.target.value)
              setPathEdited(true)
              // The reading belongs to the suggested path, not to whatever is being typed over it.
              setPathState(null)
            }}
          />
          {pathState?.exists === true && (
            <p className={pathState.empty ? css.fieldHintWarn : css.fieldHintError}>
              {pathState.empty ? t('create.path.reuse') : t('create.path.exists')}
            </p>
          )}
          {pathState?.exists !== true && <p className={css.fieldHint}>{t('create.path.hint')}</p>}
        </div>

        <label className={css.toggleRow}>
          <input
            type="checkbox"
            role="switch"
            className={css.switch}
            checked={register}
            disabled={busy}
            onChange={(event) => { setRegister(event.target.checked) }}
          />
          <span className={css.toggleText}>
            <span className={css.fieldLabel}>{t('create.register')}</span>
          </span>
        </label>

        <label className={css.toggleRow}>
          <input
            type="checkbox"
            role="switch"
            className={css.switch}
            checked={register && openSession}
            // A session opens IN a Workspace, so this is unreachable while the directory is not
            // being adopted as one.
            disabled={busy || !register}
            onChange={(event) => { setOpenSession(event.target.checked) }}
          />
          <span className={css.toggleText}>
            <span className={css.fieldLabel}>{t('create.open')}</span>
          </span>
        </label>
      </div>
    </Modal>
  )
}
