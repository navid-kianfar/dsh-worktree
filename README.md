# @achasoft/dsh-worktree

Git worktrees and branches for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web Client.

A chip in the session header says which branch and which worktree the session is working in. Clicking either half opens a switcher; the `+` beside them creates a new worktree, adopts its directory as a harness Workspace, and opens a session there.

```
 ⑂ main ↑2 •  │  ⧉ my-repo  2      +
   └ branch      └ worktree        └ new worktree
```

The plugin also owns the **new-session row**, where a session is placed rather than inspected. It takes that seat by shadowing the core workspace picker at a lower slot priority, so no harness source is patched and uninstalling the plugin hands the seat straight back.

```
 📁 my-repo ▾    [ Open Workspace ]    ☐ Worktree          ◇ Standard mode
   └ project switcher                     └ run in a        └ the harness's own
                                            git worktree      preset control
```

## What it does

**Branches** — list local and remote-tracking branches with their tip commit, author, age, and ahead/behind counters; filter them by fuzzy search; switch, create, rename, and delete. A branch already checked out in another worktree says so and jumps there instead of failing, because git refuses to check one branch out twice. `Fetch` updates remote-tracking refs and prunes the ones whose remote branch is gone.

**Worktrees** — list every worktree of the repository with its branch, path, and lock or prunable state; open a session in one; lock, unlock, remove, and prune. Creating a worktree fills its directory from a configurable path template, then optionally registers it as a Workspace and starts a session in it.

**Project switcher** — the session-start chip lists your Workspaces and switches between them. It is a switcher and nothing else: the core picker's trailing "Add workspace…" row is deliberately gone, because a menu whose job is choosing between projects should not also be the only way to create one.

**Open Workspace** — a labelled button beside the switcher that opens the host's own folder chooser and starts a session in whatever it returns. This is the action the core picker buried as the last row of its menu.

**Worktree checkbox** — tick it and the session runs in a **fresh git worktree** instead of the repository itself. The worktree is created at once, on a provisional branch, because a session can only be pointed at a directory that already exists; the branch is then **renamed from your first message** — by your deployment's own model, falling back to a slug of the prompt when no model is configured — so a task gets a name that describes it without anyone typing one. Unticking before you send removes the worktree and its provisional branch and returns you to the Workspace you came from.

**Uncommitted work is never discarded.** A checkout with local changes uses `git switch --merge`, which carries them across and aborts on conflict. A force-delete or force-remove is a separate switch, and by default also needs the branch or worktree name typed to confirm.

## Requirements

- DeepSeek Harness with the `web` app.
- `git` on the host process PATH. `git switch` is used, so **git 2.23 or newer**; git 2.36 adds the NUL-separated worktree listing this plugin prefers and the `locked`/`prunable` attributes it reads, and below that it falls back cleanly.
- The `@deepseek-ai/dsh-subprocess` and `@deepseek-ai/dsh-fs` capabilities, both of which the base bundle mounts. Without either, the header control stays hidden and the settings card says which one is missing.
- A composed directory picker (`ui-directory-picker-native` or `-browse`, mounted automatically by the web app) for **Open Workspace**. Without one the button reports that no chooser exists and everything else keeps working.
- Optional: a default model (`agentDefaultModel`) for the worktree branch name. Without one the name is the deterministic slug of your prompt.

## Install

```sh
dsh plugin --profile web add @achasoft/dsh-worktree
```

