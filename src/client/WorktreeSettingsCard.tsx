/**
 * The worktree card on the plugin-configuration tab: whether git can answer here, and the eleven
 * preferences that shape what the worktree controls do.
 *
 * The card reproduces the configuration section's own chrome — an `<li>` disclosure card, and fields
 * laid out label / control / hint — because it cannot import those components: value-importing
 * across a plugin boundary fails the client bundle-purity gate, so matching is done by rebuilding
 * against the same design tokens.
 *
 * There is no save or discard. Every control writes immediately through the bound settings scope,
 * which owns revision fencing, so the card carries no staged form whose unsaved state would need
 * reporting. Two fields are the exception in a narrower sense: the path template and the branch
 * prefix hold a local draft while they are typed, because an intermediate keystroke of either is a
 * value the Host would reject or act on surprisingly. Every other control's rejection is prevented
 * the same way — a number below its floor is not sent, and a switch the Host refuses in combination
 * clears its dependent FIRST, in the same gesture. What prevention still misses (another tab's
 * change, a Host rule this card does not mirror) is not lost either: the bound scope resolves even
 * when the Host refuses a write, so every write is verified against the stored value and a refusal
 * is shown at the top of the card (see `./settingsWrites.ts`).
 * @module @achasoft/dsh-worktree/client/WorktreeSettingsCard
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the keyed settings.plugin.item slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { WorktreeView } from '../host/types.ts'
import type { WorktreeSettingsInjected } from './contract.ts'
import { registerWorkspaceWrites, type FieldWrite } from './settingsWrites.ts'
import css from './WorktreeSettingsCard.module.css'

/** Props the renderer binds for the worktree settings card. */
export type WorktreeSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'worktree'>
  & InjectFace<WorktreeSettingsInjected>

/** How long a typed text field must settle before its value is stored. */
const TEXT_DEBOUNCE_MS = 400

/** One labelled row: a control to the right of its label, with a hint beneath. */
function Field(props: {
  id: string
  label: string
  hint: ReactNode
  /** Rendered to the right of the label, where the section's own fields put their badges. */
  control: ReactNode
  /** Rendered under the head instead of beside the label, for a control that needs the full width. */
  wide?: ReactNode
  /** Whether the hint reports a rejected draft rather than describing the field. */
  invalid?: boolean
  /** Whether the row is inert because another setting turned it off. */
  muted?: boolean
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={props.muted === true ? css.labelMuted : css.label} htmlFor={props.id}>
          {props.label}
        </label>
        {props.control}
      </div>
      {props.wide}
      <p className={props.invalid === true ? css.invalid : css.hint}>{props.hint}</p>
    </div>
  )
}

/**
 * Hold a text field's draft locally and store it once typing settles.
 *
 * A draft the Host would reject is never sent, and is KEPT rather than dropped. Sending it instead
 * produces the worst possible field: the write is refused, the draft is cleared, and the input snaps
 * back to the stored value a moment after someone finished typing — with nothing on screen saying
 * why. Holding the draft leaves the rejected text visible under its own error message until it is
 * corrected or the card is closed.
 * @param stored - the committed value, which the draft falls back to.
 * @param commit - stores the settled value.
 * @param acceptable - whether a draft is worth sending; a rejected one is held, not stored.
 * @returns the value to render, and the change handler to bind.
 */
