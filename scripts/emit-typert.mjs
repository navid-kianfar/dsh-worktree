/**
 * Emit `generated/` — the Typert RPC contract this package's browser half mounts.
 *
 * The harness's Typert generator reads a TypeScript program seeded from the harness's own
 * `tsconfig.host.json`, so it cannot run against a package outside that checkout. The artifact is
 * therefore authored here, to the exact format that generator emits, from the one spec below; the
 * endpoint list and every wire schema live in this file and nowhere else.
 *
 * Editing `src/host/types.ts` or the `@Remote` surface means editing this spec too. `pnpm test`
 * refuses a mismatch (`scripts/check-typert.mjs`), so the two cannot drift silently.
 *
 * Usage: node scripts/emit-typert.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { FINGERPRINT_FILE, fingerprint } from './typert-fingerprint.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = `${ROOT}generated`
const PKG = '@achasoft/dsh-worktree'
const NS = 'worktree'
const SERVICE = 'worktree'
const TYPES = '../src/host/types.ts'
const SRC = 'src/host/index.ts'
const prefix = PKG.replace(/[^A-Za-z0-9]/g, '_')

/** A closed string union, as the generator spells one. */
const u = (...values) => `z.union([${values.map(v => `z.literal(${JSON.stringify(v)})`).join(', ')}])`

// --- shared object schemas, in declaration order of src/host/types.ts ---

const tracking = `z.object({
  'upstream': z.string().readonly(),
  'ahead': z.number().readonly(),
  'behind': z.number().readonly(),
  'gone': z.boolean().readonly(),
})`

const branchEntry = `z.object({
  'name': z.string().readonly(),
  'ref': z.string().readonly(),
  'kind': ${u('local', 'remote')}.readonly(),
  'current': z.boolean().readonly(),
  'tracking': ${tracking}.readonly().optional(),
  'sha': z.string().readonly(),
  'subject': z.string().readonly(),
  'author': z.string().readonly(),
  'committedAt': z.number().readonly(),
  'checkedOutAt': z.string().readonly().optional(),
})`

const worktreeEntry = `z.object({
  'path': z.string().readonly(),
  'sha': z.string().readonly().optional(),
  'branch': z.string().readonly().optional(),
  'bare': z.boolean().readonly(),
  'detached': z.boolean().readonly(),
  'locked': z.boolean().readonly(),
  'lockReason': z.string().readonly().optional(),
  'prunable': z.boolean().readonly(),
  'prunableReason': z.string().readonly().optional(),
  'current': z.boolean().readonly(),
  'main': z.boolean().readonly(),
})`

const dirtyState = `z.object({
  'staged': z.number().readonly(),
  'unstaged': z.number().readonly(),
  'untracked': z.number().readonly(),
  'conflicted': z.number().readonly(),
})`

const repoState = `z.object({
  'root': z.string().readonly(),
  'worktreeRoot': z.string().readonly(),
  'name': z.string().readonly(),
  'branch': z.string().readonly().optional(),
  'sha': z.string().readonly().optional(),
  'detached': z.boolean().readonly(),
  'unborn': z.boolean().readonly(),
  'tracking': ${tracking}.readonly().optional(),
  'dirty': ${dirtyState}.readonly(),
  'linked': z.boolean().readonly(),
})`

const failureCodes = u(
  'no-filesystem', 'no-subprocess', 'no-git', 'not-a-repository', 'path-denied', 'not-found',
  'refused', 'git-failed', 'timeout', 'cancelled', 'invalid-request',
)

const gitFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${failureCodes}.readonly(),
  'message': z.string().readonly(),
})`

const worktreeView = `z.object({
  'gitAvailable': z.boolean().readonly(),
  'gitVersion': z.string().readonly().optional(),
  'reason': z.string().readonly().optional(),
  'showChip': z.boolean().readonly(),
  'registerWorkspace': z.boolean().readonly(),
  'openSession': z.boolean().readonly(),
  'branchPrefix': z.string().readonly(),
  'refreshIntervalMs': z.number().readonly(),
  'confirmDestructive': z.boolean().readonly(),
})`

const overviewResult = `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'repo': ${repoState}.readonly(),
  'branches': z.array(${branchEntry}).readonly(),
  'branchesTruncated': z.boolean().readonly(),
  'worktrees': z.array(${worktreeEntry}).readonly(),
  'readAt': z.number().readonly(),
}), ${gitFailure}])`

const mutationResult = `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'detail': z.string().readonly(),
}), ${gitFailure}])`

const addWorktreeResult = `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'path': z.string().readonly(),
  'branch': z.string().readonly().optional(),
  'detail': z.string().readonly(),
}), ${gitFailure}])`

const suggestBranchNameResult = `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'name': z.string().readonly(),
  'source': z.union([z.literal("model"), z.literal("fallback")]).readonly(),
  'model': z.string().readonly().optional(),
}), ${gitFailure}])`

const suggestPathResult = `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'path': z.string().readonly(),
  'exists': z.boolean().readonly(),
  'emptyDirectory': z.boolean().readonly(),
}), ${gitFailure}])`

/** A request object; `workspacePath` comes first because every request extends `RepoRequest`. */
const request = (...members) => `z.object({
  'workspacePath': z.string().readonly(),${members.map(member => `\n  ${member}`).join('')}
})`

/** The one request that names no repository: naming is text work with nothing to resolve. */
const suggestBranchNameRequest = `z.object({
  'prompt': z.string().readonly(),
})`

const repoRequest = request()

/**
 * One `@Remote` endpoint: its parameters, whether it takes the gateway's signal, and its result.
 *
 * `line` is filled in from `src/host/index.ts` at emit time rather than written here, so the
 * recorded source location cannot drift from the file it points into.
 */
const ENDPOINTS = [
  {
    method: 'addWorktree',
    params: [{ name: 'request', type: 'AddWorktreeRequest', schema: request(
      `'path': z.string().readonly().optional(),`,
      `'branch': z.string().readonly(),`,
      `'createBranch': z.boolean().readonly(),`,
      `'startPoint': z.string().readonly().optional(),`,
      `'detach': z.boolean().readonly(),`,
    ) }],
    cancellation: true,
    result: { type: 'AddWorktreeResult', schema: addWorktreeResult },
  },
  {
    method: 'checkout',
    params: [{ name: 'request', type: 'CheckoutRequest', schema: request(
      `'branch': z.string().readonly(),`,
      `'carryChanges': z.boolean().readonly(),`,
    ) }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'createBranch',
    params: [{ name: 'request', type: 'CreateBranchRequest', schema: request(
      `'branch': z.string().readonly(),`,
      `'startPoint': z.string().readonly().optional(),`,
      `'checkout': z.boolean().readonly(),`,
    ) }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'deleteBranch',
    params: [{ name: 'request', type: 'DeleteBranchRequest', schema: request(
      `'branch': z.string().readonly(),`,
      `'force': z.boolean().readonly(),`,
    ) }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'describe',
    params: [],
    cancellation: true,
    result: { type: 'WorktreeView', schema: worktreeView },
  },
  {
    method: 'fetch',
    params: [{ name: 'request', type: 'RepoRequest', schema: repoRequest }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'lockWorktree',
    params: [{ name: 'request', type: 'LockWorktreeRequest', schema: request(
      `'path': z.string().readonly(),`,
      `'locked': z.boolean().readonly(),`,
      `'reason': z.string().readonly().optional(),`,
    ) }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'overview',
    params: [{ name: 'request', type: 'RepoRequest', schema: repoRequest }],
    cancellation: true,
    result: { type: 'OverviewResult', schema: overviewResult },
  },
  {
    method: 'pruneWorktrees',
    params: [{ name: 'request', type: 'RepoRequest', schema: repoRequest }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'removeWorktree',
    params: [{ name: 'request', type: 'RemoveWorktreeRequest', schema: request(
      `'path': z.string().readonly(),`,
      `'force': z.boolean().readonly(),`,
    ) }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'renameBranch',
    params: [{ name: 'request', type: 'RenameBranchRequest', schema: request(
      `'branch': z.string().readonly(),`,
      `'name': z.string().readonly(),`,
    ) }],
    cancellation: true,
    result: { type: 'MutationResult', schema: mutationResult },
  },
  {
    method: 'suggestBranchName',
    params: [{ name: 'request', type: 'SuggestBranchNameRequest', schema: suggestBranchNameRequest }],
    cancellation: true,
    result: { type: 'SuggestBranchNameResult', schema: suggestBranchNameResult },
  },
  {
    method: 'suggestPath',
    params: [{ name: 'request', type: 'SuggestPathRequest', schema: request(
      `'branch': z.string().readonly(),`,
    ) }],
    cancellation: true,
    result: { type: 'SuggestPathResult', schema: suggestPathResult },
  },
]

/**
 * Read the source line each `@Remote` decorator sits on.
 * @returns method name to 1-based line number.
 */
async function sourceLines() {
  const source = await readFile(new URL(SRC, `file://${ROOT}`), 'utf8')
  const lines = new Map()
  source.split('\n').forEach((line, index) => {
    const match = /@Remote\('([^']+)'\)/.exec(line)
    // The generator points at the METHOD, which follows its decorator on the next line.
    if (match !== null) lines.set(match[1], index + 2)
  })
  return lines
}

