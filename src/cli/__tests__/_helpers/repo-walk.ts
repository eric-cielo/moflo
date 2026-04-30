import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_WALK_DEPTH = 12;

export function findRepoRoot(callerUrl: string): string {
  let dir = dirname(fileURLToPath(callerUrl));
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    if (isMofloRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `findRepoRoot: could not locate moflo repo root (walked ${MAX_WALK_DEPTH} levels up from ${callerUrl})`,
  );
}

function isMofloRepoRoot(dir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'package.json'), 'utf-8');
  } catch {
    return false;
  }
  try {
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name !== 'moflo') return false;
  } catch {
    return false;
  }
  try {
    return statSync(join(dir, 'src', 'cli')).isDirectory();
  } catch {
    return false;
  }
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MAX_BYTES = 5_000_000;

export function* walkSource(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkSource(full);
      continue;
    }
    if (!entry.isFile()) continue;

    const dotIdx = entry.name.lastIndexOf('.');
    if (dotIdx === -1) continue;
    if (!EXTENSIONS.has(entry.name.slice(dotIdx))) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (/\.(test|spec)\.[mc]?[jt]sx?$/.test(entry.name)) continue;
    if (statSync(full).size > MAX_BYTES) continue;
    yield full;
  }
}
