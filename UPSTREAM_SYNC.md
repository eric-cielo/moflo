# Upstream Sync Tracker

Tracks which Ruflo/Claude Flow upstream commits have been reviewed and their disposition.

**Upstream remote:** `upstream` → `https://github.com/ruvnet/ruflo.git`
**Last sync review:** 2026-03-20

## Reviewed Commits

| Commit | PR | Description | Status | Notes |
|--------|-----|-------------|--------|-------|
| `cc44cac11` | #1360 | fix: statusline generator always overwrites legacy copy | **SKIP** | We rewrote our statusline with compact/dashboard modes |
| `45dada037` | #1362 | fix: doctor checks + AgentDB bridge errors (v3.5.19) | **SKIP** | We rewrote doctor in 4.6.3 (moflo name detection, npm registry) |
| `0120fad1f` | #1363 | fix: 7 critical audit fixes, Windows settings, ADR-063 | **REVIEW** | May contain Windows fixes we need |
| `6992d5f67` | #1365 | feat: implement all stub features + fix 8 bugs (v3.5.22) | **SKIP** | v3/ workspace changes, not in our shipped path |
| `3a8b30e0e` | #1365 | Merge PR for stub features | **SKIP** | Merge commit |
| `6ff8a77e1` | #1366 | docs: update MCP tool counts, beginner guidance | **SKIP** | Docs only, we have our own README |
| `8e51bd54d` | #1346 | fix(cli): prevent TS2307 for optional codex import | **SKIP** | v3/ workspace TS fix |
| `5e51914c1` | #1314 | fix(memory): prepublishOnly guard for dist exports | **SKIP** | v3/ workspace build fix |
| `dc7957cf4` | #1341 | Fix hooks package type export paths | **SKIP** | v3/ workspace fix |
| `a3d0b4462` | #1337 | Fix benchmark environment lookup in ESM | **SKIP** | v3/ workspace fix |
| `5fdd8e19e` | #1336 | Fix PluginManager priority and version checks | **SKIP** | v3/ workspace fix |
| `bcc5fb6b1` | — | feat: v3.5.23 — merge 5 community PRs + ADR-065 | **SKIP** | v3/ workspace, ADRs only |
| `b1b615aae` | #1317 | fix(agents): make base template frontmatter YAML-safe | **SKIP** | Agent template fix, not in our shipped helpers |
| `7bc901cf5` | #1305 | docs: Update branding from Claude Flow to Ruflo | **SKIP** | We have our own MoFlo branding |
| `9e8ad26bc` | #1368 | fix: rebase onto v3.5.23 + ESM/CJS interop | **SKIP** | v3/ workspace fix |
| `100ffeaa3` | #1369 | fix(daemon): CPU-proportional maxCpuLoad | **APPLIED** | Good daemon fix |
| `adcfe6fad` | #1311 | fix: close semantic routing learning loop | **ALREADY HAVE** | We implemented this independently in our routing outcomes |
| `5138cfaa7` | #1370 | fix: add missing attention class wrappers + CJS/ESM interop | **SKIP** | v3/ workspace fix |
| `e0d4703eb` | #1374 | feat: ruvector WASM integration + real semantic embeddings | **SKIP** | We have our own Xenova embedding pipeline |
| `b2618f985` | #1377 | fix: intelligence vector store + statusline accuracy | **APPLIED** | intelligence.cjs fixes |
| `07ff7f564` | #1381 | fix: prevent MCP server self-kill on startup | **APPLIED** | Important MCP stability fix |
| `75fe9f564` | #1383 | fix: address security audit findings | **APPLIED** | Security fixes |
| `66cd6cbbc` | #1385 | fix: hive-mind_status reads real agent state | **APPLIED** | Bug fix for hive-mind status |
| `35e094aa8` | — | docs: update SECURITY.md contact email | **SKIP** | We have our own contact info |

## Applied Changes (this session)

### From hook-handler.cjs (#1342 fix + clean exit)
- Removed argv fallback that caused shell glob junk files
- Added `process.exit(0)` in finally block for clean hook exit

### From intelligence.cjs (#1377)
- Fixed `parentPath` vs `path` for Node.js compatibility
- Support both flat array and `{ entries: [...] }` formats
- Read `metadata.sourceFile` as fallback

### From auto-memory-hook.mjs
- Suppress unhandled rejection warnings from dynamic import failures
- Added `process.exit(0)` for clean hook exit

### From ruvector WASM integration (#1374) — partial
> **Note:** All @ruvector dependencies have since been fully replaced by in-house pure TypeScript/WASM implementations in `@moflo/neural` and `@moflo/embeddings`.
- Added `@ruvector/learning-wasm` as a direct dependency (was missing, blocking MicroLoRA)
- SONA and EWC++ were already wired in via `agentic-flow` → `@ruvector/sona`
- Did NOT adopt the multi-provider embedding abstraction — our simplified pipeline (Transformers.js direct) works with same precision
