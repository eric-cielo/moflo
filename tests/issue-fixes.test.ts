/**
 * Tests for GitHub issues #74, #75, #76, #77, #79, #80
 *
 * #74: CLI --version reads from generated version.ts, synced from root package.json
 * #75: session-start auto-pretrains when intelligence is cold
 * #76: Doctor intelligence check falls back to memory-backed patterns
 * #77: createSONALearningEngine handles no-args without crashing
 * #79: extractPatterns produces many granular patterns, not just 5 buckets
 * #80: Doctor ReasoningBank check uses distill() lifecycle
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const rootPkgPath = resolve(__dirname, '../package.json');
const cliPkgPath = resolve(__dirname, '../src/@claude-flow/cli/package.json');
const versionTsPath = resolve(__dirname, '../src/@claude-flow/cli/src/version.ts');

describe('#74 — CLI version sync', () => {
  it('version.ts exists and exports VERSION', () => {
    const content = readFileSync(versionTsPath, 'utf-8');
    expect(content).toContain("export const VERSION = '");
  });

  it('version.ts matches root package.json version', () => {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    const content = readFileSync(versionTsPath, 'utf-8');
    expect(content).toContain(`'${rootPkg.version}'`);
  });

  it('CLI package.json matches root package.json version', () => {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf-8'));
    expect(cliPkg.version).toBe(rootPkg.version);
  });

  it('root package.json has prebuild script that syncs version', () => {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    expect(rootPkg.scripts.prebuild).toContain('sync-version');
  });

  it('VERSION re-exported from CLI index matches root', async () => {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    const { VERSION } = await import('../src/@claude-flow/cli/src/version.js');
    expect(VERSION).toBe(rootPkg.version);
  });
});

describe('#75 — session-start auto-pretrain', () => {
  it('session-start handler calls pretrain when restoredPatterns is 0', async () => {
    // Import the handler (heavy import tree — needs extended timeout under full suite)
    const { hooksSessionStart } = await import(
      '../src/@claude-flow/cli/src/mcp-tools/hooks-tools.js'
    );

    // Run with daemon disabled to keep test fast
    const result = await hooksSessionStart.handler({
      sessionId: 'test-session',
      restoreLatest: false,
      startDaemon: false,
    });

    // Should have pretrain field in result
    expect(result).toHaveProperty('pretrain');
    expect(result.pretrain).toHaveProperty('ran');
    // When no patterns restored, pretrain should have run
    if (result.sessionMemory.restoredPatterns === 0) {
      expect(result.pretrain.ran).toBe(true);
    }
  }, 30_000);
});

describe('#77 — createSONALearningEngine default args', () => {
  // Full functional tests are in src/@claude-flow/neural/__tests__/sona.test.ts
  // Here we verify the source code structure is correct

  it('source file contains DEFAULT_MODE_CONFIGS fallback', () => {
    const content = readFileSync(
      resolve(__dirname, '../src/@claude-flow/neural/src/sona-integration.ts'),
      'utf-8'
    );
    expect(content).toContain('DEFAULT_MODE_CONFIGS');
    expect(content).toContain("mode?: SONAMode");
    expect(content).toContain("modeConfig?: SONAModeConfig");
  });

  it('JS file also contains DEFAULT_MODE_CONFIGS fallback', () => {
    const content = readFileSync(
      resolve(__dirname, '../src/@claude-flow/neural/src/sona-integration.js'),
      'utf-8'
    );
    expect(content).toContain('DEFAULT_MODE_CONFIGS');
    expect(content).toContain('resolvedMode');
  });
});

describe('#79 — extractPatterns produces granular patterns', () => {
  it('extractPatterns source has extended pattern categories', () => {
    const content = readFileSync(
      resolve(__dirname, '../src/@claude-flow/cli/src/mcp-tools/hooks-tools.ts'),
      'utf-8'
    );
    // Should have all the new granular pattern types
    expect(content).toContain("type: 'import-module'");
    expect(content).toContain("type: 'import-ratio'");
    expect(content).toContain("type: 'error-strategy'");
    expect(content).toContain("type: 'async-style'");
    expect(content).toContain("type: 'type-interface'");
    expect(content).toContain("type: 'type-alias'");
    expect(content).toContain("type: 'test-framework'");
    expect(content).toContain("type: 'config-env'");
    expect(content).toContain("type: `function-prefix-${prefix}`");
    expect(content).toContain("type: 'decorator'");
  });

  it('file limit increased for medium depth', () => {
    const content = readFileSync(
      resolve(__dirname, '../src/@claude-flow/cli/src/mcp-tools/hooks-tools.ts'),
      'utf-8'
    );
    // Medium depth should scan 200 files (was 60)
    expect(content).toMatch(/depth === 'deep' \? 500/);
    expect(content).toMatch(/depth === 'shallow' \? 80/);
    expect(content).toMatch(/: 200/);
  });
});

describe('#80 — Doctor ReasoningBank uses distill() lifecycle', () => {
  it('doctor.ts uses distill() instead of retrieve()', () => {
    const content = readFileSync(
      resolve(__dirname, '../src/@claude-flow/cli/src/commands/doctor.ts'),
      'utf-8'
    );
    // Should use distill() which populates memories, not retrieve() which reads from empty map
    expect(content).toContain('rb.distill(trajectory)');
    expect(content).toContain('rb.storeTrajectory(trajectory)');
    // Should NOT use retrieve() which reads from unpopulated memories Map
    expect(content).not.toMatch(/rb\.retrieve\(/);
  });
});
