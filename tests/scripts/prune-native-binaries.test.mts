/**
 * Tests for scripts/prune-native-binaries.mjs — walker + prune logic
 * exercised on temp fixtures; never touches the real node_modules tree.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  findConsumerRoot,
  findOrtPackages,
  isSourceRepo,
  pruneOrtPackage,
  removeDir,
  run,
} from '../../scripts/prune-native-binaries.mjs';

const ALL_PLATFORMS = ['darwin', 'linux', 'win32'] as const;
const ALL_ARCHES = ['arm64', 'x64'] as const;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'moflo-prune-'));
});

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Build an `onnxruntime-node/bin/napi-v3/<plat>/<arch>/` fixture tree. */
function buildOrtTree(
  root: string,
  combos: Array<{ platform: string; arch: string; bytes?: number }>,
): string {
  const ortDir = join(root, 'onnxruntime-node');
  const napi = join(ortDir, 'bin', 'napi-v3');
  mkdirSync(napi, { recursive: true });
  for (const { platform, arch, bytes = 1024 } of combos) {
    const leaf = join(napi, platform, arch);
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, 'onnxruntime_binding.node'), Buffer.alloc(bytes));
  }
  // Non-binary sibling file to confirm we don't touch anything outside napi-v3
  writeFileSync(join(ortDir, 'package.json'), '{"name":"onnxruntime-node"}');
  return ortDir;
}

describe('findOrtPackages', () => {
  it('finds a single top-level onnxruntime-node', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'onnxruntime-node'), { recursive: true });
    const hits = findOrtPackages(nm);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(join(nm, 'onnxruntime-node'));
  });

  it('finds nested onnxruntime-node under another package', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'fastembed', 'node_modules', 'onnxruntime-node'), { recursive: true });
    const hits = findOrtPackages(nm);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(join(nm, 'fastembed', 'node_modules', 'onnxruntime-node'));
  });

  it('finds both hoisted and nested copies in the same tree', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'onnxruntime-node'), { recursive: true });
    mkdirSync(join(nm, 'fastembed', 'node_modules', 'onnxruntime-node'), { recursive: true });
    const hits = findOrtPackages(nm);
    expect(hits).toHaveLength(2);
  });

  it('descends into scoped @org dirs', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, '@scope', 'pkg', 'node_modules', 'onnxruntime-node'), { recursive: true });
    const hits = findOrtPackages(nm);
    expect(hits).toHaveLength(1);
  });

  it('returns empty array when node_modules has no onnxruntime-node', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'lodash'), { recursive: true });
    expect(findOrtPackages(nm)).toEqual([]);
  });

  it('tolerates a non-existent directory', () => {
    expect(findOrtPackages(join(tmp, 'does-not-exist'))).toEqual([]);
  });
});

