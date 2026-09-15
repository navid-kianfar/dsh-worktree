/**
 * The first-send half of the worktree checkbox: it turns a staged worktree into a real one when the
 * first prompt is sent, and sends that prompt from inside it.
 *
 * The harness has no pre-send hook for a plain prompt (input triggers only adjudicate drafts that
 * start with `/`), so this seat sits in the composer's own tool row and listens on its card in the
 * capture phase: Enter in the editor and a click on the send button. It steps in only when the send
 * would otherwise go ahead in the project folder while a worktree is staged — never for a `/`
 * command, while a trigger menu owns Enter, mid-composition, or while the send button is disabled
 * (empty, busy, or uploads still pending) — so every other send is untouched.
 *
 * When it does step in:
 *
 * 1. It raises a composer block, and keeps it until the prompt has been sent from the worktree (or
 *    the attempt is abandoned), so no second Enter can reach the project folder meanwhile.
 * 2. It names the branch from the prompt and creates the worktree from the staged base branch, then
 *    adopts it as a workspace.
 * 3. Before each step with a lasting effect it confirms this session is still the one on screen. The
 *    move goes through the hero toolbar's own pick — the path a manual project switch takes, which
 *    carries the draft and its attachments — and that toolbar belongs to whatever is on screen, so
 *    picking after the user has navigated elsewhere would carry someone else's draft.
 * 4. The gate mounted in the worktree's blank session sends the carried draft with the composer's own
 *    submit, and consumes the marker. A marker that is not consumed in time voids the attempt: the
 *    workspace, worktree and branch are removed again, the staged choice is restored, and the user
 *    is told — nothing sent means nothing left behind.
 *
 * Renders nothing visible: the seat exists to be inside the composer card.
 * @module @achasoft/dsh-worktree/client/SendGate
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the composer tool-row seat and the session standard kit (`useInput`, `inputActions`).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { applyBranchPrefix } from '../shared/branch-name.ts'
import type { WorktreeCommands, WorktreeSendGateInjected } from './contract.ts'
import {
  PENDING_SEND_TTL_MS, heroPicker, pendingSends, stagedSessions, type StagedSession,
} from './staging.ts'

/** Full gate props: the session standard kit & the injected actions & the locale seat. */
export type WorktreeSendGateProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<WorktreeSendGateInjected>
  & PropsLocale<'worktree'>

/** How many numbered names to try when git reports the chosen branch already exists. */
const NAME_ATTEMPTS = 5

/**
 * Safari delivers the Enter that confirms an IME candidate just after `compositionend`; the harness
 * keymap treats that window as still composing, and so does this gate.
 */
const COMPOSITION_GRACE_MS = 10

/**
 * A branch name for a prompt that yielded none, e.g. one made only of attachments.
 * @returns a short unique-enough branch component.
 */
function fallbackBranch(): string {
  const suffix = globalThis.crypto?.randomUUID === undefined
    ? Math.random().toString(16).slice(2, 10).padEnd(8, '0')
    : globalThis.crypto.randomUUID().replace(/-/gu, '').slice(0, 8)
  return `wt-${suffix}`
}

/**
 * The first free name at or after `name` among the repository's branches.
 * @param name - the preferred name.
 * @param taken - every known branch name, local and remote-tracking.
 * @returns `name`, or `name-2`, `name-3`, … when it is taken.
 */
export function freeBranchName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Thrown when the user left the session mid-attempt; it ends the attempt with nothing created. */
class AttemptAbandoned extends Error {}

/** Thrown when the move to the worktree never landed; everything it created has been removed. */
class MoveFailed extends Error {}

/**
 * Watch the composer for the first send of a staged worktree, and send carried prompts.
 * @param props - the session kit, the injected actions, and the locale seat.
 * @returns a hidden marker inside the composer card.
 */
