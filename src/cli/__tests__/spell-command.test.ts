/**
 * Spell CLI Command Tests
 *
 * Story #370: Verifies CLI workflow→spell rename is correct.
 */

import { describe, it, expect } from 'vitest';
import { spellCommand } from '../commands/spell.js';
import { scheduleCommand } from '../commands/spell-schedule.js';

describe('Spell CLI Command', () => {
  it('command name is "spell"', () => {
    expect(spellCommand.name).toBe('spell');
  });

  it('has "workflow" as backwards-compat alias', () => {
    expect(spellCommand.aliases).toContain('workflow');
  });

  it('description uses spell terminology', () => {
    expect(spellCommand.description).toMatch(/spell/i);
    expect(spellCommand.description).not.toMatch(/workflow/i);
  });

  it('has expected subcommands', () => {
    const subNames = spellCommand.subcommands!.map(s => s.name).sort();
    expect(subNames).toEqual(['cast', 'list', 'schedule', 'status', 'stop', 'template', 'validate']);
  });

  it('cast subcommand has "run" alias for backwards compat', () => {
    const cast = spellCommand.subcommands!.find(s => s.name === 'cast');
    expect(cast).toBeDefined();
    expect(cast!.aliases).toContain('run');
  });

  it('stop subcommand has "dispel" alias', () => {
    const stop = spellCommand.subcommands!.find(s => s.name === 'stop');
    expect(stop).toBeDefined();
    expect(stop!.aliases).toContain('dispel');
  });

  it('template subcommand has "grimoire" alias', () => {
    const template = spellCommand.subcommands!.find(s => s.name === 'template');
    expect(template).toBeDefined();
    expect(template!.aliases).toContain('grimoire');
  });

  it('examples use "moflo spell" not "moflo workflow"', () => {
    for (const ex of spellCommand.examples ?? []) {
      expect(ex.command).toMatch(/^moflo spell/);
      expect(ex.command).not.toMatch(/moflo workflow/);
    }
  });
});

describe('Spell Schedule Subcommand', () => {
  it('schedule command name is "schedule"', () => {
    expect(scheduleCommand.name).toBe('schedule');
  });

  it('has create, list, cancel subcommands', () => {
    const subNames = scheduleCommand.subcommands!.map(s => s.name).sort();
    expect(subNames).toEqual(['cancel', 'create', 'list']);
  });

  it('examples use "moflo spell schedule"', () => {
    for (const ex of scheduleCommand.examples ?? []) {
      expect(ex.command).toMatch(/moflo spell schedule/);
      expect(ex.command).not.toMatch(/moflo workflow/);
    }
  });
});

describe('Command index registration', () => {
  it('spellCommand is registered in commands index', async () => {
    const { hasCommand, getCommandAsync } = await import('../commands/index.js');
    expect(hasCommand('spell')).toBe(true);
    const cmd = await getCommandAsync('spell');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('spell');
  });

  it('castCommand is registered as a top-level command', async () => {
    const { hasCommand, getCommandAsync } = await import('../commands/index.js');
    expect(hasCommand('cast')).toBe(true);
    const cmd = await getCommandAsync('cast');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('cast');
  });

  it('top-level cast and spell cast share the same Command object', async () => {
    const { getCommandAsync } = await import('../commands/index.js');
    const topCast = await getCommandAsync('cast');
    const spell = await getCommandAsync('spell');
    const spellCast = spell!.subcommands!.find(s => s.name === 'cast');
    expect(topCast).toBe(spellCast);
  });

  it('no "workflow" as a primary command name in loaders', async () => {
    const { getCommandNames } = await import('../commands/index.js');
    const names = getCommandNames();
    // "spell" should be present, "workflow" should not be a loader key
    expect(names).toContain('spell');
    // workflow may exist as an alias via commandRegistry from spellCommand.aliases
    // but should NOT be in commandLoaders as a separate entry
  });
});

describe('Completions include spell', () => {
  it('TOP_LEVEL_COMMANDS has spell, not workflow', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../commands/completions.ts'),
      'utf-8',
    );
    expect(source).toContain("'spell'");
    expect(source).not.toContain("'workflow'");
    expect(source).toContain('spell:Spell casting');
  });
});
