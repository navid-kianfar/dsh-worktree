/**
 * Smoke-test the built browser half by loading it the way the harness's module loader does.
 *
 * The client bundle is not an ordinary module: it is a `window.__ModuleLoader__.load({ id, factory })`
 * handoff, and the only thing that proves the registrations are wired correctly is exercising that
 * handoff. `tsc` cannot (it type-checks sources, not the handoff) and neither can a rendering test
 * (there is no DOM here) — but the two mistakes this file exists to catch are both load-time: a seat
 * registered into a key that does not exist, and a shadowing priority that would silently leave the
 * core picker in place.
 *
 * Runs against `lib/client.js`, so it skips when the package has not been built. `pnpm test` does not
 * build first; `pnpm build && pnpm test` does.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { beforeEach, describe, expect, it } from 'vitest'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const built = existsSync(BUNDLE)

/** One captured loader entry. */
interface LoaderEntry {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** A registration the fake slot service was asked to make. */
interface Registration {
  readonly name: string
  readonly options: Record<string, unknown>
}

/**
 * Load the built bundle in a context that has a `window` but no `document`.
 *
 * No `document` on purpose: the bundle installs a `<style>` tag per stylesheet at factory time and
 * guards it with `typeof document !== 'undefined'`, so a context without one proves the guard works
 * as well as keeping this test out of a DOM implementation.
 * @returns the bundle's exports.
 */
function loadBundle(): Record<string, unknown> {
  const source = readFileSync(BUNDLE, 'utf8')
  const nodeRequire = createRequire(import.meta.url)
  let entry: LoaderEntry | undefined
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(captured: LoaderEntry) { entry = captured },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  if (entry === undefined) throw new Error('the bundle did not hand itself to the module loader')
  // `react-dom` is required by the bundle but never used by these registrations; the real one is
  // loaded so the module table matches what the loader would supply.
  const table: Record<string, unknown> = {
    react: nodeRequire('react'),
    'react/jsx-runtime': nodeRequire('react/jsx-runtime'),
    'react-dom': nodeRequire('react-dom'),
    // A stub: this bundle only ever holds the primitive components, and nothing here renders.
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
  }
  return (entry as LoaderEntry).factory(specifier => {
    const found = table[specifier]
    if (found === undefined) throw new Error(`the bundle required an unknown module "${specifier}"`)
    return found
  })
}

/**
 * A Context stub recording every slot registration, with the services the bundle reads at apply time.
 * @param registrations - collects each `slots.register` call.
 * @param services - what `ctx.get` answers, by service name; absent names read as not composed.
 * @returns a context shaped like the client root the harness hands a plugin.
 */
function fakeContext(
  registrations: Registration[],
  services: Record<string, unknown> = { uiWorkspace: { pickDirectory: async () => null } },
): unknown {
  const remote = {
    $mount: async () => undefined,
    worktree: {
      describe: async () => ({ ok: true, value: {} }),
      suggestBranchName: async () => ({ ok: true, value: { ok: true, name: 'x', source: 'fallback' } }),
    },
  }
  const slots = {
    inject: (_key: string, callback: () => unknown) => { callback(); return () => {} },
    register: (options: Record<string, unknown>) => {
      registrations.push({ name: String(options['name']), options })
      return () => {}
    },
  }
  // Only what the installed Workspace Controller has: navigation (`startSession`) is `uiWorkspace`'s,
  // and there is no path opener here at all.
  const workspaces = {
    create: async () => ({ workspaceId: 'ws' }),
    rename: async () => undefined,
    delete: async () => undefined,
  }
  const ctx = {
    remote,
    slots,
    workspaces,
    locale: { register: () => () => {} },
    effect: () => () => {},
    settingsScope: { bind: () => ({ getSnapshot: () => ({ value: undefined }), set: async () => {} }) },
    // The bundle registers its seats from a CHILD plugin so the child can inject the Remote
    // namespace the parent just mounted; running the child body inline is what a real fiber does.
    plugin: (child: { apply?: (scope: unknown) => void }) => { child.apply?.(ctx) },
    get: (name: string) => services[name],
  }
  return ctx
}

describe.skipIf(!built)('the built client bundle', () => {
  let registrations: Registration[]

  beforeEach(() => { registrations = [] })

  /**
   * Load the bundle and run its apply against a recording context.
   * @returns the captured registrations.
   */
  async function applyBundle(services?: Record<string, unknown>): Promise<Registration[]> {
    const bundle = loadBundle()
    await (bundle['apply'] as (ctx: unknown) => Promise<void>)(fakeContext(registrations, services))
    return registrations
  }

  /**
   * Apply the bundle and build the branch and worktree row's injected face.
   * @param services - what `ctx.get` answers.
   * @returns the chip's face.
   */
  async function chipFace(services: Record<string, unknown>): Promise<Record<string, (...args: never[]) => unknown>> {
    const captured = await applyBundle(services)
    const chip = captured.find(entry =>
      entry.name === 'conversation.input.dock' && entry.options['id'] === 'worktree')
    return (chip?.options['inject'] as () => Record<string, (...args: never[]) => unknown>)()
  }

  it('registers the chip, the hero toolbar, the send gate, the naming watcher, and the card', async () => {
    const captured = await applyBundle()
    const names = captured.map(entry =>
      `${entry.name}#${String(entry.options['id'] ?? entry.options['key'] ?? '')}`)
    expect(names).toEqual([
      'conversation.input.dock#worktree',
      'conversation.hero.workspace#',
      'conversation.input.left#worktree-send-gate',
      'conversation.session.header.utilities#worktree-naming',
      'settings.plugin.item#worktree',
    ])
  })

  it('puts the chip above the composer and nowhere in the session header', async () => {
    const captured = await applyBundle()
    const chips = captured.filter(entry => entry.options['id'] === 'worktree')
    expect(chips.map(entry => entry.name)).toEqual(['conversation.input.dock'])
    // After the core todo (0) and queue (20) dock entries, so it is the row touching the composer.
    expect(chips[0]?.options['order']).toBeGreaterThan(20)
    // The only header occupant left is the naming watcher, which renders nothing.
    const header = captured.filter(entry => entry.name.startsWith('conversation.session.header'))
    expect(header.map(entry => entry.options['id'])).toEqual(['worktree-naming'])
  })

  it('takes the hero picker seat below the core registration', async () => {
    const captured = await applyBundle()
    const hero = captured.find(entry => entry.name === 'conversation.hero.workspace')
    // The core picker registers at the default priority; anything at or above it leaves the core
    // picker rendering, and "Add workspace…" stays in the menu this package exists to replace.
    expect(hero?.options['priority']).toBeLessThan(0)
  })

  it('builds every injected face the seats need', async () => {
    const captured = await applyBundle()
    const faces = new Map(captured.map((entry) => {
      const inject = entry.options['inject'] as (() => Record<string, unknown>) | undefined
      expect(inject, `${entry.name} has no inject factory`).toBeTypeOf('function')
      const key = `${entry.name}#${String(entry.options['id'] ?? entry.options['key'] ?? '')}`
      return [key, inject?.() ?? {}]
    }))
    for (const face of faces.values()) {
      expect(face).toMatchObject({ describeWorktree: expect.any(Function) })
    }
    // The two git seats bind operations; the card owns settings instead and gets no command set.
    for (const key of [
      'conversation.input.dock#worktree',
      'conversation.session.header.utilities#worktree-naming',
      'conversation.input.left#worktree-send-gate',
    ]) {
      expect(faces.get(key), key).toMatchObject({ commandsFor: expect.any(Function) })
    }
    expect(faces.get('conversation.hero.workspace#')).toMatchObject({
      commandsFor: expect.any(Function),
      pickDirectory: expect.any(Function),
      createWorkspace: expect.any(Function),
    })
    // Naming and renaming moved to the send gate; the toolbar no longer carries them.
    expect(faces.get('conversation.hero.workspace#')).not.toHaveProperty('renameWorkspace')
    expect(faces.get('conversation.hero.workspace#')).not.toHaveProperty('suggestBranchName')
    // The gate reaches harness facilities through `ctx.get`; with none composed it must still answer.
    const gate = faces.get('conversation.input.left#worktree-send-gate') as Record<string, (...args: unknown[]) => unknown>
    expect(gate).toMatchObject({
      createWorkspace: expect.any(Function),
      suggestBranchName: expect.any(Function),
      renameWorkspace: expect.any(Function),
      deleteWorkspace: expect.any(Function),
      menuClaimsEnter: expect.any(Function),
      currentSession: expect.any(Function),
      block: expect.any(Function),
      notify: expect.any(Function),
    })
    expect(gate['menuClaimsEnter']?.('s1')).toBe(false)
    expect(gate['currentSession']?.()).toBeUndefined()
    expect(() => { gate['block']?.('s1', 'busy') }).not.toThrow()
    expect(() => { gate['notify']?.('s1', 'failed') }).not.toThrow()
    expect(faces.get('settings.plugin.item#worktree')).toMatchObject({
      hooks: expect.any(Object),
      setField: expect.any(Function),
    })
  })

  it('opens a session in an adopted worktree through uiWorkspace, not the Workspace Controller', async () => {
    const started: unknown[] = []
    const chip = await chipFace({
      uiWorkspace: { pickDirectory: async () => null, startSession: (id: unknown) => { started.push(id) } },
    })
    const adopt = chip['adoptWorkspace'] as (path: string, openSession: boolean) => Promise<void>
    await adopt('/repo-wt', false)
    expect(started).toEqual([])
    await adopt('/repo-wt', true)
    expect(started).toEqual(['ws'])
  })

  it('refuses to open a session when no workspace navigation is composed', async () => {
    const chip = await chipFace({})
    const adopt = chip['adoptWorkspace'] as (path: string, openSession: boolean) => Promise<void>
    await expect(adopt('/repo-wt', false)).resolves.toBeUndefined()
    await expect(adopt('/repo-wt', true)).rejects.toThrow(/no workspace navigation/)
  })

  it('reveals a path through the Session Remote file-manager handoff', async () => {
    const requests: unknown[] = []
    const chip = await chipFace({
      'remote.session': {
        canOpenWorkspacePath: async () => ({ ok: true, value: true }),
        openWorkspacePath: async (request: unknown) => {
          requests.push(request)
          return { ok: true, value: { opened: true } }
        },
      },
    })
    await expect((chip['canRevealPath'] as () => Promise<boolean>)()).resolves.toBe(true)
    await (chip['revealPath'] as (path: string) => Promise<void>)('/repo-wt')
    expect(requests).toEqual([{ action: 'reveal', path: '/repo-wt' }])
  })

  it('reports reveal as unsupported, and rejects it, when the Host cannot', async () => {
    const failing = await chipFace({
      'remote.session': {
        canOpenWorkspacePath: async () => ({ ok: true, value: false }),
        openWorkspacePath: async () => ({ ok: false, error: { code: 'gateway/internal', message: 'no opener' } }),
      },
    })
    await expect((failing['canRevealPath'] as () => Promise<boolean>)()).resolves.toBe(false)
    await expect((failing['revealPath'] as (path: string) => Promise<void>)('/x')).rejects.toThrow(/no opener/)
    registrations = []
    const absent = await chipFace({})
    await expect((absent['canRevealPath'] as () => Promise<boolean>)()).resolves.toBe(false)
    await expect((absent['revealPath'] as (path: string) => Promise<void>)('/x')).rejects.toThrow(/no session remote/)
  })

  /**
   * Apply the bundle and build the send gate's injected face.
   * @param services - what `ctx.get` answers.
   * @returns the gate's face.
   */
  async function gateFace(services: Record<string, unknown>): Promise<Record<string, (...args: never[]) => unknown>> {
    const captured = await applyBundle(services)
    const gate = captured.find(entry => entry.options['id'] === 'worktree-send-gate')
    return (gate?.options['inject'] as () => Record<string, (...args: never[]) => unknown>)()
  }

  it('leaves Enter to a trigger menu only while a row is highlighted, as the harness keymap does', async () => {
    let menu: { open: boolean, highlight: unknown } = { open: true, highlight: null }
    const services = {
      sessions: { scope: (id: string) => ({ id }), list: { getSnapshot: () => ({ current: 's1' }) } },
      inputTriggers: { sessionOf: () => ({ menu: { getSnapshot: () => menu } }) },
    }
    const gate = await gateFace(services)
    const claims = gate['menuClaimsEnter'] as (sessionId: string) => boolean
    // Open but still loading: nothing highlighted, so Enter sends — and the gate must own that send.
    expect(claims('s1')).toBe(false)
    menu = { open: true, highlight: { source: 'file', index: 0 } }
    expect(claims('s1')).toBe(true)
    menu = { open: false, highlight: null }
    expect(claims('s1')).toBe(false)
    expect((gate['currentSession'] as () => string | undefined)()).toBe('s1')
  })
})
