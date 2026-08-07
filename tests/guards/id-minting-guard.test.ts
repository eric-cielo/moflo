/**
 * Guards the ID-minting consolidation from #1423.
 *
 * Story #801 fixed `agent_spawn` after base-36 slicing of `Math.random()` was
 * observably colliding under burst spawns, and stopped there. ~38 sites kept
 * the pattern, and four separately-written `generateId` helpers accumulated —
 * three of them live and identically named. This test exists so it cannot split
 * a third time.
 *
 * Shape-based, with no allowlist, deliberately: a new site trips it on first
 * use. Note what is NOT banned — plain `Math.random()` is correct and stays in
 * ~120 places (neural weight init, epsilon-greedy exploration, HNSW level
 * selection, benchmark workloads, jitter). Only the base-36-slice idiom, which
 * in this codebase means "mint an identifier", is caught.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateId, randomSuffix } from '../../src/cli/shared/utils/id.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Shipped source. `.claude/scripts/` is a synced mirror of `bin/`, so scanning bin covers it. */
const SHIPPED_ROOTS = ['src/cli', 'bin'];

/** Not shipped: test trees, fixtures, and build output. */
const SKIP_DIR = new Set(['__tests__', 'node_modules', 'dist', 'fixtures']);
const SOURCE_EXT = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);

/** `Math.random().toString(36)` in any spacing — the ID-minting idiom. */
const BASE36_SLICE = /Math\s*\.\s*random\s*\(\s*\)\s*\.\s*toString\s*\(\s*36\s*\)/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIR.has(entry)) yield* walk(full);
      continue;
    }
    if (entry.includes('.test.') || entry.includes('.spec.')) continue;
    if (SOURCE_EXT.has(path.extname(entry))) yield full;
  }
}

/**
 * Every shipped source file, already split into lines.
 *
 * Read once and memoised: three scans share this, and each was otherwise
 * re-walking and re-reading the whole shipped tree.
 */
let cachedSources: Array<{ rel: string; lines: string[] }> | null = null;

function shippedSources(): Array<{ rel: string; lines: string[] }> {
  cachedSources ??= SHIPPED_ROOTS.flatMap((root) =>
    [...walk(path.join(REPO_ROOT, root))].map((file) => ({
      rel: path.relative(REPO_ROOT, file),
      // `/\r?\n/` rather than `'\n'`. `.gitattributes` pins `eol=lf` for *.ts
      // and *.mjs, so CRLF should not reach here — this is the habit, not a
      // live fix, and it keeps a future `$`-anchored matcher from silently
      // failing on a stray `\r` if that policy ever changes.
      lines: readFileSync(file, 'utf8').split(/\r?\n/),
    })),
  );
  return cachedSources;
}