const LINES = await sourceLines()
const missing = ENDPOINTS.filter(endpoint => !LINES.has(endpoint.method)).map(e => e.method)
if (missing.length > 0) {
  console.error(`typert: this spec names endpoints ${SRC} does not declare: ${missing.join(', ')}`)
  process.exit(1)
}

const constName = (method, suffix) => `${prefix}_${NS}_${method}_${suffix}$schema`

function schemaBlock() {
  const lines = []
  for (const endpoint of ENDPOINTS) {
    endpoint.params.forEach((parameter, index) => {
      lines.push(`const ${constName(endpoint.method, `parameter_${index}`)} = ${parameter.schema}`)
    })
    lines.push(`const ${constName(endpoint.method, 'result')} = ${endpoint.result.schema}`)
  }
  return lines.join('\n')
}

function descriptorBlock() {
  return ENDPOINTS.map((endpoint) => {
    const parameters = endpoint.params.map((parameter, index) => `        {
          name: '${parameter.name}',
          wire: '${parameter.name}',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '${TYPES}#${parameter.type}',
            schema: ${constName(endpoint.method, `parameter_${index}`)},
          },
        },`).join('\n')
    return `    {
      id: '${PKG}#${NS}/${endpoint.method}',
      service: '${SERVICE}',
      namespace: '${NS}',
      method: '${endpoint.method}',
      invocation: { kind: 'direct' },
      parameters: [
${parameters === '' ? '      ' : parameters}
      ],
${endpoint.cancellation ? "      cancellation: { parameter: 'signal' },\n" : ''}      result: {
        mode: 'strict',
        typeSymbol: '${TYPES}#${endpoint.result.type}',
        schema: ${constName(endpoint.method, 'result')},
      },
      sourceLocation: {"file":"${SRC}","line":${LINES.get(endpoint.method)},"column":3},
    },`
  }).join('\n')
}

const HEADER_REMOTE = '/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */'
const HEADER_HOST = '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */'

const remoteJs = `${HEADER_REMOTE}
import { z } from 'zod'

${schemaBlock()}

export const TYPERT_REMOTE = {
  package: '${PKG}',
  descriptors: [
${descriptorBlock()}
  ],
}

export default TYPERT_REMOTE
`

const hostJs = `${HEADER_HOST}
import { z } from 'zod'

${schemaBlock()}

export const TYPERT = {
  package: '${PKG}',
  face: 'host',
  schemas: [
  ],
  invocations: [
${descriptorBlock()}
  ],
  model: {
    "services": [],
    "events": [],
    "objects": []
  },
}
`

const signature = (endpoint) => {
  const params = endpoint.params.map(parameter => `${parameter.name}: ${parameter.type}`)
  if (endpoint.cancellation) params.push('signal?: AbortSignal')
  return `(${params.join(', ')}) => Promise<RemoteResult<${endpoint.result.type}>>`
}

const usedTypes = [...new Set(ENDPOINTS.flatMap(endpoint =>
  [...endpoint.params.map(parameter => parameter.type), endpoint.result.type]))].sort()

const hex = Buffer.from(NS, 'utf8').toString('hex')
const remoteDts = `${HEADER_REMOTE}
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { ${usedTypes.join(', ')} } from '${TYPES}'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$${hex} {
${ENDPOINTS.map(endpoint => `    ${endpoint.method}: ${signature(endpoint)}`).join('\n')}
  }
  interface TypertRemoteMap {
${ENDPOINTS.map(endpoint => `    '${NS}/${endpoint.method}': ${signature(endpoint)}`).join('\n')}
  }
  interface TypertRemoteNamespaceMap {
    '${NS}': TypertRemoteNamespace$${hex}
  }
}

export declare const TYPERT_REMOTE: TypertRemoteContribution
export default TYPERT_REMOTE
`

const hostDts = `${HEADER_HOST}

export declare const TYPERT: unknown
`

await mkdir(OUT, { recursive: true })
await writeFile(`${OUT}/typert.remote-client.js`, remoteJs)
await writeFile(`${OUT}/typert.remote-client.d.ts`, remoteDts)
await writeFile(`${OUT}/typert.host.js`, hostJs)
await writeFile(`${OUT}/typert.host.d.ts`, hostDts)
// Recorded last, and from the same inputs the check re-hashes: writing it before the artifacts
// would leave a fingerprint vouching for files a failed write never produced.
await writeFile(`${ROOT}${FINGERPRINT_FILE}`, `${await fingerprint()}\n`)
console.log(`typert: emitted ${ENDPOINTS.length} endpoints into generated/`)
