/**
 * Tests for @moflo/guidance package build configuration
 *
 * Validates that:
 * 1. The guidance package has source files
 * 2. The tsconfig.json is configured to output to dist/
 * 3. The package.json exports reference dist/ paths
 * 4. The prepublishOnly script includes guidance build
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const guidancePkgDir = resolve(__dirname, '../src/packages/guidance');
const rootPkgPath = resolve(__dirname, '../package.json');

describe('@moflo/guidance package build', () => {
  it('has TypeScript source files', () => {
    const srcDir = resolve(guidancePkgDir, 'src');
    expect(existsSync(srcDir)).toBe(true);

    const tsFiles = readdirSync(srcDir).filter(f => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
    expect(tsFiles).toContain('compiler.ts');
    expect(tsFiles).toContain('retriever.ts');
    expect(tsFiles).toContain('gates.ts');
  });

  it('has tsconfig.json targeting dist/', () => {
    const tsconfigPath = resolve(guidancePkgDir, 'tsconfig.json');
    expect(existsSync(tsconfigPath)).toBe(true);

    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    expect(tsconfig.compilerOptions.rootDir).toBe('./src');
  });

  it('package.json exports reference dist/ paths', () => {
    const pkgPath = resolve(guidancePkgDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.exports['.']).toHaveProperty('import', './dist/index.js');
    expect(pkg.exports['./compiler']).toHaveProperty('import', './dist/compiler.js');
    expect(pkg.exports['./retriever']).toHaveProperty('import', './dist/retriever.js');
    expect(pkg.exports['./gates']).toHaveProperty('import', './dist/gates.js');
  });

  it('root package.json includes guidance dist in files array', () => {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    const files: string[] = rootPkg.files || [];

    expect(files.some((f: string) => f.includes('packages/guidance/dist'))).toBe(true);
  });

  it('root package.json has prepublishOnly that triggers build', () => {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    const prepublish = rootPkg.scripts?.prepublishOnly || '';

    // tsc -b builds guidance via project references, so prepublishOnly
    // just needs to run the build (which includes guidance)
    expect(prepublish).toContain('build');
  });

  it('root package.json has build:guidance script', () => {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    const buildGuidance = rootPkg.scripts?.['build:guidance'] || '';

    expect(buildGuidance).toContain('packages/guidance');
    expect(buildGuidance).toContain('tsc');
  });
});
