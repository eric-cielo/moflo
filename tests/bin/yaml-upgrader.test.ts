/**
 * Tests for bin/lib/yaml-upgrader.mjs — the idempotent section upgrader
 * that keeps existing moflo.yaml files current without requiring re-init.
 *
 * See: .claude/guidance/internal/upgrade-contract.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { makeTempRoot, cleanTempRoot } from './_helpers.js';

// Dynamic import so Vitest can resolve the .mjs from this .ts test file.
const upgraderUrl = 'file://' + resolve(__dirname, '../../bin/lib/yaml-upgrader.mjs').replace(/\\/g, '/');
const {
  REQUIRED_SECTIONS,
  RENAMED_SECTIONS,
  hasTopLevelSection,
  missingSections,
  ensureYamlSections,
  renameYamlSections,
} = await import(upgraderUrl);

describe('yaml-upgrader', () => {
  let root: string;
  let yamlPath: string;

  beforeEach(() => {
    root = makeTempRoot('yaml-upgrader');
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

    it('appends auto_meditate block (default-on) when missing (#1198)', () => {
      writeFileSync(yamlPath, 'project:\n  name: foo\n', 'utf-8');
      const appended = ensureYamlSections(yamlPath);

      expect(appended).toContain('auto_meditate');
      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toMatch(/^auto_meditate:/m);
      expect(content).toContain('enabled: true');
    });

    it('is idempotent when all required sections are already present', () => {
      const existing =
        'project:\n  name: foo\n' +
        'session_continuity:\n  capture: true\n  inject: true\n' +
        'auto_meditate:\n  enabled: false\n' +
        'sandbox:\n  enabled: true\n  tier: full\n';
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

  describe('renameYamlSections (auto_reflect → auto_meditate migration)', () => {
    it('RENAMED_SECTIONS maps the legacy auto_reflect key to auto_meditate', () => {
      expect(RENAMED_SECTIONS).toEqual(
        expect.arrayContaining([{ from: 'auto_reflect', to: 'auto_meditate' }]),
      );
    });

    it('renames a legacy auto_reflect block in place, preserving the user value', () => {
      writeFileSync(yamlPath, 'project:\n  name: foo\nauto_reflect:\n  enabled: false\n', 'utf-8');
      const applied = renameYamlSections(yamlPath);
      expect(applied).toContain('auto_reflect→auto_meditate');
      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toMatch(/^auto_meditate:/m);
      expect(content).not.toMatch(/^auto_reflect:/m);
      expect(content).toContain('enabled: false'); // the user's opt-out survives the rebrand
    });

    it('ensureYamlSections migrates auto_reflect in place without appending a duplicate', () => {
      writeFileSync(yamlPath, 'project:\n  name: foo\nauto_reflect:\n  enabled: false\n', 'utf-8');
      ensureYamlSections(yamlPath);
      const content = readFileSync(yamlPath, 'utf-8');
      expect(content).toMatch(/^auto_meditate:/m);
      expect(content).not.toMatch(/^auto_reflect:/m);
      expect((content.match(/^auto_meditate:/gm) || []).length).toBe(1);
      expect(content).toContain('enabled: false');
    });

    it('is a no-op when auto_meditate already exists', () => {
      const existing = 'project:\n  name: foo\nauto_meditate:\n  enabled: true\n';
      writeFileSync(yamlPath, existing, 'utf-8');
      expect(renameYamlSections(yamlPath)).toEqual([]);
      expect(readFileSync(yamlPath, 'utf-8')).toBe(existing);
    });
  });

  describe('init template parity', () => {
    it('init template contains a sandbox block identical in intent to the registry', () => {
      // The two sources of truth must stay in sync: the canonical YAML template
      // (moflo-yaml-template.ts, used by both `flo init` and the session-start
      // self-heal in #895) emits the same block for new projects that
      // yaml-upgrader appends to existing ones.
      const tplPath = resolve(__dirname, '../../src/cli/init/moflo-yaml-template.ts');
      const tplSource = readFileSync(tplPath, 'utf-8');
      const sandboxEntry = REQUIRED_SECTIONS.find((s: any) => s.key === 'sandbox');
      expect(sandboxEntry).toBeTruthy();

      // The template must define sandbox and share the key config lines
      expect(tplSource).toContain('sandbox:');
      expect(tplSource).toContain('enabled: false');
      expect(tplSource).toContain('tier: auto');
    });
  });
});
