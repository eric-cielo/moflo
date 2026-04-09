import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SpellConnectorRegistry } from '../src/registry/connector-registry.js';
import type { SpellConnector } from '../src/types/spell-connector.types.js';

function makeConnector(name: string, overrides?: Partial<SpellConnector>): SpellConnector {
  return {
    name,
    description: `${name} connector`,
    version: '1.0.0',
    capabilities: ['read'],
    initialize: async () => {},
    dispose: async () => {},
    execute: async () => ({ success: true, data: {} }),
    listActions: () => [],
    ...overrides,
  };
}

describe('SpellConnectorRegistry', () => {
  let registry: SpellConnectorRegistry;

  beforeEach(() => {
    registry = new SpellConnectorRegistry();
  });

  it('registers and retrieves a connector by name', () => {
    const connector = makeConnector('http');
    registry.register(connector);

    expect(registry.has('http')).toBe(true);
    expect(registry.get('http')).toBe(connector);
    expect(registry.size).toBe(1);
  });

  it('throws on duplicate registration', () => {
    registry.register(makeConnector('http'));
    expect(() => registry.register(makeConnector('http'))).toThrow(
      'Spell connector "http" is already registered'
    );
  });

  it('throws on invalid connector (missing required methods)', () => {
    const invalid = { name: 'bad', description: 'x' } as unknown as SpellConnector;
    expect(() => registry.register(invalid)).toThrow(
      'does not implement SpellConnector interface'
    );
  });

  it('throws on connector with empty name', () => {
    const connector = makeConnector('');
    expect(() => registry.register(connector)).toThrow(
      'does not implement SpellConnector interface'
    );
  });

  it('unregisters a connector', () => {
    registry.register(makeConnector('http'));
    expect(registry.unregister('http')).toBe(true);
    expect(registry.has('http')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('unregister returns false for unknown connector', () => {
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('get returns undefined for unknown connector', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered connectors', () => {
    registry.register(makeConnector('http'), 'shipped');
    registry.register(makeConnector('slack'), 'user');

    const entries = registry.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].connector.name).toBe('http');
    expect(entries[0].source).toBe('shipped');
    expect(entries[1].connector.name).toBe('slack');
    expect(entries[1].source).toBe('user');
  });

  it('names returns all registered connector names', () => {
    registry.register(makeConnector('http'));
    registry.register(makeConnector('slack'));
    expect(registry.names()).toEqual(['http', 'slack']);
  });

  it('clear removes all connectors', () => {
    registry.register(makeConnector('http'));
    registry.register(makeConnector('slack'));
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.names()).toEqual([]);
  });

  it('scan with no directories returns zero registered', async () => {
    const result = await registry.scan();
    expect(result.registered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('scan with nonexistent directory returns zero registered', async () => {
    const reg = new SpellConnectorRegistry({
      shippedDir: '/nonexistent/path/connectors',
    });
    const result = await reg.scan();
    expect(result.registered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('tracks source correctly', () => {
    registry.register(makeConnector('http'), 'shipped');
    registry.register(makeConnector('slack'), 'user');
    registry.register(makeConnector('db'), 'npm');

    const entries = registry.list();
    const byName = Object.fromEntries(entries.map(e => [e.connector.name, e.source]));
    expect(byName.http).toBe('shipped');
    expect(byName.slack).toBe('user');
    expect(byName.db).toBe('npm');
  });

  it('registeredAt is set on registration', () => {
    const before = new Date();
    registry.register(makeConnector('http'));
    const after = new Date();

    const entry = registry.list()[0];
    expect(entry.registeredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(entry.registeredAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe('SpellConnectorRegistry npm discovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-registry-npm-'));
  });

  function createNpmConnector(
    pkgName: string,
    connectorDef: string,
    pkgJsonExtra: Record<string, unknown> = {},
  ) {
    const pkgDir = path.join(tmpDir, 'node_modules', pkgName);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'index.js'), connectorDef);
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkgName, version: '1.0.0', main: 'index.js', ...pkgJsonExtra }),
    );
  }

  const validConnectorJs = `
    module.exports = {
      name: 'npm-test',
      description: 'npm test connector',
      version: '1.0.0',
      capabilities: ['read'],
      initialize: async () => {},
      dispose: async () => {},
      execute: async () => ({ success: true, data: {} }),
      listActions: () => [],
    };
  `;

  it('discovers moflo-connector-* packages from node_modules', async () => {
    createNpmConnector('moflo-connector-test', validConnectorJs);

    const reg = new SpellConnectorRegistry({ projectRoot: tmpDir });
    const result = await reg.scan();

    expect(result.registered).toBe(1);
    expect(reg.has('npm-test')).toBe(true);
    expect(reg.list()[0].source).toBe('npm');
  });

  it('skips non-moflo-connector packages', async () => {
    createNpmConnector('other-package', validConnectorJs);

    const reg = new SpellConnectorRegistry({ projectRoot: tmpDir });
    const result = await reg.scan();

    expect(result.registered).toBe(0);
  });

  it('uses moflo-connector field from package.json when present', async () => {
    const pkgDir = path.join(tmpDir, 'node_modules', 'moflo-connector-custom');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'custom-entry.js'), validConnectorJs);
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'moflo-connector-custom', version: '1.0.0', 'moflo-connector': 'custom-entry.js' }),
    );

    const reg = new SpellConnectorRegistry({ projectRoot: tmpDir });
    const result = await reg.scan();

    expect(result.registered).toBe(1);
  });

  it('reports error for missing entry point', async () => {
    const pkgDir = path.join(tmpDir, 'node_modules', 'moflo-connector-broken');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'moflo-connector-broken', version: '1.0.0', main: 'nonexistent.js' }),
    );

    const reg = new SpellConnectorRegistry({ projectRoot: tmpDir });
    const result = await reg.scan();

    expect(result.registered).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('not found');
  });

  it('no node_modules directory does not crash', async () => {
    const reg = new SpellConnectorRegistry({ projectRoot: path.join(tmpDir, 'empty-project') });
    const result = await reg.scan();

    expect(result.registered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('user connector overrides npm connector with same name', async () => {
    // Create npm connector
    createNpmConnector('moflo-connector-http', `
      module.exports = {
        name: 'http',
        description: 'npm http',
        version: '0.1.0',
        capabilities: ['read'],
        initialize: async () => {},
        dispose: async () => {},
        execute: async () => ({ success: true, data: { source: 'npm' } }),
        listActions: () => [],
      };
    `);

    const reg = new SpellConnectorRegistry({ projectRoot: tmpDir });
    // Pre-register a user connector with the same name
    reg.register(makeConnector('http'), 'user');

    const result = await reg.scan();
    // npm connector should NOT override the user connector
    expect(reg.list().find(e => e.connector.name === 'http')?.source).toBe('user');
  });
});
