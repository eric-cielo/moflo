/**
 * Tests for `checkDaemonWriteRouting` doctor check (#987).
 *
 * Surfaces the single-writer-architecture safety net (#981): warns when the
 * daemon is disabled in moflo.yaml AND the consumer has an MCP server
 * configured (the configuration where multi-process sql.js clobber re-opens).
 *
 * Tests isolate from the dev environment by:
 *   - using a temp project root for moflo.yaml + .mcp.json
 *   - redirecting HOME / USERPROFILE / APPDATA to a temp dir so the
 *     home-config sweep can't pick up the developer's real ~/.claude/...
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkDaemonWriteRouting } from '../commands/doctor-checks-config.js';

function makeTemp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `doctor-routing-${label}-`));
}

describe('checkDaemonWriteRouting (#987)', () => {
  let projectRoot: string;
  let homeDir: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origAppData = process.env.APPDATA;

  beforeEach(() => {
    projectRoot = makeTemp('proj');
    homeDir = makeTemp('home');
    // Redirect homedir() lookups so we don't pick up the dev's real
    // ~/.claude/claude_desktop_config.json.
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    if (process.platform === 'win32') process.env.APPDATA = homeDir;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  function writeYaml(content: string): void {
    fs.writeFileSync(path.join(projectRoot, 'moflo.yaml'), content);
  }

  function writeProjectMcp(servers: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: servers }),
    );
  }

  it('passes with the default config (daemon enabled)', async () => {
    // No moflo.yaml at all — loadMofloConfig returns defaults, auto_start: true.
    const result = await checkDaemonWriteRouting(projectRoot);
    expect(result.name).toBe('Daemon Write Routing');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('Daemon enabled');
    expect(result.message).toContain('#981');
  });

  it('passes when daemon explicitly enabled in moflo.yaml', async () => {
    writeYaml('daemon:\n  auto_start: true\n');
    const result = await checkDaemonWriteRouting(projectRoot);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('Daemon enabled');
  });

  it('passes when daemon disabled but no MCP server is configured', async () => {
    writeYaml('daemon:\n  auto_start: false\n');
    const result = await checkDaemonWriteRouting(projectRoot);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('no MCP server');
  });

  it('warns when daemon disabled AND project .mcp.json has servers', async () => {
    writeYaml('daemon:\n  auto_start: false\n');
    writeProjectMcp({ moflo: { command: 'npx', args: ['moflo', 'mcp', 'start'] } });

    const result = await checkDaemonWriteRouting(projectRoot);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Daemon disabled');
    expect(result.message).toContain('1 MCP server');
    expect(result.message).toContain('clobber');
    expect(result.fix).toContain('daemon.auto_start: true');
  });

  it('warns when daemon disabled AND home claude_desktop_config has servers', async () => {
    writeYaml('daemon:\n  auto_start: false\n');
    // Drop a fake home-config under our redirected HOME
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.claude', 'claude_desktop_config.json'),
      JSON.stringify({ mcpServers: { moflo: {}, other: {} } }),
    );

    const result = await checkDaemonWriteRouting(projectRoot);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/[12] MCP server/);
  });

  it('skips unreadable MCP configs without throwing', async () => {
    writeYaml('daemon:\n  auto_start: false\n');
    fs.writeFileSync(path.join(projectRoot, '.mcp.json'), 'this is not json');

    const result = await checkDaemonWriteRouting(projectRoot);
    // Malformed config doesn't count as a server; with no other config we pass.
    expect(result.status).toBe('pass');
    expect(result.message).toContain('no MCP server');
  });
});
