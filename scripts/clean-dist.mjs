#!/usr/bin/env node
// Scan each monorepo module's dist/ for orphaned build outputs whose TypeScript
// source has been renamed or deleted, and remove them.
//
// Background: after a source file rename, tsc -b writes the new output but leaves
// the old one behind, and tsc -b --clean only removes files the current build
// graph knows about — so once tsbuildinfo is rewritten post-rename, the orphan
// slips past it. Since package.json's files whitelist includes every module's
// dist js output, those orphans leak into npm pack tarballs.
//
// Exports findOrphans() for in-process use (smoke harness); runs as CLI with
// optional --check flag (exit 1 if any orphans found).
//
// See issue #505.
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const modulesRoot = join(repoRoot, 'src', 'modules');

// Order matters: longer suffixes (.d.ts.map, .js.map) must match before their
// shorter parents (.d.ts, .js) when stripping a compiled extension.
const COMPILED_EXTS = ['.d.ts.map', '.d.ts', '.js.map', '.mjs', '.cjs', '.js'];
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
const SKIP_BASENAMES = new Set(['tsconfig.tsbuildinfo']);

function stripJsonComments(s) {
  return s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function readTsconfig(path) {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`failed to parse ${path}: ${e.message}`);
  }
}

function moduleDistPaths(modDir) {
  const tsconfigPath = join(modDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;
  const cfg = readTsconfig(tsconfigPath);
  const co = cfg.compilerOptions || {};
  const outDir = resolve(modDir, co.outDir || '.');
  const rootDir = resolve(modDir, co.rootDir || '.');
  return { outDir, rootDir };
}

function stripCompiledExt(name) {
  for (const ext of COMPILED_EXTS) {
    if (name.endsWith(ext)) return { stem: name.slice(0, -ext.length), ext };
  }
  return null;
}

function hasMatchingSource(rootDir, relStem) {
  for (const ext of SOURCE_EXTS) {
    if (existsSync(join(rootDir, relStem + ext))) return true;
  }
  return false;
}

function walkDist(outDir, rootDir, out) {
  if (!existsSync(outDir)) return;
  const stack = [outDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_BASENAMES.has(d.name)) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(full);
        continue;
      }
      const parsed = stripCompiledExt(d.name);
      if (!parsed) continue;
      const relStem = relative(outDir, join(dir, parsed.stem));
      if (!hasMatchingSource(rootDir, relStem)) out.push(full);
    }
  }
}

export function findOrphans() {
  if (!existsSync(modulesRoot)) return [];
  const orphans = [];
  for (const d of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const paths = moduleDistPaths(join(modulesRoot, d.name));
    if (!paths) continue;
    walkDist(paths.outDir, paths.rootDir, orphans);
  }
  return orphans;
}

function runCli(checkMode) {
  const orphans = findOrphans();
  if (orphans.length === 0) {
    if (!checkMode) console.log('✓ clean-dist: no orphans found');
    return 0;
  }
  if (checkMode) {
    console.error(`✗ clean-dist: ${orphans.length} orphan(s) found:`);
    for (const o of orphans) console.error('  ' + relative(repoRoot, o));
    return 1;
  }
  let failed = 0;
  for (const o of orphans) {
    try {
      rmSync(o, { force: true });
    } catch (e) {
      failed++;
      console.error(`  ! failed to remove ${relative(repoRoot, o)}: ${e.message}`);
    }
  }
  const removed = orphans.length - failed;
  console.log(`✓ clean-dist: removed ${removed} orphan(s)${failed ? ` (${failed} failed)` : ''}`);
  for (const o of orphans) console.log('  ' + relative(repoRoot, o));
  return failed > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.includes('--check'));
}