function useDebouncedText(
  stored: string,
  commit: (value: string) => void,
  acceptable: (value: string) => boolean = () => true,
): [string, (value: string) => void] {
  const [draft, setDraft] = useState<string | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit
  const acceptableRef = useRef(acceptable)
  acceptableRef.current = acceptable

  useEffect(() => {
    if (draft === null || !acceptableRef.current(draft)) return undefined
    const timer = setTimeout(() => {
      commitRef.current(draft)
      // Dropping the draft after the write is what lets a value changed from cordis.yml or another
      // tab reach this field again; holding it would pin the input to whatever was last typed here.
      setDraft(null)
    }, TEXT_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [draft])

  return [draft ?? stored, setDraft]
}

/**
 * Whether a path template expands to a distinct directory per branch.
 *
 * The Host refuses one that does not — every worktree would land in the same directory and only the
 * first could be created — so the same rule is applied here, before the write rather than after it.
 * @param template - the template as typed.
 * @returns true when it names the branch.
 */
function templateNamesBranch(template: string): boolean {
  return template.includes('{branch}') || template.includes('{branchPath}')
}

/**
 * Render the worktree settings card.
 * @param props - the bound settings scope, the capability probe, and the locale seat.
 * @returns the card.
 */
export function WorktreeSettingsCard(props: WorktreeSettingsCardProps) {
  const { t, setFields, describeWorktree } = props
  const settings = props.useWorktreeSettings(snapshot => snapshot)
  const [capability, setCapability] = useState<WorktreeView | null>(null)
  const [open, setOpen] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const fieldId = useId()
  const value = settings.value
  const disabled = !settings.writable || value === undefined

  useEffect(() => {
    const controller = new AbortController()
    void describeWorktree(controller.signal).then((next) => {
      if (!controller.signal.aborted) setCapability(next)
    }, () => {
      // A failed probe leaves the status line on its "git was not found" copy, which is the same
      // thing a Host without git shows; every control below stays editable either way.
    })
    return () => { controller.abort() }
  }, [describeWorktree])

  /**
   * Store writes and put a refusal on screen instead of dropping it.
   * @param writes - the fields to store, dependent fields first.
   */
  const write = (writes: readonly FieldWrite[]): void => {
    setWriteError(null)
    setFields(writes).catch((reason: unknown) => {
      setWriteError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const [template, setTemplate] = useDebouncedText(
    value?.worktreePathTemplate ?? '',
    next => { write([['worktreePathTemplate', next]]) },
    templateNamesBranch,
  )
  const [prefix, setPrefix] = useDebouncedText(
    value?.branchPrefix ?? '',
    next => { write([['branchPrefix', next]]) },
  )
  const templateInvalid = !templateNamesBranch(template)

  /** Store a seconds-valued control as the milliseconds the section is spelled in. */
  const setSeconds = (
    field: 'refreshIntervalMs' | 'gitTimeoutMs' | 'networkTimeoutMs', raw: string, floor: number,
  ): void => {
    const seconds = Number(raw)
    if (Number.isSafeInteger(seconds) && seconds >= floor) write([[field, seconds * 1_000]])
  }

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('settings.title')}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        <IconChevronDownOutline14
          className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
        />
      </button>

      {open && (
        <div className={css.body}>
          {writeError !== null && (
            <p className={css.invalid} role="alert">{t('settings.writeRefused', { reason: writeError })}</p>
          )}
          <div className={css.group}>
            <Field
              id={`${fieldId}-git`}
              label={t('settings.git')}
              control={(
                <span className={css.badges}>
                  <span className={capability?.gitAvailable === true ? css.badge : css.badgeMuted}>
                    {capability?.gitAvailable === true
                      ? (capability.gitVersion ?? t('settings.git'))
                      : t('settings.git.missing')}
                  </span>
                </span>
              )}
              /* The reason is an operator diagnostic and stays English by policy; it replaces the
                 field's own description only when there is something wrong to say. */
              hint={capability?.reason ?? t('settings.git.hint')}
            />
            <Field
              id={`${fieldId}-chip`}
              label={t('settings.showChip')}
              control={(
                <input
                  id={`${fieldId}-chip`}
                  className={css.switch}
                  type="checkbox"
                  role="switch"
                  disabled={disabled}
                  checked={value?.showChip ?? true}
                  onChange={(event) => { write([['showChip', event.target.checked]]) }}
                />
              )}
              hint={t('settings.showChip.hint')}
            />
          </div>

          <div className={css.group}>
            <div className={css.groupTitle}>{t('settings.group.worktrees')}</div>
            <Field
              id={`${fieldId}-template`}
              label={t('settings.pathTemplate')}
              control={null}
              wide={(
                <input
                  id={`${fieldId}-template`}
                  className={templateInvalid ? css.inputInvalid : css.inputWide}
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={disabled}
                  {...templateInvalid ? { 'aria-invalid': true } : {}}
                  value={template}
                  onChange={(event) => { setTemplate(event.target.value) }}
                />
              )}
              invalid={templateInvalid}
              hint={templateInvalid
                ? t('settings.pathTemplate.invalid')
                : t('settings.pathTemplate.hint')}
            />
            <Field
              id={`${fieldId}-prefix`}
              label={t('settings.branchPrefix')}
              control={(
                <input
                  id={`${fieldId}-prefix`}
                  className={css.input}
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="feature/"
                  disabled={disabled}
                  value={prefix}
                  onChange={(event) => { setPrefix(event.target.value) }}
                />
              )}
              hint={t('settings.branchPrefix.hint')}
            />
            <Field
              id={`${fieldId}-register`}
              label={t('settings.registerWorkspace')}
              control={(
                <input
                  id={`${fieldId}-register`}
                  className={css.switch}
                  type="checkbox"
                  role="switch"
                  disabled={disabled}
                  checked={value?.registerWorkspace ?? true}
                  onChange={(event) => {
                    // The Host refuses the combination outright and validates after every write, so
                    // the dependent flag is cleared in the same gesture and BEFORE registration.
                    write(registerWorkspaceWrites(event.target.checked, value?.openSession))
                  }}
                />
              )}
              hint={t('settings.registerWorkspace.hint')}
            />
            <Field
              id={`${fieldId}-session`}
              label={t('settings.openSession')}
              muted={value?.registerWorkspace === false}
              control={(
                <input
                  id={`${fieldId}-session`}
                  className={css.switch}
                  type="checkbox"
                  role="switch"
                  disabled={disabled || value?.registerWorkspace === false}
                  checked={value?.openSession ?? true}
                  onChange={(event) => { write([['openSession', event.target.checked]]) }}
                />
              )}
              hint={t('settings.openSession.hint')}
            />
          </div>

          <div className={css.group}>
            <div className={css.groupTitle}>{t('settings.group.branches')}</div>
            <Field
              id={`${fieldId}-remote`}
              label={t('settings.includeRemote')}
              control={(
                <input
                  id={`${fieldId}-remote`}
                  className={css.switch}
                  type="checkbox"
                  role="switch"
                  disabled={disabled}
                  checked={value?.includeRemoteBranches ?? true}
                  onChange={(event) => { write([['includeRemoteBranches', event.target.checked]]) }}
                />
              )}
              hint={t('settings.includeRemote.hint')}
            />
            <Field
              id={`${fieldId}-max`}
              label={t('settings.maxBranches')}
              control={(
                <input
                  id={`${fieldId}-max`}
                  className={css.input}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  disabled={disabled}
                  value={value?.maxBranches ?? ''}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    // A non-integer or zero entry is refused here rather than sent: the Host schema
                    // would reject it, and a rejected write leaves the field looking accepted.
                    if (Number.isSafeInteger(next) && next >= 1) write([['maxBranches', next]])
                  }}
                />
              )}
              hint={t('settings.maxBranches.hint')}
            />
          </div>

          <div className={css.group}>
            <div className={css.groupTitle}>{t('settings.group.timing')}</div>
            {/* Seconds here, milliseconds on the wire: a person setting a cadence or a timeout thinks
                in seconds, while the section's unit is fixed by the schema it shares with cordis.yml. */}
            <Field
              id={`${fieldId}-interval`}
              label={t('settings.refreshInterval')}
              control={(
                <input
                  id={`${fieldId}-interval`}
                  className={css.input}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  disabled={disabled}
                  value={value === undefined ? '' : Math.round(value.refreshIntervalMs / 1_000)}
                  onChange={(event) => { setSeconds('refreshIntervalMs', event.target.value, 0) }}
                />
              )}
              hint={t('settings.refreshInterval.hint')}
            />
            <Field
              id={`${fieldId}-git-timeout`}
              label={t('settings.gitTimeout')}
              control={(
                <input
                  id={`${fieldId}-git-timeout`}
                  className={css.input}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  disabled={disabled}
                  value={value === undefined ? '' : Math.round(value.gitTimeoutMs / 1_000)}
                  onChange={(event) => { setSeconds('gitTimeoutMs', event.target.value, 1) }}
                />
              )}
              hint={t('settings.gitTimeout.hint')}
            />
            <Field
              id={`${fieldId}-network-timeout`}
              label={t('settings.networkTimeout')}
              control={(
                <input
                  id={`${fieldId}-network-timeout`}
                  className={css.input}
                  type="number"
                  min={Math.max(1, Math.round((value?.gitTimeoutMs ?? 1_000) / 1_000))}
                  inputMode="numeric"
                  disabled={disabled}
                  value={value === undefined ? '' : Math.round(value.networkTimeoutMs / 1_000)}
                  onChange={(event) => {
                    // Floored at the local timeout because the Host refuses anything below it; a
                    // write that would be rejected is not sent.
                    setSeconds(
                      'networkTimeoutMs',
                      event.target.value,
                      Math.max(1, Math.round((value?.gitTimeoutMs ?? 1_000) / 1_000)),
                    )
                  }}
                />
              )}
              hint={t('settings.networkTimeout.hint')}
            />
          </div>

          <div className={css.group}>
            <div className={css.groupTitle}>{t('settings.group.safety')}</div>
            <Field
              id={`${fieldId}-confirm`}
              label={t('settings.confirmDestructive')}
              control={(
                <input
                  id={`${fieldId}-confirm`}
                  className={css.switch}
                  type="checkbox"
                  role="switch"
                  disabled={disabled}
                  checked={value?.confirmDestructive ?? true}
                  onChange={(event) => { write([['confirmDestructive', event.target.checked]]) }}
                />
              )}
              hint={t('settings.confirmDestructive.hint')}
            />
          </div>
        </div>
      )}
    </li>
  )
}
