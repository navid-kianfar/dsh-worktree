/**
 * The new-session workspace switcher: which project this session starts in, plus the two controls
 * that decide how it starts there.
 *
 * This seat shadows `ui-workspace`'s own picker (registered one priority lower) rather than
 * replacing the core chrome, because the chrome is not a slot: the shell draws the folder chip and
 * hands every occupant the same owner share. Shadowing is the documented way to change what the
 * chip's cluster contains without forking the shell, and the chip itself keeps working — it is the
 * owner's toggle, and this component renders what opening it means.
 *
 * Three departures from the core picker, all of them the reason this exists:
 *
 * - **No "Add workspace…" row.** A menu whose job is choosing between projects must not also be the
 *   only way to create one; a row that leaves the menu for a dialog reads as a third choice rather
 *   than an action, which is precisely the confusion this replaces. Adopting a directory is its own
 *   labelled button, so the menu is only ever a switcher.
 * - **`Open Workspace` as a button.** It calls the Host's own chooser and starts a session in what
 *   it returns — the one action that was previously buried as the last row of the menu.
 * - **A worktree checkbox.** Ticking it puts the session in a fresh git worktree instead of the
 *   repository: the worktree is created immediately (a session can only be pointed at a directory
 *   that exists) on a provisional branch, and the session-header seat renames that branch from the
 *   first prompt, because nobody can name a task before they have described it.
 * @module @achasoft/dsh-worktree/client/HeroWorkspace
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { IconFolderClose16, IconFolderOpen16, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the hero workspace seat) and the standard kit
// (`useWorkspaces`) the framework hands every root-scope entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { applyBranchPrefix } from '../shared/branch-name.ts'
import type { WorktreeHeroInjected } from './contract.ts'
import { FailureStrip } from './FailureStrip.tsx'
import { worktreeIntents, type WorktreeIntent } from './intents.ts'
import { useWorktree } from './useWorktree.ts'
import css from './surface.module.css'

/** Full hero props: runtime share (owner toggle + standard kit) & injected share & locale seat. */
export type HeroWorkspaceProps =
  PropsRuntime<'conversation.hero.workspace'>
  & InjectFace<WorktreeHeroInjected>
  & PropsLocale<'worktree'>

/**
 * A provisional branch name that cannot collide with a typed one.
 *
 * Prefixed with `wt-` and suffixed with random hex rather than derived from anything, because it is
 * thrown away: the branch is renamed from the prompt as soon as there is one, and this name only has
 * to be unique for the seconds between creating the worktree and naming it.
 * @returns an unremarkable branch-name component.
 */
function provisionalBranch(): string {
  // `crypto.randomUUID` needs a secure context, which a harness reached over a LAN address is not;
  // a weak suffix is fine here because it only has to be unique among one repository's worktrees.
  const suffix = globalThis.crypto?.randomUUID === undefined
    ? Math.random().toString(16).slice(2, 10).padEnd(8, '0')
    : globalThis.crypto.randomUUID().replace(/-/gu, '').slice(0, 8)
  return `wt-${suffix}`
}

/**
 * Render the workspace switcher, the open-workspace button, and the worktree checkbox.
 * @param props - the owner's toggle state and pick callback, the injected actions, and the locale seat.
 * @returns the menu and the two controls beside the chip.
 */
