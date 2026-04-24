/**
 * Tests for scripts/prune-native-binaries.mjs — walker + prune logic
 * exercised on temp fixtures; never touches the real node_modules tree.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  collectOtherOrtDeclarers,
  findConsumerRoot,
  findOrtPackages,
  isSourceRepo,
  plantCudaStub,
  pruneGpuProviders,
  pruneOrtPackage,
  removeDir,
  resolveOrtForOwner,
  run,
} from '../../scripts/prune-native-binaries.mjs';

/** Minimal `package.json` for a fastembed install in a test fixture. */
function writeFastembedPkg(fastembedDir: string): void {
  writeFileSync(
    join(fastembedDir, 'package.json'),
    JSON.stringify({ name: 'fastembed', dependencies: { 'onnxruntime-node': '^1.0.0' } }),
  );
}

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

describe('findOrtPackages (fastembed-owned only)', () => {
  it('returns empty when node_modules has no onnxruntime-node and no fastembed', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'lodash'), { recursive: true });
    expect(findOrtPackages(nm)).toEqual([]);
  });

  it('tolerates a non-existent directory', () => {
    expect(findOrtPackages(join(tmp, 'does-not-exist'))).toEqual([]);
  });

  it('returns empty when onnxruntime-node exists but no fastembed is installed', () => {
    // A bare top-level ORT with no fastembed owner belongs to some other
    // consumer — we must not touch it.
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'onnxruntime-node'), { recursive: true });
    expect(findOrtPackages(nm)).toEqual([]);
  });

  it('returns the nested ORT when fastembed carries its own private copy', () => {
    const nm = join(tmp, 'node_modules');
    const fastembed = join(nm, 'fastembed');
    mkdirSync(join(fastembed, 'node_modules', 'onnxruntime-node'), { recursive: true });
    writeFastembedPkg(fastembed);
    expect(findOrtPackages(nm)).toEqual([join(fastembed, 'node_modules', 'onnxruntime-node')]);
  });

  it('returns the hoisted ORT when fastembed is the sole ORT declarer', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'fastembed'), { recursive: true });
    writeFastembedPkg(join(nm, 'fastembed'));
    mkdirSync(join(nm, 'onnxruntime-node'), { recursive: true });
    expect(findOrtPackages(nm)).toEqual([join(nm, 'onnxruntime-node')]);
  });

  it('leaves the hoisted ORT alone when a sibling package also declares it', () => {
    // Regression guard for EPIC #527 architect review (#552): a hoisted ORT
    // shared with an Electron cross-compile packager must keep its full
    // platform binary set.
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'fastembed'), { recursive: true });
    writeFastembedPkg(join(nm, 'fastembed'));
    mkdirSync(join(nm, 'onnxruntime-node'), { recursive: true });

    mkdirSync(join(nm, 'electron-packager'), { recursive: true });
    writeFileSync(
      join(nm, 'electron-packager', 'package.json'),
      JSON.stringify({
        name: 'electron-packager',
        dependencies: { 'onnxruntime-node': '^1.0.0' },
      }),
    );

    expect(findOrtPackages(nm)).toEqual([]);
  });

  it('still prunes nested ORT even when a sibling declarer blocks the hoisted copy', () => {
    const nm = join(tmp, 'node_modules');
    const fastembed = join(nm, 'fastembed');
    mkdirSync(join(fastembed, 'node_modules', 'onnxruntime-node'), { recursive: true });
    writeFastembedPkg(fastembed);
    // Foreign hoisted copy — owned by electron-packager, must be preserved.
    mkdirSync(join(nm, 'onnxruntime-node'), { recursive: true });
    mkdirSync(join(nm, 'electron-packager'), { recursive: true });
    writeFileSync(
      join(nm, 'electron-packager', 'package.json'),
      JSON.stringify({
        name: 'electron-packager',
        optionalDependencies: { 'onnxruntime-node': '^1.0.0' },
      }),
    );

    expect(findOrtPackages(nm)).toEqual([join(fastembed, 'node_modules', 'onnxruntime-node')]);
  });

  it('ignores a sibling onnxruntime-node nested under a non-fastembed parent', () => {
    // Acceptance test (#552): foreign nested ORT must be untouched.
    const nm = join(tmp, 'node_modules');
    const fastembed = join(nm, 'fastembed');
    mkdirSync(join(fastembed, 'node_modules', 'onnxruntime-node'), { recursive: true });
    writeFastembedPkg(fastembed);

    // Another package with its own nested ORT — completely unrelated to ours.
    mkdirSync(join(nm, 'electron-packager', 'node_modules', 'onnxruntime-node'), { recursive: true });
    writeFileSync(
      join(nm, 'electron-packager', 'package.json'),
      JSON.stringify({ name: 'electron-packager' }),
    );

    expect(findOrtPackages(nm)).toEqual([join(fastembed, 'node_modules', 'onnxruntime-node')]);
  });

  it('descends into scoped @org dirs to find nested fastembed owners', () => {
    const nm = join(tmp, 'node_modules');
    const fastembed = join(nm, '@scope', 'pkg', 'node_modules', 'fastembed');
    mkdirSync(join(fastembed, 'node_modules', 'onnxruntime-node'), { recursive: true });
    writeFastembedPkg(fastembed);
    expect(findOrtPackages(nm)).toEqual([join(fastembed, 'node_modules', 'onnxruntime-node')]);
  });

  it('dedupes when multiple non-hoisted fastembed installs resolve to the same ORT', () => {
    // No `<nm>/fastembed` — forces the walker path. Two nested fastembed
    // installs both resolve upward to the single hoisted ORT.
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'foo', 'node_modules', 'fastembed'), { recursive: true });
    writeFastembedPkg(join(nm, 'foo', 'node_modules', 'fastembed'));
    mkdirSync(join(nm, 'bar', 'node_modules', 'fastembed'), { recursive: true });
    writeFastembedPkg(join(nm, 'bar', 'node_modules', 'fastembed'));
    mkdirSync(join(nm, 'onnxruntime-node'), { recursive: true });
    expect(findOrtPackages(nm)).toEqual([join(nm, 'onnxruntime-node')]);
  });
});

