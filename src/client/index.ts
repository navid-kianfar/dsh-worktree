/**
 * Worktree plugin, browser half. Two registrations: the chip in the session header's utilities seat,
 * and the worktree card on the plugin settings tab keyed by the `worktree` namespace.
 *
 * Everything git goes over this plugin's own Remote namespace, because a page cannot run a process.
 * The two things the browser DOES own are the ones the Host cannot reach: which workspace the
 * current session belongs to, and what it means to open a session somewhere — so adopting a worktree
 * directory as a Workspace and starting a session in it are client acts, wired into the injected
 * face below rather than into the endpoint.
 * @module @achasoft/dsh-worktree/client
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge and the generated `worktree` namespace.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the session-header utilities seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the keyed settings.plugin.item slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The generated Host-for-Client contract for this plugin's own endpoint. Importing it here — rather
// than adding a row to the curated api-remotes assembly — is what keeps the capability a plugin: the
// namespace mounts and unmounts with this fiber, and no shipped source names `worktree`.
import worktreeRemote from '../../generated/typert.remote-client.js'
import type { WorktreeSettings } from '../host/types.ts'
import type {
  WorktreeChipInjected, WorktreeCommands, WorktreeHeroInjected, WorktreeNamingInjected,
  WorktreeSettingsInjected,
} from './contract.ts'
import { WorktreeChip } from './WorktreeChip.tsx'
import { HeroWorkspace } from './HeroWorkspace.tsx'
import { WorktreeNaming } from './WorktreeNaming.tsx'
import { WorktreeSettingsCard } from './WorktreeSettingsCard.tsx'
import { en, zh, type WorktreeKey } from './locales.ts'

export type {
  WorktreeChipInjected, WorktreeCommands, WorktreeHeroInjected, WorktreeNamingInjected,
  WorktreeSettingsInjected,
} from './contract.ts'
export type { WorktreeKey } from './locales.ts'
export type { WorktreeChipProps } from './WorktreeChip.tsx'
export type { HeroWorkspaceProps } from './HeroWorkspace.tsx'
export type { WorktreeNamingProps } from './WorktreeNaming.tsx'
export type { WorktreeSettingsCardProps } from './WorktreeSettingsCard.tsx'
export type { WorktreeState } from './useWorktree.ts'
export type { WorktreeIntent, WorktreeIntentStore } from './intents.ts'
export type { RelativeAge } from './format.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The session-header worktree chip's, both switchers', and the settings card's copy. */
    worktree: WorktreeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const LOCALE_NS = 'worktree'

/**
 * Settings namespace the Host section is registered under.
 *
 * Spelled separately from {@link LOCALE_NS} and from the Remote namespace even though all three read
 * the same, because each is fixed by a different grammar: settings namespaces are kebab-case, a
 * Remote namespace is a property identifier, and a dictionary namespace is a plain key.
 */
const SETTINGS_NS = 'worktree'

/**
 * Required services of the OUTER plugin: locale, the Remote mount point, and the Workspaces domain.
 *
 * Deliberately NOT `remote.worktree`. This plugin's apply creates that namespace by mounting its own
 * contribution, so it cannot also wait for it — and Cordis refuses to read a service the fiber did
 * not inject. Both halves of that bind are resolved by the child plugin below, which injects
 * `remote.worktree` after the parent has provided it.
 */
export const inject = ['locale', 'remote', 'workspaces']

/**
 * Client plugin body: mount this plugin's own Remote namespace, then register the chip and the card.
 * @param ctx - client root context.
 * @returns after the `worktree` namespace is callable; its methods are withdrawn when this fiber unloads.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Mounted on THIS fiber, so the endpoint's lifetime is the plugin's.
  await ctx.remote.$mount(worktreeRemote)
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'worktree: dictionaries')

  // The surface is a child so it can INJECT the namespace its parent just provided. Cordis will not
  // hand a fiber a service it did not declare, and the parent cannot declare one it creates itself;
  // the split is what lets the seats hold a properly injected reference.
  ctx.plugin({
    name: 'worktree-surface',
    inject: ['slots', 'settingsScope', 'locale', 'remote', 'remote.worktree', 'workspaces'],
    apply: surface,
  })
}

/**
 * Register the header chip and the settings card against a context that has the worktree namespace.
 * @param ctx - the child fiber, with `remote.worktree` injected.
 */