Then add it to the profile's bundle list in `$DSH_HOME/profiles/web/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@achasoft/dsh-worktree"]
    }
  }
}
```

Restart the profile. Nothing else is required — there is no provider to choose and no credential to supply.

## Settings

Every field is editable from **Settings → Plugins → Worktrees and branches**, and from your profile's `cordis.patch.yml` by the `worktree` id. Changes take effect on the next request; nothing needs a restart.

| Field | Default | What it does |
| --- | --- | --- |
| `showChip` | `true` | Render the session-header control. Off keeps the endpoints and this card. |
| `worktreePathTemplate` | `{repoParent}/{repo}-worktrees/{branch}` | Where a new worktree goes. See below. |
| `branchPrefix` | `''` | Prefilled when creating a branch, e.g. `feature/`. |
| `registerWorkspace` | `true` | Adopt a worktree's directory as a harness Workspace. |
| `openSession` | `true` | Open a session in that Workspace. Requires `registerWorkspace`. |
| `includeRemoteBranches` | `true` | List remote-tracking branches beside the local ones. |
| `maxBranches` | `200` | Most branches one reading returns; the list says when it truncated. |
| `refreshIntervalMs` | `15000` | How often the chip re-reads. `0` reads only on an explicit refresh. |
| `gitTimeoutMs` | `20000` | Bound for a local git command. |
| `networkTimeoutMs` | `120000` | Bound for a command that contacts a remote. Never below `gitTimeoutMs`. |
| `maxOutputBytes` | `1048576` | In-memory cap per captured git stream. |
| `graceMs` | `5000` | TERM-to-KILL grace when a git command is terminated. |
| `confirmDestructive` | `true` | Require typing the name before a force-delete or force-remove. |

### Path template

The template expands against the repository being acted on. A relative result resolves against the repository root.

| Placeholder | Expands to |
| --- | --- |
| `{repoRoot}` | the repository's main worktree directory |
| `{repoParent}` | its parent directory |
| `{repo}` | its basename |
| `{branch}` | the branch name with `/` folded to `-`, so `feature/login` stays one directory |
| `{branchPath}` | the branch name with its slashes kept, so `feature/login` nests |

The template must contain `{branch}` or `{branchPath}`; without one, every worktree would expand to the same directory and only the first could be created. The plugin refuses such a template at load and the settings card refuses to store it.

## Design notes

**git runs on the host, never in the browser.** Reading a repository means running `git` and parsing its machine formats, and creating a worktree means writing a directory — neither is reachable from a page. What crosses the wire is already classified: parsed readings, and mutation outcomes carrying git's own summary line.

**A value from the browser becomes a git argument only after the host has proved what it names** — a branch through `rev-parse --verify`, a worktree path by matching git's own `worktree list`. The one path that skips that check, a new worktree's destination, must be absent or an empty directory.

**Nothing here is model-facing.** Which branch you are on is operator context that never enters a prompt, so the plugin adds no tool, no prompt contribution, and no session event. The agent reaches git the way it always has: through the shell. The one model call this plugin makes is its own — naming a worktree's branch — and its answer reaches git as a branch name, never as prompt text.

**The new-session seat is taken by shadowing, not by forking the shell.** `ui-workspace` registers `conversation.hero.workspace` at the default slot priority and this plugin registers the same single seat at `-1`, which is the slot system's documented shadowing rule: the lowest live entry renders. The shell's folder chip, its draft-carrying workspace switch, and the composed directory-flow hole all keep working; only the menu's contents and the two controls beside it change.

**A worktree is created before its name exists, and renamed after.** A session runs in a directory, so the directory has to exist before the session does — but the only thing worth naming a worktree after is the prompt, which is typed afterwards. So the branch starts on a random provisional name (`wt-<8 hex>`), the session is pointed at it, and a second seat in the session header renames it once the first message is admitted. The directory keeps the provisional name; the Workspace's display title is renamed too, so the switcher reads the branch name. Renaming the directory as well would move a Workspace out from under a live session, which is a worse trade than an unlovely folder name.

**Unticking removes what ticking created, and only that.** The provisional branch is this plugin's own invention — nobody had it before the box was ticked — so unticking removes the worktree and then deletes that branch. `force: false` on the delete means a branch someone has since committed to is refused and kept; at that point the worktree is already gone and the commits are what matter.

**Remote branches are never deleted.** Deleting one means pushing a deletion to somebody else's repository, which is not something a switcher popover should be able to do by accident.

**Removing a worktree leaves its Workspace registered.** The removal dialog promises to delete a directory and keep the branch; silently un-registering a Workspace you may have created yourself is a different domain's business. Remove it from the sidebar when you want it gone.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test          # checks the generated Typert contract, then runs the unit tests
pnpm run build
```

`generated/` holds the Typert RPC contract and is **committed source**, not a build output this package can reproduce: the harness's generator only runs inside a `deepseek-harness` checkout. It is authored to that generator's format by `scripts/emit-typert.mjs`, and `pnpm test` refuses a mismatch — so editing `src/host/types.ts` or the `@Remote` surface means editing that spec and re-running `pnpm run regen:typert`.

## License

MIT
