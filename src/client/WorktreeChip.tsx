/**
 * The session-header chip: which branch and which worktree this session is working in, and the two
 * popovers that change either.
 *
 * The chip renders only when it has something true to say. No workspace, no git, a workspace that is
 * not a repository, or the deployment having switched it off all render nothing at all — a control
 * that cannot act is worse than an absent one, and the settings card is where the reason belongs.
 * @module @achasoft/dsh-worktree/client/WorktreeChip
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlusOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the session-header utilities seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { basenameOf } from '../shared/path.ts'
import type { WorktreeEntry } from '../host/types.ts'
import type { WorktreeChipInjected } from './contract.ts'
import { GitBranchGlyph, WorktreeGlyph } from './Glyphs.tsx'
import { BranchPanel } from './BranchPanel.tsx'
import { WorktreePanel } from './WorktreePanel.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { CreateWorktreeDialog } from './CreateWorktreeDialog.tsx'
import { RenameDialog } from './RenameDialog.tsx'
import { branchLabel, dirtyCount, elideMiddle, trackingLabel } from './format.ts'
import { useWorktree } from './useWorktree.ts'
import css from './surface.module.css'

/** Full chip props: runtime share (standard kit + header owner) & injected share & locale seat. */
export type WorktreeChipProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<WorktreeChipInjected>
  & PropsLocale<'worktree'>

/** Which popover is showing, if either. */
type OpenPanel = 'branch' | 'worktree' | null

/** Which dialog is showing, if any. */
type Dialog =
  | { readonly kind: 'create'; readonly branch?: string }
  | { readonly kind: 'rename'; readonly branch: string }
  | { readonly kind: 'delete-branch'; readonly branch: string }
  | { readonly kind: 'remove-worktree'; readonly entry: WorktreeEntry }
  | null

/**
 * Render the chip, its popovers, and whichever dialog is open.
 * @param props - the standard kit, the injected commands, and the locale seat.
 * @returns the chip, or null when there is nothing true to draw.
 */
