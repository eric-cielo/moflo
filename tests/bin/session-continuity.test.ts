/**
 * Tests for passive session-continuity (#1185).
 *
 * Covers the pure logic (secret scrub, digest assembly, relevance scoring,
 * selection, capped formatting), the JSON store round-trip, and an end-to-end
 * capture subprocess (stdin → digest file, including the `<private>` opt-out).
 *
 * Cross-platform (Rule #1): temp dirs via os/path, capture driven by spawnSync
 * with arg arrays, no shell or POSIX-only assumptions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

import { scrubSecrets, containsSecret } from '../../bin/lib/pii-scrub.mjs';
import {
  SCORE,
  DEFAULT_MAX_AGE_HOURS,
  INJECT_MAX_CHARS,
  KEEP_DIGESTS,
  readContinuityConfig,
  hasPrivateOptOut,
  assembleDigestContent,
  buildDigestMetadata,
  scoreDigest,
  selectBestDigest,
  relativeTime,
  formatInjection,
  writeDigest,
  readDigests,
  rotateDigests,
  continuityDir,
} from '../../bin/lib/session-continuity.mjs';

const CAPTURE_SCRIPT = resolve(__dirname, '../../bin/session-continuity.mjs');
const HOUR = 3_600_000;

function makeTempRoot(label: string): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-continuity-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(join(root, '.moflo'), { recursive: true });
  return root;
}
function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle hold — non-fatal */ }
}

// ── Secret scrubbing ────────────────────────────────────────────────────────

describe('pii-scrub: scrubSecrets', () => {
  it('redacts API keys, JWTs, tokens and private keys', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'eyJhbGciOiAiSFMyNTYifQ.eyJzdWIiOiAiMTIzNDU2In0.dozjgNryP4J3jVmNHl0w',
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_0123456789012345678901234567890123456789',
      'export TOKEN=supersecretvalue123',
    ];
    for (const s of samples) {
      const out = scrubSecrets(s);
      expect(containsSecret(out)).toBe(false);
      expect(out).toMatch(/REDACTED/);
    }
  });

  it('redacts credentials embedded in a URL but keeps the host', () => {
    const out = scrubSecrets('postgres://admin:hunter2@db.internal:5432/app');
    expect(out).toContain('postgres://admin:[REDACTED]@');
    expect(out).not.toContain('hunter2');
  });

  it('KEEPS benign context — file paths and branch names are not sensitive on local disk', () => {
    const text = '**Stopped at:** on `feat/1185-continuity`, 3 uncommitted file(s) in src/cli/init/';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('is idempotent and safe on non-string input', () => {
    const once = scrubSecrets('token=abcdef123456');
    expect(scrubSecrets(once)).toBe(once);
    expect(scrubSecrets(undefined as unknown as string)).toBe('');
    expect(scrubSecrets(123 as unknown as string)).toBe('');
  });
});

// ── Digest assembly ─────────────────────────────────────────────────────────

describe('assembleDigestContent', () => {
  it('emits only the sections that have content (non-reconstructable first)', () => {
    const out = assembleDigestContent({
      goal: 'Implement session continuity',
      decisions: ['capture-on + gated inject', 'reject /flo:save'],
      gitState: { branch: 'feat/x', lastCommit: 'wire capture', uncommittedCount: 2 },
    });
    expect(out).toContain('**Goal:** Implement session continuity');
    expect(out).toContain('**Decisions this session:** capture-on + gated inject; reject /flo:save');
    expect(out).toContain('**Stopped at:** on `feat/x`, last commit: "wire capture", 2 uncommitted file(s)');
  });

  it('returns empty string when nothing substantive was captured', () => {
    expect(assembleDigestContent({})).toBe('');
    expect(assembleDigestContent({ gitState: { branch: null } })).toBe('');
  });
});

describe('buildDigestMetadata', () => {
  it('flags unfinished work from uncommitted files', () => {
    const m = buildDigestMetadata({ gitState: { branch: 'main', changedFiles: ['a.ts'], uncommittedCount: 1 }, sessionId: 's1', endedAt: 100 });
    expect(m).toMatchObject({ branch: 'main', sessionId: 's1', endedAt: 100, hadUnfinished: true });
    expect(m.changedFiles).toEqual(['a.ts']);
  });
  it('clean tree with no open threads is not unfinished', () => {
    const m = buildDigestMetadata({ gitState: { branch: 'main', changedFiles: [], uncommittedCount: 0 } });
    expect(m.hadUnfinished).toBe(false);
  });
});

// ── Relevance scoring ───────────────────────────────────────────────────────

