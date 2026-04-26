import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';

export function makeTempRoot(label: string): string {
  const root = resolve(
    __dirname,
    `../../.testoutput/.test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

export function cleanTempRoot(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}