describe('resolveOrtForOwner', () => {
  it('returns the nested ORT when present in the owner dir', () => {
    const owner = join(tmp, 'node_modules', 'fastembed');
    const ort = join(owner, 'node_modules', 'onnxruntime-node');
    mkdirSync(ort, { recursive: true });
    expect(resolveOrtForOwner(owner)).toBe(ort);
  });

  it('walks up through a parent node_modules to find the hoisted ORT', () => {
    const owner = join(tmp, 'node_modules', 'fastembed');
    mkdirSync(owner, { recursive: true });
    const hoisted = join(tmp, 'node_modules', 'onnxruntime-node');
    mkdirSync(hoisted, { recursive: true });
    expect(resolveOrtForOwner(owner)).toBe(hoisted);
  });

  it('prefers the nested copy over a hoisted one when both exist', () => {
    const owner = join(tmp, 'node_modules', 'fastembed');
    const nested = join(owner, 'node_modules', 'onnxruntime-node');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(tmp, 'node_modules', 'onnxruntime-node'), { recursive: true });
    expect(resolveOrtForOwner(owner)).toBe(nested);
  });

  it('returns null when no ancestor carries ORT', () => {
    const owner = join(tmp, 'node_modules', 'fastembed');
    mkdirSync(owner, { recursive: true });
    expect(resolveOrtForOwner(owner)).toBeNull();
  });

  it('skips the pathological node_modules/node_modules probe', () => {
    // Plant `<tmp>/node_modules/node_modules/onnxruntime-node` — which Node's
    // resolver would never look at — and assert it's not returned.
    const owner = join(tmp, 'node_modules', 'fastembed');
    mkdirSync(owner, { recursive: true });
    mkdirSync(join(tmp, 'node_modules', 'node_modules', 'onnxruntime-node'), { recursive: true });
    expect(resolveOrtForOwner(owner)).toBeNull();
  });
});