describe('scoreDigest', () => {
  const now = 1_000 * HOUR;
  const fresh = now - HOUR; // 1h ago

  it('feature-branch match + recency clears the inject threshold', () => {
    const meta = { branch: 'feat/x', changedFiles: [], endedAt: fresh };
    const s = scoreDigest(meta, { branch: 'feat/x', changedFiles: [] }, { now });
    expect(s).toBeGreaterThanOrEqual(SCORE.INJECT_THRESHOLD);
  });

  it('mainline branch match alone does NOT clear the threshold (everyone is on main)', () => {
    const meta = { branch: 'main', changedFiles: [], endedAt: fresh, hadUnfinished: false };
    const s = scoreDigest(meta, { branch: 'main', changedFiles: [] }, { now });
    expect(s).toBeLessThan(SCORE.INJECT_THRESHOLD);
  });

  it('mainline match + file overlap + unfinished does clear the threshold', () => {
    const meta = { branch: 'main', changedFiles: ['src/a.ts', 'src/b.ts'], endedAt: fresh, hadUnfinished: true };
    const s = scoreDigest(meta, { branch: 'main', changedFiles: ['src/a.ts', 'src/b.ts'] }, { now });
    expect(s).toBeGreaterThanOrEqual(SCORE.INJECT_THRESHOLD);
  });

  it('returns 0 for digests older than maxAgeHours', () => {
    const meta = { branch: 'feat/x', changedFiles: [], endedAt: now - 100 * HOUR };
    expect(scoreDigest(meta, { branch: 'feat/x', changedFiles: [] }, { now, maxAgeHours: 72 })).toBe(0);
  });

  it('recency decays — older same-branch scores lower than fresher', () => {
    const ctx = { branch: 'feat/x', changedFiles: [] };
    const older = scoreDigest({ branch: 'feat/x', changedFiles: [], endedAt: now - 48 * HOUR }, ctx, { now });
    const newer = scoreDigest({ branch: 'feat/x', changedFiles: [], endedAt: now - 1 * HOUR }, ctx, { now });
    expect(newer).toBeGreaterThan(older);
  });
});

describe('selectBestDigest', () => {
  const now = 1_000 * HOUR;
  const ctx = { branch: 'feat/x', changedFiles: ['src/a.ts'] };

  it('picks the highest-scoring digest above threshold', () => {
    const rows = [
      { content: 'old', metadata: { branch: 'feat/x', changedFiles: [], endedAt: now - 40 * HOUR } },
      { content: 'best', metadata: { branch: 'feat/x', changedFiles: ['src/a.ts'], endedAt: now - 1 * HOUR, hadUnfinished: true } },
    ];
    const best = selectBestDigest(rows, ctx, { now });
    expect(best?.row.content).toBe('best');
  });

  it('returns null when nothing is relevant (fresh unrelated session)', () => {
    const rows = [{ content: 'x', metadata: { branch: 'other-branch', changedFiles: [], endedAt: now - 50 * HOUR } }];
    expect(selectBestDigest(rows, ctx, { now })).toBeNull();
  });

  it('skips empty-content rows and the excluded session', () => {
    const rows = [
      { content: '', metadata: { branch: 'feat/x', endedAt: now - HOUR } },
      { content: 'self', metadata: { branch: 'feat/x', endedAt: now - HOUR, sessionId: 'me' } },
    ];
    expect(selectBestDigest(rows, ctx, { now, excludeSessionId: 'me' })).toBeNull();
  });
});

// ── Formatting ──────────────────────────────────────────────────────────────

