/**
 * Storing settings-card changes so that a change the Host refuses is seen rather than lost.
 *
 * The bound settings scope does not reject when the Host refuses a write: it quietly reloads Host
 * state and resolves (installed `@deepseek-ai/dsh-client-ui-settings` 0.1.5-rc.2, `recover` in
 * `lib/client.js`). A card that fires writes with `void` therefore cannot tell a stored change from
 * a refused one — the switch simply flips back, or worse, a two-field gesture half lands. So every
 * write here settles, and then the stored snapshot is compared with what was asked for.
 * @module @achasoft/dsh-worktree/client/settingsWrites
 */

import type { WorktreeSettings } from '../host/types.ts'

/** One field and the value to store in it. */
export type FieldWrite = readonly [field: keyof WorktreeSettings & string, value: WorktreeSettings[keyof WorktreeSettings]]

/**
 * The part of a bound settings scope these writes use.
 *
 * `mutate` is optional because the harness checkout this package compiles against declares only
 * `set`; the installed 0.1.5-rc.2 scope has both, and `mutate` applies several fields as one Host
 * validation, which is what a pair of dependent fields needs.
 */
export interface WritableScope {
  getSnapshot: () => { readonly value?: Partial<Record<string, unknown>> | undefined }
  set: (field: string, value: unknown) => Promise<void>
  mutate?: (ops: ReadonlyArray<{ op: 'set'; path: string[]; value: unknown }>) => Promise<void>
}

/** The Host did not store one or more fields it was asked to. */
export class SettingsWriteRefused extends Error {
  /**
   * @param fields - the fields whose stored value differs from the one written.
   */
  constructor(readonly fields: readonly string[]) {
    super(`the Host did not store ${fields.join(', ')}; the stored settings were reloaded`)
    this.name = 'SettingsWriteRefused'
  }
}

/**
 * The writes for turning "Register as a workspace" on or off.
 *
 * The Host refuses `openSession` without `registerWorkspace`, and validates the section after EVERY
 * write. Turning registration off while sessions are on must therefore clear `openSession` FIRST:
 * the other order has the first write refused (sessions still on) and the second accepted, which
 * leaves registration on and sessions off — the opposite of what was clicked.
 * @param next - the switch's new state.
 * @param openSession - the stored `openSession`, when known.
 * @returns the writes, dependent field first.
 */
export function registerWorkspaceWrites(next: boolean, openSession: boolean | undefined): readonly FieldWrite[] {
  if (!next && openSession === true) return [['openSession', false], ['registerWorkspace', false]]
  return [['registerWorkspace', next]]
}

/**
 * Build the card's writer over one scope.
 *
 * Writes that arrive while earlier ones are still settling form one burst, and only the burst's
 * LAST settlement verifies — covering every field written in it. An earlier settlement cannot be
 * verified: the scope publishes only its latest write's view, so a superseded write's fields would
 * read as refused while the burst is still on its way.
 * @param scope - the bound `worktree` settings scope.
 * @returns a function storing writes, in order, that rejects when the Host did not store them.
 */
export function createFieldWriter(scope: WritableScope): (writes: readonly FieldWrite[]) => Promise<void> {
  const burst = new Map<string, unknown>()
  let latest = 0
  return async (writes) => {
    const generation = ++latest
    for (const [field, value] of writes) burst.set(field, value)
    await store(scope, writes)
    if (generation !== latest) return
    const stored = scope.getSnapshot().value
    const refused = [...burst].filter(([field, value]) => stored?.[field] !== value).map(([field]) => field)
    burst.clear()
    if (refused.length > 0) throw new SettingsWriteRefused(refused)
  }
}

/**
 * Hand writes to the scope: as one atomic mutation when it offers one, otherwise one field at a
 * time in the order given.
 * @param scope - the bound settings scope.
 * @param writes - the writes, dependent fields first.
 */
async function store(scope: WritableScope, writes: readonly FieldWrite[]): Promise<void> {
  if (scope.mutate !== undefined) {
    const ops = writes.map(([field, value]) => ({ op: 'set' as const, path: [field], value }))
    await scope.mutate(ops)
    return
  }
  for (const [field, value] of writes) {
    // Sequential by design: the Host validates after each field, so the order given is the order
    // the section passes through, and each must be valid on its own.
    await scope.set(field, value)
  }
}