function surface(ctx: ClientContext): void {
  // Every endpoint returns the carrier's RemoteResult envelope. A transport failure is a different
  // fact from a git failure, so it is thrown rather than folded into the business union the Host
  // defines: the chip keeps its previous reading on screen, and a dialog keeps its form.
  const unwrap = <T>(result: RemoteResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`)
    return result.value
  }
  const remote = ctx.remote.worktree
  const describeWorktree: WorktreeChipInjected['describeWorktree'] =
    signal => remote.describe(signal).then(unwrap)

  /**
   * The composed directory chooser, read without an inject requirement.
   *
   * `uiWorkspace` is provided by a plugin this one does not depend on: the chooser is composed by
   * whichever directory-picker backend the deployment mounts, and a deployment without one must
   * still get every other control. Reading it here is what lets the Open Workspace button report
   * "this deployment has no chooser" instead of failing to load.
   */
  const pickDirectory: WorktreeHeroInjected['pickDirectory'] = async () => {
    const chooser = ctx.get('uiWorkspace') as
      { pickDirectory: () => Promise<string | null> } | undefined
    if (chooser === undefined) {
      throw new Error('this deployment composes no directory picker, so a folder cannot be chosen')
    }
    return chooser.pickDirectory()
  }

  /**
   * Bind every git operation to one workspace directory.
   *
   * Bound rather than passed per call because the workspace is the one argument every endpoint
   * shares and the one the component must not be able to get wrong: a seat holds a bound set for the
   * workspace it belongs to, and no call site restates the path.
   * @param workspacePath - the workspace's canonical directory.
   * @returns the bound command set.
   */
  const commandsFor = (workspacePath: string): WorktreeCommands => ({
    overview: signal => remote.overview({ workspacePath }, signal).then(unwrap),
    fetch: () => remote.fetch({ workspacePath }).then(unwrap),
    checkout: request => remote.checkout({ ...request, workspacePath }).then(unwrap),
    createBranch: request => remote.createBranch({ ...request, workspacePath }).then(unwrap),
    deleteBranch: request => remote.deleteBranch({ ...request, workspacePath }).then(unwrap),
    renameBranch: request => remote.renameBranch({ ...request, workspacePath }).then(unwrap),
    suggestPath: (branch, signal) => remote.suggestPath({ workspacePath, branch }, signal).then(unwrap),
    addWorktree: request => remote.addWorktree({ ...request, workspacePath }).then(unwrap),
    removeWorktree: request => remote.removeWorktree({ ...request, workspacePath }).then(unwrap),
    lockWorktree: request => remote.lockWorktree({ ...request, workspacePath }).then(unwrap),
    pruneWorktrees: () => remote.pruneWorktrees({ workspacePath }).then(unwrap),
  })

  /**
   * Adopt a directory as a Workspace, and optionally move the harness into it.
   *
   * `create` is idempotent on the Host — a path already owned by a Workspace answers that Workspace
   * — so adopting a worktree that was adopted before reuses the existing entry rather than adding a
   * second one for the same directory.
   * @param path - the worktree directory.
   * @param openSession - open (or reuse) a session in the resulting Workspace.
   */
  const adoptWorkspace: WorktreeChipInjected['adoptWorkspace'] = async (path, openSession) => {
    const workspace = await ctx.workspaces.create({ path })
    if (openSession) ctx.workspaces.startSession(workspace.workspaceId)
  }

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    // List seats are addressed by id; the seat orders itself after the resident chrome.
    id: 'worktree',
    locale: LOCALE_NS,
    inject: (): WorktreeChipInjected => ({
      describeWorktree,
      commandsFor,
      adoptWorkspace,
      revealPath: path => ctx.workspaces.openPath(path),
    }),
  }, WorktreeChip))

  /**
   * The new-session surface, registered at a NEGATIVE priority.
   *
   * Shadowing rather than replacing: `ui-workspace` registers the same single seat at the default
   * priority 0, and the lowest live entry is the one that renders, so this entry takes the seat
   * without the other package noticing — and uninstalling this plugin hands it straight back. What
   * the seat RENDERS is the whole point: the core picker's menu ends with an "Add workspace…" row,
   * and a menu that both switches and creates is what this surface exists to un-confuse.
   */
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({
    name: 'conversation.hero.workspace',
    priority: -1,
    locale: LOCALE_NS,
    inject: (): WorktreeHeroInjected => ({
      describeWorktree,
      commandsFor,
      pickDirectory,
      createWorkspace: async (path) => (await ctx.workspaces.create({ path })).workspaceId,
      renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
      suggestBranchName: (prompt) => remote.suggestBranchName({ prompt }).then(unwrap),
    }),
  }, HeroWorkspace))

  // Renders nothing; it exists to sit in the session scope and give a new worktree its real name
  // once the first prompt names the task. See the module doc for why that cannot happen earlier.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'worktree-naming',
    locale: LOCALE_NS,
    inject: (): WorktreeNamingInjected => ({
      describeWorktree,
      commandsFor,
      renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
      suggestBranchName: (prompt) => remote.suggestBranchName({ prompt }).then(unwrap),
    }),
  }, WorktreeNaming))

  const scope = ctx.settingsScope.bind<WorktreeSettings>({ namespace: SETTINGS_NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SETTINGS_NS,
    locale: LOCALE_NS,
    inject: (): WorktreeSettingsInjected => ({
      hooks: { worktreeSettings: scope satisfies SettingsScope<WorktreeSettings> },
      describeWorktree,
      setField: (field, value) => scope.set(field, value),
    }),
  }, WorktreeSettingsCard))
}
