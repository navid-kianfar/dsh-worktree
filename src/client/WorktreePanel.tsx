/**
 * The worktree switcher: every checkout of this repository, and the one control that adds another.
 *
 * Clicking a row opens a session in that worktree, which is the whole point of the surface — a
 * worktree is only useful once the harness is pointed at it, so the row's primary action adopts the
 * directory as a Workspace and starts a session there rather than merely reporting the path.
 * @module @achasoft/dsh-worktree/client/WorktreePanel
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlusOutline16, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { basenameOf } from '../shared/path.ts'
import type { OverviewSuccess, WorktreeEntry } from '../host/types.ts'
import { RowMenu, type RowMenuItem } from './RowMenu.tsx'
import { FailureStrip } from './FailureStrip.tsx'
import type { WorktreeState } from './useWorktree.ts'
import css from './surface.module.css'

/** What the worktree switcher needs beyond the shared reading. */
export interface WorktreePanelProps {
  /** The current reading. */
  overview: OverviewSuccess
  /** The shared reading and its two ways forward. */
  state: WorktreeState
  /** The `worktree` namespace translate. */
  t: TranslateNS<'worktree'>
  /** Open (or reuse) a session in a worktree directory. */
  onOpen: (path: string) => void
  /** Show a worktree's directory in the host's file manager. */
  onReveal: (path: string) => void
  /** Lock or unlock a worktree. */
  onLock: (path: string, locked: boolean) => void
  /** Open the removal confirmation. */
  onRemove: (entry: WorktreeEntry) => void
  /** Drop the administrative records of worktrees whose directories are gone. */
  onPrune: () => void
  /** Open the create-worktree dialog with nothing prefilled. */
  onCreate: () => void
}

/**
 * Render the worktree switcher.
 * @param props - the reading, the shared state, and every action a row can start.
 * @returns the popover's contents.
 */
export function WorktreePanel(props: WorktreePanelProps) {
  const { overview, state, t, onOpen, onReveal, onLock, onRemove, onPrune, onCreate } = props
  const prunable = overview.worktrees.some(entry => entry.prunable)

  return (
    <>
      <div className={css.panelHead}>
        <span className={css.panelTitle}>{t('worktrees.title')}</span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('branches.refresh')}
          title={t('branches.refresh')}
          disabled={state.busy}
          onClick={state.refresh}
        >
          <IconRefreshOutline14 className={state.busy ? css.spin : undefined} />
        </button>
      </div>

      <FailureStrip failure={state.failure} t={t} />

      <ul className={css.list}>
        {overview.worktrees.map((entry) => {
          const items: RowMenuItem[] = [
            { id: 'reveal', label: t('worktrees.reveal'), onSelect: () => { onReveal(entry.path) } },
          ]
          if (!entry.main) {
            items.push(
              {
                id: 'lock',
                label: entry.locked ? t('worktrees.unlock') : t('worktrees.lock'),
                onSelect: () => { onLock(entry.path, !entry.locked) },
              },
              {
                id: 'remove',
                label: t('worktrees.remove'),
                danger: true,
                // git refuses to remove a locked worktree, so the entry says so by being unusable
                // rather than by failing after the confirmation.
                disabled: entry.locked,
                onSelect: () => { onRemove(entry) },
              },
            )
          }
          return (
            <li key={entry.path} className={css.row}>
              <button
                type="button"
                className={css.rowMain}
                disabled={state.busy}
                onClick={() => { onOpen(entry.path) }}
              >
                <span className={css.rowTop}>
                  <span className={entry.current ? css.rowNameCurrent : css.rowName}>
                    {basenameOf(entry.path)}
                  </span>
                  {entry.current && <span className={css.badgeAccent}>{t('worktrees.current')}</span>}
                  {entry.main && <span className={css.badge}>{t('worktrees.main')}</span>}
                  {entry.locked && <span className={css.badge}>{t('worktrees.locked')}</span>}
                  {entry.prunable && <span className={css.badgeWarn}>{t('worktrees.prunable')}</span>}
                </span>
                <span className={css.rowMeta}>
                  <span className={css.rowMetaText}>
                    {entry.branch ?? (entry.detached ? `${t('worktrees.detached')} ${entry.sha ?? ''}` : entry.sha ?? '')}
                  </span>
                </span>
                <span className={css.rowMeta}>
                  <span className={css.rowMetaText}>{entry.path}</span>
                </span>
                {entry.lockReason !== undefined && (
                  <span className={css.rowMeta}>
                    <span className={css.rowMetaText}>{entry.lockReason}</span>
                  </span>
                )}
              </button>
              <span className={css.rowActions}>
                <RowMenu label={basenameOf(entry.path)} items={items} />
              </span>
            </li>
          )
        })}
        {overview.worktrees.length <= 1 && (
          <li className={css.empty}>{t('worktrees.empty')}</li>
        )}
      </ul>

      <div className={css.footer}>
        <button
          type="button"
          className={css.footerButton}
          disabled={state.busy}
          onClick={onCreate}
        >
          <IconPlusOutline16 />
          {t('create.title')}
        </button>
        {/* Pruning is offered only when git has something to prune, so the control is never a
            no-op someone has to click to find out about. */}
        {prunable && (
          <button
            type="button"
            className={css.footerButton}
            disabled={state.busy}
            onClick={onPrune}
          >
            {t('worktrees.prune')}
          </button>
        )}
      </div>
    </>
  )
}