export function WorktreeSendGate(props: WorktreeSendGateProps) {
  const {
    sessionId, useWorkspaces, useSessions, useInput, inputActions, t,
    describeWorktree, commandsFor, createWorkspace, deleteWorkspace, renameWorkspace, suggestBranchName,
    menuClaimsEnter, currentSession, block, notify,
  } = props
  const workspace = useWorkspaces(state => state.items.find(item => item.sessionIds.includes(sessionId)))
  const blank = useSessions(state => state.byId[sessionId]?.blank)
  const draft = useInput(state => state.draft)
  // Read defensively: the field is on the shipped harness's input state, but older type packages
  // this plugin compiles against do not declare it.
  const attachments = useInput(state =>
    (state as { attachmentIds?: readonly unknown[] }).attachmentIds?.length ?? 0)
  const phase = useInput(state => state.phase)
  const marker = useRef<HTMLSpanElement>(null)
  const creating = useRef(false)
  // Event listeners are attached once per card; they read the current facts through this ref rather
  // than being re-attached on every keystroke.
  const latest = useRef({ workspace, blank, draft, attachments, phase })
  latest.current = { workspace, blank, draft, attachments, phase }

  // ---- the worktree's own session: send the carried prompt ----
  const pending = useSyncExternalStore(pendingSends.subscribe, pendingSends.getSnapshot)
  useEffect(() => {
    // `pending` is read only to re-run on change; liveness is checked against the clock, so an expired
    // marker is left for its creator to reclaim rather than consumed here.
    if (workspace === undefined || blank !== true || !pendingSends.has(workspace.workspaceId, Date.now())) return
    // The carry lands before this session renders, but wait for it rather than assume it.
    if (draft.trim() === '' && attachments === 0) return
    if (phase !== 'plain') return
    if (!pendingSends.take(workspace.workspaceId, Date.now())) return
    inputActions.submit()
  }, [pending, workspace, blank, draft, attachments, phase, inputActions])

  // ---- the project's blank session: create the worktree on first send ----
  const start = useCallback((staged: StagedSession): void => {
    const origin = latest.current.workspace
    if (origin === undefined) return
    creating.current = true
    block(sessionId, t('send.creating'))
    const commands = commandsFor(origin.path)
    const prompt = latest.current.draft
    /** Still on this session, with the toolbar that belongs to it on screen. */
    const onScreen = (): boolean => currentSession() === sessionId && heroPicker.available()

    void (async () => {
      const [view, suggestion, overview] = await Promise.all([
        describeWorktree().catch(() => undefined),
        prompt.trim() === '' ? Promise.resolve(undefined) : suggestBranchName(prompt).catch(() => undefined),
        commands.overview().catch(() => undefined),
      ])
      if (!onScreen()) throw new AttemptAbandoned()

      const taken = new Set(overview?.ok === true ? overview.branches.map(branch => branch.name) : [])
      const preferred = applyBranchPrefix(
        view?.branchPrefix ?? '',
        suggestion?.ok === true ? suggestion.name : fallbackBranch(),
      )
      const created = await addWorktreeNamed(commands, preferred, taken, staged.baseBranch)

      const cleanUp = async (workspaceId?: WorkspaceId): Promise<void> => {
        if (workspaceId !== undefined) await deleteWorkspace(workspaceId).catch(() => undefined)
        // The branch is this gate's own and has no commits yet, so it goes with the worktree.
        await commands.removeWorktree({ path: created.path, force: false }).catch(() => undefined)
        await commands.deleteBranch({ branch: created.branch, force: false }).catch(() => undefined)
      }

      let workspaceId: WorkspaceId
      try {
        workspaceId = await createWorkspace(created.path)
      } catch (reason) {
        await cleanUp()
        throw reason
      }
      if (!onScreen()) {
        await cleanUp(workspaceId)
        throw new AttemptAbandoned()
      }
      // Best effort: the sidebar reads better with the branch name than with the directory name.
      void renameWorkspace(workspaceId, created.branch).catch(() => undefined)

      // Synchronous from the check above to the pick, so the toolbar picked through is this session's.
      pendingSends.add(workspaceId, sessionId, Date.now())
      stagedSessions.clear(origin.workspaceId)
      heroPicker.pick(workspaceId)

      const sent = await waitForSend(workspaceId)
      if (!sent) {
        pendingSends.take(workspaceId, Date.now())
        await cleanUp(workspaceId)
        stagedSessions.restore(staged)
        throw new MoveFailed()
      }
    })().catch((reason: unknown) => {
      if (reason instanceof AttemptAbandoned) {
        // Shown when the user comes back: their message is still in the composer, unsent.
        notify(sessionId, t('send.abandoned'))
        return
      }
      if (reason instanceof MoveFailed) {
        notify(sessionId, t('send.moveFailed'))
        return
      }
      const message = reason instanceof Error ? reason.message : String(reason)
      notify(sessionId, t('send.failed', { message }))
    }).finally(() => {
      block(sessionId, undefined)
      creating.current = false
    })
  }, [
    block, commandsFor, createWorkspace, currentSession, deleteWorkspace, describeWorktree, notify,
    renameWorkspace, sessionId, suggestBranchName, t,
  ])

  useEffect(() => {
    const card = marker.current?.closest('[data-composer-card]')
    if (!(card instanceof HTMLElement)) return undefined

    let composing = false
    let composingUntil = 0
    const onCompositionStart = (): void => { composing = true }
    const onCompositionEnd = (): void => {
      composing = false
      composingUntil = Date.now() + COMPOSITION_GRACE_MS
    }

    /** The send button: the card's last button, trailing the tool row after every seat. */
    const sendButton = (): HTMLButtonElement | undefined => {
      const buttons = card.querySelectorAll('button')
      return buttons[buttons.length - 1] ?? undefined
    }

    /** The staged choice when this send is one the gate owns, otherwise undefined. */
    const owned = (): StagedSession | undefined => {
      const facts = latest.current
      if (creating.current || facts.workspace === undefined || facts.blank !== true) return undefined
      const staged = stagedSessions.get(facts.workspace.workspaceId)
      if (staged?.worktree !== true || facts.phase !== 'plain') return undefined
      const text = facts.draft.trim()
      if (text === '' && facts.attachments === 0) return undefined
      if (text.startsWith('/') || menuClaimsEnter(sessionId)) return undefined
      // Disabled means the harness would not send either: empty, busy, or an upload still running.
      if (sendButton()?.disabled !== false) return undefined
      return staged
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.repeat) return
      if (event.isComposing || event.keyCode === 229 || composing || Date.now() < composingUntil) return
      const target = event.target
      if (!(target instanceof Element) || target.closest('[contenteditable="true"]') === null) return
      const staged = owned()
      if (staged === undefined) return
      event.preventDefault()
      event.stopPropagation()
      start(staged)
    }

    const onClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest('button')
      if (button === null || button !== sendButton()) return
      const staged = owned()
      if (staged === undefined) return
      event.preventDefault()
      event.stopPropagation()
      start(staged)
    }

    card.addEventListener('compositionstart', onCompositionStart, true)
    card.addEventListener('compositionend', onCompositionEnd, true)
    card.addEventListener('keydown', onKeyDown, true)
    card.addEventListener('click', onClick, true)
    return () => {
      card.removeEventListener('compositionstart', onCompositionStart, true)
      card.removeEventListener('compositionend', onCompositionEnd, true)
      card.removeEventListener('keydown', onKeyDown, true)
      card.removeEventListener('click', onClick, true)
    }
  }, [menuClaimsEnter, sessionId, start])

  return <span ref={marker} hidden aria-hidden="true" />
}

