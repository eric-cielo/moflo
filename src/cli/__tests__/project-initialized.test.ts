// Shared init-detection predicate (#1363).
//
// `flo status` and `flo start` each tested for `.moflo/config.yaml` alone.
// That file is written by writeRuntimeConfig() only under
// `if (options.components.runtime)`, so a consumer who inits with a component
// subset never gets it — and both commands then hard-failed with
// "MoFlo is not initialized in this directory" on a healthy install.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isProjectInitialized } from '../shared/utils/project-initialized.js';

const REPO_ROOT = resolve(__dirname, '../../..');

function makeTempRoot(): string {
  const root = resolve(
    REPO_ROOT,
    '.testoutput',
    '.test-project-initialized-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  return root;
}

describe('isProjectInitialized (#1363)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows occasionally holds handles — non-fatal */
    }
  });

  // The regression itself: this is the exact shape of a real install that
  // `flo status` and `flo start` were rejecting.
  it('accepts an install with .moflo/ and root moflo.yaml but no config.yaml', () => {
    mkdirSync(join(root, '.moflo'), { recursive: true });
    writeFileSync(join(root, 'moflo.yaml'), 'version: 4\n');

    expect(isProjectInitialized(root)).toBe(true);
  });

  it('accepts .moflo/config.json as a marker', () => {
    mkdirSync(join(root, '.moflo'), { recursive: true });
    writeFileSync(join(root, '.moflo', 'config.json'), '{}');

    expect(isProjectInitialized(root)).toBe(true);
  });

  it('still accepts the legacy .moflo/config.yaml marker', () => {
    mkdirSync(join(root, '.moflo'), { recursive: true });
    writeFileSync(join(root, '.moflo', 'config.yaml'), 'version: "3.0.0"\n');

    expect(isProjectInitialized(root)).toBe(true);
  });

  it('accepts root moflo.config.json as a marker', () => {
    mkdirSync(join(root, '.moflo'), { recursive: true });
    writeFileSync(join(root, 'moflo.config.json'), '{}');

    expect(isProjectInitialized(root)).toBe(true);
  });

  it('rejects a directory with no moflo state at all', () => {
    expect(isProjectInitialized(root)).toBe(false);
  });

  // A partial teardown can leave .moflo/ behind with no config; that is not an
  // initialized project and must not be reported as one.
  it('rejects a bare .moflo/ directory with no config marker', () => {
    mkdirSync(join(root, '.moflo'), { recursive: true });

    expect(isProjectInitialized(root)).toBe(false);
  });

  // Conversely, a stray moflo.yaml with no state directory means init never ran.
  it('rejects a config marker with no .moflo/ directory', () => {
    writeFileSync(join(root, 'moflo.yaml'), 'version: 4\n');

    expect(isProjectInitialized(root)).toBe(false);
  });

  // `.moflo` as a FILE is not a state directory — statSync().isDirectory()
  // must gate this, not a bare existsSync.
  it('rejects a .moflo file masquerading as the state directory', () => {
    writeFileSync(join(root, '.moflo'), 'not a directory');
    writeFileSync(join(root, 'moflo.yaml'), 'version: 4\n');

    expect(isProjectInitialized(root)).toBe(false);
  });

  it('rejects a nonexistent path without throwing', () => {
    expect(isProjectInitialized(join(root, 'does', 'not', 'exist'))).toBe(false);
  });
});
