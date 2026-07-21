/**
 * Tests for `checkMcpToolPermissions` and its companion `MCP Tool Permissions`
 * auto-fixer (#1300).
 *
 * Failure mode being guarded against: the settings-generator emitted
 * `mcp__moflo__:*` into `.claude/settings.json` `permissions.allow`. Claude Code
 * does NOT support wildcards in MCP permission rules, so that string matched no
 * real tool name and every `mcp__moflo__…` call fell through to a permission
 * prompt in every consumer install. The generator is fixed going forward; this
 * check + fix heals already-generated settings.json files in place.
 *
 * ## Test isolation
 *
 * The check + fix resolve `.claude/settings.json` under `process.cwd()` /
 * `findProjectRoot()`. We anchor both on a tmp dir via `CLAUDE_PROJECT_DIR`
 * (honored ahead of any FS walk) plus `process.chdir`, and restore afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkMcpToolPermissions } from '../../commands/doctor-checks-config.js';
import { autoFixCheck } from '../../commands/doctor-fixes.js';

let tmpDir: string;
let originalCwd: string;
let savedProjectDir: string | undefined;

function writeSettings(allow: string[]): string {
  const claudeDir = join(tmpDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow, deny: [] } }, null, 2));
  return settingsPath;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-mcp-perms-'));
  originalCwd = process.cwd();
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('checkMcpToolPermissions', () => {
  it('passes when there is no .claude/settings.json', async () => {
    const result = await checkMcpToolPermissions(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('nothing to verify');
  });

  it('warns on the malformed mcp__moflo__:* wildcard rule', async () => {
    writeSettings(['Bash(*)', 'mcp__moflo__:*']);
    const result = await checkMcpToolPermissions(tmpDir);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('mcp__moflo__:*');
    expect(result.fix).toBe('flo healer --fix -c mcp-permissions');
  });

  it('warns on a mcp__moflo__* asterisk pattern too', async () => {
    writeSettings(['mcp__moflo__*']);
    const result = await checkMcpToolPermissions(tmpDir);
    expect(result.status).toBe('warn');
  });

  it('passes with the correct bare mcp__moflo prefix', async () => {
    writeSettings(['Bash(*)', 'mcp__moflo']);
    const result = await checkMcpToolPermissions(tmpDir);
    expect(result.status).toBe('pass');
  });

  it('does NOT warn on a valid exact-tool rule (no wildcard)', async () => {
    // A consumer scoping to individual tools is legitimate — must not fire.
    writeSettings(['mcp__moflo__memory_store', 'mcp__moflo__memory_search']);
    const result = await checkMcpToolPermissions(tmpDir);
    expect(result.status).toBe('pass');
  });

  it('does not double-report malformed settings.json (owned by Status Line)', async () => {
    const claudeDir = join(tmpDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), '{ not valid json');
    const result = await checkMcpToolPermissions(tmpDir);
    expect(result.status).toBe('pass');
  });
});

describe('autoFixCheck repairs the malformed moflo MCP permission', () => {
  it('drops the wildcard rule, adds the bare prefix, preserves other rules', async () => {
    const settingsPath = writeSettings(['Bash(*)', 'Read(*)', 'mcp__moflo__:*']);

    const ok = await autoFixCheck({
      name: 'MCP Tool Permissions',
      status: 'warn',
      message: 'malformed moflo MCP permission rule',
      fix: 'flo healer --fix -c mcp-permissions',
    });
    expect(ok).toBe(true);

    const allow = JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow as string[];
    expect(allow).not.toContain('mcp__moflo__:*');
    expect(allow).toContain('mcp__moflo');
    // Unrelated rules survive untouched.
    expect(allow).toContain('Bash(*)');
    expect(allow).toContain('Read(*)');
  });

  it('preserves valid exact-tool rules while adding the bare prefix', async () => {
    const settingsPath = writeSettings(['mcp__moflo__memory_store', 'mcp__moflo__:*']);

    await autoFixCheck({
      name: 'MCP Tool Permissions',
      status: 'warn',
      message: 'malformed moflo MCP permission rule',
      fix: 'flo healer --fix -c mcp-permissions',
    });

    const allow = JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow as string[];
    expect(allow).toContain('mcp__moflo__memory_store'); // valid exact tool kept
    expect(allow).toContain('mcp__moflo');               // bare prefix added
    expect(allow).not.toContain('mcp__moflo__:*');       // malformed dropped
  });

  it('is idempotent — a re-run over healed settings makes no change and the check passes', async () => {
    const settingsPath = writeSettings(['mcp__moflo__:*']);
    await autoFixCheck({
      name: 'MCP Tool Permissions', status: 'warn', message: 'x',
      fix: 'flo healer --fix -c mcp-permissions',
    });
    const afterFirst = readFileSync(settingsPath, 'utf8');

    const recheck = await checkMcpToolPermissions(tmpDir);
    expect(recheck.status).toBe('pass');

    await autoFixCheck({
      name: 'MCP Tool Permissions', status: 'warn', message: 'x',
      fix: 'flo healer --fix -c mcp-permissions',
    });
    expect(readFileSync(settingsPath, 'utf8')).toBe(afterFirst);
  });

  it('writes via atomic rename — no leftover temp debris', async () => {
    writeSettings(['mcp__moflo__:*']);
    await autoFixCheck({
      name: 'MCP Tool Permissions', status: 'warn', message: 'x',
      fix: 'flo healer --fix -c mcp-permissions',
    });
    const debris = readdirSync(join(tmpDir, '.claude')).filter((f) => f.includes('.tmp.'));
    expect(debris).toEqual([]);
  });
});
