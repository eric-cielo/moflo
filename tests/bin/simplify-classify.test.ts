/**
 * System tests for bin/simplify-classify.cjs.
 *
 * Drives the *real* classifier as a subprocess, piping synthetic diffs over
 * stdin. Asserts on the dispatch decision (tier, agentCount, model). This
 * directly verifies the cost-control behavior:
 *
 *   - mechanical decomposition  → SMALL / 1 agent / haiku
 *   - tiny diff                 → TRIVIAL / 0 agents
 *   - small logic edit          → SMALL / 1 agent
 *   - large diff with new logic → NORMAL / 3 agents
 *   - security-path + new logic → NORMAL / 3 agents
 *   - never returns opus        → ALL cases
 *   - default-branch detection  → consumer's actual default branch, not hardcoded 'main'
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseDiff, decide, classifyDiff, detectDefaultBranch } from '../../bin/simplify-classify.cjs';

const CLASSIFIER = resolve(__dirname, '../../bin/simplify-classify.cjs');

function runClassifier(diffText: string): any {
  const stdout = execFileSync('node', [CLASSIFIER, '--diff'], {
    input: diffText, encoding: 'utf-8', timeout: 15000,
  });
  return JSON.parse(stdout);
}

// ── Diff fixtures ────────────────────────────────────────────────────────────

/** A mechanical decomposition diff — 5 functions moved from one file into 5 new
 *  files. Exact shape of the #906 case. ~330 LOC across 6 files, additions ≈
 *  deletions, declarations relocate (declAdded ≈ declRemoved, netDecls small). */
function mechanicalDecompositionDiff(): string {
  let diff = '';
  // Original file: 5 functions removed
  diff += `diff --git a/src/cli/commands/doctor.ts b/src/cli/commands/doctor.ts
index abc..def 100644
--- a/src/cli/commands/doctor.ts
+++ b/src/cli/commands/doctor.ts
@@ -1,40 +1,5 @@
-export function checkDaemon() {
-  // ... 30 lines of body
-  const x = 1;
-  return x;
-}
-export function checkSession() {
-  return true;
-}
-export function checkMemory() {
-  return 1;
-}
-export function checkSwarm() {
-  return 2;
-}
-export function checkAidefence() {
-  return 3;
-}
+import { checkDaemon } from './doctor/daemon.js';
+import { checkSession } from './doctor/session.js';
+import { checkMemory } from './doctor/memory.js';
+import { checkSwarm } from './doctor/swarm.js';
+import { checkAidefence } from './doctor/aidefence.js';
`;
  const newFiles = ['daemon', 'session', 'memory', 'swarm', 'aidefence'];
  for (const f of newFiles) {
    diff += `diff --git a/src/cli/commands/doctor/${f}.ts b/src/cli/commands/doctor/${f}.ts
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/src/cli/commands/doctor/${f}.ts
@@ -0,0 +1,5 @@
+export function check${f.charAt(0).toUpperCase() + f.slice(1)}() {
+  // body
+  const x = 1;
+  return x;
+}
`;
  }
  return diff;
}

/** A small logic edit — ~25 lines changed, 1 file, no declarations added/removed. */
function smallLogicEditDiff(): string {
  return `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,5 +10,30 @@
   if (x > 0) {
-    return x;
+    if (cache.has(x)) return cache.get(x);
+    const result = x * 2;
+    cache.set(x, result);
+    if (result > MAX) {
+      log.warn('exceeded');
+      return MAX;
+    }
+    return result;
   }
+  if (x === 0) {
+    if (zeroCache.size > 0) {
+      return zeroCache.values().next().value;
+    }
+    const z = computeZero();
+    zeroCache.add(z);
+    return z;
+  }
+  if (x < 0) {
+    if (negativeCache.has(-x)) return -negativeCache.get(-x);
+    const r = -compute(-x);
+    negativeCache.set(-x, -r);
+    return r;
+  }
   return -1;
 }
`;
}

/** A trivial typo fix — single comment edit. */
function trivialTypoDiff(): string {
  return `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-// fixs the bug
+// fixes the bug
 export const X = 1;
`;
}

