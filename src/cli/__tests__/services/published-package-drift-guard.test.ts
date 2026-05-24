/**
 * Published-package drift guard (issue #585).
 *
 * Two static invariants that, if violated, would ship a broken consumer
 * install — the same class of bug as 4.8.87-rc.2 (issue #583). Pairs with
 * the consumer-smoke probe at `scripts/consumer-smoke/probe-bare-specifiers.mjs`:
 * the smoke catches it at runtime, this catches it in vitest in <100ms so a
 * dev sees the problem before they push.
 *
 *   1. **Files-array coverage**: every `@moflo/<pkg>` bare specifier used in
 *      moflo source must point to a module whose dist is in
 *      `package.json`'s `files` array. A bare import for a module not
 *      shipped in the tarball will throw `ERR_MODULE_NOT_FOUND` in any
 *      consumer install.
 *
 *   2. **Bare-import inventory**: snapshot the set of `@moflo/<pkg>`
 *      packages imported anywhere in source. New entries fail the test
 *      until they're added to ALLOWED_BARE_PACKAGES — at which point the
 *      dev has been forced to think about whether the consumer-smoke
 *      probe still covers them. (It auto-extends, but the static signal
 *      keeps the inventory honest.)
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findRepoRoot } from '../_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SRC_ROOT = join(REPO_ROOT, 'src');

// Auto-installed externals that intentionally aren't in moflo's `files` array.
// Adding to this list is a deliberate choice — every entry here costs the
// consumer an extra install on first use.
const AUTO_INSTALLED_EXTERNALS = new Set<string>();

// Pinned inventory of bare packages. New entries force a dev to verify the
// consumer-smoke probe still covers them.
const ALLOWED_BARE_PACKAGES = new Set<string>([]);

const BARE_RE = /(?:from|import)\s*\(?\s*['"](@moflo\/[a-z][a-z0-9_-]*)(?:\/[a-z0-9_/.-]+)?['"]/g;

// Skip JSDoc and line comments — they routinely show example imports for
// modules we don't actually depend on. The `tests/` and `__tests__/`
// directories are excluded because per-module test code may import the
// module's own siblings via bare specifier for ergonomics, but those
// imports never run inside a consumer install.
const TEST_DIRS = new Set(['__tests__', 'tests', 'test']);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (TEST_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTs(full);
      continue;
    }
    if (!/\.(m?ts|m?js)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (!entry.isFile()) continue;
    yield full;
  }
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//');
}

function scanBareImports(): Set<string> {
  const found = new Set<string>();
  for (const file of walkTs(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('@moflo/')) continue;
    for (const line of text.split('\n')) {
      if (isCommentLine(line)) continue;
      if (!line.includes('@moflo/')) continue;
      BARE_RE.lastIndex = 0;
      let m;
      while ((m = BARE_RE.exec(line)) !== null) {
        found.add(m[1]);
      }
    }
  }
  return found;
}

interface PkgJson {
  files?: string[];
}

function shippedModules(): Set<string> {
  // After workspace-collapse epic #586, no `src/modules/<pkg>/dist/` entries
  // remain in the files array — every former workspace package is inlined
  // under src/cli/ and shipped via `dist/src/cli/`. Returning an empty set
  // keeps Test 1 honest: any reintroduction of a bare `@moflo/<pkg>`
  // specifier will fail because nothing is "shipped" under that name.
  return new Set<string>();
}

describe('published-package drift guard (issue #585)', () => {
  it('every @moflo/* bare specifier points to a module shipped in package.json files (or an allowed external)', () => {
    const used = scanBareImports();
    const shipped = shippedModules();
    const orphans: string[] = [];
    for (const spec of used) {
      if (shipped.has(spec)) continue;
      if (AUTO_INSTALLED_EXTERNALS.has(spec)) continue;
      orphans.push(spec);
    }
    expect(
      orphans,
      `These @moflo/* bare imports target modules not shipped in package.json "files":\n  ${orphans.join('\n  ')}\n` +
        `Either (a) add the module's dist to "files", (b) add to AUTO_INSTALLED_EXTERNALS if it's a real external, ` +
        `or (c) remove the import.`,
    ).toEqual([]);
  });

  it('inventory of @moflo/* bare specifiers matches the pinned allow-list', () => {
    const used = scanBareImports();
    const unexpected = [...used].filter((s) => !ALLOWED_BARE_PACKAGES.has(s));
    const missing = [...ALLOWED_BARE_PACKAGES].filter((s) => !used.has(s));
    expect(
      { unexpected, missing },
      `New or removed @moflo/* bare specifiers detected.\n` +
        `If intentional: update ALLOWED_BARE_PACKAGES in this file AND verify the consumer-smoke probe ` +
        `at scripts/consumer-smoke/probe-bare-specifiers.mjs covers the new path.`,
    ).toEqual({ unexpected: [], missing: [] });
  });

  it('files array no longer references the legacy src/modules/ tree', () => {
    // After epic #586 there should be zero `src/modules/<pkg>/...` entries
    // in the files array. Catches a regression that would resurrect the
    // old workspace layout.
    const pkg: PkgJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const filesArr = pkg.files ?? [];
    const stale = filesArr.filter(e => /^!?src\/modules\//.test(e));
    expect(
      stale,
      `package.json "files" still has src/modules/ entries:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no src/modules/ references re-enter source, scripts, bin, or shipped guidance/skills', () => {
    // Issue #661: post-collapse audit. The src/modules/ tree was deleted in
    // PR #602 — every reference to it in code, scripts, comments, or shipped
    // docs is stale and either misleading or actively wrong. Catches the next
    // engineer who copies an old path from git history.
    //
    // Scope: production-relevant trees only. Historical refs in docs/ (e.g.
    // ADRs that describe the collapse itself) are explicitly excluded.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'skills'),
      join(REPO_ROOT, '.claude', 'scripts'),
    ];
    const STALE_RE = /\bsrc\/modules\//;
    // Lines that mention `src/modules/` to *document its absence* are allowed:
    // typical phrasings — "no longer", "deleted", "WRONG", "pre-collapse",
    // "Replaced the pre-#XXX", etc. Any line missing these markers is a
    // real violation.
    const HISTORICAL_MARKERS = /no longer|deleted|removed|WRONG|pre-collapse|pre-#?\d|formerly|workspace tree|workspace-collapse|was the|used to|legacy|stale|banned/i;
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        // Skip the drift guard itself — it intentionally talks about the
        // legacy tree to assert its absence.
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const text = readFileSync(file, 'utf8');
        if (!STALE_RE.test(text)) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!STALE_RE.test(lines[i])) continue;
          if (HISTORICAL_MARKERS.test(lines[i])) continue;
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Stale src/modules/ refs detected (collapse #586/#602 deleted that tree):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no `.claude-flow` paths re-enter source, scripts, bin, or shipped guidance (#699)', () => {
    // Issue #699: moflo owns its runtime state under `.moflo/`. The legacy
    // `.claude-flow/` path is migration-only — every reintroduction in
    // production code is a regression that would split state between two
    // dirs on consumer machines. Catches mechanical sweeps that miss spots.
    //
    // Scope: production-relevant trees only. Test fixtures inside __tests__/
    // are excluded — those create temp dirs and don't ship.
    //
    // `.claude/scripts/` is intentionally NOT scanned: it's a runtime sync
    // target for bin/ scripts (refreshed by session-start-launcher.mjs on
    // version drift) and not part of the published package. Stale copies
    // there auto-resolve on the next moflo upgrade.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'helpers'), // shipped (#735): writers here re-create `.claude-flow/`
      join(REPO_ROOT, '.claude', 'skills'),
    ];
    const CLAUDE_FLOW_RE = /\.claude-flow/;
    // Lines that intentionally reference `.claude-flow` for migration or
    // legacy-fallback reasons must carry one of these explicit markers. Vague
    // word-soup ("legacy" alone, "migration") is intentionally NOT allowed —
    // exemption must be a deliberate token an author types on purpose.
    const ALLOWED_MARKERS = /\bLEGACY(?:-CONFIG|-V2|:)?\b|pre-#699|claude-flow-backup-/;
    // The migration helpers themselves must talk about `.claude-flow` —
    // that's their entire purpose. Skip the files outright so we don't have
    // to sprinkle markers on every line.
    const MIGRATION_FILES = new Set([
      'src/cli/services/moflo-paths.ts',
      'bin/lib/moflo-paths.mjs',
    ]);

    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        // Skip the drift guard itself (talks about both names) and the
        // __tests__ tree (test fixtures may create .claude-flow temp dirs
        // intentionally, e.g. to assert the migration runs).
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (file.endsWith('moflo-paths-migration.test.ts')) continue;
        if (/[/\\]__tests__[/\\]/.test(file)) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        if (MIGRATION_FILES.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        if (!CLAUDE_FLOW_RE.test(text)) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!CLAUDE_FLOW_RE.test(lines[i])) continue;
          if (ALLOWED_MARKERS.test(lines[i])) continue;
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Stale .claude-flow paths detected (issue #699 migrated runtime state to .moflo).\n` +
        `If a reference is intentional (legacy fallback, migration code), add one of these\n` +
        `explicit markers to the same line: LEGACY, LEGACY-CONFIG, LEGACY-V2, pre-#699,\n` +
        `or "claude-flow-backup-". For migration helpers, add the path to\n` +
        `MIGRATION_FILES in this file.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no `.swarm/` *writer* paths re-enter production source (#1168)', () => {
    // Issue #1168: moflo's canonical runtime store is `.moflo/`. The legacy
    // `.swarm/` path is read-only — used by the cherry-pick recovery, the
    // bridge migration window probe, and the doctor 'Swarm Residue' fix as
    // a source. Production code MUST NOT *write* to `.swarm/`.
    //
    // The original guard only matched an fs call with an inline `.swarm`
    // string literal on the SAME line. That missed the shape that let
    // `memory.ts:openDb` keep recreating `.swarm/memory.db` long after #1168:
    // a path built from a constant (`const SWARM_DIR = '.swarm'; join(cwd,
    // SWARM_DIR, file)`) and written through a WRAPPER (`openDaemonDatabase`)
    // rather than a bare `fs.*` call. This version is constant-aware and
    // wrapper-aware: it collects every identifier bound to a `.swarm` path,
    // then flags any writer call referencing such an id (or an inline literal).
    //
    // Read-only references (legacyMemoryDbPath, fallback existsSync/readFileSync
    // probes, doc strings, comments) are still allowed without a marker — only
    // writer call-sites are flagged. `unlinkSync` is intentionally NOT a writer
    // here: deleting `.swarm/` residue is cleanup, not recreation. If a future
    // PR genuinely needs to write `.swarm/`, add a `LEGACY-V2-WRITE` marker on
    // the same line.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'helpers'),
      join(REPO_ROOT, '.claude', 'skills'),
    ];
    // Functions that persist to disk: fs primitives PLUS moflo's DB wrapper
    // `openDaemonDatabase` (it mkdir's the parent dir + opens read-write).
    const WRITER_FNS =
      /\b(mkdirSync|writeFileSync|renameSync|appendFileSync|cpSync|copyFileSync|createWriteStream|openSync|openDaemonDatabase|fs\.mkdir)\s*\(/;
    // A `.swarm` path literal, e.g. '.swarm', "./.swarm", `.swarm/memory.db`.
    const SWARM_LITERAL = /['"`]\.?[/\\]?\.swarm(?:[/\\][^'"`]*)?['"`]/;
    const ALLOWED_MARKERS = /LEGACY-V2-WRITE|pre-#1168/;
    const MIGRATION_FILES = new Set<string>([]);
    // For move/copy writers the WRITE target is the 2nd argument (source-first
    // signature). For every other writer it's the 1st. We only inspect the
    // target-position arg so that *reading* from or *moving out of* `.swarm/`
    // (renameSync(swarmSrc, canonicalDst), appendFileSync(canonical,
    // readFileSync(swarmSrc))) is correctly allowed — only writes *into*
    // `.swarm/` are flagged.
    const MOVE_COPY_FNS = new Set(['renameSync', 'cpSync', 'copyFileSync']);

    // Split a call's argument string on top-level commas, respecting nested
    // parens/brackets/braces and string literals.
    const topLevelArgs = (argStr: string): string[] => {
      const args: string[] = [];
      let depth = 0;
      let cur = '';
      let inStr: string | null = null;
      for (let k = 0; k < argStr.length; k++) {
        const ch = argStr[k];
        if (inStr) {
          cur += ch;
          if (ch === inStr && argStr[k - 1] !== '\\') inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
        if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue; }
        if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      if (cur.trim()) args.push(cur.trim());
      return args;
    };

    // Extract `{ fnName, args }` for a single-line writer call, or null when
    // the call spans lines (no balanced close on this line).
    const extractWriterCall = (line: string): { fnName: string; args: string[] } | null => {
      const m = line.match(WRITER_FNS);
      if (!m || m.index === undefined) return null;
      const fnName = m[1].replace(/^fs\./, '');
      const open = line.indexOf('(', m.index);
      if (open < 0) return null;
      let depth = 0;
      let end = -1;
      let inStr: string | null = null;
      for (let k = open; k < line.length; k++) {
        const ch = line[k];
        if (inStr) { if (ch === inStr && line[k - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { end = k; break; } }
      }
      if (end < 0) return null;
      return { fnName, args: topLevelArgs(line.slice(open + 1, end)) };
    };

    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (/[/\\]__tests__[/\\]/.test(file)) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        if (MIGRATION_FILES.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        if (!text.includes('.swarm')) continue;
        const lines = text.split('\n');

        // Collect identifiers bound to a `.swarm` path. Two sweeps cover the
        // real shapes: (1) a dir-name constant `const SWARM_DIR = '.swarm'`,
        // (2) a path var built via join/resolve/template/concat that references
        // a `.swarm` literal or a dir-name constant from sweep 1.
        const swarmIds = new Set<string>();
        for (const line of lines) {
          const m = line.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*['"`]\.?[/\\]?\.swarm[/\\]?['"`]/);
          if (m) swarmIds.add(m[1]);
        }
        const idAlt = () => [...swarmIds].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        for (const line of lines) {
          const m = line.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*(.+)$/);
          if (!m) continue;
          const [, id, rhs] = m;
          if (swarmIds.has(id)) continue;
          const refsConst = swarmIds.size > 0 && new RegExp(`\\b(?:${idAlt()})\\b`).test(rhs);
          const refsLiteral = SWARM_LITERAL.test(rhs);
          const isPathExpr = /\b(?:path\.)?(?:join|resolve)\(|`|\+/.test(rhs);
          if ((refsConst || refsLiteral) && isPathExpr) swarmIds.add(id);
        }

        // Flag writer call-sites whose WRITE-TARGET arg is a `.swarm` path
        // (inline literal or a collected swarm-path identifier).
        const idRe = swarmIds.size > 0 ? new RegExp(`\\b(?:${idAlt()})\\b`) : null;
        const targetIsSwarm = (arg: string | undefined): boolean =>
          !!arg && (SWARM_LITERAL.test(arg) || (idRe !== null && idRe.test(arg)));
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!WRITER_FNS.test(line)) continue;
          if (ALLOWED_MARKERS.test(line)) continue;
          const call = extractWriterCall(line);
          if (call) {
            const targetIdx = MOVE_COPY_FNS.has(call.fnName) ? 1 : 0;
            if (targetIsSwarm(call.args[targetIdx])) offenders.push(`${rel}:${i + 1}`);
          } else {
            // Multi-line writer call: fall back to a conservative scan of the
            // call portion (no balanced close on this line to position-parse).
            const callArgs = line.slice(line.search(WRITER_FNS));
            if (SWARM_LITERAL.test(callArgs) || (idRe && idRe.test(callArgs))) {
              offenders.push(`${rel}:${i + 1}`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      `Production code writes to .swarm/ (issue #1168 moved every writer to .moflo/).\n` +
        `This includes paths built from a constant and written via a wrapper\n` +
        `(e.g. openDaemonDatabase) — not just inline fs.*('...swarm...') calls.\n` +
        `If the new write is intentional (e.g. a new migration codepath), add\n` +
        `the marker LEGACY-V2-WRITE or pre-#1168 to the same line.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no `npm install @moflo/<pkg>` strings remain in source or shipped guidance', () => {
    // Issue #661: moflo publishes as a single npm package called `moflo`. Any
    // `npm install @moflo/cli` (or @moflo/neural, @moflo/memory, …) string in
    // user-facing output sends consumers to a 404. Catches both error
    // messages and example commands.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'skills'),
      join(REPO_ROOT, '.claude', 'scripts'),
    ];
    const STALE_RE = /npm\s+install\s+(?:-g\s+)?@moflo\//;
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const text = readFileSync(file, 'utf8');
        if (!STALE_RE.test(text)) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (STALE_RE.test(lines[i])) offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Stale "npm install @moflo/<pkg>" strings — moflo publishes as a single package called "moflo":\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no `claude-flow <subcommand>` invocation strings remain in user-facing output', () => {
    // moflo's CLI binary is `flo` (package `moflo`). Any user-facing string
    // that tells a user to run `claude-flow <cmd>` — help examples, the daemon
    // "Stop with: …" hint, status-box headers, "Starting claude-flow daemon…"
    // logs — is stale branding that sends users to a binary they don't have.
    //
    // This flags the COMMAND-INVOCATION shape `claude-flow <subcommand>` (a
    // space + lowercase word after the name). It deliberately does NOT match
    // the legitimate keeps that share the prefix:
    //   - `claude-flow.config.json` (dot, not space) — legacy config reader
    //   - `@claude-flow/...` (slash) — upstream package identity refs
    //   - `cmdline.includes('claude-flow')` — backward-compat daemon detection
    //   - comments (skipped) — historical/explanatory prose
    // If a user-facing string must mention the legacy CLI verbatim (rare),
    // add the marker `LEGACY-CLI` or `claude-flow-backup-` on the same line.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'helpers'),
      join(REPO_ROOT, '.claude', 'skills'),
    ];
    // `claude-flow` immediately followed by whitespace + a lowercase
    // subcommand-like word. `(?<![@./\w-])` rejects `@claude-flow`, `.claude-flow`,
    // and word-joined forms so only the bare CLI name matches.
    const CLI_INVOCATION_RE = /(?<![@./\w-])claude-flow\s+[a-z][a-z-]*/;
    const ALLOWED_MARKERS = /LEGACY-CLI|claude-flow-backup-/;
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (/[/\\]__tests__[/\\]/.test(file)) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const text = readFileSync(file, 'utf8');
        if (!text.includes('claude-flow')) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          if (!CLI_INVOCATION_RE.test(line)) continue;
          if (ALLOWED_MARKERS.test(line)) continue;
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Stale "claude-flow <cmd>" invocation strings — moflo's CLI binary is "flo":\n` +
        `replace with "flo <cmd>" (or "npx moflo <cmd>" where PATH isn't guaranteed).\n` +
        `If a verbatim legacy reference is intentional, add a "LEGACY-CLI" marker.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no production code *writes* CLAUDE_FLOW_* env vars or the claudeFlow.* settings tree (#1209)', () => {
    // Issue #1209: the claude-flow → moflo rebrand migrated every WRITER to
    // emit `MOFLO_*` env vars and the `moflo.*` settings tree. READS still
    // accept the pre-rebrand names as a fallback (see services/env-compat.ts
    // and hook-block-hash.ts), so this guard is deliberately write-only: it
    // flags new writers that would re-introduce the legacy brand into a
    // consumer's environment, .mcp.json, settings.json, or systemd unit.
    //
    // The write shapes below intentionally do NOT match: reads
    // (`readMofloEnv('X')`, `existingEnv.CLAUDE_FLOW_X || …`), comparisons
    // (`=== '1'`), deletions (`delete x.claudeFlow`), the upstream package-list
    // identifier `CLAUDE_FLOW_PACKAGES`, or the legacy `.claude-flow` dir
    // constant `LEGACY_CLAUDE_FLOW_DIR`. If a genuine new writer is required
    // (e.g. a migration codepath), add the marker `LEGACY-ENV-WRITE` on the
    // same line.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'helpers'),
      join(REPO_ROOT, '.claude', 'skills'),
    ];
    const WRITE_PATTERNS: RegExp[] = [
      /\bCLAUDE_FLOW_[A-Z0-9_]+\s*:/,                  // object-literal env key: `CLAUDE_FLOW_X: 'v'`
      /process\.env\.CLAUDE_FLOW_[A-Z0-9_]+\s*=(?!=)/, // assignment: `process.env.CLAUDE_FLOW_X = …`
      /\bCLAUDE_FLOW_[A-Z0-9_]+=(?!=)/,                // KEY=value string: systemd unit, .env, help text
      /\.claudeFlow\s*=(?!=)/,                          // settings member write: `settings.claudeFlow = …`
    ];
    const ALLOWED_MARKERS = /LEGACY-ENV-WRITE/;
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (/[/\\]__tests__[/\\]/.test(file)) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const text = readFileSync(file, 'utf8');
        if (!text.includes('CLAUDE_FLOW_') && !text.includes('claudeFlow')) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          if (ALLOWED_MARKERS.test(line)) continue;
          if (WRITE_PATTERNS.some((re) => re.test(line))) {
            offenders.push(`${rel}:${i + 1}`);
          }
        }
      }
    }
    expect(
      offenders,
      `Production code WRITES legacy claude-flow branding (#1209 migrated every\n` +
        `writer to MOFLO_* / moflo.*). Switch the writer to the MOFLO_* env name\n` +
        `or the moflo.* settings key (reads still fall back to the old name).\n` +
        `If a legacy write is genuinely required, add a "LEGACY-ENV-WRITE" marker\n` +
        `on the same line.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * Walk every file under `dir`, recursively. Excludes node_modules, dist,
 * .git, and other generated directories. Yields absolute paths for any file
 * — caller filters by extension.
 */
function* walkAll(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    if (entry.name === '.swarm' || entry.name === '.claude-flow' || entry.name === '.moflo') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAll(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    yield full;
  }
}
