/**
 * Naming a new worktree from the prompt that asked for it.
 *
 * The new-session surface creates a worktree before it knows what the session is for — it has a
 * checkbox and a repository, and the prompt arrives after the session is already pointed at the
 * worktree — so the branch starts on a provisional name and is renamed once there is something to
 * name it after. This module is the "name it after" half.
 *
 * The model is the deployment's own composer model, read through `agentDefaultModel`, exactly as the
 * companion advanced-sidebar plugin drafts a commit message: no second credential, no second
 * provider, and a deployment without a model still names its worktrees because the deterministic
 * prompt slug below is a complete answer on its own. The model call is therefore allowed to fail —
 * every failure path returns the slug rather than an error, because "the branch is called
 * `fix-login-redirect` instead of the model's prettier phrasing" is not a problem anyone needs told.
 * @module @achasoft/dsh-worktree/host/naming
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'
// Type-only: the ctx.agentDefaultModel Context merge, which is where the route comes from.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { slugify } from '../shared/name.ts'
import type { SuggestBranchNameResult } from './types.ts'

/** Most prompt characters framed into one naming request; the tail of a long prompt never changes the name. */
const MAX_PROMPT_CHARS = 4_000

/** Wall-clock bound for the auxiliary model call. */
const MODEL_TIMEOUT_MS = 20_000

/** Output-token cap: a branch name is a handful of words. */
const MAX_OUTPUT_TOKENS = 32

/**
 * System instruction for the naming call.
 *
 * Framed as hard output constraints rather than a request, because the answer is used as a git ref:
 * anything the model adds — a prefix, a code fence, an apology — has to be stripped again, and the
 * cheapest way not to strip it is not to receive it.
 */
const SYSTEM = [
  'Name a git branch for the coding task described by the supplied user prompt.',
  'Answer with only the branch name: lowercase words separated by single hyphens.',
  'Use no more than five words, no prefix, no slash, no quotes, no punctuation, no explanation.',
].join('\n')

/**
 * Read the name out of one model answer.
 *
 * The answer is allowed to be wrong in the ways models are wrong here: a fenced block, a quoted
 * string, a leading `Branch:` label, a trailing period. All of it is the same text as far as
 * {@link slugify} is concerned, so there is nothing to unwrap.
 * @param answer - the joined text deltas of the naming call.
 * @returns the name, possibly empty.
 */
function nameFromAnswer(answer: string): string {
  return slugify(answer)
}

/** The default-model selection this module reads; declared locally so the package carries no runtime dependency on it. */
interface DefaultModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffortId
}

/** The subset of the Context this module reads, gathered once so the call site stays one expression. */
interface NamingContext {
  readonly llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
  readonly models: { currentSelection(): DefaultModelSelection }
}

/**
 * Resolve the optional model capability pair.
 *
 * The cast is the cost of the package's two-tsconfig build: `ctx.get`'s key is typed by the Context
 * merge of whichever `@deepseek-ai/dsh-llm` copy a consumer's own resolution reaches, and the two
 * copies an out-of-tree plugin sees (the checkout's types for one, the running install's for the
 * other) are structurally the same API with different brand identities. Pinning the local shape is
 * what keeps this module compiling against both.
 * @param ctx - Host context.
 * @returns the pair when both services are mounted, otherwise undefined.
 */
function namingContext(ctx: Context): NamingContext | undefined {
  const llm = ctx.get('llm')
  const models = ctx.get('agentDefaultModel')
  if (llm === undefined || models === undefined) return undefined
  return {
    llm: llm as unknown as NamingContext['llm'],
    models: models as unknown as NamingContext['models'],
  }
}

/**
 * Ask the deployment's model to name the task one prompt describes.
 *
 * Never rejects and never fails on the model's account: a missing route, a timeout, an adapter error,
 * and an empty answer all answer with the deterministic slug instead, because the caller is in the
 * middle of creating a worktree and has no separate handling for "the name is plain".
 * @param ctx - Host context; the model services are read optionally.
 * @param prompt - the human's prompt.
 * @param signal - cancellation from the caller's abandoned request.
 * @returns the suggested name, or a classified failure for an unusable prompt.
 */
export async function suggestBranchName(
  ctx: Context, prompt: string, signal?: AbortSignal,
): Promise<SuggestBranchNameResult> {
  const trimmed = prompt.trim()
  if (trimmed === '') {
    return { ok: false, code: 'invalid-request', message: 'a branch name needs a prompt to describe' }
  }
  const fallback = slugify(trimmed)
  const naming = namingContext(ctx)
  if (naming === undefined) {
    return { ok: true, name: fallback === '' ? 'worktree' : fallback, source: 'fallback' }
  }
  const framed = trimmed.slice(0, MAX_PROMPT_CHARS)
  const selection = naming.models.currentSelection()
  // A caller signal and a deadline are both wanted: the first is the request being abandoned, the
  // second is a model that never answers.
  const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    let answer = ''
    for await (const chunk of naming.llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      system: SYSTEM,
      maxTokens: MAX_OUTPUT_TOKENS,
      messages: [createUserMessage({
        content: [{ type: 'text', text: framed }],
        source: { kind: 'plugin', plugin: '@achasoft/dsh-worktree' },
      })],
      signal: combined,
    })) {
      if (chunk.type === 'text-delta' && chunk.text !== undefined) answer += chunk.text
    }
    const named = nameFromAnswer(answer)
    if (named === '') {
      return { ok: true, name: fallback === '' ? 'worktree' : fallback, source: 'fallback' }
    }
    return {
      ok: true,
      name: named,
      source: 'model',
      model: `${selection.provider}/${selection.model}`,
    }
  } catch {
    // Including the abort case: a cancelled naming request is a name nobody is waiting for, and the
    // caller's worktree still needs one.
    return { ok: true, name: fallback === '' ? 'worktree' : fallback, source: 'fallback' }
  }
}
