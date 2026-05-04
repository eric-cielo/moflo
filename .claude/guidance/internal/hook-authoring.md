# Authoring MoFlo Hook Handlers

**Purpose:** How to write or edit hook handlers under `.claude/helpers/`. Covers the stdin-JSON contract, exit-code semantics, `$CLAUDE_PROJECT_DIR` resolution (with the Windows path quirk), and the gate-vs-handler split. Internal-only — consumers configure hooks via `settings.json` but do not author the helper scripts (those are synced from moflo on session-start).

> Hook handlers run in *every consumer's* environment after install. A regression here is a consumer-blast-radius event (#860 was a missing `CLAUDE_CODE_HEADLESS` guard that pegged CPU on every consumer for 15 minutes per session). Treat hook code with the same care as the launcher.

---

## 1. The `.claude/helpers/` Directory Surface

| File | Role | Triggered by |
|------|------|--------------|
| `gate-hook.mjs` | PreToolUse gate dispatcher — parses Claude Code's stdin JSON, delegates to `gate.cjs` | `Read`, `Glob`, `Grep`, `Bash`, etc. |
| `gate.cjs` | Gate logic — memory-first, task-first, dangerous-command, PR safety | Invoked by `gate-hook.mjs` |
| `hook-handler.cjs` | PostToolUse + Stop + Notification dispatcher | `Write`/`Edit`/`Agent`, session end, notifications |
| `prompt-hook.mjs` | UserPromptSubmit handler | Each user prompt |
| `subagent-start.cjs` | SubagentStart handler — bootstrap reminders | Subagent spawn |
| `auto-memory-hook.mjs` | SessionStart `import` + Stop `sync` for the auto-memory directory | Session start, session end |
| `statusline.cjs` | Status-line renderer | Status-line refresh |
| `intelligence.cjs` | Helper module loaded by gate.cjs (not a direct hook entry) | Internal |
| `simplify-classify.cjs` | Helper module for the simplify gate | Internal |

**Two-layer design (gate-hook.mjs + gate.cjs):** the `.mjs` entry parses Claude Code's stdin JSON and forwards via env vars; the `.cjs` does the actual decision logic. Keep this split — mixing JSON parsing into the decision layer makes both harder to test.