/**
 * Create the worktree on a new branch, numbering the name when git reports it taken.
 *
 * The overview's branch list is capped, so an old branch with the same name can be missing from
 * `taken`; git's refusal is the authority, and a numbered retry is what a person would do.
 * @param commands - the project's bound git commands.
 * @param preferred - the name derived from the prompt.
 * @param taken - branch names already known to exist.
 * @param startPoint - the staged base branch, or undefined for the current HEAD.
 * @returns the created worktree's path and branch.
 * @throws Error with git's message when creation fails for another reason or every attempt is taken.
 */
async function addWorktreeNamed(
  commands: WorktreeCommands,
  preferred: string,
  taken: ReadonlySet<string>,
  startPoint: string | undefined,
): Promise<{ path: string, branch: string }> {
  const known = new Set(taken)
  let lastMessage = ''
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const branch = freeBranchName(preferred, known)
    const created = await commands.addWorktree({
      branch,
      createBranch: true,
      ...startPoint === undefined ? {} : { startPoint },
      detach: false,
    })
    if (created.ok) return { path: created.path, branch: created.branch ?? branch }
    lastMessage = created.message
    if (!/already exists/iu.test(created.message)) break
    known.add(branch)
  }
  throw new Error(lastMessage)
}

/**
 * Wait until the worktree's session has consumed its marker, or the marker has expired.
 * @param workspaceId - the worktree's workspace.
 * @returns true when the prompt was sent, false when the move did not land in time.
 */
function waitForSend(workspaceId: WorkspaceId): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (sent: boolean): void => {
      unsubscribe()
      clearTimeout(timer)
      resolve(sent)
    }
    const unsubscribe = pendingSends.subscribe(() => {
      if (!pendingSends.getSnapshot().has(workspaceId)) settle(true)
    })
    const timer = setTimeout(() => { settle(!pendingSends.getSnapshot().has(workspaceId)) }, PENDING_SEND_TTL_MS)
    if (!pendingSends.getSnapshot().has(workspaceId)) settle(true)
  })
}
