/**
 * The new-session toolbar, shaped like Claude Code's: the project switcher, the mode chip, and one
 * pill holding the branch and the worktree checkbox — in that order.
 *
 * This seat shadows `ui-workspace`'s own picker (registered one priority lower). The shell draws the
 * folder chip itself and hands its toggle to whichever entry holds the seat, so the chip stays core
 * chrome and this component renders what opening it means: a searchable project list with "Browse
 * for folder…" underneath. The mode chip (`conversation.hero.agentPreset`) is rendered by the shell
 * right after this seat, and every slot's wrapper is `display: contents`, so the pill carries a CSS
 * `order` that places it after the mode chip instead of before it.
 *
 * The pill mirrors Claude Code:
 *
 * - **Worktree unticked** — the session runs in the project folder, so the branch control switches
 *   that folder's branch. git refuses the switch when uncommitted changes would be lost, and the
 *   refusal is shown in the dropdown.
 * - **Worktree ticked** — nothing is created yet. The branch control picks the branch the new worktree
 *   will start from, and the composer's send gate creates the worktree when the first prompt is sent,
 *   named from that prompt. Unticking before then leaves nothing behind.
 *
 * Once a project is selected the pill always holds the third place in the row, so the row reads the
 * same for every project and never reflows when a reading lands:
 *
 * - **Still reading** — a neutral placeholder of the pill's shape, not interactive, not "no git": a
 *   repository must never flash as unsupported before it has been read.
 * - **Not a repository, git unavailable, or switched off** — the pill is drawn disabled, the branch
 *   half reads "no git", the checkbox cannot be ticked, and the tooltip says why. No error box: there
 *   is nothing to do about it here, but an absent control leaves people wondering where it went.
 * @module @achasoft/dsh-worktree/client/HeroWorkspace
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconBranchOutline16, IconChevronDownOutline14, IconFolderClose16, IconFolderOpenOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the hero workspace seat) and the standard kit
// (`useWorkspaces`) the framework hands every root-scope entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorktreeHeroInjected } from './contract.ts'
import { branchLabel, elideMiddle } from './format.ts'
import { PickerPopover, type PickerRow } from './PickerPopover.tsx'
import { heroPicker, stagedSessions } from './staging.ts'
import { heroPillState, type HeroPillState } from './surfaceState.ts'
import { useWorktree } from './useWorktree.ts'
import css from './surface.module.css'

/** Full hero props: runtime share (owner toggle + standard kit) & injected share & locale seat. */
export type HeroWorkspaceProps =
  PropsRuntime<'conversation.hero.workspace'>
  & InjectFace<WorktreeHeroInjected>
  & PropsLocale<'worktree'>

/**
 * Render the project switcher's dropdown and the branch + worktree pill.
 * @param props - the owner's toggle state and pick callback, the injected actions, and the locale seat.
 * @returns the project dropdown, the pill, and any browse failure.
 */
