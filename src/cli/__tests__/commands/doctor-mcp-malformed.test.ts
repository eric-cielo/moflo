/**
 * Tests for `checkMcpServers` malformed-JSON handling and its companion
 * `MCP Servers` auto-fixer (#1126).
 *
 * Failure mode being guarded against: a `.mcp.json` with unescaped Windows
 * backslashes (`"C:\Users\..."`) makes `JSON.parse` throw. The pre-fix loop
 * silently swallowed the error and reported a misleading "0 servers (flo not
 * found)" — driving users to `claude mcp add` (which doesn't touch the
 * malformed file). The replacement surfaces a `malformed JSON at <path>: …`
 * warning and routes `flo healer --fix -c mcp-servers` to the regenerator.
 *
 * ## Test isolation
 *
 * The MCP search-path list includes `~/.claude/claude_desktop_config.json`,
 * `~/.config/claude/mcp.json` and (on Windows) `%APPDATA%/Claude/...`. If we
 * don't redirect those, the developer's real Claude Desktop config leaks
 * into the check and `inspectMcpConfigs` may match the wrong file before
 * reaching the tmp `.mcp.json`. We redirect:
 *   - `CLAUDE_PROJECT_DIR` → tmpDir (anchors `findProjectRoot` per
 *     feedback_unified_project_root_resolver.md and dogfooding.md § 5)
 *   - `HOME`, `USERPROFILE` (Node's `os.homedir()` honors USERPROFILE on
 *     Windows, HOME on POSIX) → a guaranteed-empty fake home under tmpDir
 *   - `APPDATA` (Windows-only) → another guaranteed-empty dir under tmpDir
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkMcpServers, inspectMcpConfigs } from '../../commands/doctor-checks-config.js';
import { autoFixCheck } from '../../commands/doctor-fixes.js';

let tmpDir: string;
let originalCwd: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-mcp-malformed-'));
  originalCwd = process.cwd();
  savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  };

  const fakeHome = join(tmpDir, '__home__');
  const fakeAppData = join(tmpDir, '__appdata__');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeAppData, { recursive: true });

  // os.homedir() prefers USERPROFILE on Windows, HOME on POSIX. Set both so
  // the test is identical across platforms regardless of which Node consults.
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.APPDATA = fakeAppData;
  // findProjectRoot honors CLAUDE_PROJECT_DIR ahead of any FS walk — anchors
  // both the reader (via default arg) and the autoFixCheck path on tmpDir
  // without depending on process.cwd().
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('inspectMcpConfigs', () => {
  it('returns valid_with_moflo when .mcp.json parses and contains moflo', () => {
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { moflo: { command: 'node' } } }));
    const result = inspectMcpConfigs(tmpDir);
    expect(result.status).toBe('valid_with_moflo');
    expect(result.count).toBe(1);
  });

  it('returns valid_no_moflo when .mcp.json parses but moflo absent', () => {
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'node' } } }));
    const result = inspectMcpConfigs(tmpDir);
    expect(result.status).toBe('valid_no_moflo');
    expect(result.count).toBe(1);
  });

  it('returns malformed when .mcp.json has unescaped Windows backslashes', () => {
    // The exact shape that caused #1126 — produced by an older writer that
    // string-concatenated instead of JSON.stringify-ing. `String.raw` keeps
    // every backslash literal so the on-disk bytes match what motailz had:
    // `"C:\Users\..."` inside a JSON string is unescaped → JSON.parse throws.
    const bad = String.raw`{
  "mcpServers": {
    "moflo": {
      "command": "cmd",
      "args": ["/c", "node", "C:\Users\eric\app.js"]
    }
  }
}`;
    writeFileSync(join(tmpDir, '.mcp.json'), bad);
    const result = inspectMcpConfigs(tmpDir);
    expect(result.status).toBe('malformed');
    expect(result.path).toContain('.mcp.json');
    expect(result.parseError).toBeDefined();
  });

  it('returns not_found when no project .mcp.json exists', () => {
    const result = inspectMcpConfigs(tmpDir);
    expect(result.status).toBe('not_found');
  });

  it('ignores Claude Desktop configs entirely (moflo targets Claude Code, not Desktop)', () => {
    // #1126 regression guard. A previous wide-net scan made a parseable
    // APPDATA `claude_desktop_config.json` (which has only `preferences`,
    // no `mcpServers`) outrank a malformed project `.mcp.json`, masking
    // the real failure. moflo doesn't ship to Claude Desktop and isn't
    // ever registered there — Claude Desktop paths are out of scope for
    // this check. The narrow project-only scan means a Claude Desktop
    // config sitting at APPDATA has zero effect on the verdict.
    writeFileSync(join(tmpDir, '.mcp.json'), '{ "mcpServers": { "moflo": { "args": ["C:\\Users"] } } }');
    const appData = process.env.APPDATA;
    if (appData) {
      const claudeDir = join(appData, 'Claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, 'claude_desktop_config.json'),
        JSON.stringify({ preferences: { sidebarMode: 'chat' } }),
      );
    }
    const result = inspectMcpConfigs(tmpDir);
    expect(result.status).toBe('malformed'); // the broken project file wins, as it should
    expect(result.path).toContain('.mcp.json');
  });
});

describe('checkMcpServers reports each state distinctly', () => {
  it('passes with the new "moflo configured" message wording', async () => {
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { moflo: { command: 'node' } } }));
    const result = await checkMcpServers(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('moflo configured');
    // stale wording purged — the old message was "N servers (flo configured)";
    // check the boundary explicitly since "moflo" trivially contains "flo".
    expect(result.message).not.toMatch(/\(flo configured\)/);
  });

  it('warns about malformed JSON with the actual parse error in the message', async () => {
    const bad = '{ "mcpServers": { "moflo": { "args": ["C:\\Users"] } } }';
    writeFileSync(join(tmpDir, '.mcp.json'), bad);
    const result = await checkMcpServers(tmpDir);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/malformed JSON at/);
    expect(result.message).toContain('.mcp.json');
    expect(result.fix).toBe('flo healer --fix -c mcp-servers');
  });

  it('warns "moflo not registered" — distinct from malformed and not_found', async () => {
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'node' } } }));
    const result = await checkMcpServers(tmpDir);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('moflo not registered');
  });

  it('honors CLAUDE_PROJECT_DIR via findProjectRoot when called from a subdirectory', async () => {
    // Consumer-realistic case: `flo healer` invoked from `<project>/src/`. The
    // pre-fix `process.cwd()` walk would have missed `.mcp.json` at the
    // project root; findProjectRoot anchors on CLAUDE_PROJECT_DIR (or walks
    // up from cwd looking for markers) so the check still finds the file.
    const subdir = join(tmpDir, 'sub', 'deep');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { moflo: { command: 'node' } } }));
    process.chdir(subdir);
    // No explicit arg — exercises the default `findProjectRoot()` path.
    const result = await checkMcpServers();
    expect(result.status).toBe('pass');
  });
});

describe('autoFixCheck regenerates malformed .mcp.json', () => {
  it('backs up the original then writes parseable JSON in its place', async () => {
    const bad = '{ "mcpServers": { "moflo": { "args": ["C:\\Users"] } } }';
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, bad);

    const ok = await autoFixCheck({
      name: 'MCP Servers',
      status: 'warn',
      message: `malformed JSON at ${mcpPath}`,
      fix: 'flo healer --fix -c mcp-servers',
    });

    expect(ok).toBe(true);

    // The regenerated file must parse and must contain the moflo server entry.
    const regenerated = readFileSync(mcpPath, 'utf8');
    const parsed = JSON.parse(regenerated);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.moflo).toBeDefined();

    // Path values inside the regenerated args must be properly JSON-escaped.
    // If the generator ever regressed to string concatenation, the regenerated
    // file would itself fail JSON.parse here — fast-fail signal.
    const args = parsed.mcpServers.moflo.args;
    expect(Array.isArray(args)).toBe(true);

    // A timestamped backup of the malformed original must exist for forensic
    // inspection — never silently drop a user's broken file.
    const backups = readdirSync(tmpDir).filter((f) => f.startsWith('.mcp.json.malformed-'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(tmpDir, backups[0]), 'utf8')).toBe(bad);
  });

  it('writes the regenerated file via atomic rename — no leftover temp files', async () => {
    // Guards against a regression where the fixer switches back to a plain
    // writeFileSync that leaves `.tmp.<pid>` debris if the rename throws.
    const bad = '{ "mcpServers": { "moflo": { "args": ["C:\\Users"] } } }';
    const mcpPath = join(tmpDir, '.mcp.json');
    writeFileSync(mcpPath, bad);

    await autoFixCheck({
      name: 'MCP Servers',
      status: 'warn',
      message: `malformed JSON at ${mcpPath}`,
      fix: 'flo healer --fix -c mcp-servers',
    });

    const debris = readdirSync(tmpDir).filter((f) => f.includes('.tmp.'));
    expect(debris).toEqual([]);
  });
});
