/**
 * Project Root Tests
 *
 * Validates findProjectRoot() walks up from cwd to find package.json or .git.
 *
 * Story #229: Extracted from workflow-tools.ts.
 */

import { describe, it, expect } from 'vitest';
import { findProjectRoot } from '../../services/project-root.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('findProjectRoot', () => {
  it('should return a directory containing package.json or .git', () => {
    const root = findProjectRoot();
    const hasPackageJson = existsSync(resolve(root, 'package.json'));
    const hasGit = existsSync(resolve(root, '.git'));
    expect(hasPackageJson || hasGit).toBe(true);
  });

  it('should return a string path', () => {
    expect(typeof findProjectRoot()).toBe('string');
  });

  it('should return the same value on repeated calls', () => {
    expect(findProjectRoot()).toBe(findProjectRoot());
  });
});
