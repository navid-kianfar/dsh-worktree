/**
 * The session-header half of the worktree checkbox: it gives a freshly created worktree its real
 * name.
 *
 * The new-session surface has to create the worktree before the session exists — a session runs in a
 * directory, and the worktree is the directory — but the only thing worth naming it after is the
 * prompt, which arrives afterwards. So the branch starts provisional and this seat, which is the one
 * place that can see both the session's draft and its workspace, renames it once the first message
 * has been sent.
 *
 * Renders nothing. It occupies a list seat in the header's utilities row purely to exist in the
 * session scope, which is the scope that carries `useInput`; a component that returned markup would
 * be a second control in a row that already has one.
 * @module @achasoft/dsh-worktree/client/WorktreeNaming
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the session-header seat and the session standard kit (`useInput`) it publishes.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { applyBranchPrefix } from '../shared/branch-name.ts'
import type { WorktreeView } from '../host/types.ts'
import type { WorktreeNamingInjected } from './contract.ts'
import { worktreeIntents, type WorktreeIntent } from './intents.ts'

/** Full watcher props: the session standard kit & the injected git actions & the locale seat. */
export type WorktreeNamingProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<WorktreeNamingInjected>
  & PropsLocale<'worktree'>

/**
 * Watch one session for the message that names its worktree.
 * @param props - the session kit, the injected actions, and the locale seat.
 * @returns null, always.
 */
export function WorktreeNaming(props: WorktreeNamingProps) {
  const {
    sessionId, useSessions, useWorkspaces, useInput,
    describeWorktree, commandsFor, renameWorkspace, suggestBranchName,
  } = props
  const workspace = useWorkspaces(state =>
    state.items.find(item => item.sessionIds.includes(sessionId)))
  const blank = useSessions(state => state.byId[sessionId]?.blank)
  const draft = useInput(state => state.draft)
  const intents = useSyncExternalStore(worktreeIntents.subscribe, worktreeIntents.getSnapshot)
  const intent = intents.find(entry => entry.workspaceId === workspace?.workspaceId && !entry.named)
  const [view, setView] = useState<WorktreeView | null>(null)
  // One attempt per worktree: a failed rename must not become a retry loop, because the effect
  // re-runs on every draft change and the attempt itself cannot be observed from the store.
  const attempted = useRef<ReadonlySet<string>>(new Set())
  // The last draft anyone typed. The submit path clears the draft in the same breath as it admits
  // the message, so the text is only still here because an earlier commit kept it.
  const lastDraft = useRef('')

  useEffect(() => {
    const controller = new AbortController()
    void describeWorktree(controller.signal).then(
      (next) => { if (!controller.signal.aborted) setView(next) },
      () => { /* A failed probe leaves the watcher inert, which is the same as no worktree pending. */ },
    )
    return () => { controller.abort() }
  }, [describeWorktree])

  useEffect(() => {
    if (draft.trim() !== '') lastDraft.current = draft
  }, [draft])

  const name = useCallback((entry: WorktreeIntent, workspacePath: string, prompt: string): void => {
    attempted.current = new Set([...attempted.current, entry.workspaceId])
    void suggestBranchName(prompt).then((suggestion) => {
      if (!suggestion.ok) return undefined
      const name = applyBranchPrefix(view?.branchPrefix ?? '', suggestion.name)
      return commandsFor(workspacePath)
        .renameBranch({ branch: entry.branch, name })
        .then((renamed) => {
          worktreeIntents.markNamed(entry.workspaceId, name)
          // Best effort: the Worktree switcher reads better with the branch's name than with the
          // directory the provisional name produced, but the rename above is the fact that matters.
          if (renamed.ok) void renameWorkspace(entry.workspaceId, name).catch(() => {})
        })
    }).catch(() => {
      // A naming attempt that could not be carried out leaves the provisional branch in place. It is
      // a working branch with an unlovely name, which is not worth a second control to fix.
    })
  }, [view?.branchPrefix, commandsFor, renameWorkspace, suggestBranchName])

  useEffect(() => {
    if (intent === undefined || view === null || workspace === undefined) return
    // Only a sent message names the worktree: a half-typed draft describes an intention, and naming
    // from it would put a word on the branch that the person had not finished choosing.
    if (blank !== false) return
    if (attempted.current.has(intent.workspaceId)) return
    const prompt = lastDraft.current.trim()
    if (prompt === '') return
    name(intent, workspace.path, prompt)
  }, [intent, view, workspace, blank, name])

  return null
}
