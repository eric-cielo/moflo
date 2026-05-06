/**
 * System tests for bin/simplify-classify.cjs (issue #908 part 2).
 *
 * Drives the *real* classifier as a subprocess, piping synthetic diffs over
 * stdin. Asserts on the dispatch decision (tier, agentCount, model). This
 * directly verifies the cost-control behavior the issue cares about:
 *
 *   - #906-shape (mechanical decomposition)  → SMALL / 1 agent / sonnet
 *   - tiny diff                              → TRIVIAL / 0 agents
 *   - small logic edit                       → SMALL / 1 agent
 *   - large diff with new logic              → NORMAL / 3 agents
 *   - security-path + new logic              → NORMAL / 3 agents
 *   - never returns opus                     → ALL cases
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { parseDiff, decide, classifyDiff } from '../../bin/simplify-classify.cjs';

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
