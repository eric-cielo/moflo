/**
 * Tests for discoverTestDirs() and the canonical YAML template.
 *
 * After #895 the discovery walks + YAML render moved to moflo-yaml-template.ts
 * (single source of truth shared by `flo init` and the session-start self-heal).
 * moflo-init.ts re-exports `discoverTestDirs` for backward compatibility.
 *
 * Verifies test directory discovery logic:
 * - Finds top-level test dirs (tests/, test/, __tests__/, spec/, e2e/)
 * - Walks for colocated __tests__ dirs inside src
 * - Skips excluded dirs (node_modules, dist, etc.)
 * - moflo.yaml gets tests section with auto_index.tests flag
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const INIT_FILE = path.resolve(__dirname, '../src/cli/init/moflo-init.ts');
const TEMPLATE_FILE = path.resolve(__dirname, '../src/cli/init/moflo-yaml-template.ts');

describe('moflo-init.ts test directory support', () => {
  let initContent: string;
  let templateContent: string;

  beforeEach(() => {
    initContent = fs.readFileSync(INIT_FILE, 'utf-8');
    templateContent = fs.readFileSync(TEMPLATE_FILE, 'utf-8');
  });

  it('exports discoverTestDirs function', () => {
    // discoverTestDirs is defined in moflo-yaml-template.ts and re-exported
    // from moflo-init.ts for backward compatibility.
    expect(templateContent).toContain('export function discoverTestDirs');
    expect(initContent).toContain('export { discoverTestDirs }');
  });

  it('checks common test directory names', () => {
    // Should check: tests, test, __tests__, spec, e2e
    expect(templateContent).toContain("'tests'");
    expect(templateContent).toContain("'test'");
    expect(templateContent).toContain("'__tests__'");
    expect(templateContent).toContain("'spec'");
    expect(templateContent).toContain("'e2e'");
  });

  it('walks for colocated __tests__ dirs', () => {
    expect(templateContent).toContain("entry.name === '__tests__'");
  });

  it('skips excluded directories', () => {
    // WALK_SKIP_DIRS in moflo-yaml-template.ts excludes standard dirs
    expect(templateContent).toContain("'node_modules'");
    expect(templateContent).toContain("'dist'");
  });

  it('MofloInitAnswers interface includes tests fields', () => {
    expect(initContent).toContain('tests: boolean');
    expect(initContent).toContain('testDirs: string[]');
  });

  it('generateConfig includes tests section in YAML', () => {
    expect(templateContent).toContain('# Test file discovery and indexing');
    expect(templateContent).toContain('namespace: tests');
    expect(templateContent).toContain('patterns: ["*.test.*", "*.spec.*", "*.test-*"]');
  });

  it('auto_index includes tests flag', () => {
    // The render takes a fully-resolved config; the answers default-merge happens
    // in moflo-init.ts before calling renderMofloYaml.
    expect(templateContent).toMatch(/auto_index:\s*\n\s+guidance: \$\{guidance\}/);
    expect(templateContent).toContain('tests: ${tests}');
    expect(initContent).toContain('tests: answers?.tests ?? true');
  });

  it('defaultAnswers includes test discovery', () => {
    expect(initContent).toContain('discoverTestDirs(root)');
  });

  // SCRIPT_MAP membership is asserted strictly in init-copy-maps.test.ts
  // ('shipped script lists agree across all sync sites'), which extracts the
  // block and diffs all 3 sync sites — strictly stronger than a loose toContain.
});
