/**
 * Tests for #1151 — MCP server PID/log relocated to per-project `.moflo/`.
 *
 * Pre-#1151, `MCPServerManager` wrote `<os.tmpdir()>/claude-flow-mcp.{pid,log}`
 * which was shared across every moflo consumer on the machine. Two projects'
 * MCP servers raced to overwrite the same PID file, and `flo mcp stop` killed
 * whichever happened to write last (potentially the wrong project). Same bug
 * class as #1145 (cross-project daemon port collision) at the MCP layer.
 *
 * Fix shape: PID/log now resolve through the unified `findProjectRoot` to
 * `<projectRoot>/.moflo/mcp-server.{pid,log}`. These tests verify the new
 * layout and the abandoned-tmpdir cleanup path (dead pre-#1151 PID files
 * unlinked on next start; live ones preserved for the older project).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { MCPServerManager } from '../mcp-server.js';

describe('MCP server per-project PID/log (#1151)', () => {
  let projectRoot: string;
  let prevClaudeProjectDir: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'mcp-pid-test-'));
    mkdirSync(join(projectRoot, '.moflo'), { recursive: true });
    // Anchor `findProjectRoot()` to the temp dir so the manager picks it.
    prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;
  });

  afterEach(() => {
    if (prevClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('defaults pidFile and logFile under <projectRoot>/.moflo/', () => {
    const manager = new MCPServerManager();
    // Inspect via the public options the manager will use.
    const opts = (manager as unknown as { options: { pidFile: string; logFile: string } }).options;
    expect(opts.pidFile).toBe(join(projectRoot, '.moflo', 'mcp-server.pid'));
    expect(opts.logFile).toBe(join(projectRoot, '.moflo', 'mcp-server.log'));
  });

  it('writePidFile creates the per-project file and the parent dir if missing', async () => {
    rmSync(join(projectRoot, '.moflo'), { recursive: true, force: true });
    const manager = new MCPServerManager();
    await (manager as unknown as { writePidFile: () => Promise<void> }).writePidFile();
    const pidFile = join(projectRoot, '.moflo', 'mcp-server.pid');
    expect(existsSync(pidFile)).toBe(true);
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('cleanupAbandonedTmpdirPid unlinks a dead pre-#1151 tmpdir PID file', async () => {
    const legacyPid = join(tmpdir(), 'claude-flow-mcp.pid');
    const legacyLog = join(tmpdir(), 'claude-flow-mcp.log');
    // A PID nearly guaranteed to be dead (max-uint16 + 1 is unused on most systems).
    writeFileSync(legacyPid, '999999', 'utf8');
    writeFileSync(legacyLog, 'old log\n', 'utf8');

    const manager = new MCPServerManager();
    await (manager as unknown as { cleanupAbandonedTmpdirPid: () => Promise<void> })
      .cleanupAbandonedTmpdirPid();

    expect(existsSync(legacyPid)).toBe(false);
    expect(existsSync(legacyLog)).toBe(false);
  });

  it('cleanupAbandonedTmpdirPid leaves a LIVE legacy PID alone (belongs to another project)', async () => {
    const legacyPid = join(tmpdir(), 'claude-flow-mcp.pid');
    const legacyLog = join(tmpdir(), 'claude-flow-mcp.log');
    // Our own pid is guaranteed alive — stand in for "another project's MCP".
    writeFileSync(legacyPid, String(process.pid), 'utf8');
    writeFileSync(legacyLog, 'alive log\n', 'utf8');

    try {
      const manager = new MCPServerManager();
      await (manager as unknown as { cleanupAbandonedTmpdirPid: () => Promise<void> })
        .cleanupAbandonedTmpdirPid();

      expect(existsSync(legacyPid)).toBe(true);
      expect(existsSync(legacyLog)).toBe(true);
    } finally {
      rmSync(legacyPid, { force: true });
      rmSync(legacyLog, { force: true });
    }
  });
});