export function HeroWorkspace(props: HeroWorkspaceProps) {
  const {
    useWorkspaces, open, anchorRef, selectedId, onPick, onClose, t,
    describeWorktree, commandsFor, pickDirectory, createWorkspace,
  } = props
  const workspaces = useWorkspaces(state => state.items)
  const selected = workspaces.find(workspace => workspace.workspaceId === selectedId)
  const selectedPath = selected?.path
  const commands = useMemo(
    () => (selectedPath === undefined ? null : commandsFor(selectedPath)),
    [commandsFor, selectedPath],
  )
  const state = useWorktree(describeWorktree, commands)
  const { view, overview, busy, run, failure, clearFailure } = state
  const staging = useSyncExternalStore(stagedSessions.subscribe, stagedSessions.getSnapshot)
  const staged = selectedId === undefined ? undefined : staging.get(selectedId)
  const [browseFailure, setBrowseFailure] = useState<string | undefined>(undefined)
  const [browsing, setBrowsing] = useState(false)
  const [branchesOpen, setBranchesOpen] = useState(false)
  const branchAnchor = useRef<HTMLButtonElement>(null)
  // A stable stand-in for an owner that supplied no anchor: a fresh object per render would re-run
  // the popover's placement effect on every render, and placement itself re-renders.
  const noAnchor = useRef<HTMLElement>(null)

  /** Hand a workspace to the owner, which is what carries the draft and opens its blank session. */
  const pick = useCallback((workspaceId: WorkspaceId): void => { onPick(workspaceId) }, [onPick])

  // The composer's send gate moves to the worktree through this same pick, so the draft is carried
  // exactly as a manual project switch carries it.
  useEffect(() => {
    heroPicker.set(pick)
    return () => { heroPicker.set(undefined) }
  }, [pick])

  const browse = useCallback((): void => {
    onClose()
    setBrowseFailure(undefined)
    setBrowsing(true)
    void pickDirectory().then((path) => {
      if (path === null) return undefined
      return createWorkspace(path).then((workspaceId) => { pick(workspaceId) })
    }).catch((reason: unknown) => {
      setBrowseFailure(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBrowsing(false) })
  }, [onClose, pickDirectory, createWorkspace, pick])

  // With no project to choose between, opening the switcher IS browsing — an empty dropdown with one
  // action row would only be an extra click.
  useEffect(() => {
    if (open && workspaces.length === 0 && !browsing) browse()
  }, [open, workspaces.length, browsing, browse])

  const projectRows: readonly PickerRow[] = workspaces.map(workspace => ({
    id: workspace.workspaceId,
    label: workspace.title,
    detail: workspace.path,
    icon: <IconFolderClose16 size={16} />,
    selected: workspace.workspaceId === selectedId,
  }))

  const pill = heroPillState({ hasProject: selectedId !== undefined, view, overview, failure })
  const pillReady = pill.kind === 'ready'
  const repo = pillReady ? pill.overview.repo : undefined
  // A staged worktree the project turns out not to support must not linger: the send gate acts on
  // the staged choice, and a disabled checkbox cannot be unticked. A reading that has merely not
  // landed yet is not grounds — the pill becomes interactive as soon as it does.
  const unsupported = pill.kind === 'unsupported'
  useEffect(() => {
    if (unsupported && selectedId !== undefined) stagedSessions.clear(selectedId)
  }, [unsupported, selectedId])

  const worktree = staged?.worktree === true
  const shownBranch = worktree && staged?.baseBranch !== undefined
    ? staged.baseBranch
    : repo === undefined ? '' : branchLabel(repo, t('chip.detached'))

  const branchRows: readonly PickerRow[] = (overview?.branches ?? []).map(branch => ({
    id: branch.name,
    label: branch.name,
    ...branch.kind === 'remote' ? { detail: t('branches.remote') } : {},
    icon: <IconBranchOutline16 size={14} />,
    selected: branch.name === shownBranch,
  }))

  const closeBranches = useCallback((): void => {
    setBranchesOpen(false)
    clearFailure()
  }, [clearFailure])

  const pickBranch = (branch: string): void => {
    if (selectedId === undefined || commands === null) return
    if (worktree) {
      // Staged only: the worktree starts from this branch when the first prompt is sent.
      stagedSessions.update(selectedId, { baseBranch: branch })
      closeBranches()
      return
    }
    if (repo?.branch === branch) { closeBranches(); return }
    // The session will run in the project folder, so the folder itself moves to the branch. No
    // carrying: a switch that would drop uncommitted work is refused, and the refusal stays visible.
    void run(() => commands.checkout({ branch, carryChanges: false })).then((result) => {
      if (result !== null) closeBranches()
    })
  }

  const toggleWorktree = (checked: boolean): void => {
    if (selectedId === undefined) return
    if (checked) stagedSessions.update(selectedId, { worktree: true })
    // Unticking forgets the base too: the pill goes back to showing where the folder really is.
    else stagedSessions.clear(selectedId)
  }

  return (
    <>
      <PickerPopover
        open={open && workspaces.length > 0}
        anchorRef={anchorRef ?? noAnchor}
        onClose={onClose}
        rows={projectRows}
        onPick={(id) => { pick(id as WorkspaceId) }}
        placeholder={t('hero.projects.search')}
        ariaLabel={t('hero.projects.title')}
        emptyText={t('hero.projects.empty')}
        action={{
          label: t('hero.projects.browse'),
          icon: <IconFolderOpenOutline16 size={16} />,
          onSelect: browse,
        }}
      />

      {pill.kind === 'ready' && (
        <span className={css.heroPill} role="group" aria-label={t('chip.aria')}>
          <Tooltip
            label={t(worktree ? 'hero.branch.base.tooltip' : 'hero.branch.tooltip')}
            side="bottom"
            delayMs={250}
            disabled={branchesOpen}
          >
            <button
              ref={branchAnchor}
              type="button"
              className={css.heroPillBranch}
              aria-haspopup="dialog"
              aria-expanded={branchesOpen}
              disabled={busy && !branchesOpen}
              onClick={() => { if (branchesOpen) closeBranches(); else setBranchesOpen(true) }}
            >
              <IconBranchOutline16 className={css.heroIcon} size={14} />
              <span className={css.heroText}>{elideMiddle(shownBranch, 24)}</span>
              <IconChevronDownOutline14 className={css.heroIcon} size={12} />
            </button>
          </Tooltip>
          <span className={css.heroPillDivider} aria-hidden="true" />
          <Tooltip
            label={t('hero.worktree.tooltip', { branch: shownBranch })}
            side="bottom"
            delayMs={250}
          >
            <label className={css.heroPillCheck}>
              <input
                type="checkbox"
                className={css.heroCheckBox}
                checked={worktree}
                onChange={(event) => { toggleWorktree(event.target.checked) }}
              />
              <span className={css.heroText}>{t('hero.worktree')}</span>
            </label>
          </Tooltip>
        </span>
      )}

      {pill.kind === 'loading' && <InertPill t={t} loading />}

      {pill.kind === 'unsupported' && <InertPill t={t} reason={unsupportedTooltip(pill, t)} />}

      <PickerPopover
        open={pillReady && branchesOpen}
        anchorRef={branchAnchor}
        onClose={closeBranches}
        rows={branchRows}
        onPick={pickBranch}
        placeholder={t('branches.search')}
        ariaLabel={t('branches.title')}
        emptyText={t('branches.empty')}
        error={branchesOpen ? failure?.message ?? null : null}
        busy={busy}
      />

      {browseFailure !== undefined && (
        <span className={css.heroError} role="alert">{browseFailure}</span>
      )}
    </>
  )
}

/**
 * The tooltip for a disabled pill: the specific reason, in the operator's language.
 * @param pill - the unsupported state.
 * @param t - the locale seat.
 * @returns the sentence to show.
 */
function unsupportedTooltip(
  pill: Extract<HeroPillState, { kind: 'unsupported' }>,
  t: HeroWorkspaceProps['t'],
): string {
  switch (pill.reason) {
    case 'not-a-repository': return t('hero.noGit.notRepository')
    case 'switched-off': return t('hero.noGit.switchedOff')
    case 'unavailable':
      return pill.detail === undefined ? t('hero.noGit.unavailable') : t('hero.noGit.unavailableBecause', { reason: pill.detail })
  }
}

/**
 * The pill's shape with nothing to act on: the loading placeholder, or the disabled "no git" pill.
 *
 * One component for both so they are the same size as each other and as the live pill — the row
 * holds its layout through all three. Nothing inside is a button: the branch half is text, and the
 * checkbox is a disabled native box, so keyboard and pointer users meet one inert control rather than
 * a button that does nothing. The tooltip hangs off the pill itself, which stays focusable when
 * disabled so the reason is reachable without a mouse — a disabled control receives no hover events
 * in some engines, and no focus in any.
 * @param props.t - the locale seat.
 * @param props.loading - render the placeholder rather than the disabled pill.
 * @param props.reason - the disabled pill's tooltip.
 * @returns the inert pill.
 */
function InertPill({ t, loading = false, reason }: { t: HeroWorkspaceProps['t']; loading?: boolean; reason?: string }) {
  const body = (
    <span
      className={loading ? css.heroPillLoading : css.heroPillDisabled}
      role="group"
      aria-label={t('chip.aria')}
      aria-disabled="true"
      {...loading ? { 'aria-busy': true } : { tabIndex: 0 }}
    >
      <span className={css.heroPillStatic}>
        <IconBranchOutline16 className={css.heroIcon} size={14} />
        {loading
          ? <span className={css.heroPlaceholder} aria-hidden="true" />
          : <span className={css.heroText}>{t('hero.noGit')}</span>}
      </span>
      <span className={css.heroPillDivider} aria-hidden="true" />
      <label className={css.heroPillStaticCheck}>
        <input type="checkbox" className={css.heroCheckBox} checked={false} disabled readOnly />
        <span className={css.heroText}>{t('hero.worktree')}</span>
      </label>
    </span>
  )
  if (loading || reason === undefined) return body
  return <Tooltip label={reason} side="bottom" delayMs={250}>{body}</Tooltip>
}
