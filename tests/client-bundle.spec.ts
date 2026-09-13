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
 * @returns a context shaped like the client root the harness hands a plugin.
 */
function fakeContext(registrations: Registration[]): unknown {
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
  const workspaces = {
    create: async () => ({ workspaceId: 'ws' }),
    rename: async () => undefined,
    startSession: () => undefined,
    openPath: async () => undefined,
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
    get: (name: string) => (name === 'uiWorkspace' ? { pickDirectory: async () => null } : undefined),
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
  async function applyBundle(): Promise<Registration[]> {
    const bundle = loadBundle()
    await (bundle['apply'] as (ctx: unknown) => Promise<void>)(fakeContext(registrations))
    return registrations
  }

  it('registers the chip, the naming watcher, and the shadowing hero picker', async () => {
    const captured = await applyBundle()
    const names = captured.map(entry =>
      `${entry.name}#${String(entry.options['id'] ?? entry.options['key'] ?? '')}`)
    expect(names).toEqual([
      'conversation.session.header.utilities#worktree',
      'conversation.hero.workspace#',
      'conversation.session.header.utilities#worktree-naming',
      'settings.plugin.item#worktree',
    ])
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
    for (const key of ['conversation.session.header.utilities#worktree', 'conversation.session.header.utilities#worktree-naming']) {
      expect(faces.get(key), key).toMatchObject({ commandsFor: expect.any(Function) })
    }
    expect(faces.get('conversation.hero.workspace#')).toMatchObject({
      commandsFor: expect.any(Function),
      pickDirectory: expect.any(Function),
      createWorkspace: expect.any(Function),
      renameWorkspace: expect.any(Function),
      suggestBranchName: expect.any(Function),
    })
    expect(faces.get('settings.plugin.item#worktree')).toMatchObject({
      hooks: expect.any(Object),
      setField: expect.any(Function),
    })
  })
})
