/**
 * Tests for src/cli/init/moflo-yaml-template.ts — canonical moflo.yaml renderer
 * shared by `flo init` and the session-start launcher self-heal (#895).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  renderMofloYaml,
  defaultMofloYamlConfig,
  ensureMofloYamlExists,
  validateMofloYaml,
  REQUIRED_TOP_LEVEL_SECTIONS,
  detectExtensions,
  discoverSrcDirs,
  discoverTestDirs,
  discoverGuidanceDirs,
  type MofloYamlConfig,
} from '../init/moflo-yaml-template.js';

function makeTempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `moflo-yaml-${label}-`));
  return root;
}

function cleanRoot(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

const baselineConfig: MofloYamlConfig = {
  projectName: 'demo-app',
  guidanceDirs: ['.claude/guidance'],
  srcDirs: ['src'],
  testDirs: ['tests'],
  detectedExts: ['.ts', '.tsx'],
  guidance: true,
  codeMap: true,
  tests: true,
  gates: true,
  stopHook: true,
};

describe('renderMofloYaml', () => {
  it('emits all top-level sections the launcher self-heal expects to be present', () => {
    const yaml = renderMofloYaml(baselineConfig);
    for (const key of [
      'project:', 'guidance:', 'code_map:', 'tests:', 'gates:', 'auto_index:',
      'memory:', 'hooks:', 'mcp:', 'sandbox:', 'status_line:', 'models:', 'model_routing:',
    ]) {
      expect(yaml).toContain(key);
    }
  });

  it('includes the project name verbatim', () => {
    const yaml = renderMofloYaml({ ...baselineConfig, projectName: 'my-special-app' });
    expect(yaml).toContain('name: "my-special-app"');
  });

  it('emits each guidance/src/test dir on its own list line', () => {
    const yaml = renderMofloYaml({
      ...baselineConfig,
      guidanceDirs: ['.claude/guidance', 'docs'],
      srcDirs: ['src', 'lib'],
      testDirs: ['tests', '__tests__'],
    });
    expect(yaml).toMatch(/directories:\n {4}- \.claude\/guidance\n {4}- docs/);
    expect(yaml).toMatch(/directories:\n {4}- src\n {4}- lib/);
    expect(yaml).toMatch(/directories:\n {4}- tests\n {4}- __tests__/);
  });

  it('emits detected extensions as a quoted YAML inline list', () => {
    const yaml = renderMofloYaml({ ...baselineConfig, detectedExts: ['.go', '.py'] });
    expect(yaml).toContain('extensions: [".go", ".py"]');
  });

  it('reflects the gates flag in both gates: and hooks.gate:', () => {
    const onYaml = renderMofloYaml({ ...baselineConfig, gates: true });
    expect(onYaml).toMatch(/memory_first: true/);
    expect(onYaml).toMatch(/gate: true/);

    const offYaml = renderMofloYaml({ ...baselineConfig, gates: false });
    expect(offYaml).toMatch(/memory_first: false/);
    expect(offYaml).toMatch(/gate: false/);
  });

  it('keeps model_routing.enabled at true (#894 default flip)', () => {
    const yaml = renderMofloYaml(baselineConfig);
    expect(yaml).toMatch(/model_routing:\n\s+enabled: true/);
  });

  it('keeps sandbox.enabled at false (opt-in)', () => {
    const yaml = renderMofloYaml(baselineConfig);
    expect(yaml).toMatch(/sandbox:\n\s+enabled: false/);
  });

  it('emits merge.auto at false (opt-in, #1285)', () => {
    const yaml = renderMofloYaml(baselineConfig);
    expect(yaml).toMatch(/merge:\n\s+auto: false/);
  });

  it('is byte-stable for the same config (no Date.now or randomness)', () => {
    const a = renderMofloYaml(baselineConfig);
    const b = renderMofloYaml(baselineConfig);
    expect(a).toBe(b);
  });
});

describe('defaultMofloYamlConfig', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('defaults'); });
  afterEach(() => cleanRoot(root));

  it('uses path.basename(root) as the project name', () => {
    const config = defaultMofloYamlConfig(root);
    expect(config.projectName).toBe(path.basename(root));
  });

  it('falls back to .claude/guidance / src / tests when nothing is detected', () => {
    const config = defaultMofloYamlConfig(root);
    expect(config.guidanceDirs).toEqual(['.claude/guidance']);
    expect(config.srcDirs).toEqual(['src']);
    expect(config.testDirs).toEqual(['tests']);
  });

  it('falls back to .ts/.tsx/.js/.jsx when no source files exist', () => {
    const config = defaultMofloYamlConfig(root);
    expect(config.detectedExts).toEqual(['.ts', '.tsx', '.js', '.jsx']);
  });

  it('detects existing src/ with .ts files', () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
    const config = defaultMofloYamlConfig(root);
    expect(config.srcDirs).toContain('src');
    expect(config.detectedExts).toContain('.ts');
  });

  it('detects existing tests/ dir', () => {
    fs.mkdirSync(path.join(root, 'tests'));
    const config = defaultMofloYamlConfig(root);
    expect(config.testDirs).toContain('tests');
  });
});

describe('ensureMofloYamlExists', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('ensure'); });
  afterEach(() => cleanRoot(root));

  it('creates moflo.yaml when missing', () => {
    const yamlPath = path.join(root, 'moflo.yaml');
    expect(fs.existsSync(yamlPath)).toBe(false);

    const result = ensureMofloYamlExists(root);

    expect(result.created).toBe(true);
    expect(result.path).toBe(yamlPath);
    expect(fs.existsSync(yamlPath)).toBe(true);
  });

  it('writes a yaml file containing every top-level section', () => {
    ensureMofloYamlExists(root);
    const content = fs.readFileSync(path.join(root, 'moflo.yaml'), 'utf-8');
    for (const key of [
      'project:', 'guidance:', 'code_map:', 'tests:', 'gates:', 'auto_index:',
      'memory:', 'hooks:', 'mcp:', 'sandbox:', 'status_line:', 'models:', 'model_routing:',
    ]) {
      expect(content).toContain(key);
    }
  });

  it('is idempotent — never overwrites an existing file', () => {
    const yamlPath = path.join(root, 'moflo.yaml');
    const sentinel = '# user wrote this\nproject:\n  name: "do-not-clobber"\n';
    fs.writeFileSync(yamlPath, sentinel, 'utf-8');

    const first = ensureMofloYamlExists(root);
    expect(first.created).toBe(false);
    expect(fs.readFileSync(yamlPath, 'utf-8')).toBe(sentinel);

    const second = ensureMofloYamlExists(root);
    expect(second.created).toBe(false);
    expect(fs.readFileSync(yamlPath, 'utf-8')).toBe(sentinel);
  });

  it('returns the absolute path even when the file already exists', () => {
    const yamlPath = path.join(root, 'moflo.yaml');
    fs.writeFileSync(yamlPath, 'project:\n  name: "x"\n', 'utf-8');
    const result = ensureMofloYamlExists(root);
    expect(result.path).toBe(yamlPath);
  });

  it('renders byte-identical output to renderMofloYaml(defaultMofloYamlConfig(root))', () => {
    ensureMofloYamlExists(root);
    const written = fs.readFileSync(path.join(root, 'moflo.yaml'), 'utf-8');
    const expected = renderMofloYaml(defaultMofloYamlConfig(root));
    expect(written).toBe(expected);
  });
});

describe('ensureMofloYamlExists — write safety (#895)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('safety'); });
  afterEach(() => cleanRoot(root));

  it('does not leave a .tmp sidecar after a successful create', () => {
    ensureMofloYamlExists(root);
    const leftovers = fs.readdirSync(root).filter((f) => f.startsWith('moflo.yaml.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('returns created:false and leaves an existing yaml untouched', () => {
    // Covers the early-return branch in ensureMofloYamlExists: when the file
    // exists at entry we never write anything. The deeper TOCTOU branch
    // (file appears between the entry probe and the second probe) is
    // exercised in the unit-level atomic-file-write tests.
    const yamlPath = path.join(root, 'moflo.yaml');
    const sentinel = '# external writer\nproject:\n  name: race-winner\n';
    fs.writeFileSync(yamlPath, sentinel, 'utf-8');

    const result = ensureMofloYamlExists(root);
    expect(result.created).toBe(false);
    expect(fs.readFileSync(yamlPath, 'utf-8')).toBe(sentinel);
  });

  it('rendered content is fully written before becoming visible (atomic rename)', () => {
    // The ensure path renders into memory, writes a tmp sidecar, then renames
    // — so any reader either sees the file absent or sees the complete file.
    // Sanity check: after ensure returns, the file is complete (not partial).
    ensureMofloYamlExists(root);
    const written = fs.readFileSync(path.join(root, 'moflo.yaml'), 'utf-8');
    expect(written.endsWith('\n')).toBe(true);
    expect(written).toContain('# MoFlo — Project Configuration');
    expect(written).toContain('model_routing:');
    // Confirm complete render by comparing to the canonical output
    expect(written).toBe(renderMofloYaml(defaultMofloYamlConfig(root)));
  });
});

describe('validateMofloYaml — compliance check (#895 doctor)', () => {
  let root: string;
  let yamlPath: string;
  beforeEach(() => {
    root = makeTempRoot('validate');
    yamlPath = path.join(root, 'moflo.yaml');
  });
  afterEach(() => cleanRoot(root));

  it('reports exists:false when file is missing', () => {
    const result = validateMofloYaml(yamlPath);
    expect(result.exists).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.kind).toBe('parse-error');
  });

  it('reports empty when file exists but has no content', () => {
    fs.writeFileSync(yamlPath, '   \n  ', 'utf-8');
    const result = validateMofloYaml(yamlPath);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === 'empty')).toBe(true);
  });

  it('reports missing top-level sections', () => {
    fs.writeFileSync(yamlPath, 'project:\n  name: partial\n', 'utf-8');
    const result = validateMofloYaml(yamlPath);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('model_routing');
    expect(result.missingSections).toContain('sandbox');
    expect(result.missingSections).not.toContain('project');
  });

  it('reports valid:true for a freshly-created moflo.yaml', () => {
    ensureMofloYamlExists(root);
    const result = validateMofloYaml(yamlPath);
    expect(result.valid).toBe(true);
    expect(result.exists).toBe(true);
    expect(result.missingSections).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('does not throw on unparseable filesystem state — returns issues instead', () => {
    expect(() => validateMofloYaml(path.join(root, 'no', 'such', 'path.yaml'))).not.toThrow();
  });

  it('REQUIRED_TOP_LEVEL_SECTIONS contains every key the renderer emits', () => {
    const yaml = renderMofloYaml(baselineConfig);
    for (const section of REQUIRED_TOP_LEVEL_SECTIONS) {
      expect(yaml).toMatch(new RegExp(`^${section}\\s*:`, 'm'));
    }
  });
});

describe('discovery walk safety', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('walk'); });
  afterEach(() => cleanRoot(root));

  it('discoverSrcDirs ignores node_modules / dist / .moflo / .git', () => {
    for (const skip of ['node_modules', 'dist', '.moflo', '.git']) {
      fs.mkdirSync(path.join(root, skip, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, skip, 'src', 'a.ts'), '');
    }
    const dirs = discoverSrcDirs(root);
    expect(dirs).not.toContain('node_modules/src');
    expect(dirs).not.toContain('dist/src');
    expect(dirs).not.toContain('.moflo/src');
  });

  it('discoverGuidanceDirs returns empty when no guidance dirs exist', () => {
    expect(discoverGuidanceDirs(root)).toEqual([]);
  });

  it('discoverTestDirs returns empty when no test dirs exist', () => {
    expect(discoverTestDirs(root)).toEqual([]);
  });

  it('detectExtensions falls back when src/ does not exist', () => {
    expect(detectExtensions(root, ['src'])).toEqual(['.ts', '.tsx', '.js', '.jsx']);
  });
});
