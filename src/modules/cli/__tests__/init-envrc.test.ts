/**
 * Tests for .envrc PATH setup step in flo init
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeEnvrc, ENVRC_PATH_LINE } from '../src/init/envrc-generator.js';
import type { InitResult } from '../src/init/types.js';

function makeResult(): InitResult {
  return {
    success: true,
    platform: {
      os: 'linux',
      arch: 'x64',
      nodeVersion: process.version,
      shell: 'bash',
      homeDir: os.homedir(),
      configDir: '',
    },
    created: {
      directories: [],
      files: [],
    },
    skipped: [],
    errors: [],
    summary: {
      skillsCount: 0,
      commandsCount: 0,
      agentsCount: 0,
      hooksEnabled: 0,
    },
  };
}

describe('writeEnvrc', () => {
  let tmpDir: string;
  let result: InitResult;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-init-envrc-'));
    result = makeResult();
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .envrc when it does not exist', async () => {
    await writeEnvrc(tmpDir, result);

    const envrcPath = path.join(tmpDir, '.envrc');
    expect(fs.existsSync(envrcPath)).toBe(true);

    const content = fs.readFileSync(envrcPath, 'utf-8');
    expect(content).toBe(ENVRC_PATH_LINE + '\n');
    expect(result.created.files).toContain('.envrc');
    expect(result.skipped).not.toContain('.envrc');
  });

  it('appends PATH line to existing .envrc without the line', async () => {
    const envrcPath = path.join(tmpDir, '.envrc');
    const existingContent = 'export FOO=bar\n';
    fs.writeFileSync(envrcPath, existingContent, 'utf-8');

    await writeEnvrc(tmpDir, result);

    const content = fs.readFileSync(envrcPath, 'utf-8');
    expect(content).toBe(existingContent + ENVRC_PATH_LINE + '\n');
    expect(result.created.files).toContain('.envrc (appended PATH)');
    expect(result.skipped).not.toContain('.envrc');
  });

  it('appends newline separator when existing file lacks trailing newline', async () => {
    const envrcPath = path.join(tmpDir, '.envrc');
    const existingContent = 'export FOO=bar'; // no trailing newline
    fs.writeFileSync(envrcPath, existingContent, 'utf-8');

    await writeEnvrc(tmpDir, result);

    const content = fs.readFileSync(envrcPath, 'utf-8');
    expect(content).toBe(existingContent + '\n' + ENVRC_PATH_LINE + '\n');
  });

  it('skips when PATH line is already present', async () => {
    const envrcPath = path.join(tmpDir, '.envrc');
    const existingContent = ENVRC_PATH_LINE + '\n';
    fs.writeFileSync(envrcPath, existingContent, 'utf-8');

    await writeEnvrc(tmpDir, result);

    // File should be unchanged
    const content = fs.readFileSync(envrcPath, 'utf-8');
    expect(content).toBe(existingContent);
    expect(result.skipped).toContain('.envrc');
    expect(result.created.files).toHaveLength(0);
  });

  it('skips when PATH line is present among other lines', async () => {
    const envrcPath = path.join(tmpDir, '.envrc');
    const existingContent = `export FOO=bar\n${ENVRC_PATH_LINE}\nexport BAZ=qux\n`;
    fs.writeFileSync(envrcPath, existingContent, 'utf-8');

    await writeEnvrc(tmpDir, result);

    const content = fs.readFileSync(envrcPath, 'utf-8');
    expect(content).toBe(existingContent);
    expect(result.skipped).toContain('.envrc');
  });

  it('handles Windows-style line endings when checking for existing line', async () => {
    const envrcPath = path.join(tmpDir, '.envrc');
    const existingContent = `export FOO=bar\r\n${ENVRC_PATH_LINE}\r\n`;
    fs.writeFileSync(envrcPath, existingContent, 'utf-8');

    await writeEnvrc(tmpDir, result);

    // Should detect the existing line even with \r\n
    expect(result.skipped).toContain('.envrc');
    expect(result.created.files).toHaveLength(0);
  });

  it('prints guidance messages to console', async () => {
    const logSpy = vi.spyOn(console, 'log');

    await writeEnvrc(tmpDir, result);

    const messages = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(messages).toContain('direnv allow');
    expect(messages).toContain('source .envrc');
  });

  it('is idempotent — second call is a no-op', async () => {
    await writeEnvrc(tmpDir, result);

    const result2 = makeResult();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await writeEnvrc(tmpDir, result2);

    expect(result2.skipped).toContain('.envrc');
    expect(result2.created.files).toHaveLength(0);

    // File content should have only one PATH line
    const content = fs.readFileSync(path.join(tmpDir, '.envrc'), 'utf-8');
    const matches = content.split(/\r?\n/).filter((l) => l.trim() === ENVRC_PATH_LINE);
    expect(matches).toHaveLength(1);
  });
});

describe('ENVRC_PATH_LINE', () => {
  it('exports the expected PATH line', () => {
    expect(ENVRC_PATH_LINE).toBe('export PATH="./node_modules/.bin:$PATH"');
  });
});
