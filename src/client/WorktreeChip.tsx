/**
 * The session's branch and worktree control: which branch and which worktree this session is working
 * in, and the two popovers that change either.
 *
 * It sits in a slim row of its own directly above the composer card (`conversation.input.dock`),
 * not in the session header. That is where the new-session pill sits before the first prompt, so the
 * control stays in the place people already looked for it once the session has started, and it is
 * next to the thing it qualifies — what the next prompt will run against. Being below the transcript
 * means its popovers open upward.
 *
 * The row renders only when it has something true to say. A blank session renders nothing, because
 * the shell's new-session hero is on screen and already carries this plugin's pill. No workspace, no
 * git, a workspace that is not a repository, or the deployment having switched it off also render
 * nothing — in a running session a control that cannot act is noise above the composer, and the
 * settings card is where the reason belongs.
 * @module @achasoft/dsh-worktree/client/WorktreeChip
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlusOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the input dock seat).
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
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog.tsx'
import { branchLabel, dirtyCount, elideMiddle, trackingLabel } from './format.ts'
import { sessionStarted, type SessionPhaseFacts } from './surfaceState.ts'
import { useWorktree } from './useWorktree.ts'
import css from './surface.module.css'

/** Full chip props: runtime share (standard kit + dock owner) & injected share & locale seat. */
export type WorktreeChipProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<WorktreeChipInjected>
  & PropsLocale<'worktree'>

/** A selector hook over the conversation assembly, as far as this row reads it. */
type UseActiveTargets = (selector: (snapshot: { readonly activeTargets: ReadonlySet<string> }) => number) => number

/**
 * Stand-in for a harness that hands the dock no `useConversation`: no conversation target is ever
 * active. A hook in its own right, so the call site stays unconditional whichever one it gets.
 * @returns zero.
 */
const useNoActiveTargets: UseActiveTargets = () => 0

/** Gap between the row and an open popover. */
const PANEL_GAP = 8

/** Clearance a popover keeps from the top of the viewport. */
const PANEL_MARGIN = 12

/** A popover never grows past this, however much room there is above the row. */
const PANEL_MAX_HEIGHT = 480

/**
 * The highest point a popover opening upward from an element can be seen at.
 *
 * Not simply the viewport's top: the row lives in the conversation's scroll container, which starts
 * below the session header, and a popover reaching past that container's top edge is hidden under
 * the header even though it is still inside the window. The nearest ancestor that clips vertically
 * is that edge.
 * @param element - the element the popover is anchored to.
 * @returns the clipping ancestor's top in viewport coordinates, or 0 when nothing clips.
 */
function ceilingOf(element: HTMLElement): number {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow !== 'visible') return Math.max(0, node.getBoundingClientRect().top)
  }
  return 0
}

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
  const {
    sessionId, useWorkspaces, describeWorktree, commandsFor, adoptWorkspace, canRevealPath, revealPath, t,
  } = props
  // Read structurally: the dock's owner share is the installed harness's `SessionSnapshot`, and
  // `useConversation` is its session standard kit. Neither is spelled that way in every harness
  // version this compiles against, and an absent hook must read as "no target active" rather than
  // throw. See `sessionStarted` for the rule both feed.
  const { session, useConversation } = props as unknown as {
    readonly session?: SessionPhaseFacts
    readonly useConversation?: UseActiveTargets
  }
  const useActiveTargets = useConversation ?? useNoActiveTargets
  const activeTargets = useActiveTargets(snapshot => snapshot.activeTargets.size)
  const started = sessionStarted(session, activeTargets)
  const [panel, setPanel] = useState<OpenPanel>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  // Unknown reads as unsupported: the action appears once the Host says yes, never as a dead item.
  const [revealable, setRevealable] = useState(false)

  useEffect(() => {
    let live = true
    canRevealPath().then(
      (supported) => { if (live) setRevealable(supported) },
      () => { if (live) setRevealable(false) },
    )
    return () => { live = false }
  }, [canRevealPath])
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The room above the row, measured when a popover opens and on resize: the popover opens upward
  // from the composer, and on a short window a fixed height would run off the top of the viewport.
  const [panelMaxHeight, setPanelMaxHeight] = useState(PANEL_MAX_HEIGHT)

  const workspacePath = useWorkspaces(
    snapshot => snapshot.items.find(item => item.sessionIds.includes(sessionId))?.path,
  )
  const commands = useMemo(
    () => (workspacePath === undefined ? null : commandsFor(workspacePath)),
    [commandsFor, workspacePath],
  )
  // No reading for a blank session: the hero pill is on screen and reads the same repository itself.
  const state = useWorktree(describeWorktree, started ? commands : null)
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

  // Layout effect, so the popover is capped before it paints rather than one frame too tall.
  useLayoutEffect(() => {
    if (panel === null) return undefined
    const measure = (): void => {
      const root = rootRef.current
      if (root === null) return
      const top = root.getBoundingClientRect().top
      setPanelMaxHeight(Math.max(0, Math.min(PANEL_MAX_HEIGHT, top - ceilingOf(root) - PANEL_GAP - PANEL_MARGIN)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [panel])

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

  if (!started || view === null || !view.showChip || commands === null || overview === null) return null

  const { repo } = overview
  const dirty = dirtyCount(repo.dirty)
  const track = trackingLabel(repo.tracking)
  const label = repo.unborn ? t('chip.unborn') : branchLabel(repo, t('chip.detached'))
  const current = overview.worktrees.find(entry => entry.current)
  const worktreeName = basenameOf(current?.path ?? repo.worktreeRoot)

  return (
    <div ref={rootRef} className={css.root}>
      <span className={css.pill}>
        <Tooltip label={t('chip.branch.tooltip')} side="top" delayMs={250} disabled={panel !== null}>
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

        <span className={css.pillDivider} aria-hidden="true" />

        <Tooltip label={t('chip.worktree.tooltip')} side="top" delayMs={250} disabled={panel !== null}>
          <button
            type="button"
            className={css.segment}
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

      <Tooltip label={t('chip.create.tooltip')} side="top" delayMs={250}>
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
        <div className={css.panel} style={{ maxHeight: panelMaxHeight }} role="dialog" aria-label={t('branches.title')}>
          <BranchPanel
            overview={overview}
            state={state}
            t={t}
            branchPrefix={view.branchPrefix}
            onFetch={() => { void run(() => commands.fetch()) }}
            onSearch={commands.searchBranches}
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
        <div className={css.panel} style={{ maxHeight: panelMaxHeight }} role="dialog" aria-label={t('worktrees.title')}>
          <WorktreePanel
            overview={overview}
            state={state}
            t={t}
            onOpen={openWorktree}
            {...revealable
              ? {
                  onReveal: (path: string) => {
                    void revealPath(path).catch(() => {
                      // Revealing is a convenience; failing it silently keeps a popover from turning
                      // into an error surface for something nothing depends on.
                    })
                  },
                }
              : {}}
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
        <RemoveWorktreeDialog
          entry={dialog.entry}
          commands={commands}
          requireTyped={view.confirmDestructive}
          t={t}
          failure={state.failure}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={(force, discardIgnored) => {
            void run(() => commands.removeWorktree({ path: dialog.entry.path, force, discardIgnored }))
              .then((result) => {
                if (result !== null) closeDialog()
              })
          }}
        />
      )}
    </div>
  )
}
