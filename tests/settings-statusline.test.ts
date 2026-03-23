/**
 * Tests for statusLine configuration in settings-generator.ts
 *
 * Validates that:
 * 1. statusLine is included in settings.json when components.statusline is true
 * 2. statusLine is included when options.statusline.enabled is true
 * 3. statusLine command uses the correct helper script path
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('settings-generator statusLine config', () => {
  const generatorPath = resolve(__dirname, '../src/@claude-flow/cli/src/init/settings-generator.ts');

  it('checks both components.statusline and statusline.enabled', () => {
    const content = readFileSync(generatorPath, 'utf-8');

    // The guard should use options.components.statusline OR options.statusline?.enabled
    // Previously it only checked options.statusline.enabled, missing cases where
    // components.statusline was true but statusline.enabled was unset
    expect(content).toMatch(/options\.components\.statusline\s*\|\|\s*options\.statusline\??\.\s*enabled/);
  });

  it('generates statusLine with correct command format', () => {
    const content = readFileSync(generatorPath, 'utf-8');

    // The statusLine command should reference the local helper script
    expect(content).toContain('statusline.cjs');
    expect(content).toContain("type: 'command'");
  });

  it('statusLine command does not use cmd /c wrapper', () => {
    const content = readFileSync(generatorPath, 'utf-8');

    // Per the comment in the source: statusline must NOT use cmd /c
    // Claude Code manages stdin directly for statusline commands
    const statusLineSection = content.slice(
      content.indexOf('generateStatusLineConfig'),
      content.indexOf('}', content.indexOf('generateStatusLineConfig') + 200) + 1
    );
    expect(statusLineSection).not.toContain('cmd /c');
  });
});