describe('formatInjection', () => {
  it('frames as a verifiable lead and stays under the size cap', () => {
    const now = 10 * HOUR;
    const out = formatInjection({ row: { content: 'X'.repeat(5000) }, meta: { endedAt: now - 3 * HOUR } }, now);
    expect(out).toContain('Where you left off');
    expect(out).toContain('verify current state before continuing');
    expect(out).toContain('3 hours ago');
    expect(out.length).toBeLessThanOrEqual(INJECT_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns empty for empty content', () => {
    expect(formatInjection({ row: { content: '   ' }, meta: {} })).toBe('');
  });
});

describe('relativeTime', () => {
  it('humanises minutes / hours / days', () => {
    const now = 1000 * HOUR;
    expect(relativeTime(now - 30 * 60_000, now)).toBe('30 minutes ago');
    expect(relativeTime(now - 5 * HOUR, now)).toBe('5 hours ago');
    expect(relativeTime(now - 50 * HOUR, now)).toBe('2 days ago');
  });
});

// ── Opt-out + config ────────────────────────────────────────────────────────

describe('hasPrivateOptOut', () => {
  it('detects the <private> tag case-insensitively', () => {
    expect(hasPrivateOptOut('please <PRIVATE> do not store')).toBe(true);
    expect(hasPrivateOptOut('normal message')).toBe(false);
  });
});

describe('readContinuityConfig', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('cfg'); });
  afterEach(() => cleanTempRoot(root));

  it('defaults both flags on with no moflo.yaml', () => {
    expect(readContinuityConfig(root)).toEqual({ capture: true, inject: true, maxAgeHours: DEFAULT_MAX_AGE_HOURS });
  });

  it('parses explicit false flags and max_age_hours', () => {
    writeFileSync(resolve(root, 'moflo.yaml'), 'session_continuity:\n  capture: true\n  inject: false\n  max_age_hours: 24\n');
    expect(readContinuityConfig(root)).toEqual({ capture: true, inject: false, maxAgeHours: 24 });
  });
});

// ── Store round-trip ────────────────────────────────────────────────────────

describe('JSON digest store', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('store'); });
  afterEach(() => cleanTempRoot(root));

  it('writeDigest → readDigests round-trips content + metadata', () => {
    writeDigest(root, 'session-abc', { content: 'hello', metadata: { branch: 'feat/x', endedAt: 1 } });
    const rows = readDigests(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('hello');
    expect(rows[0].metadata.branch).toBe('feat/x');
  });

  it('upserts by key — same session overwrites, does not accumulate', () => {
    writeDigest(root, 'session-abc', { content: 'v1', metadata: {} });
    writeDigest(root, 'session-abc', { content: 'v2', metadata: {} });
    const rows = readDigests(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('v2');
  });

  it('rotateDigests keeps only the most recent KEEP_DIGESTS', () => {
    for (let i = 0; i < KEEP_DIGESTS + 5; i++) {
      writeDigest(root, `session-${i}`, { content: `c${i}`, metadata: { endedAt: i } });
    }
    rotateDigests(root);
    const files = readdirSync(continuityDir(root)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(KEEP_DIGESTS);
  });

  it('readDigests tolerates a malformed file', () => {
    mkdirSync(continuityDir(root), { recursive: true });
    writeFileSync(join(continuityDir(root), 'broken.json'), '{ not valid json');
    writeDigest(root, 'good', { content: 'ok', metadata: {} });
    const rows = readDigests(root);
    expect(rows.map((r) => r.content)).toContain('ok');
  });
});

// ── End-to-end capture subprocess ───────────────────────────────────────────

function runCapture(root: string, input: object) {
  return spawnSync('node', [CAPTURE_SCRIPT, 'capture'], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 20_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
}

function writeTranscript(root: string, userMessages: string[]): string {
  const p = resolve(root, 'transcript.jsonl');
  const lines = userMessages.map((m) => JSON.stringify({ type: 'user', message: { role: 'user', content: m } }));
  writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
  return p;
}

describe('capture subprocess (end-to-end)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('e2e'); });
  afterEach(() => cleanTempRoot(root));

  it('writes a scrubbed digest from the session goal', () => {
    const transcript = writeTranscript(root, ['Implement the new export feature with key sk-ant-secret0123456789abcdefghij']);
    const r = runCapture(root, { session_id: 'sess-1', transcript_path: transcript });
    expect(r.status).toBe(0);

    const rows = readDigests(root);
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain('Implement the new export feature');
    // The secret that rode in on the goal text must be scrubbed before persist.
    expect(rows[0].content).not.toContain('sk-ant-secret');
    expect(containsSecret(rows[0].content)).toBe(false);
    expect(rows[0].metadata.sessionId).toBe('sess-1');
  });

  it('honors the <private> opt-out — no digest is written', () => {
    const transcript = writeTranscript(root, ['<private> work on the secret prototype, do not remember this']);
    const r = runCapture(root, { session_id: 'sess-2', transcript_path: transcript });
    expect(r.status).toBe(0);
    expect(existsSync(continuityDir(root))).toBe(false);
  });

  it('respects capture: false in moflo.yaml', () => {
    writeFileSync(resolve(root, 'moflo.yaml'), 'session_continuity:\n  capture: false\n');
    const transcript = writeTranscript(root, ['Some goal worth remembering']);
    const r = runCapture(root, { session_id: 'sess-3', transcript_path: transcript });
    expect(r.status).toBe(0);
    expect(existsSync(continuityDir(root))).toBe(false);
  });
});