describe('collectOtherOrtDeclarers', () => {
  it('returns empty when no packages declare ORT', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'lodash'), { recursive: true });
    writeFileSync(join(nm, 'lodash', 'package.json'), JSON.stringify({ name: 'lodash' }));
    expect([...collectOtherOrtDeclarers(nm)]).toEqual([]);
  });

  it('excludes fastembed itself from the declarer set', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'fastembed'), { recursive: true });
    writeFastembedPkg(join(nm, 'fastembed'));
    expect([...collectOtherOrtDeclarers(nm)]).toEqual([]);
  });

  it('detects ORT in dependencies / optionalDependencies / peerDependencies', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'a'), { recursive: true });
    writeFileSync(join(nm, 'a', 'package.json'), JSON.stringify({ name: 'a', dependencies: { 'onnxruntime-node': '^1' } }));
    mkdirSync(join(nm, 'b'), { recursive: true });
    writeFileSync(join(nm, 'b', 'package.json'), JSON.stringify({ name: 'b', optionalDependencies: { 'onnxruntime-node': '^1' } }));
    mkdirSync(join(nm, 'c'), { recursive: true });
    writeFileSync(join(nm, 'c', 'package.json'), JSON.stringify({ name: 'c', peerDependencies: { 'onnxruntime-node': '^1' } }));
    mkdirSync(join(nm, 'd'), { recursive: true });
    writeFileSync(join(nm, 'd', 'package.json'), JSON.stringify({ name: 'd' }));
    expect([...collectOtherOrtDeclarers(nm)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('scans scoped packages under @org/', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, '@scope', 'ort-user'), { recursive: true });
    writeFileSync(
      join(nm, '@scope', 'ort-user', 'package.json'),
      JSON.stringify({ name: '@scope/ort-user', dependencies: { 'onnxruntime-node': '^1' } }),
    );
    expect([...collectOtherOrtDeclarers(nm)]).toEqual(['@scope/ort-user']);
  });

  it('tolerates missing or malformed package.json files', () => {
    const nm = join(tmp, 'node_modules');
    mkdirSync(join(nm, 'missing-pkg-json'), { recursive: true });
    mkdirSync(join(nm, 'broken-pkg-json'), { recursive: true });
    writeFileSync(join(nm, 'broken-pkg-json', 'package.json'), '{not valid json');
    expect([...collectOtherOrtDeclarers(nm)]).toEqual([]);
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

  it('strips GPU provider libraries and plants a CUDA stub on linux/x64', () => {
    // Regression guard for the 327 MB CUDA provider (ORT 1.21 linux/x64) that
    // fastembed never loads. We prune any bundled providers, then plant a
    // zero-byte stub so the upstream ORT postinstall (running AFTER us) sees
    // the file and skips its download.
    const ortDir = buildOrtTree(tmp, [{ platform: 'linux', arch: 'x64' }]);
    const archDir = join(ortDir, 'bin', 'napi-v3', 'linux', 'x64');
    writeFileSync(join(archDir, 'libonnxruntime.so.1'), Buffer.alloc(1024));
    writeFileSync(join(archDir, 'libonnxruntime_providers_tensorrt.so'), Buffer.alloc(2048));
    writeFileSync(join(archDir, 'libonnxruntime_providers_shared.so'), Buffer.alloc(512));

    pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64' });

    expect(existsSync(join(archDir, 'libonnxruntime.so.1'))).toBe(true);
    expect(existsSync(join(archDir, 'onnxruntime_binding.node'))).toBe(true);
    expect(existsSync(join(archDir, 'libonnxruntime_providers_tensorrt.so'))).toBe(false);
    expect(existsSync(join(archDir, 'libonnxruntime_providers_shared.so'))).toBe(false);
    // CUDA stub planted: zero-byte sentinel blocks the upstream fetch.
    const stub = join(archDir, 'libonnxruntime_providers_cuda.so');
    expect(existsSync(stub)).toBe(true);
    expect(statSync(stub).size).toBe(0);
  });

  it('does not plant a CUDA stub on non-linux platforms', () => {
    const ortDir = buildOrtTree(tmp, [{ platform: 'darwin', arch: 'arm64' }]);
    const archDir = join(ortDir, 'bin', 'napi-v3', 'darwin', 'arm64');

    pruneOrtPackage(ortDir, { keepPlatform: 'darwin', keepArch: 'arm64' });

    expect(existsSync(join(archDir, 'libonnxruntime_providers_cuda.so'))).toBe(false);
  });
});