describe('pruneOrtPackage', () => {
  it('keeps only the current platform+arch, removes all others', () => {
    const combos = ALL_PLATFORMS.flatMap((p) => ALL_ARCHES.map((a) => ({ platform: p, arch: a })));
    const ortDir = buildOrtTree(tmp, combos);

    const bytes = pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64', measure: true });
    expect(bytes).toBeGreaterThan(0);

    const napi = join(ortDir, 'bin', 'napi-v3');
    const survivors = readdirSync(napi);
    expect(survivors).toEqual(['linux']);
    expect(readdirSync(join(napi, 'linux'))).toEqual(['x64']);
  });

  it('skips the directory-size walk when measure is false (default hot path)', () => {
    const combos = ALL_PLATFORMS.flatMap((p) => ALL_ARCHES.map((a) => ({ platform: p, arch: a })));
    const ortDir = buildOrtTree(tmp, combos);

    const bytes = pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64' });
    // Default path returns 0 bytes — size walk is skipped; prune still happens.
    expect(bytes).toBe(0);
    expect(readdirSync(join(ortDir, 'bin', 'napi-v3'))).toEqual(['linux']);
  });

  it('deletes non-current archs under the kept platform', () => {
    const ortDir = buildOrtTree(tmp, [
      { platform: 'linux', arch: 'x64' },
      { platform: 'linux', arch: 'arm64' },
    ]);

    pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64' });

    expect(existsSync(join(ortDir, 'bin', 'napi-v3', 'linux', 'x64'))).toBe(true);
    expect(existsSync(join(ortDir, 'bin', 'napi-v3', 'linux', 'arm64'))).toBe(false);
  });

  it('is a no-op when only the current platform+arch exists', () => {
    const ortDir = buildOrtTree(tmp, [{ platform: 'linux', arch: 'x64' }]);

    const bytes = pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64' });

    expect(bytes).toBe(0);
    expect(existsSync(join(ortDir, 'bin', 'napi-v3', 'linux', 'x64'))).toBe(true);
  });

  it('returns 0 when bin/napi-v3 is missing (future layout change)', () => {
    const ortDir = join(tmp, 'onnxruntime-node');
    mkdirSync(ortDir, { recursive: true });
    expect(pruneOrtPackage(ortDir)).toBe(0);
  });

  it('preserves sibling files outside bin/napi-v3', () => {
    const ortDir = buildOrtTree(tmp, [
      { platform: 'linux', arch: 'x64' },
      { platform: 'win32', arch: 'x64' },
    ]);
    pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64' });
    expect(existsSync(join(ortDir, 'package.json'))).toBe(true);
  });

  it('retries once on EBUSY then swallows persistent failures', () => {
    const ortDir = buildOrtTree(tmp, [
      { platform: 'linux', arch: 'x64' },
      { platform: 'win32', arch: 'x64' },
    ]);

    // Spy that always throws EBUSY-like error — mirrors Windows file lock.
    let calls = 0;
    const rm = () => {
      calls++;
      const err = new Error('resource busy') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    };

    // Should not throw; returns 0 bytes on failure.
    expect(() => pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64', rm })).not.toThrow();
    expect(calls).toBeGreaterThan(0);
    // The original tree is still intact because rm was a no-op spy.
    expect(existsSync(join(ortDir, 'bin', 'napi-v3', 'win32', 'x64'))).toBe(true);
  });
});

describe('removeDir', () => {
  it('returns bytes reclaimed when measure is true', () => {
    const target = join(tmp, 'removeme');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.bin'), Buffer.alloc(2048));
    writeFileSync(join(target, 'b.bin'), Buffer.alloc(1024));

    const bytes = removeDir(target, { measure: true });
    expect(bytes).toBe(3072);
    expect(existsSync(target)).toBe(false);
  });

  it('returns 0 and still removes when measure is false', () => {
    const target = join(tmp, 'removeme');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.bin'), Buffer.alloc(512));

    const bytes = removeDir(target);
    expect(bytes).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('returns 0 and logs when rm throws', () => {
    const dir = join(tmp, 'never-removed');
    mkdirSync(dir);
    const err = new Error('perm') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    const rm = () => { throw err; };
    expect(removeDir(dir, { rm })).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('isSourceRepo', () => {
  it('returns true when the script path has no node_modules segment and nearest package.json is moflo', () => {
    const scriptPath = join(tmp, 'scripts', 'prune-native-binaries.mjs');
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'moflo' }));
    expect(isSourceRepo(scriptPath)).toBe(true);
  });

  it('returns false when path includes node_modules (consumer install)', () => {
    const scriptPath = join(tmp, 'node_modules', 'moflo', 'scripts', 'prune.mjs');
    expect(isSourceRepo(scriptPath)).toBe(false);
  });

  it('returns false when nearest package.json is not named moflo', () => {
    const scriptPath = join(tmp, 'scripts', 'prune.mjs');
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'some-other-project' }));
    expect(isSourceRepo(scriptPath)).toBe(false);
  });
});

describe('findConsumerRoot', () => {
  it('extracts the path before the first node_modules segment', () => {
    const scriptPath = join('C:', 'workspace', 'app', 'node_modules', 'moflo', 'scripts', 'x.mjs');
    expect(findConsumerRoot(scriptPath)).toBe(join('C:', 'workspace', 'app'));
  });

  it('returns null when path has no node_modules segment', () => {
    expect(findConsumerRoot(join(tmp, 'scripts', 'x.mjs'))).toBeNull();
  });

  it('uses the outermost node_modules segment for nested installs', () => {
    // If moflo is installed non-hoisted under another package, the path will
    // contain two `node_modules/` segments. The OUTERMOST one marks the real
    // consumer root — otherwise we'd scan only the intermediate package's
    // node_modules/ and miss hoisted onnxruntime-node at the consumer root.
    const p = join('C:', 'app', 'node_modules', 'some-pkg', 'node_modules', 'moflo', 'scripts', 'x.mjs');
    expect(findConsumerRoot(p)).toBe(join('C:', 'app'));
  });
});

describe('run (end-to-end dry flows)', () => {
  /**
   * Build a consumer-install-shaped fixture and return the fake
   * script path pointing at `<consumerRoot>/node_modules/moflo/scripts/x.mjs`.
   */
  function buildConsumerFixture(): { scriptPath: string; consumerRoot: string; ortDir: string } {
    const consumerRoot = tmp;
    const mofloScripts = join(consumerRoot, 'node_modules', 'moflo', 'scripts');
    mkdirSync(mofloScripts, { recursive: true });
    const scriptPath = join(mofloScripts, 'prune-native-binaries.mjs');
    writeFileSync(scriptPath, '// placeholder\n');
    const ortDir = buildOrtTree(
      join(consumerRoot, 'node_modules', 'fastembed', 'node_modules'),
      ALL_PLATFORMS.flatMap((p) => ALL_ARCHES.map((a) => ({ platform: p, arch: a }))),
    );
    return { scriptPath, consumerRoot, ortDir };
  }

  it('prunes every non-current combo in a simulated consumer install', () => {
    const { scriptPath, ortDir } = buildConsumerFixture();

    // verbose: true so bytesReclaimed is measured (default hot path skips the
    // walk for speed — exercised separately).
    const result = run({ scriptPath, env: {}, verbose: true });

    expect(result.reason).toBe('pruned');
    expect(result.packagesPruned).toBe(1);
    expect(result.bytesReclaimed).toBeGreaterThan(0);

    const survivors = readdirSync(join(ortDir, 'bin', 'napi-v3'));
    expect(survivors).toEqual([process.platform]);
    expect(readdirSync(join(ortDir, 'bin', 'napi-v3', process.platform))).toEqual([process.arch]);
  });

  it('skips when MOFLO_NO_PRUNE=1 — preserves the full tree', () => {
    const { scriptPath, ortDir } = buildConsumerFixture();

    const result = run({ scriptPath, env: { MOFLO_NO_PRUNE: '1' } });

    expect(result.reason).toBe('opt-out');
    expect(result.bytesReclaimed).toBe(0);
    // Full tree intact
    const survivors = readdirSync(join(ortDir, 'bin', 'napi-v3')).sort();
    expect(survivors).toEqual(['darwin', 'linux', 'win32']);
  });

  it('skips source-repo installs', () => {
    const scriptPath = join(tmp, 'scripts', 'prune-native-binaries.mjs');
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'moflo' }));

    const result = run({ scriptPath, env: {} });
    expect(result.reason).toBe('source-repo');
  });

  it('skips gracefully when node_modules is missing (Yarn PnP)', () => {
    // `run()` doesn't require the script file to exist on disk — it only reads
    // the path string. Under PnP, the consumer root has no `node_modules/`
    // directory even though npm-style postinstall may still fire. Pass a
    // purely synthetic script path and assert the skip branch.
    const syntheticConsumerRoot = join(tmp, 'pnp-consumer');
    mkdirSync(syntheticConsumerRoot, { recursive: true });
    const scriptPath = join(syntheticConsumerRoot, 'node_modules', 'moflo', 'scripts', 'x.mjs');
    // Deliberately do NOT create node_modules on disk.

    const result = run({ scriptPath, env: {} });
    expect(result.reason).toBe('no-node-modules');
  });

  it('is a no-op when no onnxruntime-node is present', () => {
    const consumerRoot = tmp;
    const scriptPath = join(consumerRoot, 'node_modules', 'moflo', 'scripts', 'x.mjs');
    mkdirSync(join(consumerRoot, 'node_modules', 'moflo', 'scripts'), { recursive: true });
    writeFileSync(scriptPath, '');
    mkdirSync(join(consumerRoot, 'node_modules', 'lodash'), { recursive: true });

    const result = run({ scriptPath, env: {} });
    expect(result.reason).toBe('no-ort');
    expect(result.bytesReclaimed).toBe(0);
  });
});