/** A genuinely large diff with new logic — 600+ LOC, 8 files, 6 new functions. */
function largeNewLogicDiff(): string {
  let diff = '';
  for (let i = 0; i < 8; i++) {
    diff += `diff --git a/src/feature/file${i}.ts b/src/feature/file${i}.ts
index abc..def 100644
--- a/src/feature/file${i}.ts
+++ b/src/feature/file${i}.ts
@@ -1,5 +1,80 @@
 // existing code
+export function newFeatureFn${i}(input: string): string {
+  // 70+ lines of new logic
`;
    for (let j = 0; j < 75; j++) {
      diff += `+  const step${j} = ${j};\n`;
    }
    diff += `+  return input;\n+}\n`;
  }
  return diff;
}

/** Security-path edit with new logic. */
function securityPathNewLogicDiff(): string {
  return `diff --git a/src/cli/aidefence/scanner.ts b/src/cli/aidefence/scanner.ts
index abc..def 100644
--- a/src/cli/aidefence/scanner.ts
+++ b/src/cli/aidefence/scanner.ts
@@ -10,3 +10,18 @@
 export class Scanner {
   scan() { return true; }
 }
+export class AdvancedScanner {
+  // new logic for the security path
+  scan(input: string): boolean {
+    if (this.dangerous(input)) return false;
+    return this.deep(input);
+  }
+  dangerous(input: string): boolean {
+    return /badpattern/.test(input);
+  }
+  deep(input: string): boolean {
+    return input.length < 1000;
+  }
+}
+export function configureScanner(opts: any) {
+  return new AdvancedScanner();
+}
`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('simplify-classify: pure logic via require()', () => {
  it('mechanical decomposition (#906-shape) → SMALL, 1 agent, haiku', () => {
    // Relocations get haiku: pattern-matching review beats deep reasoning,
    // ~5x cheaper than sonnet, negligible miss rate.
    const decision = classifyDiff(mechanicalDecompositionDiff());
    expect(decision.tier).toBe('SMALL');
    expect(decision.agentCount).toBe(1);
    expect(decision.model).toBe('haiku');
    expect(decision.reasoning.join(' ')).toMatch(/relocation/i);
    expect(decision.stats.fileCount).toBeGreaterThanOrEqual(5);
  });

  it('trivial typo → TRIVIAL, 0 agents (no agent spawn)', () => {
    const decision = classifyDiff(trivialTypoDiff());
    expect(decision.tier).toBe('TRIVIAL');
    expect(decision.agentCount).toBe(0);
  });

  it('small logic edit → SMALL, 1 agent', () => {
    const decision = classifyDiff(smallLogicEditDiff());
    expect(decision.tier).toBe('SMALL');
    expect(decision.agentCount).toBe(1);
    expect(decision.model).toBe('sonnet');
  });

  it('large new logic → NORMAL, 3 agents', () => {
    const decision = classifyDiff(largeNewLogicDiff());
    expect(decision.tier).toBe('NORMAL');
    expect(decision.agentCount).toBe(3);
    expect(decision.model).toBe('sonnet');
    expect(decision.reasoning.join(' ')).toMatch(/>500 LOC|new declaration/i);
  });

  it('security path + new logic → NORMAL, 3 agents', () => {
    const decision = classifyDiff(securityPathNewLogicDiff());
    expect(decision.tier).toBe('NORMAL');
    expect(decision.agentCount).toBe(3);
    expect(decision.stats.securityHit).toBe(true);
    expect(decision.reasoning.join(' ')).toMatch(/security/i);
  });

  it('empty diff → TRIVIAL', () => {
    const decision = classifyDiff('');
    expect(decision.tier).toBe('TRIVIAL');
    expect(decision.agentCount).toBe(0);
  });

  it('never returns opus, regardless of input', () => {
    // Code review is breadth-bound, not depth-bound — opus is never the right
    // model. Sonnet (default) and haiku (mechanical relocations) are valid.
    for (const fixture of [
      mechanicalDecompositionDiff(),
      trivialTypoDiff(),
      smallLogicEditDiff(),
      largeNewLogicDiff(),
      securityPathNewLogicDiff(),
    ]) {
      const decision = classifyDiff(fixture);
      expect(decision.model).not.toBe('opus');
      expect(['sonnet', 'haiku']).toContain(decision.model);
    }
  });
});

describe('simplify-classify: parseDiff stats', () => {
  it('counts adds/deletes correctly on the mechanical fixture', () => {
    const stats = parseDiff(mechanicalDecompositionDiff());
    expect(stats.added).toBeGreaterThan(20);
    expect(stats.deleted).toBeGreaterThan(10);
    expect(stats.declAdded).toBeGreaterThanOrEqual(5);
    expect(stats.declRemoved).toBeGreaterThanOrEqual(5);
    // Net new declarations should be small for mechanical moves
    expect(Math.abs(stats.netDecls)).toBeLessThanOrEqual(2);
  });

  it('flags security path correctly', () => {
    const stats = parseDiff(securityPathNewLogicDiff());
    expect(stats.securityHit).toBe(true);
  });

  it('counts new files', () => {
    const stats = parseDiff(mechanicalDecompositionDiff());
    expect(stats.newFiles).toBeGreaterThanOrEqual(5);
  });
});

describe('simplify-classify: decide() boundary cases', () => {
  it('balance ratio threshold — 0.6 means 60% balanced', () => {
    // 100 added / 60 deleted = 0.6 — should still trip relocation if decls match
    const decision = decide({
      added: 100, deleted: 60, declAdded: 5, declRemoved: 5,
      netDecls: 0, fileCount: 4, newFiles: 0, renamedFiles: 0, securityHit: false, files: [],
    });
    expect(decision.tier).toBe('SMALL');
    expect(decision.reasoning.join(' ')).toMatch(/relocation/i);
  });

  it('add-heavy new-feature diff is NOT classified as relocation', () => {
    // 6 new declarations, only 1 removed — this is a new feature, not a move.
    const decision = decide({
      added: 200, deleted: 20, declAdded: 6, declRemoved: 1,
      netDecls: 5, fileCount: 4, newFiles: 0, renamedFiles: 0, securityHit: false, files: [],
    });
    // Reasoning must not say "relocation" — that's the false-positive guard.
    // (Whether it lands SMALL or NORMAL is a separate routing decision; the
    // user's rule is "single agent unless warranted" so 220 LOC / 4 files
    // can legitimately stay SMALL.)
    expect(decision.reasoning.join(' ')).not.toMatch(/relocation/i);
  });

  it('1-line touch on security path is still SMALL (no new logic)', () => {
    const decision = decide({
      added: 1, deleted: 1, declAdded: 0, declRemoved: 0,
      netDecls: 0, fileCount: 1, newFiles: 0, renamedFiles: 0, securityHit: true, files: ['src/cli/aidefence/x.ts'],
    });
    // Security hit alone does not escalate — only security + new declarations
    expect(decision.agentCount).toBeLessThanOrEqual(1);
  });
});

describe('simplify-classify: end-to-end CLI invocation', () => {
  it('CLI returns JSON with the expected shape', () => {
    const decision = runClassifier(mechanicalDecompositionDiff());
    expect(decision).toMatchObject({
      tier: 'SMALL',
      agentCount: 1,
      model: 'haiku',
    });
    expect(Array.isArray(decision.reasoning)).toBe(true);
    expect(decision.stats).toBeDefined();
  });

  it('CLI handles trivial diff', () => {
    const decision = runClassifier(trivialTypoDiff());
    expect(decision.tier).toBe('TRIVIAL');
    expect(decision.agentCount).toBe(0);
  });

  it('CLI handles large diff', () => {
    const decision = runClassifier(largeNewLogicDiff());
    expect(decision.tier).toBe('NORMAL');
    expect(decision.agentCount).toBe(3);
  });
});

describe('simplify-classify: default-branch detection', () => {
  // Hardcoded 'main' silently miscalibrates classification on consumers using
  // 'master', 'develop', or any other default branch — empty diff → TRIVIAL →
  // gate stamps clean without any real review. detectDefaultBranch must read
  // the consumer's actual default.
  const tempRepos: string[] = [];

  function newTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempRepos.push(dir); // register before any throwable work
    return dir;
  }

  function makeRepo(opts: { defaultBranch?: string; setOriginHead?: boolean } = {}): string {
    const dir = newTempDir('simplify-classify-');
    const branch = opts.defaultBranch ?? 'main';
    // Use separate execSync calls (no shell) to keep cross-platform behavior consistent
    execSync(`git init -b ${branch} -q`, { cwd: dir });
    execSync('git config user.email t@e.com', { cwd: dir });
    execSync('git config user.name T', { cwd: dir });
    execSync('git config commit.gpgsign false', { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# t\n');
    execSync('git add README.md', { cwd: dir });
    execSync('git commit -m init -q', { cwd: dir });
    if (opts.setOriginHead) {
      // Simulate a remote HEAD without a real remote: create the remote-tracking
      // branch ref first so symbolic-ref --short resolves cleanly.
      execSync(`git update-ref refs/remotes/origin/${branch} HEAD`, { cwd: dir });
      execSync(`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${branch}`, { cwd: dir });
    }
    return dir;
  }

  // Spawn a fresh Node subprocess in `cwd` so each probe gets an unprimed module
  // (the classifier memoizes detectDefaultBranch within a single process).
  function probeDefaultBranch(cwd: string): string {
    return execFileSync(
      'node',
      ['-e', `process.chdir(${JSON.stringify(cwd)}); const m = require(${JSON.stringify(CLASSIFIER)}); process.stdout.write(m.detectDefaultBranch());`],
      { encoding: 'utf-8', timeout: 10000 },
    );
  }

  function runClassifierIn(cwd: string): any {
    const stdout = execFileSync('node', [CLASSIFIER], { cwd, encoding: 'utf-8', timeout: 15000 });
    return JSON.parse(stdout);
  }

  afterEach(() => {
    for (const d of tempRepos.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('picks up origin/HEAD when set (non-main default branch)', () => {
    const dir = makeRepo({ defaultBranch: 'develop', setOriginHead: true });
    expect(probeDefaultBranch(dir)).toBe('develop');
  });

  it('falls back to init.defaultBranch when origin/HEAD is missing', () => {
    const dir = makeRepo({ defaultBranch: 'trunk', setOriginHead: false });
    execSync('git config init.defaultBranch trunk', { cwd: dir });
    expect(probeDefaultBranch(dir)).toBe('trunk');
  });

  it('falls back to "main" when no signals available', () => {
    // Not even a git repo — both git calls fail, fallback is 'main'
    const dir = newTempDir('simplify-classify-bare-');
    expect(probeDefaultBranch(dir)).toBe('main');
  });

  it('CLI uses the detected branch as merge base, not hardcoded "main"', () => {
    // The discriminator: commit a change ON `develop`, with NO working-tree
    // changes. A correct implementation diffs against `develop` (sees the
    // commit). A hardcoded-`main` implementation diffs against a non-existent
    // ref (`git diff main...HEAD` errors → safeExec returns ''), so committed
    // diff is invisible and `stats.added` would be 0.
    //
    // Scenario: branch off develop, add commits on the branch, classifier
    // invoked from the branch tip with no --base.
    const dir = makeRepo({ defaultBranch: 'develop', setOriginHead: true });
    execSync('git checkout -q -b feature', { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# t\nadded line 1\nadded line 2\nadded line 3\nadded line 4\n');
    execSync('git add README.md', { cwd: dir });
    execSync('git commit -m feat -q', { cwd: dir });

    const decision = runClassifierIn(dir);
    expect(decision.stats).toBeDefined();
    // 4 added lines committed since the develop merge-base. If the classifier
    // hardcoded 'main', `git diff main...HEAD` would error and committed diff
    // would be empty (working tree is clean too) — stats.added would be 0.
    expect(decision.stats.added).toBeGreaterThanOrEqual(4);
  });
});