describe('pruneGpuProviders', () => {
  function populate(dir: string, names: string[], bytes = 1024) {
    mkdirSync(dir, { recursive: true });
    for (const n of names) writeFileSync(join(dir, n), Buffer.alloc(bytes));
  }

  it('removes CUDA / TensorRT / shared providers on Linux (.so)', () => {
    const archDir = join(tmp, 'linux-x64');
    populate(archDir, [
      'libonnxruntime.so.1',
      'libonnxruntime.so.1.21.0',
      'onnxruntime_binding.node',
      'libonnxruntime_providers_cuda.so',
      'libonnxruntime_providers_tensorrt.so',
      'libonnxruntime_providers_shared.so',
    ]);

    const bytes = pruneGpuProviders(archDir, { measure: true });
    expect(bytes).toBe(3072);

    const survivors = readdirSync(archDir).sort();
    expect(survivors).toEqual([
      'libonnxruntime.so.1',
      'libonnxruntime.so.1.21.0',
      'onnxruntime_binding.node',
    ]);
  });

  it('removes DirectML.dll on Windows (case-insensitive)', () => {
    const archDir = join(tmp, 'win32-x64');
    populate(archDir, ['DirectML.dll', 'onnxruntime.dll', 'onnxruntime_binding.node']);

    pruneGpuProviders(archDir);

    expect(existsSync(join(archDir, 'DirectML.dll'))).toBe(false);
    expect(existsSync(join(archDir, 'onnxruntime.dll'))).toBe(true);
    expect(existsSync(join(archDir, 'onnxruntime_binding.node'))).toBe(true);
  });

  it('matches Windows onnxruntime_providers_*.dll naming', () => {
    const archDir = join(tmp, 'win32-x64');
    populate(archDir, [
      'onnxruntime.dll',
      'onnxruntime_providers_cuda.dll',
      'onnxruntime_providers_shared.dll',
    ]);

    pruneGpuProviders(archDir);

    expect(existsSync(join(archDir, 'onnxruntime.dll'))).toBe(true);
    expect(existsSync(join(archDir, 'onnxruntime_providers_cuda.dll'))).toBe(false);
    expect(existsSync(join(archDir, 'onnxruntime_providers_shared.dll'))).toBe(false);
  });

  it('preserves the CPU core and Node binding on every platform', () => {
    const archDir = join(tmp, 'any');
    populate(archDir, [
      'libonnxruntime.so.1',             // linux cpu core
      'libonnxruntime.so.1.21.0',        // linux cpu core (versioned)
      'libonnxruntime.1.21.0.dylib',     // darwin cpu core
      'onnxruntime.dll',                 // windows cpu core
      'onnxruntime_binding.node',        // node binding
    ]);

    pruneGpuProviders(archDir);
    expect(readdirSync(archDir).sort()).toEqual([
      'libonnxruntime.1.21.0.dylib',
      'libonnxruntime.so.1',
      'libonnxruntime.so.1.21.0',
      'onnxruntime.dll',
      'onnxruntime_binding.node',
    ]);
  });

  it('is a no-op when the arch dir has no GPU providers', () => {
    const archDir = join(tmp, 'darwin-arm64');
    populate(archDir, ['libonnxruntime.1.21.0.dylib', 'onnxruntime_binding.node']);

    expect(pruneGpuProviders(archDir, { measure: true })).toBe(0);
    expect(readdirSync(archDir)).toHaveLength(2);
  });

  it('returns 0 when the arch dir does not exist', () => {
    expect(pruneGpuProviders(join(tmp, 'missing'))).toBe(0);
  });

  it('tolerates rm failure, leaves the file in place, and moves on', () => {
    const archDir = join(tmp, 'linux-x64');
    populate(archDir, ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so']);

    // Spy that errors on CUDA, succeeds on tensorrt.
    const removed: string[] = [];
    const rm = (path: string) => {
      if (path.endsWith('libonnxruntime_providers_cuda.so')) {
        const err = new Error('busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      removed.push(path);
    };

    expect(() => pruneGpuProviders(archDir, { rm })).not.toThrow();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/libonnxruntime_providers_tensorrt\.so$/);
  });
});

describe('plantCudaStub', () => {
  const linuxX64 = { keepPlatform: 'linux', keepArch: 'x64', env: {} };

  it('creates a zero-byte stub on linux/x64', () => {
    const archDir = join(tmp, 'linux-x64');
    mkdirSync(archDir, { recursive: true });

    expect(plantCudaStub(archDir, linuxX64)).toBe(true);

    const stub = join(archDir, 'libonnxruntime_providers_cuda.so');
    expect(existsSync(stub)).toBe(true);
    expect(statSync(stub).size).toBe(0);
    expect(readdirSync(archDir)).toEqual(['libonnxruntime_providers_cuda.so']);
  });

  it('no-ops on non-linux platforms', () => {
    const archDir = join(tmp, 'darwin-arm64');
    mkdirSync(archDir, { recursive: true });

    expect(plantCudaStub(archDir, { keepPlatform: 'darwin', keepArch: 'arm64', env: {} })).toBe(false);
    expect(plantCudaStub(archDir, { keepPlatform: 'win32', keepArch: 'x64', env: {} })).toBe(false);
    expect(existsSync(join(archDir, 'libonnxruntime_providers_cuda.so'))).toBe(false);
  });

  it('no-ops on linux/arm64 (upstream does not fetch CUDA there)', () => {
    const archDir = join(tmp, 'linux-arm64');
    mkdirSync(archDir, { recursive: true });

    expect(plantCudaStub(archDir, { keepPlatform: 'linux', keepArch: 'arm64', env: {} })).toBe(false);
    expect(existsSync(join(archDir, 'libonnxruntime_providers_cuda.so'))).toBe(false);
  });

  it('no-ops when ONNXRUNTIME_NODE_INSTALL_CUDA=true (user opt-in to CUDA)', () => {
    const archDir = join(tmp, 'linux-x64');
    mkdirSync(archDir, { recursive: true });

    const env = { ONNXRUNTIME_NODE_INSTALL_CUDA: 'true' };
    expect(plantCudaStub(archDir, { keepPlatform: 'linux', keepArch: 'x64', env })).toBe(false);
    expect(existsSync(join(archDir, 'libonnxruntime_providers_cuda.so'))).toBe(false);
  });

  it('no-ops when a real CUDA binary already exists (do not clobber)', () => {
    const archDir = join(tmp, 'linux-x64');
    mkdirSync(archDir, { recursive: true });
    writeFileSync(join(archDir, 'libonnxruntime_providers_cuda.so'), Buffer.alloc(4096));

    expect(plantCudaStub(archDir, linuxX64)).toBe(false);
    expect(statSync(join(archDir, 'libonnxruntime_providers_cuda.so')).size).toBe(4096);
  });

  it('pruneOrtPackage on linux/x64 prunes GPU then plants the stub', () => {
    const ortDir = buildOrtTree(tmp, [{ platform: 'linux', arch: 'x64' }]);
    const archDir = join(ortDir, 'bin', 'napi-v3', 'linux', 'x64');
    writeFileSync(join(archDir, 'libonnxruntime.so.1'), Buffer.alloc(1024));
    writeFileSync(join(archDir, 'libonnxruntime_providers_shared.so'), Buffer.alloc(512));

    pruneOrtPackage(ortDir, { keepPlatform: 'linux', keepArch: 'x64' });

    expect(existsSync(join(archDir, 'libonnxruntime.so.1'))).toBe(true);
    expect(existsSync(join(archDir, 'libonnxruntime_providers_shared.so'))).toBe(false);
    // Stub planted last — blocks upstream ORT postinstall CUDA fetch.
    const stub = join(archDir, 'libonnxruntime_providers_cuda.so');
    expect(existsSync(stub)).toBe(true);
    expect(statSync(stub).size).toBe(0);
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