export function WorktreeChip(props: WorktreeChipProps) {
  const { sessionId, useWorkspaces, describeWorktree, commandsFor, adoptWorkspace, revealPath, t } = props
  const [panel, setPanel] = useState<OpenPanel>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  const workspacePath = useWorkspaces(
    snapshot => snapshot.items.find(item => item.sessionIds.includes(sessionId))?.path,
  )
  const commands = useMemo(
    () => (workspacePath === undefined ? null : commandsFor(workspacePath)),
    [commandsFor, workspacePath],
  )
  const state = useWorktree(describeWorktree, commands)
  const { view, overview, busy, run, clearFailure } = state

  const close = useCallback((): void => {
    setPanel(null)
    clearFailure()
  }, [clearFailure])

  // A dialog portals to the body, so the popover's containment check would read a click inside it as
  // a click outside. Closing the popover as the dialog opens sidesteps that entirely, and is what a
  // person expects anyway: the dialog is now the thing being worked in.
  const openDialog = useCallback((next: Dialog): void => {
    setPanel(null)
    clearFailure()
    setDialog(next)
  }, [clearFailure])

  const closeDialog = useCallback((): void => {
    setDialog(null)
    clearFailure()
  }, [clearFailure])

  useEffect(() => {
    if (panel === null) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) === true) return
      // A row's action menu is portaled to the body, so DOM containment in this chip's own subtree
      // cannot see it. Without the marker check the popover would close on pointerdown and unmount
      // the menu item before the click that opened it ever landed.
      const element = target instanceof Element ? target : target.parentElement
      if (element?.closest('[data-worktree-portal]') != null) return
      setPanel(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPanel(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panel])

  /**
   * Adopt a worktree directory and move the harness into it.
   *
   * Always with a session, and always adopting, whatever the settings say: those two preferences are
   * the DEFAULTS the create dialog opens with, while this is someone clicking a worktree row — which
   * has one meaning, and cannot be honored without a Workspace to open the session in.
   */
  const openWorktree = useCallback((path: string): void => {
    setPanel(null)
    void adoptWorkspace(path, true).catch(() => {
      // Adoption failures belong to the Workspaces domain, which reports them on the session list's
      // own error state; there is no second place for this surface to say the same thing.
    })
  }, [adoptWorkspace])

  if (view === null || !view.showChip || commands === null || overview === null) return null

  const { repo } = overview
  const dirty = dirtyCount(repo.dirty)
  const track = trackingLabel(repo.tracking)
  const label = repo.unborn ? t('chip.unborn') : branchLabel(repo, t('chip.detached'))
  const current = overview.worktrees.find(entry => entry.current)
  const worktreeName = basenameOf(current?.path ?? repo.worktreeRoot)

  return (
    <span ref={rootRef} className={css.root}>
      <span className={css.pill}>
        <Tooltip label={t('chip.branch.tooltip')} side="bottom" delayMs={250} disabled={panel !== null}>
          <button
            type="button"
            className={css.segment}
            aria-label={t('chip.aria')}
            aria-haspopup="dialog"
            aria-expanded={panel === 'branch'}
            onClick={() => { setPanel(panel === 'branch' ? null : 'branch') }}
          >
            <GitBranchGlyph className={css.segmentIcon} width={14} height={14} />
            <span className={css.segmentText}>{elideMiddle(label)}</span>
            {track !== '' && <span className={css.segmentTrack}>{track}</span>}
            {dirty > 0 && <span className={css.dirtyDot} title={t('chip.dirty')} />}
          </button>
        </Tooltip>

        <Tooltip label={t('chip.worktree.tooltip')} side="bottom" delayMs={250} disabled={panel !== null}>
          <button
            type="button"
            className={css.segmentDivider}
            aria-label={t('worktrees.title')}
            aria-haspopup="dialog"
            aria-expanded={panel === 'worktree'}
            onClick={() => { setPanel(panel === 'worktree' ? null : 'worktree') }}
          >
            <WorktreeGlyph className={css.segmentIcon} width={14} height={14} />
            <span className={css.segmentText}>{elideMiddle(worktreeName, 16)}</span>
            {overview.worktrees.length > 1 && (
              <span className={css.count}>{overview.worktrees.length}</span>
            )}
          </button>
        </Tooltip>
      </span>

      <Tooltip label={t('chip.create.tooltip')} side="bottom" delayMs={250}>
        <button
          type="button"
          className={css.add}
          aria-label={t('chip.create.tooltip')}
          disabled={busy}
          onClick={() => { openDialog({ kind: 'create' }) }}
        >
          <IconPlusOutline16 />
        </button>
      </Tooltip>

      {panel === 'branch' && (
        <div className={css.panel} role="dialog" aria-label={t('branches.title')}>
          <BranchPanel
            overview={overview}
            state={state}
            t={t}
            branchPrefix={view.branchPrefix}
            onFetch={() => { void run(() => commands.fetch()) }}
            onCheckout={(branch, carryChanges) => {
              void run(() => commands.checkout({ branch, carryChanges })).then((result) => {
                if (result !== null) close()
              })
            }}
            onCreate={(branch) => {
              void run(() => commands.createBranch({ branch, checkout: true })).then((result) => {
                if (result !== null) close()
              })
            }}
            onWorktreeFor={(branch) => { openDialog({ kind: 'create', branch }) }}
            onRename={(branch) => { openDialog({ kind: 'rename', branch }) }}
            onDelete={(branch) => { openDialog({ kind: 'delete-branch', branch }) }}
            onJump={openWorktree}
          />
        </div>
      )}

      {panel === 'worktree' && (
        <div className={css.panel} role="dialog" aria-label={t('worktrees.title')}>
          <WorktreePanel
            overview={overview}
            state={state}
            t={t}
            onOpen={openWorktree}
            onReveal={(path) => {
              void revealPath(path).catch(() => {
                // Revealing is a convenience the Host may not support; failing it silently keeps a
                // popover from turning into an error surface for something nothing depends on.
              })
            }}
            onLock={(path, locked) => { void run(() => commands.lockWorktree({ path, locked })) }}
            onRemove={(entry) => { openDialog({ kind: 'remove-worktree', entry }) }}
            onPrune={() => { void run(() => commands.pruneWorktrees()) }}
            onCreate={() => { openDialog({ kind: 'create' }) }}
          />
        </div>
      )}

      {dialog?.kind === 'create' && (
        <CreateWorktreeDialog
          overview={overview}
          view={view}
          commands={commands}
          {...dialog.branch === undefined ? {} : { initialBranch: dialog.branch }}
          t={t}
          failure={state.failure}
          busy={busy}
          onCancel={closeDialog}
          onSubmit={(request) => {
            void run(() => commands.addWorktree({
              branch: request.branch,
              path: request.path,
              createBranch: request.createBranch,
              ...request.startPoint === undefined ? {} : { startPoint: request.startPoint },
              detach: false,
            })).then((created) => {
              if (created === null) return
              closeDialog()
              // Adoption is a separate step, and deliberately outside `run`: the worktree already
              // exists by now, so a Workspaces-domain failure must not read as the creation having
              // failed. It runs on the path git settled on rather than the one that was typed —
              // git canonicalizes the destination, and a Workspace registered under the other
              // spelling would be a second entry for one directory.
              if (!request.register) return
              void adoptWorkspace(created.path, request.openSession).catch(() => {
                // Reported by the Workspaces domain on the session list's own error state.
              })
            })
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <RenameDialog
          branch={dialog.branch}
          t={t}
          failure={state.failure}
          busy={busy}
          onCancel={closeDialog}
          onSubmit={(name) => {
            void run(() => commands.renameBranch({ branch: dialog.branch, name })).then((result) => {
              if (result !== null) closeDialog()
            })
          }}
        />
      )}

      {dialog?.kind === 'delete-branch' && (
        <ConfirmDialog
          title={t('branches.delete.title', { name: dialog.branch })}
          body={t('branches.delete.body')}
          forceLabel={t('branches.delete.force')}
          typedValue={dialog.branch}
          requireTyped={view.confirmDestructive}
          confirmLabel={t('branches.delete.confirm')}
          t={t}
          failure={state.failure}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={(force) => {
            void run(() => commands.deleteBranch({ branch: dialog.branch, force })).then((result) => {
              if (result !== null) closeDialog()
            })
          }}
        />
      )}

      {dialog?.kind === 'remove-worktree' && (
        <ConfirmDialog
          title={t('worktrees.remove.title')}
          body={t('worktrees.remove.body', { path: dialog.entry.path })}
          forceLabel={t('worktrees.remove.force')}
          typedValue={basenameOf(dialog.entry.path)}
          requireTyped={view.confirmDestructive}
          confirmLabel={t('worktrees.remove.confirm')}
          t={t}
          failure={state.failure}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={(force) => {
            void run(() => commands.removeWorktree({ path: dialog.entry.path, force })).then((result) => {
              if (result !== null) closeDialog()
            })
          }}
        />
      )}
    </span>
  )
}
