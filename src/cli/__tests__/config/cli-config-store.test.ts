/**
 * Tests for the CLI JSON config store — the file behind `flo config` and the
 * doctor's `Config File` check.
 *
 * Validates that the store:
 *  - writes the canonical `.moflo/config.json` and reads it back
 *  - prefers the canonical file, then legacy `claude-flow.*` names (#699)
 *  - writes back to whichever file the project already has
 *  - merges a partial file over defaults instead of returning it raw
 *  - surfaces corrupt JSON as an error rather than silently defaulting
 *  - coerces `set` values to the type already at that key
 *  - rejects unknown keys and prototype-polluting ones
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CliConfigParseError,
  cliConfigPath,
  defaultCliConfig,
  findCliConfigFile,
  flattenConfig,
  getConfigValue,
  loadCliConfig,
  resetSection,
  saveCliConfig,
  setConfigValue,
} from '../../config/cli-config-store.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-config-store-')));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cli-config-store', () => {
  describe('save + load', () => {
    it('round-trips through .moflo/config.json', () => {
      const written = saveCliConfig(tmpDir, defaultCliConfig());

      expect(written).toBe(cliConfigPath(tmpDir));
      expect(loadCliConfig(tmpDir)).toMatchObject({
        path: cliConfigPath(tmpDir),
        config: { version: '3.0.0', swarm: { maxAgents: 15 } },
      });
    });

    it('creates the .moflo directory when absent', () => {
      saveCliConfig(tmpDir, defaultCliConfig());

      expect(JSON.parse(readFileSync(cliConfigPath(tmpDir), 'utf8'))).toHaveProperty('version');
    });

    it('returns defaults and a null path when no config exists', () => {
      const { config, path } = loadCliConfig(tmpDir);

      expect(path).toBeNull();
      expect(config).toEqual(defaultCliConfig());
    });

    it('merges a partial file over defaults', () => {
      mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
      writeFileSync(cliConfigPath(tmpDir), JSON.stringify({ swarm: { topology: 'ring' } }));

      const { config } = loadCliConfig(tmpDir);

      expect(config.swarm.topology).toBe('ring');
      expect(config.swarm.maxAgents).toBe(15); // default survives
      expect(config.memory.backend).toBe('hybrid');
    });

    it('throws on corrupt JSON instead of silently defaulting', () => {
      mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
      writeFileSync(cliConfigPath(tmpDir), '{ not json');

      expect(() => loadCliConfig(tmpDir)).toThrow(CliConfigParseError);
    });
  });

  describe('candidate precedence', () => {
    it('prefers .moflo/config.json over a legacy root file', () => {
      mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
      writeFileSync(cliConfigPath(tmpDir), JSON.stringify({ swarm: { topology: 'canonical' } }));
      writeFileSync(join(tmpDir, 'claude-flow.config.json'), JSON.stringify({ swarm: { topology: 'legacy' } }));

      expect(findCliConfigFile(tmpDir)).toBe(cliConfigPath(tmpDir));
      expect(loadCliConfig(tmpDir).config.swarm.topology).toBe('canonical');
    });

    it('reads a pre-#699 claude-flow.config.json when it is all that exists', () => {
      writeFileSync(join(tmpDir, 'claude-flow.config.json'), JSON.stringify({ swarm: { topology: 'legacy' } }));

      expect(loadCliConfig(tmpDir).config.swarm.topology).toBe('legacy');
    });

    it('writes back to the file the project already has', () => {
      const legacy = join(tmpDir, 'moflo.config.json');
      writeFileSync(legacy, JSON.stringify({ swarm: { topology: 'ring' } }));

      const written = saveCliConfig(tmpDir, defaultCliConfig());

      expect(written).toBe(legacy);
      expect(findCliConfigFile(tmpDir)).toBe(legacy);
    });
  });

  describe('getConfigValue', () => {
    it('reads nested and array paths', () => {
      const config = defaultCliConfig();

      expect(getConfigValue(config, 'swarm.topology')).toEqual({ found: true, value: 'hybrid' });
      expect(getConfigValue(config, 'providers.0.name')).toEqual({ found: true, value: 'anthropic' });
    });

    it('reports unknown and out-of-range paths as not found', () => {
      const config = defaultCliConfig();

      expect(getConfigValue(config, 'swarm.nonesuch').found).toBe(false);
      expect(getConfigValue(config, 'providers.99.name').found).toBe(false);
      expect(getConfigValue(config, '').found).toBe(false);
    });
  });

  describe('setConfigValue', () => {
    it('coerces to the type already at the key', () => {
      const config = defaultCliConfig();

      expect(setConfigValue(config, 'swarm.maxAgents', '20')).toEqual({ ok: true, value: 20 });
      expect(setConfigValue(config, 'swarm.autoScale', 'off')).toEqual({ ok: true, value: false });
      expect(setConfigValue(config, 'swarm.topology', 'mesh')).toEqual({ ok: true, value: 'mesh' });
      expect(config.swarm).toMatchObject({ maxAgents: 20, autoScale: false, topology: 'mesh' });
    });

    it('rejects values that do not fit the key type', () => {
      const config = defaultCliConfig();

      expect(setConfigValue(config, 'swarm.maxAgents', 'lots').ok).toBe(false);
      expect(setConfigValue(config, 'swarm.autoScale', 'maybe').ok).toBe(false);
      expect(config.swarm.maxAgents).toBe(15);
    });

    it('rejects a whole section as a value', () => {
      const result = setConfigValue(defaultCliConfig(), 'swarm', 'mesh');

      expect(result.ok).toBe(false);
    });

    it('rejects unknown keys rather than creating them', () => {
      const config = defaultCliConfig();

      expect(setConfigValue(config, 'swarm.nonesuch', '1').ok).toBe(false);
      expect(config.swarm).not.toHaveProperty('nonesuch');
    });

    it('rejects prototype-polluting keys', () => {
      const config = defaultCliConfig();

      expect(setConfigValue(config, '__proto__.polluted', 'yes').ok).toBe(false);
      expect(setConfigValue(config, 'swarm.constructor', 'yes').ok).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('writes into array entries', () => {
      const config = defaultCliConfig();

      expect(setConfigValue(config, 'providers.0.enabled', 'false')).toEqual({ ok: true, value: false });
      expect(config.providers[0].enabled).toBe(false);
    });
  });

  describe('flattenConfig', () => {
    it('produces dotted leaf keys', () => {
      const flat = flattenConfig(defaultCliConfig());

      expect(flat['swarm.topology']).toBe('hybrid');
      expect(flat['providers.0.name']).toBe('anthropic');
      expect(Object.values(flat).every((v) => typeof v !== 'object')).toBe(true);
    });
  });

  describe('resetSection', () => {
    it('restores one section and leaves the rest alone', () => {
      const config = defaultCliConfig();
      setConfigValue(config, 'swarm.maxAgents', '99');
      setConfigValue(config, 'memory.cacheSize', '1');

      const reset = resetSection(config, 'swarm');

      expect(reset.swarm.maxAgents).toBe(15);
      expect(reset.memory.cacheSize).toBe(1);
    });

    it('restores everything for "all" while preserving mode flags', () => {
      const config = defaultCliConfig({ v3: false, sparc: true });
      setConfigValue(config, 'swarm.maxAgents', '99');

      const reset = resetSection(config, 'all');

      expect(reset.swarm.maxAgents).toBe(15);
      expect(reset.v3Mode).toBe(false);
      expect(reset.sparc).toBe(true);
    });
  });
});
