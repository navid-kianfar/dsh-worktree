/**
 * The branch switcher: everything `git branch` and `git switch` do, as one filtered list.
 *
 * A row does the obvious thing on click and keeps the rest behind its action menu, because switching
 * is what someone opening this list almost always wants. The one exception is a branch already
 * checked out in another worktree — git refuses to check it out twice, so that row jumps to the
 * worktree holding it instead of failing.
 * @module @achasoft/dsh-worktree/client/BranchPanel
 */

import { useMemo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconDownloadOutline16, IconPlusOutline16, IconRefreshOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { applyBranchPrefix, checkBranchName } from '../shared/branch-name.ts'
import { basenameOf } from '../shared/path.ts'
import type { BranchEntry, OverviewSuccess } from '../host/types.ts'
import { RowMenu, type RowMenuItem } from './RowMenu.tsx'
import { dirtyCount, fuzzyScore, relativeAge, trackingLabel } from './format.ts'
import { FailureStrip } from './FailureStrip.tsx'
import type { WorktreeState } from './useWorktree.ts'
import css from './surface.module.css'

/** What the branch switcher needs beyond the shared reading. */
export interface BranchPanelProps {
  /** The current reading. */
  overview: OverviewSuccess
  /** The shared reading and its two ways forward. */
  state: WorktreeState
  /** The `worktree` namespace translate. */
  t: TranslateNS<'worktree'>
  /** Prefix offered for a newly created branch. */
  branchPrefix: string
  /** Update remote-tracking refs and prune the ones whose remote branch is gone. */
  onFetch: () => void
  /** Switch onto a branch, creating the local one for a remote row. */
  onCheckout: (branch: string, carryChanges: boolean) => void
  /**
   * Create a branch under the typed name and switch onto it.
   *
   * No carry flag: `switch --create` keeps uncommitted work on the new branch by construction, since
   * the new branch starts at the commit the work was already sitting on.
   */
  onCreate: (branch: string) => void
  /** Open the create-worktree dialog with this branch prefilled. */
  onWorktreeFor: (branch: string) => void
  /** Open the rename dialog for a local branch. */
  onRename: (branch: string) => void
  /** Open the delete confirmation for a local branch. */
  onDelete: (branch: string) => void
  /** Open a session in the worktree that already holds a branch. */
  onJump: (path: string) => void
}

/**
 * Render the branch switcher.
 * @param props - the reading, the shared state, and every action a row can start.
 * @returns the popover's contents.
 */
export function BranchPanel(props: BranchPanelProps) {
  const {
    overview, state, t, branchPrefix,
    onFetch, onCheckout, onCreate, onWorktreeFor, onRename, onDelete, onJump,
  } = props
  const [query, setQuery] = useState('')
  const [carry, setCarry] = useState(false)
  const now = Date.now()
  const dirty = dirtyCount(overview.repo.dirty)

  const matched = useMemo(() => {
    if (query === '') return overview.branches
    return overview.branches
      .map(entry => ({ entry, score: fuzzyScore(entry.name, query) }))
      .filter(scored => scored.score >= 0)
      .sort((left, right) => right.score - left.score)
      .map(scored => scored.entry)
  }, [overview.branches, query])

  const local = matched.filter(entry => entry.kind === 'local')
  const remote = matched.filter(entry => entry.kind === 'remote')
  const typed = query.trim()
  const proposed = applyBranchPrefix(branchPrefix, typed)
  // The create row is offered only for a name no branch already carries, so the list never shows
  // "New branch x" beside an existing `x`.
  const offersCreate = typed !== ''
    && checkBranchName(proposed).ok
    && !overview.branches.some(entry => entry.name === proposed || entry.name === typed)

  const renderRow = (entry: BranchEntry) => {
    const elsewhere = entry.checkedOutAt !== undefined && !entry.current
    const track = trackingLabel(entry.tracking)
    const age = relativeAge(entry.committedAt, now)
    const items: RowMenuItem[] = [
      {
        id: 'worktree',
        label: t('branches.action.worktree'),
        onSelect: () => { onWorktreeFor(entry.name) },
      },
    ]
    if (entry.kind === 'local') {
      items.push(
        { id: 'rename', label: t('branches.action.rename'), onSelect: () => { onRename(entry.name) } },
        {
          id: 'delete',
          label: t('branches.action.delete'),
          danger: true,
          // git refuses to delete a branch some worktree has checked out, so the entry says so by
          // being unusable rather than by failing after the confirmation.
          disabled: entry.current || entry.checkedOutAt !== undefined,
          onSelect: () => { onDelete(entry.name) },
        },
      )
    }
    return (
      <li key={entry.ref} className={css.row}>
        <button
          type="button"
          className={css.rowMain}
          disabled={entry.current || state.busy}
          onClick={() => {
            if (elsewhere && entry.checkedOutAt !== undefined) onJump(entry.checkedOutAt)
            else onCheckout(entry.name, carry)
          }}
        >
          <span className={css.rowTop}>
            <span className={entry.current ? css.rowNameCurrent : css.rowName}>{entry.name}</span>
            {entry.current && <span className={css.badgeAccent}>{t('branches.current')}</span>}
            {entry.tracking?.gone === true && <span className={css.badgeWarn}>{t('branches.gone')}</span>}
            {track !== '' && <span className={css.track}>{track}</span>}
          </span>
          <span className={css.rowMeta}>
            <span className={css.rowMetaText}>
              {entry.sha}
              {' · '}
              {entry.subject === '' ? entry.author : entry.subject}
            </span>
            <span className={css.track}>{t(`age.${age.unit}`, { value: String(age.value) })}</span>
          </span>
          {elsewhere && entry.checkedOutAt !== undefined && (
            <span className={css.rowMeta}>
              <span className={css.rowMetaText}>
                {t('branches.checkedOut', { path: basenameOf(entry.checkedOutAt) })}
              </span>
            </span>
          )}
        </button>
        <span className={css.rowActions}>
          <RowMenu label={entry.name} items={items} />
        </span>
      </li>
    )
  }

  return (
    <>
      <div className={css.panelHead}>
        <span className={css.panelTitle}>{t('branches.title')}</span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('branches.fetch')}
          title={t('branches.fetch')}
          disabled={state.busy}
          onClick={onFetch}
        >
          <IconDownloadOutline16 />
        </button>
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

      <div className={css.search}>
        {/* Autofocused because this popover exists to be typed into: it opens on a deliberate click
            and its first control is the filter. */}
        <input
          type="search"
          className={css.searchInput}
          value={query}
          placeholder={t('branches.search')}
          aria-label={t('branches.search')}
          autoFocus
          onChange={(event) => { setQuery(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const first = matched[0]
            if (first !== undefined && !first.current) onCheckout(first.name, carry)
            else if (offersCreate) onCreate(proposed)
          }}
        />
      </div>

      <FailureStrip failure={state.failure} t={t} />

      <ul className={css.list}>
        {offersCreate && (
          <li className={css.row}>
            <button
              type="button"
              className={css.rowMain}
              disabled={state.busy}
              onClick={() => { onCreate(proposed) }}
            >
              <span className={css.rowTop}>
                <IconPlusOutline16 className={css.segmentIcon} />
                <span className={css.rowName}>{t('branches.create', { name: proposed })}</span>
              </span>
            </button>
          </li>
        )}

        {local.length > 0 && <li className={css.groupLabel}>{t('branches.local')}</li>}
        {local.map(renderRow)}

        {remote.length > 0 && <li className={css.groupLabel}>{t('branches.remote')}</li>}
        {remote.map(renderRow)}

        {matched.length === 0 && !offersCreate && (
          <li className={css.empty}>{t('branches.empty')}</li>
        )}
      </ul>

      {overview.branchesTruncated && (
        <p className={css.notice}>
          {t('branches.truncated', { count: String(overview.branches.length) })}
        </p>
      )}

      {/* The carry switch appears only when there is something to carry: on a clean worktree it is a
          control with no effect, and git's own behavior is already what the switch describes. */}
      {dirty > 0 && (
        <div className={css.footer}>
          <label className={css.footerToggle}>
            <input
              type="checkbox"
              role="switch"
              className={css.switch}
              checked={carry}
              onChange={(event) => { setCarry(event.target.checked) }}
            />
            <span className={css.toggleText}>
              <span>{t('branches.carry')}</span>
              <span className={css.fieldHint}>{t('branches.carry.hint')}</span>
            </span>
          </label>
        </div>
      )}
    </>
  )
}