/** Collect `file:line  text` for every line the predicate flags. */
function scan(flagged: (line: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const { rel, lines } of shippedSources()) {
    lines.forEach((line, i) => {
      if (flagged(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  return offenders;
}

describe('#1423 — no ID is minted from Math.random()', () => {
  it('no shipped source file base-36-slices Math.random()', () => {
    const offenders = scan((line) => BASE36_SLICE.test(line));

    expect(
      offenders,
      `Mint IDs with generateId()/randomSuffix() from src/cli/shared/utils/id.ts.\n` +
        `This pattern collides — it is what Story #801 observed under burst spawns.\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('no shipped source file pairs Date.now() with Math.random() in one template', () => {
    // The same defect written without `.toString(36)` — e.g. a raw
    // `${Date.now()}-${Math.random()}` — would slip past the check above.
    const pattern = /\$\{\s*Date\s*\.\s*now\s*\(\s*\)\s*\}[^`]{0,20}\$\{[^}]*Math\s*\.\s*random/;

    expect(scan((line) => pattern.test(line))).toEqual([]);
  });
});

describe('#1427 — no ID is minted from Date.now() alone', () => {
  // Strictly worse than the Math.random() sites above: a base-36 slice carried
  // ~31 bits before slicing, a bare clock reading carries none. Two entities
  // created in the same millisecond do not risk a collision, they take one.
  //
  // `${Date.now()}` is legitimate in plenty of places — cache busters, SSE
  // pings, backup filenames, elapsed-time maths, and the doctor's own prose
  // describing the stub shape it detects. So this keys on the *binding*: a
  // template assigned to something named like an identifier, with no other
  // source of uniqueness in it.
  // The interpolation must be a bare clock reading — `${Date.now()}` or the
  // base36 spelling of it. `${Date.now() - 86400000}` is deliberately excluded:
  // that is a reference to a past instant (hooks-tools synthesises "the session
  // from an hour ago" that way), not a fresh mint, and randomising it would be
  // wrong rather than safer.
  const NOW = String.raw`\$\{\s*Date\s*\.\s*now\s*\(\s*\)(?:\s*\.\s*toString\s*\(\s*36\s*\))?\s*\}`;
  const ID_BINDING = new RegExp(
    String.raw`\b\w*(?:[Ii]d|[Kk]ey)\s*[:=]\s*[^;\n]*\`[^\`\n]*` + NOW,
  );

  /**
   * Anything that already separates two IDs minted in the same millisecond.
   * `++` covers the in-memory event/message buses, whose counters are
   * process-local and monotonic — weaker than a CSPRNG, but not zero.
   */
  const HAS_ENTROPY = /[Rr]andom|generateId|\+\+|[Cc]ounter|crypto/;

  /** Comment lines describe these shapes on purpose — see doctor-checks-swarm.ts. */
  const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

  // Known limits, stated rather than discovered later. This is a line-based
  // scan over a binding name, so it does NOT catch:
  //   - a template split across lines
  //   - concatenation: `const spellId = 'sp-' + Date.now()`
  //   - `return \`sp-${Date.now()}\`` — no binding name to key on, and keying
  //     on bare `return` would flag every function building a timestamped
  //     filename
  //   - a binding named for the entity rather than the id (`session`, `handle`)
  //   - a line where HAS_ENTROPY matches incidentally (a trailing comment
  //     containing the word "counter" masks the rest of the line)
  // None of these exist in the tree today. The check is a ratchet against the
  // shape that actually recurred 52 times, not a proof of absence.

  const flagged = (line: string) =>
    !COMMENT.test(line) && ID_BINDING.test(line) && !HAS_ENTROPY.test(line);

  it('no shipped source file binds an id/key to a template whose only variable is Date.now()', () => {
    const offenders = scan(flagged);

    expect(
      offenders,
      `Mint IDs with generateId() from src/cli/shared/utils/id.ts.\n` +
        `A bare Date.now() has zero entropy — same millisecond means same ID.\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('detects the shape it claims to detect', () => {
    // Without this, the check above passes just as happily when ID_BINDING has
    // been broken as when the codebase is clean. Uses the same predicate the
    // scan does, so the two cannot drift apart.
    const detect = flagged;

    // Caught — the #1427 shapes, in the spacings and separators used here.
    expect(detect('const spellId = `sp-${Date.now()}`;')).toBe(true);
    expect(detect('  taskId: `task_${Date.now()}`,')).toBe(true);
    expect(detect('const queenId = input.queenId || `queen-${Date.now()}`;')).toBe(true);
    expect(detect('  key: `merged_${Date.now()}`,')).toBe(true);
    expect(detect('const probeKey = `doctor-probe-${ Date.now() }`;')).toBe(true);

    // Not caught — legitimate uses that must stay legal.
    expect(detect('const cacheBuster = `?t=${Date.now()}`;')).toBe(false); // not an id binding
    expect(detect('res.write(`: ping ${Date.now()}\\n\\n`);')).toBe(false); // not a binding
    expect(detect('const backupPath = `${p}.malformed-${Date.now()}`;')).toBe(false); // a path
    expect(detect('const id = `evt-${Date.now()}-${++eventCounter}`;')).toBe(false); // counter
    expect(detect('const id = `s-${Date.now()}-${randomUUID()}`;')).toBe(false); // random
    expect(detect('const spellId = generateId("sp");')).toBe(false); // the fix itself
    // The doctor documents the stub shape in prose; that must not trip.
    expect(detect('  // literal was `swarm-${Date.now()}` (hyphen).')).toBe(false);
    // A derived past instant, not a mint.
    expect(detect('const sessionId = `session-${Date.now() - 3600000}`;')).toBe(false);

    // The base36 spelling is the same defect and is caught.
    expect(detect('const swarmId = `swarm-${Date.now().toString(36)}`;')).toBe(true);
  });
});

describe('#1423 — generateId', () => {
  it('mints unique IDs across a burst that Date.now() cannot separate', () => {
    // The failure being guarded against: entities created inside one millisecond
    // sharing an identity. 20k samples in a tight loop spans few enough
    // milliseconds that the timestamp segment is doing almost no work.
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i++) ids.add(generateId('agent'));
    expect(ids.size).toBe(20_000);
  });

  it('defaults to `<prefix>-<millis>-<12 hex>`', () => {
    expect(generateId('swarm')).toMatch(/^swarm-\d{13}-[0-9a-f]{12}$/);
  });

  it('honours the separator, entropy width, and base36 timestamp options', () => {
    expect(generateId('bc', { separator: '_' })).toMatch(/^bc_\d{13}_[0-9a-f]{12}$/);
    expect(generateId('mem', { separator: '_', bytes: 8 })).toMatch(/^mem_\d{13}_[0-9a-f]{16}$/);
    expect(generateId('mem', { base36Time: true })).toMatch(/^mem-[0-9a-z]+-[0-9a-f]{12}$/);
  });

  it('preserves the two persisted ID formats exactly', () => {
    // memory/controllers/_shared.ts and memory/bridge-core.ts write these into
    // .moflo/moflo.db. Their shapes are pinned, not normalised, so an upgrade
    // does not churn consumer state (Rule #2).
    expect(generateId('reflexion', { base36Time: true }))
      .toMatch(/^reflexion-[0-9a-z]{8,}-[0-9a-f]{12}$/);
    expect(generateId('entry', { separator: '_', bytes: 8 }))
      .toMatch(/^entry_\d{13}_[0-9a-f]{16}$/);
  });

  it('randomSuffix returns hex of the requested width and does not repeat', () => {
    expect(randomSuffix()).toMatch(/^[0-9a-f]{12}$/);
    expect(randomSuffix(4)).toMatch(/^[0-9a-f]{8}$/);
    const suffixes = new Set(Array.from({ length: 20_000 }, () => randomSuffix()));
    expect(suffixes.size).toBe(20_000);
  });
});
