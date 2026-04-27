# Testing the Spell Sandbox — Verification Protocol

**Purpose:** Rules for verifying that moflo's OS-level sandbox actually isolates AND lets Claude Code run inside. Reference this whenever you change `bwrap-sandbox.ts`, `platform-sandbox.ts`, `runner-bridge.ts`, or any code path that resolves `EffectiveSandbox`. Unit tests are not enough — sandbox bugs hide in the wired path between `moflo.yaml` and the real `bwrap` invocation.

---

## 1. Three Layers Must Be Verified Separately

Sandbox bugs come in three flavors. Tests for one layer do not catch bugs in another.

| Layer | What it tests | How to verify |
|-------|--------------|---------------|
| Args | `buildBwrapArgs()` returns correct flags | `bwrap-sandbox.test.ts` (unit) |
| Wiring | `moflo.yaml` → bridge → runner → log line | `scripts/verify-sandbox-wiring-wsl.mjs` |
| Function | `bwrap` actually isolates AND `claude -p` works inside | `scripts/verify-sandbox-bash-wsl.mjs` |

**Never claim "sandboxing is fixed" after only running unit tests.** The May 2026 regression where `bridgeRunSpell` silently dropped `sandboxConfig` passed every unit test — the bug was only visible end-to-end. Always run the WSL probes after any change to the sandbox plumbing.

---

## 2. Run the Probes from Windows (not from inside WSL)

The probes ship under `scripts/`. They expect to be invoked from the Windows host so they can shell into WSL via `powershell.exe`.

```bash
# Wiring probe (~10s) — confirms moflo.yaml is read end-to-end
powershell.exe -NoProfile -Command "wsl -d Ubuntu -- /home/eric/.nvm/versions/node/v24.12.0/bin/node /mnt/c/Users/eric/Projects/moflo/scripts/verify-sandbox-wiring-wsl.mjs"

# Functional probe (~3min) — runs claude -p inside the sandbox
powershell.exe -NoProfile -Command "wsl -d Ubuntu -- /home/eric/.nvm/versions/node/v24.12.0/bin/node /mnt/c/Users/eric/Projects/moflo/scripts/verify-sandbox-bash-wsl.mjs"

# Args+isolation probe (~30s) — exercises 5 capability scenarios via real bwrap
node scripts/verify-bwrap-wsl.mjs
```

The probes use the freshly-built `dist/`. Always run `npm run build` before invoking them.

---

## 3. Required Pass Tags for the Functional Probe

`verify-sandbox-bash-wsl.mjs` runs a real bash spell with `permissionLevel: elevated`, captures probe-output tags, and compares against expectations. A successful run of the **sandbox-enabled** scenario must emit ALL of:

| Tag | Proves |
|-----|--------|
| `TAG_PID_ISOLATED` | `--unshare-pid` actually applied (process count ≤ 10) |
| `TAG_HTTPS_OK` | `curl https://api.anthropic.com/` reaches the Claude API |
| `TAG_CLAUDE_WORKS` | `claude -p` exited 0 AND its stdout contains the expected answer |

If `TAG_CLAUDE_WORKS` is missing but `TAG_HTTPS_OK` is present, Claude Code itself is broken inside the sandbox — likely a missing tool-home bind in `bwrap-sandbox.ts:TOOL_HOME_PATHS` or a credential not readable from `~/.claude/.credentials.json`.

---

## 4. Common Symptom → Root Cause Table

| Symptom | Most likely cause | Fix location |
|---------|------------------|--------------|
| `OS sandbox: disabled (denylist active)` despite `moflo.yaml` enabling it | `projectRoot` not threaded to `bridgeRunSpell` | `runner-adapter.ts` / `spell-tools.ts` callers |
| Sandbox log shows `bwrap (linux)` but bash never wrapped | `context.sandbox?.useOsSandbox` is false in step-executor | `runner.ts` → `buildContext()` |
| Bwrap entry script exits but bwrap never returns | Missing `--die-with-parent`; child node workers keep PID namespace alive | `bwrap-sandbox.ts` args |
| `claude -p` hangs > 90s | Network slow on user machine — bump probe timeout | probe script `timeout` flag |
| `~/.claude.json` not writable inside sandbox | Tool-home bind list missing the path or `permissionLevel` not `elevated`/`autonomous` | `TOOL_HOME_PATHS` array |
| `Capability violation: bash does not declare net` | Don't request `net` cap on bash steps; rely on `permissionLevel: elevated` to grant network | step YAML — drop `capabilities.net` |

---

## 5. Sandbox Step YAML Template

When writing a probe spell, use this exact shape. Other shapes will trip the acceptance gate or the capability validator.

```yaml
name: my-sandbox-probe
steps:
  - id: probe
    type: bash
    permissionLevel: elevated   # grants tool-home binds + network
    config:
      command: |
        # your bash here
      timeout: 240000           # claude -p may take 60-120s on slow networks
```

**Pre-write the acceptance record** if your probe runs in a fresh tmpdir — otherwise the runner blocks on `ACCEPTANCE_REQUIRED`. See `verify-sandbox-bash-wsl.mjs:preAccept()` for the exact shape (`.moflo/accepted-permissions/<safe-name>.json`).

---

## 6. Regression Test Checklist for Sandbox PRs

Before merging any change to the sandbox plumbing, ALL of these must pass:

- [ ] `npx vitest run src/cli/__tests__/spells/bwrap-sandbox.test.ts` — args correctness
- [ ] `npx vitest run src/cli/__tests__/spells/runner-bridge.test.ts` — bridge auto-loads `moflo.yaml`
- [ ] `npx vitest run src/cli/__tests__/spells/platform-sandbox.test.ts` — config + capability detection
- [ ] `node scripts/verify-bwrap-wsl.mjs` (from Windows) — bwrap isolates per permission level
- [ ] `verify-sandbox-wiring-wsl.mjs` — log line shows the right tool name in WSL
- [ ] `verify-sandbox-bash-wsl.mjs` — `TAG_CLAUDE_WORKS` emitted under sandbox-enabled scenario

A green unit suite alone is not sufficient evidence to claim a sandbox fix.

---

## 7. WSL Setup Required for Local Verification

| Prerequisite | Where |
|--------------|-------|
| Ubuntu WSL distro | `wsl --install -d Ubuntu` |
| `bwrap` (bubblewrap) | `sudo apt install bubblewrap` inside WSL |
| Node ≥20 in WSL | `nvm install --lts` (probes use `/home/eric/.nvm/versions/node/<ver>/bin/node`) |
| `claude` CLI in WSL | `npm install -g @anthropic-ai/claude-code` inside WSL |
| Claude credentials | `~/.claude/.credentials.json` — log in once via `claude` interactively |

Without all five, the functional probe cannot prove anything. macOS uses `sandbox-exec` instead of `bwrap` — write a parallel macOS probe if you change `wrapWithSandboxExec()`.

---

## See Also

- `.claude/guidance/moflo-spell-sandboxing.md` — User-facing sandbox documentation
- `src/cli/spells/core/bwrap-sandbox.ts` — Linux sandbox wrapper
- `src/cli/spells/core/platform-sandbox.ts` — Detection + config resolution
- `scripts/verify-bwrap-wsl.mjs` — Args-level isolation probe (5 capability scenarios)
- `scripts/verify-sandbox-wiring-wsl.mjs` — End-to-end wiring probe
- `scripts/verify-sandbox-bash-wsl.mjs` — End-to-end functional probe (claude inside sandbox)