**Mirror requirement — `gate.cjs` ships in two places.** `bin/gate.cjs` (invoked by `flo gate ...` from the CLI surface) and `.claude/helpers/gate.cjs` (invoked by `gate-hook.mjs` from Claude Code's hook block). Both are listed in `package.json#files` and both ship to consumers. **Every edit to one MUST also edit the other in the same PR.** `flo doctor`'s `Gate Health` check fails (publish-blocker) when they drift; `flo doctor --fix` resolves drift by mirroring the source file that's "ahead" of its installed counterpart in `node_modules/moflo/` onto the other (helper-ahead → bin, bin-ahead → helper). If both source files are ahead with different content the fixer refuses to pick a side — split the PR or reconcile the two intentions manually. See Section 9's trap row.

---

## 2. Hook Event → Settings.json Wiring

Hooks fire from `.claude/settings.json`. Each event has a matcher and one or more `command` entries. The hook helper paths must use `$CLAUDE_PROJECT_DIR` — never relative paths or hardcoded user directories.

| Event | When | Typical helper |
|-------|------|----------------|
| `SessionStart` | Claude Code starts | `.claude/scripts/session-start-launcher.mjs`, `auto-memory-hook.mjs import` |
| `UserPromptSubmit` | Each user prompt | `prompt-hook.mjs`, `gate-hook.mjs prompt-reminder` |
| `PreToolUse` | Before any tool call | `gate-hook.mjs check-before-{scan,read}`, `gate-hook.mjs check-dangerous-command` |
| `PostToolUse` | After any tool call | `hook-handler.cjs post-edit`, `gate-hook.mjs reset-edit-gates` |
| `SubagentStart` | New subagent | `subagent-start.cjs` |
| `PreCompact` | Before context compaction | `gate.cjs compact-guidance` |
| `Stop` | Session end | `hook-handler.cjs session-end`, `auto-memory-hook.mjs sync` |
| `Notification` | OS notification surface | `hook-handler.cjs notification` |

**Matchers are regex on tool name.** `^(Write|Edit|MultiEdit)$` fires for those three only; `mcp__moflo__memory_` (no anchors) fires on any memory MCP tool. Quote anchors carefully — a missing `$` causes false positives that are hard to debug.

---

## 3. The Stdin JSON Contract

**Claude Code passes hook context as JSON on stdin.** Read it with a 500ms timeout to handle the no-stdin case (TTY, no tool fired). Never block waiting for stdin without a timeout — orphan hooks pin the session.

```js
let stdinData = '';
try {
  stdinData = await new Promise((res) => {
    let data = '';
    const timeout = setTimeout(() => res(data), 500);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timeout); res(data); });
    process.stdin.on('error', () => { clearTimeout(timeout); res(''); });
    if (process.stdin.isTTY) { clearTimeout(timeout); res(''); }
  });
} catch { /* no stdin */ }

let hookContext = {};
try { if (stdinData.trim()) hookContext = JSON.parse(stdinData); } catch {}
```

Keys you can rely on (when present):

| Key | Type | Meaning |
|-----|------|---------|
| `tool_name` | string | The Claude Code tool that fired (e.g. `'Read'`) |
| `tool_input` | object | The tool's input parameters; values may be objects or strings |
| `session_id` | string | Per-actor session ID — distinct across subagents, even within one Claude Code instance |
| `transcript_path` | string | Path to the current session transcript (for hooks that need history) |

**Forward `session_id` per-actor (issue #838).** Each spawned subagent gets a distinct `session_id`. A shared workflow-state file keyed only by tool name lets one subagent's directive be silently satisfied by the parent's earlier action. Always include `session_id` in your gate-state key when the gate is per-actor.

---

## 4. Exit-Code Semantics

**Exit codes are the entire contract.** Anything Claude Code reads about the hook's decision comes from exit code + stderr.

| Exit code | Meaning | When to use |
|-----------|---------|-------------|
| `0` | Continue — tool call proceeds | Default; no objection |
| `1` | Soft block (deprecated, treated as block) | Avoid; use `2` |
| `2` | Hard block — tool call refused; stderr surfaced to user and to Claude | Memory-first violation, dangerous command, missing prerequisite |

**Translate gate exit codes carefully.** `gate-hook.mjs` shells out to `gate.cjs` via `execFileSync`. Map the inner exit code to the outer hook exit code explicitly — don't trust the default.

```js
try {
  execFileSync('node', [gateScript, command], { /* ... */ });
  process.exit(0);
} catch (err) {
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(err.status === 2 || err.status === 1 ? 2 : 0);
}
```

**Never silently catch errors in a hook (`feedback_no_silent_failures`).** Either log + advise (when continuing) or block + surface stderr (when refusing). A `try {} catch {}` empty in a hook produced 4 versions of consumer-invisible breakage in #854.

---

## 5. `$CLAUDE_PROJECT_DIR` Resolution

**Always resolve hook-relative paths via `$CLAUDE_PROJECT_DIR`** — Claude Code sets it to the current project root. Falling back to `process.cwd()` works on Mac/Linux but breaks on Windows when the hook is invoked from a different working directory.

```js
const projectDir = (process.env.CLAUDE_PROJECT_DIR || process.cwd())
  .replace(/^\/([a-z])\//i, '$1:/');  // /c/Users → C:/Users on Windows
const gateScript = resolve(projectDir, '.claude/helpers/gate.cjs');
```

The `replace` step is necessary because Claude Code on Windows-via-WSL sometimes emits POSIX-style paths (`/c/Users/...`) that `path.resolve` doesn't normalize. Skip this and the hook fails silently on Windows.

See `internal/consumer-project-paths.md` for the cross-cutting rule on path resolution.

---

## 6. Cross-Platform Constraints

**Hook handlers run on Windows, macOS, and Linux. POSIX-only assumptions break on Windows.** See `shipped/moflo-cross-platform.md` for the universal rule. Hook-specific gotchas:

| Gotcha | Fix |
|--------|-----|
| `/dev/null` in stdio redirects | Use `'ignore'` in `spawn` options |
| Bash heredoc in helper code | Don't — use `node -e` or write a temp `.mjs` file |
| Forward slashes in command paths | OK; Node normalizes both ways |
| Hardcoded `~` for home dir | Use `os.homedir()` |
| `execFileSync` without `windowsHide: true` | Spawns a flash window on Windows; always include the flag |

---

## 7. Performance Budget

**Hook timeouts in `settings.json` are tight by design.** `PreToolUse` hooks have 2–3 seconds; exceeding this blocks the user's tool call.

| Hook | Typical timeout | Implication |
|------|-----------------|-------------|
| Pre-Bash dangerous-command check | 2000ms | Synchronous — keep cheap; lookups must be O(1) |
| Pre-Read/Glob/Grep memory-first | 3000ms | One memory_search check is fine; no DB mutation |
| Post-Edit (formatter, indexer) | 5000ms | Run async work in background — don't block the hook |
| SessionStart launcher | 3000ms | Defer heavy work to spawned daemon; the hook should return fast |

**Move slow work into the daemon.** Indexing, embedding generation, network calls — anything that can take >1 s — belongs in `node_modules/moflo`'s daemon, not in a synchronous hook handler. The session-start launcher uses this pattern: it forks the daemon and returns within a few hundred ms.

---

## 8. Adding a New Hook — Checklist

1. **Pick the event** — match the lifecycle moment, not the tool name; e.g. "after the user submits a prompt" is `UserPromptSubmit`, not a `Bash` matcher.
2. **Pick the matcher** — anchored regex (`^Foo$`) unless you specifically want prefix matching (`mcp__moflo__memory_`).
3. **Write the entry** in `.claude/settings.json` under the appropriate event array; use `$CLAUDE_PROJECT_DIR/.claude/helpers/<file>` for the command.
4. **Choose the helper file** — extend an existing one if the new logic is small; create a new helper for a fresh concern. Keep `.cjs` for sync logic loaded into other helpers, `.mjs` for entry points.
5. **stdin JSON parsing** — copy the 500ms-timeout pattern from `gate-hook.mjs`. Never block forever.
6. **Exit codes** — `0` = continue, `2` = block. Map inner errors carefully; never swallow.
7. **Path resolution** — `$CLAUDE_PROJECT_DIR` + the Windows `/c/` normalize step.
8. **Cross-platform** — no `/dev/null`, no `~`, `windowsHide: true` on every `execFileSync`.
9. **Test it** — `tests/bin/gate-helpers.test.ts` is the canonical test target for gate logic; mirror that file's structure for new helpers.
10. **Healer drift check** — `flo healer` includes a `Hook Block Drift` check (`hook block matches reference`). Update the reference hash in `src/cli/commands/doctor-checks-config.ts` (or the canonical owner) if you intentionally change the canonical hook block.

---

## 9. Editing an Existing Hook — Failure Modes to Watch

Hook regressions are silent. The user notices "Claude is acting weird" days later, not at the moment of the broken hook. Specific traps:

| Trap | What happens | Prevention |
|------|--------------|------------|
| `try { ... } catch {}` swallows hook failures | User never sees the error; behavior degrades silently | Log + advise + re-throw or return; never empty `catch {}` |
| Removing a hook block hash bump | Healer drift check fires for every consumer | Bump the hash in the same PR |
| Adding cwd-relative path | Works in dev, breaks for consumers | Always anchor on `$CLAUDE_PROJECT_DIR` |
| Adding a network call to `PreToolUse` | Pegs every tool invocation under flaky network | Hooks are local-only — defer net to the daemon |
| Forgetting `windowsHide: true` on spawn | Flash console window on Windows | Add it |
| Editing only one of `bin/gate.cjs` or `.claude/helpers/gate.cjs` | The two ship side-by-side; one updated, the other stale → in-source drift, doctor `Gate Health` fails (#920 shipped a docs-only-PR exemption to the helper but missed bin) | Edit BOTH in the same change; verify with `flo doctor` (or `flo doctor --fix` to mirror automatically) before committing |

**Run the dogfood loop before merging:** the hook lives in `.claude/helpers/` *and* gets synced into `node_modules/moflo/.claude/helpers/`. After local edit, the running session is still on the previously installed version (`feedback_dogfood_install_vs_source`). Publish a build or use `npm pack` + reinstall to actually exercise the change.

---

## See Also

- `.claude/guidance/internal/mcp-tool-authoring.md` — Sibling for MCP tool surface; coordinator-backed contract analogue to the gate-vs-handler split here
- `.claude/guidance/internal/testing-conventions.md` — Vitest patterns; the canonical hook tests (`tests/bin/gate-helpers.test.ts`) follow these rules
- `.claude/guidance/internal/coding-style.md` — Decomposition + DRY rules; helper modules under `.claude/helpers/` must follow them too
- `.claude/guidance/internal/consumer-project-paths.md` — Why `$CLAUDE_PROJECT_DIR`, never `process.cwd()`
- `.claude/guidance/internal/dogfooding.md` — Why hook edits don't take effect until the next session/install
- `.claude/guidance/shipped/moflo-cross-platform.md` — Cross-platform constraints applied to hook authoring
- `.claude/guidance/shipped/moflo-session-start.md` — SessionStart event wiring and the launcher contract
- `.claude/guidance/shipped/moflo-error-handling.md` — No silent catches; this is a hook-critical rule