export function HeroWorkspace(props: HeroWorkspaceProps) {
  const {
    useWorkspaces, open, anchorRef, selectedId, onPick, onClose, t,
    describeWorktree, commandsFor, pickDirectory, createWorkspace,
  } = props
  const workspaces = useWorkspaces(state => state.items)
  const selectedPath = workspaces.find(workspace => workspace.workspaceId === selectedId)?.path
  const commands = useMemo(
    () => (selectedPath === undefined ? null : commandsFor(selectedPath)),
    [commandsFor, selectedPath],
  )
  const state = useWorktree(describeWorktree, commands)
  const { view, overview, busy, run, failure } = state
  const intents = useSyncExternalStore(worktreeIntents.subscribe, worktreeIntents.getSnapshot)
  const intent = intents.find(entry => entry.workspaceId === selectedId)
  const [openFailure, setOpenFailure] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState(false)

  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )

  /** Hand a workspace to the owner, which is what carries the draft and opens its blank session. */
  const pick = useCallback((workspaceId: WorkspaceId): void => { onPick(workspaceId) }, [onPick])

  const openWorkspace = useCallback((): void => {
    onClose()
    setOpenFailure(undefined)
    setPicking(true)
    void pickDirectory().then((path) => {
      if (path === null) return undefined
      return createWorkspace(path).then((workspaceId) => { pick(workspaceId) })
    }).catch((reason: unknown) => {
      setOpenFailure(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setPicking(false) })
  }, [onClose, pickDirectory, createWorkspace, pick])

  // A menu is for choosing between targets. With none to choose between, the chip's gesture IS the
  // open action — the same rule the core picker applies, kept because the chip is still core chrome
  // and someone clicking it must not get an empty popover.
  useEffect(() => {
    if (open && workspaces.length === 0 && !picking) openWorkspace()
  }, [open, workspaces.length, picking, openWorkspace])

  const check = useCallback((): void => {
    if (selectedId === undefined || commands === null || view === null) return
    setOpenFailure(undefined)
    const branch = applyBranchPrefix(view.branchPrefix, provisionalBranch())
    void run(() => commands.addWorktree({ branch, createBranch: true, detach: false })).then((created) => {
      if (created === null) return undefined
      return createWorkspace(created.path).then((workspaceId) => {
        worktreeIntents.set({
          workspaceId,
          baseWorkspaceId: selectedId,
          path: created.path,
          branch: created.branch ?? branch,
          named: false,
        })
        pick(workspaceId)
      }).catch((reason: unknown) => {
        // The worktree exists but nothing can reach it, and leaving it behind would be a directory
        // nobody asked for: remove it, and let the git failure surface if even that fails.
        void run(() => commands.removeWorktree({ path: created.path, force: false }))
        throw reason
      })
    }).catch((reason: unknown) => {
      setOpenFailure(reason instanceof Error ? reason.message : String(reason))
    })
  }, [selectedId, commands, view, run, createWorkspace, pick])

  const uncheck = useCallback((entry: WorktreeIntent): void => {
    if (commands === null) return
    setOpenFailure(undefined)
    void run(() => commands.removeWorktree({ path: entry.path, force: false })).then((removed) => {
      if (removed === null) return undefined
      // The branch is this surface's own provisional name — nobody had it before the checkbox was
      // ticked — so it goes with the worktree. A branch someone has since committed to is refused by
      // `force: false`, which is the answer we want: the worktree is already gone and the commits stay.
      return run(() => commands.deleteBranch({ branch: entry.branch, force: false })).then(() => {
        worktreeIntents.forget(entry.workspaceId)
        pick(entry.baseWorkspaceId)
      })
    }).catch((reason: unknown) => {
      setOpenFailure(reason instanceof Error ? reason.message : String(reason))
    })
  }, [commands, run, pick])

  const items: readonly MenuEntry[] = workspaces.map(workspace => ({
    id: workspace.workspaceId,
    label: workspace.title,
    icon: <IconFolderClose16 size={16} />,
  }))

  // The menu opens on the owner's toggle, but never as the empty popover the "no workspaces" case
  // would otherwise produce — the effect above has already turned that gesture into the chooser.
  const menuOpen = open && workspaces.length > 0
  // The control needs a repository it could actually branch: a deployment without git, a workspace
  // that is not a repository, and a workspace whose reading has not landed yet all hide it rather
  // than offering something it cannot do.
  const worktreeOffered = view !== null && view.showChip && view.gitAvailable
    && commands !== null && overview !== null

  return (
    <>
      <Menu
        open={menuOpen}
        anchor={null}
        items={items}
        selectedId={selectedId}
        onSelect={(id) => { pick(id as WorkspaceId) }}
        onClose={onClose}
        side="bottom"
        portal
        getAnchorRect={getAnchorRect}
      />

      <Tooltip label={t('hero.open.tooltip')} side="bottom" delayMs={250}>
        <button
          type="button"
          className={css.heroOpen}
          disabled={picking}
          onClick={openWorkspace}
        >
          <IconFolderOpen16 className={css.heroIcon} size={16} />
          <span className={css.heroText}>{t('hero.open')}</span>
        </button>
      </Tooltip>

      {worktreeOffered && (
        <Tooltip label={t('hero.worktree.tooltip')} side="bottom" delayMs={250}>
          <label className={css.heroCheck}>
            <input
              type="checkbox"
              className={css.heroCheckBox}
              checked={intent !== undefined}
              disabled={busy}
              onChange={() => {
                if (intent === undefined) check()
                else uncheck(intent)
              }}
            />
            <span className={css.heroText}>{t('hero.worktree')}</span>
          </label>
        </Tooltip>
      )}

      {(failure !== null || openFailure !== undefined) && (
        <div className={css.heroError}>
          <FailureStrip failure={failure} t={t} />
          {openFailure !== undefined && (
            <span className={css.heroErrorText} role="alert">{openFailure}</span>
          )}
        </div>
      )}
    </>
  )
}
