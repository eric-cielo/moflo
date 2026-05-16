/**
 * Tests for the `.swarm/` residue auto-fix (Swarm Residue check).
 *
 * Validates that the migrator:
 *  - deletes `.swarm/memory.db` + `.bak` once `.moflo/moflo.db` exists
 *  - skips DB deletion when canonical is absent (surface advice, not destroy)
 *  - renames router state JSONs into `.moflo/movector/`, preserving content
 *  - keeps canonical state files when both exist (drops the legacy copy)
 *  - relocates `hooks.log` + `background.log` into `.moflo/logs/`, appending
 *    onto any pre-existing canonical log so history isn't lost
 *  - rmdirs `.swarm/` when empty
 *  - leaves `.swarm/` in place with unrecognised siblings, returning false
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoFixCheck } from '../../commands/doctor-fixes.js';

let originalCwd: string;
let originalClaudeProjectDir: string | undefined;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-swarm-residue-'));
  process.chdir(tmpDir);
  // `findProjectRoot()` honors CLAUDE_PROJECT_DIR. Pin it at the temp dir so
  // the migrator can't escape to the real moflo repo when tests run under it.
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalClaudeProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const residueCheck = {
  name: 'Swarm Residue',
  status: 'warn' as const,
  message: 'legacy artifacts in .swarm/',
  fix: 'flo healer --fix -c swarm-residue',
};

function seedSwarm(files: Record<string, string>) {
  const swarmDir = join(tmpDir, '.swarm');
  mkdirSync(swarmDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(swarmDir, name), contents, 'utf-8');
  }
}

describe('Swarm Residue auto-fix — fixSwarmLegacyResidue', () => {
  it('returns true and is a no-op when .swarm/ is absent', async () => {
    const result = await autoFixCheck(residueCheck);
    expect(result).toBe(true);
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
  });

  it('deletes .swarm/memory.db + .bak once .moflo/moflo.db exists', async () => {
    writeFileSync(join(tmpDir, '.moflo', 'moflo.db'), 'canonical', 'utf-8');
    seedSwarm({
      'memory.db': 'legacy',
      'memory.db.bak': 'legacy-backup',
    });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(true);
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
    expect(readFileSync(join(tmpDir, '.moflo', 'moflo.db'), 'utf-8')).toBe('canonical');
  });

  it('refuses to delete memory.db when canonical is absent (returns false)', async () => {
    seedSwarm({ 'memory.db': 'legacy' });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(false);
    expect(existsSync(join(tmpDir, '.swarm', 'memory.db'))).toBe(true);
  });

  it('relocates router state JSONs into .moflo/movector/ with content preserved', async () => {
    seedSwarm({
      'q-learning-model.json': '{"q":1}',
      'model-router-state.json': '{"state":"router"}',
    });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(true);
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
    expect(readFileSync(join(tmpDir, '.moflo', 'movector', 'q-learning-model.json'), 'utf-8')).toBe('{"q":1}');
    expect(readFileSync(join(tmpDir, '.moflo', 'movector', 'model-router-state.json'), 'utf-8')).toBe('{"state":"router"}');
  });

  it('keeps the canonical state file when both locations have content', async () => {
    mkdirSync(join(tmpDir, '.moflo', 'movector'), { recursive: true });
    writeFileSync(join(tmpDir, '.moflo', 'movector', 'q-learning-model.json'), '{"canonical":true}', 'utf-8');
    seedSwarm({ 'q-learning-model.json': '{"legacy":true}' });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(true);
    expect(readFileSync(join(tmpDir, '.moflo', 'movector', 'q-learning-model.json'), 'utf-8')).toBe('{"canonical":true}');
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
  });

  it('relocates logs into .moflo/logs/, appending onto an existing canonical', async () => {
    mkdirSync(join(tmpDir, '.moflo', 'logs'), { recursive: true });
    writeFileSync(join(tmpDir, '.moflo', 'logs', 'hooks.log'), 'canonical-line\n', 'utf-8');
    seedSwarm({
      'hooks.log': 'legacy-line\n',
      'background.log': 'bg-legacy\n',
    });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(true);
    expect(readFileSync(join(tmpDir, '.moflo', 'logs', 'hooks.log'), 'utf-8')).toBe('canonical-line\nlegacy-line\n');
    expect(readFileSync(join(tmpDir, '.moflo', 'logs', 'background.log'), 'utf-8')).toBe('bg-legacy\n');
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
  });

  it('leaves .swarm/ in place when an unrecognised file survives, returns false', async () => {
    writeFileSync(join(tmpDir, '.moflo', 'moflo.db'), 'canonical', 'utf-8');
    seedSwarm({
      'memory.db': 'legacy',
      'mystery-artifact.dat': 'unknown',
    });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(false);
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(true);
    expect(existsSync(join(tmpDir, '.swarm', 'mystery-artifact.dat'))).toBe(true);
    expect(existsSync(join(tmpDir, '.swarm', 'memory.db'))).toBe(false);
  });

  // #1168: writer relocations require the residue migrator to recognise the
  // new artifact set so legacy `.swarm/` directories left by pre-#1168 saves
  // get fully retired in one healer pass.
  it('relocates #1168 neural runtime state into .moflo/{movector,neural,swarm,memory}/', async () => {
    seedSwarm({
      'lora-weights.json': '{"lora":true}',
      'moe-weights.json': '{"moe":true}',
      'ewc-fisher.json': '{"ewc":true}',
      'sona-patterns.json': '{"sona":true}',
      'state.json': '{"swarm-state":true}',
      'code-map-hash.txt': 'abc123',
    });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(true);
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
    expect(readFileSync(join(tmpDir, '.moflo', 'movector', 'lora-weights.json'), 'utf-8')).toBe('{"lora":true}');
    expect(readFileSync(join(tmpDir, '.moflo', 'movector', 'moe-weights.json'), 'utf-8')).toBe('{"moe":true}');
    expect(readFileSync(join(tmpDir, '.moflo', 'neural', 'ewc-fisher.json'), 'utf-8')).toBe('{"ewc":true}');
    expect(readFileSync(join(tmpDir, '.moflo', 'neural', 'sona-patterns.json'), 'utf-8')).toBe('{"sona":true}');
    expect(readFileSync(join(tmpDir, '.moflo', 'swarm', 'state.json'), 'utf-8')).toBe('{"swarm-state":true}');
    expect(readFileSync(join(tmpDir, '.moflo', 'memory', 'code-map-hash.txt'), 'utf-8')).toBe('abc123');
  });

  it('keeps the canonical lora-weights.json when both locations have content', async () => {
    mkdirSync(join(tmpDir, '.moflo', 'movector'), { recursive: true });
    writeFileSync(join(tmpDir, '.moflo', 'movector', 'lora-weights.json'), '{"canonical":true}', 'utf-8');
    seedSwarm({ 'lora-weights.json': '{"legacy":true}' });

    const result = await autoFixCheck(residueCheck);

    expect(result).toBe(true);
    expect(readFileSync(join(tmpDir, '.moflo', 'movector', 'lora-weights.json'), 'utf-8')).toBe('{"canonical":true}');
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
  });
});
