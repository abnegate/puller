# Puller

A local React dashboard for your open authored pull requests:

```text
is:pr author:@me state:open archived:false sort:updated-desc
```

Puller keeps GitHub's result order and divides pull requests into **Ready**, **In progress**, and **Not ready**. It also shows authored pull requests grouped under the recent GitHub releases that contain them.

## Requirements

- Node.js 22.12 or newer
- pnpm 11.17.0
- [GitHub CLI](https://cli.github.com/) authenticated for the repositories you want to inspect
- At least one local agent:
  - Claude Code authenticated locally; or
  - Codex `codex-cli-exec 0.144.6` on your `PATH` and authenticated locally. Homebrew, Linuxbrew, `/usr/local/bin`, and `~/.local/bin` are searched automatically. Set `CODEX_PATH` to an absolute executable if it lives somewhere else.
- Local clones or worktrees for repositories where an agent will run

Check the command-line tools before starting:

```bash
gh auth status
claude --version
codex exec --version
codex login status
```

## Run locally

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:5173>. The Node server hosts the API and Vite middleware on the same origin.

For a production build served locally:

```bash
pnpm build
pnpm start
```

The interface follows the system light or dark preference by default and lets you override it. The pull list refreshes silently every 10 seconds while the page is visible; the existing snapshot stays rendered during background requests, so rows can move between sections without a loading flash.

The header reports four stable counts: **Open** includes every current authored pull request (including hidden rows), **Ready** and **Blocked** match the visible Ready and Not ready sections, and **Active** counts distinct local Task, Fix, and conflict-repair runs rather than CI-only work. Sections stay sticky while scrolling, paginate after 20 items, and briefly show an up/down marker when a trusted snapshot moves a pull toward or away from Ready. Favourite pulls sort first; hidden pulls stay in **Open** and can be restored from the header.

## Readiness and pull request actions

A pull request is **Ready** only when all of these are true for its current head commit:

- every review thread is resolved and GitHub's thread/comment data is complete;
- Greptile reports confidence `5/5`, links its review comment, and names the exact current head SHA;
- every CI check is complete and passing, neutral, or skipped, or GitHub reports no checks.

Pending CI or an active local agent Fix run appears under **In progress**. Its row shows passed checks out of the total. Failed, incomplete, stale, or otherwise blocked pull requests appear under **Not ready**; expand a row to inspect failed checks, unresolved review comments, and the Greptile summary.

Ready rows can expand a lazily loaded, head-pinned unified diff with horizontally scrollable filenames on the left and content changes on the right. Marking a file viewed collapses its changes and updates the viewed-file count; those marks stay local while the page remains open, are keyed to the exact pull request head, and never change GitHub. GitHub is revalidated before the diff is returned, so a changed or closed pull request is rejected instead of showing mismatched content. Clicking the row's review link opens the current Greptile review in a new tab.

Click a diff line to give the selected agent one-shot fix instructions, or shift-click a second line on the same side and hunk to select a range. The server pins the selection to the displayed base and head commits, reauthorizes the authored pull request, and proves the exact local branch before the agent applies the change. Puller itself validates the change, creates a descendant commit, and normal-pushes it to the existing pull request branch. It reports completion only after local and GitHub post-push verification; if that proof fails, it warns that the push may have succeeded and requires a refresh before retrying.

**Merge** always asks for confirmation. The server then performs a fresh, complete GitHub check of authorship, open state, exact head SHA, review state, Greptile confidence, and CI before invoking an admin merge commit with a head-match guard. A stale browser row cannot authorize a merge. Puller never merges automatically; GitHub changes only after you press and confirm **Merge**.

## Fix with Claude Code or Codex

Every agent-launching action has a Claude Code/Codex selector. The choice is captured when the action starts and remains attached to that run, including manual Fix, Auto, diff feedback, New Task, Verify, Verify all, and conflict repair. Each non-ready row has **Run fix**, which always targets the shepherd bar, and streamed terminal output. Comment on specific diff lines to give narrower review-fix instructions. Starting a Fix moves the row to **In progress** while preserving its agent and output across background refreshes. Cancel, browser disconnect, or server shutdown terminates the spawned process group.

**Auto** watches the canonical open-pull snapshot for new or edited issue comments, new unresolved review comments, new CI failure sequences, and a current-head Greptile review below `5/5`. Enabling it first records a baseline, so existing blockers are not dispatched as new work. Later matching evidence starts a context-rich Auto fix and moves that pull request to **In progress**; hidden pull requests remain watched.

Auto settings and observed evidence persist in local browser storage. Exactly one visible tab becomes the dispatcher through the browser's Web Locks API; other tabs remain in standby, and a hidden leader releases the lock. Auto runs one fix at a time, waits while a manual fix, conflict repair, or matching New Task is active, and retries temporary start failures with bounded backoff. It pauses when the page is hidden or evidence is not complete and current, and it is unavailable in browsers without Web Locks. Turning Auto off and on creates a fresh baseline.

Before an agent starts, the server refreshes GitHub and selects exactly one clean trusted worktree whose GitHub origin and checked-out commit match the pull request. By default it searches `~/Local` and `~/.codex/worktrees`. Override those roots with the platform-delimited `ACTION_WORKSPACE_ROOTS` value:

```bash
ACTION_WORKSPACE_ROOTS="/path/to/repos:/path/to/worktrees" pnpm dev
```

Fix can edit the selected worktree and consume the chosen agent's usage. Claude starts in safe mode with user, project, and local settings disabled, an empty strict MCP configuration, and hooks, plugins, skills, custom commands, and browser integration unavailable. Worktree-scoped file tools and a fixed allowlist of local test commands are approved; other write-capable shell commands are denied non-interactively. Every Git command—including fetch, pull, push, merge, rebase, checkout, switch, reset, clean, and worktree operations—plus GitHub CLI, publishing, and network commands has an explicit deny rule. Bash and its child processes run in a fail-closed sandbox that blocks outbound network access, Unix sockets, `.git` writes, and unsandboxed retries while allowing worktree edits and writes to one run-specific temporary directory. The child receives only a narrow runtime environment; tokens, API keys, arbitrary server variables, and `SSH_AUTH_SOCK` are not inherited and are also denied inside sandboxed commands.

Codex support is deliberately pinned to the locally audited `codex-cli-exec 0.144.6`. Puller finds that binary on Homebrew, Linuxbrew, `/usr/local/bin`, `~/.local/bin`, `PATH`, or `CODEX_PATH`, then refuses a different version or a swapped file until the adapter is re-audited. It launches `codex exec` with JSONL output, an ephemeral isolated home containing only a copied `auth.json`, no inherited user configuration or exec rules, network disabled, and a named least-privilege filesystem profile. For Fix, Auto, diff feedback, and Verify, project instructions, root markers, bundled skills, plugins, apps, hooks, browser/computer tools, image generation, workspace dependencies, tool suggestions, and interactive input are disabled. Codex cannot write Git metadata or publish; Puller validates, commits, and pushes the result itself.

Codex 0.144.6's named profile necessarily includes the CLI's built-in `:minimal` filesystem baseline, which grants access to standard macOS temporary roots. Puller cannot subtract that baseline in this version. It keeps verification snapshots and real conflict-repair checkouts outside global temporary roots under protected `~/.puller` state; conflict repair exposes only a disposable non-Git mirror and explicitly denies the real checkout. Treat unrelated secrets in global temporary directories as potentially visible to a Codex run.

## New tasks

The compact **New task** row searches the same favourite-aware repository catalog and lets you choose a remote base branch. Puller creates an isolated worktree and opens a pull request at the beginning of the task so the row is linked immediately, then starts the selected one-shot agent and streams its terminal output under **In progress**. Claude Code uses `--dangerously-skip-permissions`. Codex retains its named sandbox profile but intentionally starts inside the task worktree so repository instructions and skills can load. New Task is therefore powerful local execution with either provider; use it only with repositories and prompts you trust. Puller, not the agent, validates, commits, and pushes the completed change.

## Releases and verification

**Release** opens a repository selector and suggests the next stable patch tag from that repository's GitHub tags, preserving the existing `v` prefix. The viewer-scoped repository catalog is discovered once after GitHub authentication succeeds and cached for the server session; later dialog opens refresh only tag recommendations. The dialog shows separate repository-catalog and tag-check timestamps, keeps the current selection visible during background refreshes, and preserves it when the cached repository still exists. After confirmation, the server rechecks the repository allowlist, latest tag, proposed next patch, and tag nonexistence before running GitHub's generated-release-notes flow. It also asks GitHub to fail when there are no commits. Puller never creates a release until you submit and confirm the dialog.

Repository discovery for the release selector and release-action authorization includes repositories found in your open authored pull requests and in authored pull requests merged during the last 90 days. **Recently released** displays only releases published during the last week and groups them by the viewer's local calendar date. Displayed membership intersects authored merges with canonical pull request links in GitHub's release notes. **Verify** then rechecks exact membership against the adjacent release tags before Claude runs. Incomplete evidence is surfaced instead of being treated as verified membership.

**Verify** starts a separate selected-agent run for one released pull request. The server first revalidates the exact release, pull number, pull URL, merged head SHA, and release commit, then creates an immutable archive snapshot from that exact commit already present in a trusted local clone. Snapshot creation disables hooks, filters, replacement objects, and user/system Git configuration; it performs no checkout, worktree creation, or fetch. Claude runs in safe mode with only `Read`, `Glob`, and `Grep`. Codex may use inspection commands inside its read-only named profile. Neither agent can edit the snapshot or use network tools, and neither may claim tests were executed. The response streams into the row and can be cancelled. Fix and Verify share the global local-agent run limit.

Successful verification stores only validated, reusable repository recipes (for example known files, searches, manifests, and tools), never output or source contents. Memory defaults to `~/.puller/verification-memory`; set an absolute `PULLER_VERIFICATION_MEMORY_ROOT` to relocate it. Future verifications receive these bounded hints and revalidate every referenced path against the immutable snapshot before use.

## Network and security

The server binds to `127.0.0.1` by default. Binding elsewhere requires an explicit opt-in:

```bash
HOST=0.0.0.0 ALLOW_EXTERNAL=1 pnpm start
```

All mutations and Claude execution remain disabled on a non-loopback binding unless you add a second opt-in:

```bash
HOST=workstation.example.test ALLOW_EXTERNAL=1 ALLOW_EXTERNAL_EXECUTION=1 pnpm start
```

External execution lets anyone who can load that exact origin request local edits or GitHub mutations, so keep the loopback default unless the network and origin are intentionally protected.

Mutation requests require the exact configured Host and Origin plus an unguessable per-process action token obtained from that same trusted origin. The browser cannot choose executable names, CLI arguments, search queries, or filesystem paths. The server invokes `gh`, Claude, and the pinned Codex executable without a shell, validates canonical repository identities, bounds request and stream sizes, emits no CORS headers, and applies no-store, anti-sniffing, and anti-framing headers. Stream output is redacted for recognizable local paths and token formats as defense in depth.

## Verification

```bash
pnpm test
pnpm build
```

To exercise the exact installed agent commands and authentication against a disposable local fixture:

```bash
pnpm test:claude-smoke
pnpm test:codex-smoke
```

These opt-in smoke tests invoke the real local agents and may consume account usage. The Codex smoke runs through Puller's exact production adapter, requires `codex exec --version` (or `CODEX_PATH`) to print `codex-cli-exec 0.144.6`, requires a working local login, verifies a completed JSONL turn and sandboxed file write, and confirms hostile repository instructions/skills and `.git` were untouched.
