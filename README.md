# Authored pull request readiness

A local React dashboard for the GitHub search:

```text
is:pr author:@me state:open archived:false sort:updated-desc
```

It keeps the search order and divides the result into **Ready** and **Not ready**. A pull request is Ready only when every review thread is resolved, its current-head CI rollup is successful or no CI checks are reported, the latest Greptile summary has confidence `5/5`, and that same summary's full reviewed commit SHA matches the pull request head. Pending, failing, incomplete, or otherwise unknown CI state keeps a pull request Not ready.

## Requirements

- Node.js 22.12 or newer
- pnpm 11.9.0 (the version pinned by `packageManager`)
- [GitHub CLI](https://cli.github.com/) authenticated with access to every repository you want shown
- Claude Code 2.1.212, authenticated locally

Check authentication before starting:

```bash
gh auth status
claude --version
claude auth status --text
```

If necessary, authenticate with:

```bash
gh auth login
claude auth login
```

## Run locally

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:5173>. The development command runs one Node process containing both the API and Vite middleware.

To run the production build locally:

```bash
pnpm build
pnpm start
```

`pnpm start` serves both `/api/pulls` and the built React application from the same origin. It reports an actionable error if `dist/` has not been built.

## Fixing a pull request

Each Not ready row has its own instructions field, **Fix** button, and live terminal. Fix performs a fresh, complete GitHub readiness check, including current-head CI, finds the matching local worktree, and starts one non-interactive Claude Code process there. Assistant text, tool starts, and diagnostics stream to the terminal as newline-delimited events. **Cancel**, closing the browser connection, or stopping the server terminates the spawned process group. Clicking a Ready row opens the Greptile review comment for the current head in a new tab.

The initial run for a pull request requires exactly one clean trusted worktree whose GitHub `origin` matches the pull repository and whose checked-out commit exactly matches the fresh remote head. Once selected, that worktree remains associated with the pull request for the lifetime of the server so follow-up runs can continue Claude's local edits. A changed remote pull-request head clears the association and requires another clean exact-head match.

Only one Fix run may own a canonical worktree at a time, even when two different pull requests resolve through different path aliases to that same directory. The reservation lasts until the Claude process exits after completion, failure, cancellation, disconnect, or server shutdown.

By default, worktrees are discovered read-only under `~/Local` and `~/.codex/worktrees`; normal `.git` directories and `.git`-file worktrees are supported. Override the trusted roots with the platform-delimited `ACTION_WORKSPACE_ROOTS` variable (`:` on macOS/Linux and `;` on Windows):

```bash
ACTION_WORKSPACE_ROOTS="/path/to/repos:/path/to/worktrees" pnpm dev
```

The Fix action uses the command-line surface verified with Claude Code 2.1.212: one shell-free `claude --print` process with streaming JSON, `--permission-mode auto`, and no session persistence. Auto mode classifies routine and potentially destructive tool calls for unattended execution without bypassing Claude Code's permission system. The server supplies the verified pull URL, head, and blockers; browser input cannot select a filesystem path or alter command arguments. The prompt forbids fetching, checkout/reset, creating worktrees, pushing, merging, and opening pull requests. A Fix run can consume Claude usage and can edit the selected worktree, so review its terminal output and local changes.

## Tests

```bash
pnpm test
pnpm build
```

## Refresh and cache behavior

`GET /api/pulls` loads a snapshot and caches it for five minutes. `GET /api/pulls?refresh=1` bypasses freshness for a manual refresh. Concurrent requests share one in-flight GitHub query. If a refresh fails after a successful load, the API retains the last-good snapshot, marks it `stale`, and adds a warning without changing its original timestamp.

The GraphQL service paginates the outer search and only continues nested review-thread or issue-comment connections that GitHub truncated. GitHub caps search results at 1,000; a capped response is marked `partial` and includes a visible warning.

## Network and security

The server binds to `127.0.0.1` by default. A non-loopback address is rejected unless external access is explicitly enabled:

```bash
HOST=0.0.0.0 ALLOW_EXTERNAL=1 pnpm start
```

Fix execution remains disabled on a non-loopback binding unless it receives a second explicit opt-in. Use a concrete hostname or address that matches the browser origin:

```bash
HOST=workstation.example.test ALLOW_EXTERNAL=1 ALLOW_EXTERNAL_EXECUTION=1 pnpm start
```

External execution grants anyone who can load that exact origin the ability to start local edits, so keep the default loopback binding unless that access is intentional and otherwise protected.

The browser cannot supply the search query, GitHub CLI arguments, executable name, command-line options, or workspace path. Action requests require the exact configured Host and Origin plus an unguessable per-process token obtained from that same origin. The server invokes both `gh` and Claude Code without a shell, limits concurrent runs and streamed output, emits no CORS headers, and marks API responses `Cache-Control: no-store`. Every response also carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.

Assistant text is held behind a bounded 512-character carry before streaming so the server can redact the selected workspace path and recognizable token-like secrets even when Claude splits them across adjacent deltas. A terminal event flushes the safe remainder; tool and diagnostic events are otherwise streamed immediately. Redaction is defense in depth rather than a guarantee for arbitrary unknown secret formats, so avoid asking Claude to print credentials.
