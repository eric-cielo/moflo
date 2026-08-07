/**
 * #1428 — `flo swarm start` printed "All agents deployed" and advertised a
 * `flo swarm status <id>` follow-up without ever calling the coordinator or
 * persisting that id.
 *
 * The fix is honesty rather than new wiring, and the reason is structural:
 * `mcp-client.ts` imports every MCP handler *in-process*, so a coordinator a
 * one-shot CLI command builds — and anything it spawns — dies when the
 * command exits. Spawning agents here to make the banner true would have been
 * the same lie with more moving parts (the epic #798 shape). What the CLI can
 * honestly own is the persisted state file, so these tests pin that contract:
 * `start` attaches an objective to the id `init` recorded, `stop` clears it,
 * and `status` reads back what actually happened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from '../../types.js';
import { swarmCommand } from '../../commands/swarm.js';
import { output } from '../../output.js';

let originalCwd: string;
let originalProjectDir: string | undefined;
let tmpDir: string;
let written: string[];

/** Everything the command printed, joined — for asserting on the banner text. */
function printed(): string {
  return written.join('\n');
}

function sub(name: string): Command {
  const found = swarmCommand.subcommands?.find(c => c.name === name);
  if (!found) throw new Error(`swarm subcommand not found: ${name}`);
  return found;
}

function run(name: string, flags: Record<string, unknown> = {}, args: string[] = []): Promise<CommandResult> {
  const ctx: CommandContext = {
    args,
    // Non-interactive: every prompt path is skipped, so these tests never
    // block on `select`/`confirm`.
    flags: { _: [], ...flags } as CommandContext['flags'],
    cwd: tmpDir,
    interactive: false,
  };
  return sub(name).action!(ctx);
}

const stateFile = () => join(tmpDir, '.moflo', 'swarm', 'state.json');

