/**
 * Tests for bin/lib/yaml-upgrader.mjs — the idempotent section upgrader
 * that keeps existing moflo.yaml files current without requiring re-init.
 *
 * See: .claude/guidance/internal/upgrade-contract.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';

// Dynamic import so Vitest can resolve the .mjs from this .ts test file.
const upgraderUrl = 'file://' + resolve(__dirname, '../../bin/lib/yaml-upgrader.mjs').replace(/\\/g, '/');
const {
  REQUIRED_SECTIONS,
  hasTopLevelSection,
  missingSections,
  ensureYamlSections,
} = await import(upgraderUrl);

function makeTempRoot(): string {
  const root = resolve(__dirname, '../../.testoutput/.test-yaml-upgrader-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(root, { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('yaml-upgrader', () => {
  let root: string;
  let yamlPath: string;

  beforeEach(() => {
    root = makeTempRoot();
    yamlPath = resolve(root, 'moflo.yaml');
  });
  afterEach(() => cleanTempRoot(root));

  describe('REQUIRED_SECTIONS registry', () => {
    it('includes sandbox as a registered section', () => {
      const keys = REQUIRED_SECTIONS.map((s: any) => s.key);
      expect(keys).toContain('sandbox');
    });

    it('each section has a key and a block that starts with a comment', () => {
      for (const section of REQUIRED_SECTIONS) {
        expect(typeof section.key).toBe('string');
        expect(section.key.length).toBeGreaterThan(0);
        expect(typeof section.block).toBe('string');
        expect(section.block.trim().startsWith('#')).toBe(true);
        expect(section.block).toContain(`${section.key}:`);
      }
    });
  });

  describe('hasTopLevelSection', () => {
    it('finds top-level keys', () => {
      const yaml = 'project:\n  name: foo\nsandbox:\n  enabled: true\n';
      expect(hasTopLevelSection(yaml, 'project')).toBe(true);
      expect(hasTopLevelSection(yaml, 'sandbox')).toBe(true);
    });

    it('returns false for nested keys', () => {
      const yaml = 'project:\n  enabled: true\n';
      expect(hasTopLevelSection(yaml, 'enabled')).toBe(false);
    });

    it('returns false for missing keys', () => {
      const yaml = 'project:\n  name: foo\n';
      expect(hasTopLevelSection(yaml, 'sandbox')).toBe(false);
    });
  });

  describe('missingSections', () => {
    it('returns all registered sections when yaml is empty', () => {
      const missing = missingSections('');
      expect(missing).toEqual(REQUIRED_SECTIONS.map((s: any) => s.key));
    });

    it('returns only sections the yaml lacks', () => {
      const yaml = 'sandbox:\n  enabled: true\n';
      const missing = missingSections(yaml);
      expect(missing).not.toContain('sandbox');
    });
  });

  describe('ensureYamlSections', () => {
    it('returns empty list when yaml file does not exist', () => {
      const result = ensureYamlSections(yamlPath);
      expect(result).toEqual([]);
      expect(existsSync(yamlPath)).toBe(false);
    });

    it('appends sandbox block when missing', () => {
      writeFileSync(yamlPath, 'project:\n  name: foo\n', 'utf-8');
      const appended = ensureYamlSections(yamlPath);

      expect(appended).toContain('sandbox');
      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toMatch(/^sandbox:/m);
      expect(content).toContain('enabled: false');
      expect(content).toContain('tier: auto');
    });

    it('is idempotent when sandbox is already present', () => {
      const existing = 'project:\n  name: foo\nsandbox:\n  enabled: true\n  tier: full\n';
      writeFileSync(yamlPath, existing, 'utf-8');

      const firstRun = ensureYamlSections(yamlPath);
      expect(firstRun).toEqual([]);
      expect(readFileSync(yamlPath, 'utf-8')).toBe(existing);

      const secondRun = ensureYamlSections(yamlPath);
      expect(secondRun).toEqual([]);
      expect(readFileSync(yamlPath, 'utf-8')).toBe(existing);
    });

    it('never modifies existing user values in other sections', () => {
      const existing = 'project:\n  name: my-app\nmodels:\n  default: opus\n';
      writeFileSync(yamlPath, existing, 'utf-8');

      ensureYamlSections(yamlPath);

      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('name: my-app');
      expect(content).toContain('default: opus');
      // And the appended block shows up at the end
      expect(content).toMatch(/sandbox:\s*\n\s+enabled: false/);
    });

    it('preserves original content byte-for-byte before the appended block', () => {
      const existing = 'project:\n  name: foo\n';
      writeFileSync(yamlPath, existing, 'utf-8');

      ensureYamlSections(yamlPath);

      const content = readFileSync(yamlPath, 'utf-8');
      expect(content.startsWith(existing)).toBe(true);
    });

    it('works with a custom registry', () => {
      writeFileSync(yamlPath, 'project:\n  name: foo\n', 'utf-8');
      const customRegistry = [
        { key: 'custom_feature', block: '# Custom\ncustom_feature:\n  on: true\n' },
      ];
      const appended = ensureYamlSections(yamlPath, customRegistry);
      expect(appended).toEqual(['custom_feature']);
      expect(readFileSync(yamlPath, 'utf-8')).toMatch(/^custom_feature:/m);
    });
  });

  describe('init template parity', () => {
    it('init template contains a sandbox block identical in intent to the registry', () => {
      // The two sources of truth must stay in sync: moflo-init.ts template emits
      // the same block for new projects that yaml-upgrader appends to existing ones.
      const initPath = resolve(__dirname, '../../src/modules/cli/src/init/moflo-init.ts');
      const initSource = readFileSync(initPath, 'utf-8');
      const sandboxEntry = REQUIRED_SECTIONS.find((s: any) => s.key === 'sandbox');
      expect(sandboxEntry).toBeTruthy();

      // The template must define sandbox and share the key config lines
      expect(initSource).toContain('sandbox:');
      expect(initSource).toContain('enabled: false');
      expect(initSource).toContain('tier: auto');
    });
  });
});
