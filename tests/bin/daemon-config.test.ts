import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { makeTempRoot, cleanTempRoot } from './_helpers.js';

const helperUrl =
  'file://' +
  resolve(__dirname, '../../bin/lib/daemon-config.mjs').replace(/\\/g, '/');
const { shouldDaemonAutoStart } = await import(helperUrl);

function writeSettings(root: string, settings: unknown) {
  const dir = resolve(root, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'settings.json'), JSON.stringify(settings));
}

describe('shouldDaemonAutoStart', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot('daemon-config');
  });
  afterEach(() => cleanTempRoot(root));

  it('returns true when .claude/settings.json is missing (preserves prior behavior)', () => {
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });

  it('returns true when settings.json has no claudeFlow block', () => {
    writeSettings(root, { hooks: {} });
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });

  it('returns true when claudeFlow.daemon block is absent', () => {
    writeSettings(root, { claudeFlow: { version: '3.0.0' } });
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });

  it('returns true when claudeFlow.daemon.autoStart key is absent', () => {
    writeSettings(root, { claudeFlow: { daemon: { workers: ['map'] } } });
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });

  it('returns true when claudeFlow.daemon.autoStart === true', () => {
    writeSettings(root, { claudeFlow: { daemon: { autoStart: true } } });
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });

  it('returns false when claudeFlow.daemon.autoStart === false', () => {
    writeSettings(root, { claudeFlow: { daemon: { autoStart: false } } });
    expect(shouldDaemonAutoStart(root)).toBe(false);
  });

  it('returns true on malformed JSON (does not silently disable the daemon)', () => {
    const dir = resolve(root, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'settings.json'), '{this is not valid json');
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });

  it('treats truthy non-boolean values as enabled (only explicit false disables)', () => {
    writeSettings(root, { claudeFlow: { daemon: { autoStart: 'yes' } } });
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });

  it('treats null autoStart as enabled (matches "absent" semantics)', () => {
    writeSettings(root, { claudeFlow: { daemon: { autoStart: null } } });
    expect(shouldDaemonAutoStart(root)).toBe(true);
  });
});