function seedInitialisedSwarm(extra: Record<string, unknown> = {}): void {
  mkdirSync(join(tmpDir, '.moflo', 'swarm'), { recursive: true });
  writeFileSync(
    stateFile(),
    JSON.stringify({
      id: 'swarm-seeded-1428',
      topology: 'hierarchical',
      maxAgents: 8,
      strategy: 'development',
      initializedAt: '2026-01-01T00:00:00.000Z',
      status: 'ready',
      ...extra,
    }),
  );
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFile(), 'utf-8'));
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  // realpathSync: macOS hands out `/var/folders/...` paths that resolve to
  // `/private/var/folders/...`, and findProjectRoot canonicalizes — so the
  // state file these tests read back would otherwise be addressed by a
  // different string than the one the command wrote (#1145).
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1428-')));
  mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
  process.chdir(tmpDir);
  // findProjectRoot honours this ahead of any filesystem walk, which is what
  // anchors the state file inside the throwaway dir.
  process.env.CLAUDE_PROJECT_DIR = tmpDir;

  written = [];
  const capture = (...parts: unknown[]) => { written.push(parts.map(String).join(' ')); };
  for (const method of ['writeln', 'printInfo', 'printError', 'printSuccess', 'printJson'] as const) {
    vi.spyOn(output, method).mockImplementation(capture as never);
  }
  vi.spyOn(output, 'printTable').mockImplementation(capture as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('#1428 — flo swarm start', () => {
  it('fails instead of printing success when no swarm has been initialised', async () => {
    const result = await run('start', { objective: 'Build REST API' });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(printed()).toMatch(/No initialised swarm/i);
    // The precise regression: a confident banner over work that never happened.
    expect(printed()).not.toMatch(/All agents deployed/);
    expect(printed()).not.toMatch(/Swarm execution started/);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('returns the persisted swarmId rather than minting an unresolvable one', async () => {
    seedInitialisedSwarm();

    const result = await run('start', { objective: 'Build REST API' });
    const data = result.data as { swarmId: string };

    expect(result.success).toBe(true);
    expect(data.swarmId).toBe('swarm-seeded-1428');
    // Pre-fix this was `generateId('swarm', ...)` — an id `flo swarm status`
    // could never resolve, because only init/start write the file it reads.
    expect(data.swarmId).not.toMatch(/^swarm-[0-9a-z]+-[0-9a-f]{12}$/);
  });

  it('records the objective so `flo swarm status` reflects it', async () => {
    seedInitialisedSwarm();
    await run('start', { objective: 'Build REST API', strategy: 'research' });

    const state = readState();
    expect(state.objective).toBe('Build REST API');
    expect(state.strategy).toBe('research');
    expect(state.status).toBe('running');
    expect(typeof state.startedAt).toBe('string');
    // init's fields survive the merge — start attaches to a swarm, it does not
    // replace one.
    expect(state.topology).toBe('hierarchical');
    expect(state.id).toBe('swarm-seeded-1428');

    written = [];
    const status = await run('status', { format: 'json' }, []);
    const shown = status.data as { objective: string; status: string; id: string };
    expect(shown.objective).toBe('Build REST API');
    expect(shown.status).toBe('running');
    expect(shown.id).toBe('swarm-seeded-1428');
  });

  it('states plainly that it spawned no agents', async () => {
    seedInitialisedSwarm();
    await run('start', { objective: 'Build REST API' });

    expect(printed()).toMatch(/No agents were spawned/i);
    expect(printed()).not.toMatch(/All agents deployed/);
  });

  it('does not stall on a spinner delay standing in for work', async () => {
    // The removed `setTimeout(500)` was captioned "Brief delay for spinner
    // animation" and was the only thing between "Deploying agents..." and
    // "All agents deployed". Generous bound — this asserts the sleep is gone,
    // not a performance budget.
    seedInitialisedSwarm();
    const started = performance.now();
    await run('start', { objective: 'Build REST API' });
    expect(performance.now() - started).toBeLessThan(300);
  });
});

describe('#1428 — flo swarm scale', () => {
  it('fails when no swarm has been initialised instead of reporting a scale', async () => {
    const result = await run('scale', { agents: 12 }, ['swarm-anything']);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(printed()).not.toMatch(/scaled to/i);
  });

  it('reports the delta against the recorded ceiling, not a hardcoded 8', async () => {
    // Pre-fix: `const currentAgents = 8` then "Spawning 4 new agents..." for a
    // target of 12, whatever the swarm was actually configured with.
    seedInitialisedSwarm({ maxAgents: 3 });
    const result = await run('scale', { agents: 12 }, ['swarm-seeded-1428']);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ agents: 12, previousAgents: 3 });
    expect(printed()).toMatch(/3 → 12/);
    expect(printed()).not.toMatch(/Spawning \d+ new agents/);
  });

  it('persists the new ceiling and states that nothing was spawned', async () => {
    seedInitialisedSwarm({ maxAgents: 3 });
    await run('scale', { agents: 12 }, ['swarm-seeded-1428']);

    expect(readState().maxAgents).toBe(12);
    expect(printed()).toMatch(/No agents were spawned or terminated/i);
    // The rest of the recorded swarm survives the update.
    expect(readState().topology).toBe('hierarchical');
  });

  it('refuses an id that is not the active swarm', async () => {
    seedInitialisedSwarm({ maxAgents: 3 });
    const result = await run('scale', { agents: 12 }, ['swarm-some-other-id']);

    expect(result.success).toBe(false);
    expect(readState().maxAgents).toBe(3);
  });
});

describe('#1428 — flo swarm coordinate', () => {
  it('presents the roster as reference and claims no running agents', async () => {
    const result = await run('coordinate', {}, []);

    expect(result.success).toBe(true);
    expect((result.data as { agents: unknown[] }).agents).toHaveLength(15);
    expect(printed()).toMatch(/reference/i);
    expect(printed()).toMatch(/No agents were started/i);
  });

  it('no longer reports a per-agent status for agents that do not exist', async () => {
    const result = await run('coordinate', {}, []);
    const roster = result.data as { agents: Array<Record<string, unknown>> };

    // The invented column: every entry used to carry `active`/`primary`/
    // `standby`, rendered in colour, for a roster that starts nothing.
    for (const entry of roster.agents) {
      expect(entry).not.toHaveProperty('status');
    }
    expect(printed()).not.toMatch(/Flash Attention|Int8 quantized/);
  });
});

describe('#1428 — flo swarm stop', () => {
  it('fails when there is no active swarm instead of confirming a stop', async () => {
    const result = await run('stop', {}, ['swarm-anything']);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(printed()).toMatch(/No active swarm/i);
    expect(printed()).not.toMatch(/stopped/);
  });

  it('refuses an id that is not the active swarm, and names the one that is', async () => {
    seedInitialisedSwarm();

    const result = await run('stop', {}, ['swarm-some-other-id']);

    expect(result.success).toBe(false);
    expect(printed()).toMatch(/swarm-seeded-1428/);
    // The state file survives a refused stop.
    expect(existsSync(stateFile())).toBe(true);
  });

  it('clears the recorded state so status stops reporting an active swarm', async () => {
    seedInitialisedSwarm();
    await run('start', { objective: 'Build REST API' });

    written = [];
    const result = await run('stop', {}, ['swarm-seeded-1428']);

    expect(result.success).toBe(true);
    expect(existsSync(stateFile())).toBe(false);

    written = [];
    const status = await run('status', { format: 'json' }, []);
    const shown = status.data as { hasActiveSwarm: boolean; objective: string };
    expect(shown.hasActiveSwarm).toBe(false);
    expect(shown.objective).toBe('No active objective');
  });
});
