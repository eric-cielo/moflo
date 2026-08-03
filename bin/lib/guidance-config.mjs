/**
 * Single source of truth for reading the `guidance:` block out of a project's
 * moflo.yaml / moflo.config.json.
 *
 * Why this is shared rather than parsed per-caller (#1323): the guidance
 * INDEXER honoured `guidance.directories` while the guidance step GATE
 * fingerprinted a hardcoded `.claude/guidance`. Any configured directory
 * beyond that default was indexed but never fingerprinted, so edits there
 * never invalidated the gate and the guidance namespace went stale
 * indefinitely — with embeddings regenerated from the same stale rows, so
 * nothing downstream detected the drift. Two components disagreeing about one
 * config key is the bug; duplicating the parse a third time would re-create it.
 *
 * Contract: never throws. A missing, unreadable, or malformed config yields
 * `{ directories: null, specsDir: null }` and callers apply their own defaults.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/** Default guidance directories when nothing is configured. */
export const DEFAULT_GUIDANCE_DIRS = ['.claude/guidance', 'docs/guides'];

// Parsing is cheap but the gate calls this twice per step (pre + post), and
// `index-all` runs several steps per session-start. Cache per project root.
const _configCache = new Map();

function parseYaml(content) {
  let directories = null;
  let specsDir = null;

  // sdd.specs_dir (snake_case or camelCase, quoted or bare). Two-step: isolate
  // the top-level `sdd:` block (up to the next column-0 key, blank lines
  // included — a naive contiguous-line regex breaks on whitespace between
  // keys, #1294 review), then find specs_dir within it.
  const sddBlock = content.match(/(?:^|\n)[ \t]*sdd:[ \t]*\n([\s\S]*?)(?=\n\S|$)/);
  if (sddBlock) {
    const m = sddBlock[1].match(/(?:^|\n)[ \t]+specs_?[dD]ir:[ \t]*["']?([^"'\n#]+)/);
    if (m && m[1].trim()) specsDir = m[1].trim();
  }

  // Simple YAML array extraction — avoids needing js-yaml at runtime.
  // Matches:  guidance:\n    directories:\n      - .claude/guidance\n      - docs/guides
  const guidanceBlock = content.match(/guidance:\s*\n\s+directories:\s*\n((?:\s+-\s+.+\n?)+)/);
  if (guidanceBlock) {
    const items = guidanceBlock[1].match(/-\s+(.+)/g);
    if (items && items.length > 0) {
      const parsed = items
        .map(item => item.replace(/^-\s+/, '').trim())
        // Strip inline comments and surrounding quotes; drop empties so a
        // malformed entry can't produce a directory that resolves to the root.
        .map(d => d.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
      if (parsed.length > 0) directories = parsed;
    }
  }

  return { directories, specsDir };
}

function parseJson(raw) {
  let directories = null;
  let specsDir = null;

  if (Array.isArray(raw?.guidance?.directories)) {
    const parsed = raw.guidance.directories
      .filter(d => typeof d === 'string')
      .map(d => d.trim())
      .filter(Boolean);
    if (parsed.length > 0) directories = parsed;
  }

  const sd = raw?.sdd?.specs_dir ?? raw?.sdd?.specsDir;
  if (typeof sd === 'string' && sd.trim()) specsDir = sd.trim();

  return { directories, specsDir };
}

/**
 * Read the guidance config for `projectRoot`.
 *
 * @returns {{ directories: string[] | null, specsDir: string | null }}
 *   `directories` is null when unset or malformed — callers decide the default.
 */
export function readGuidanceConfig(projectRoot) {
  const cached = _configCache.get(projectRoot);
  if (cached) return cached;

  let result = { directories: null, specsDir: null };
  try {
    const yamlPath = resolve(projectRoot, 'moflo.yaml');
    const jsonPath = resolve(projectRoot, 'moflo.config.json');
    if (existsSync(yamlPath)) {
      result = parseYaml(readFileSync(yamlPath, 'utf-8'));
    } else if (existsSync(jsonPath)) {
      result = parseJson(JSON.parse(readFileSync(jsonPath, 'utf-8')));
    }
  } catch {
    // Malformed config must not break indexing or gating — fall back to
    // defaults rather than throwing out of a session-start hook.
  }

  _configCache.set(projectRoot, result);
  return result;
}

/**
 * Guidance directories for `projectRoot`, with defaults applied.
 * Always returns a non-empty array of repo-relative paths.
 */
export function resolveGuidanceDirs(projectRoot) {
  const { directories } = readGuidanceConfig(projectRoot);
  return directories && directories.length > 0 ? directories : [...DEFAULT_GUIDANCE_DIRS];
}

/** Test seam — drop memoised config (the file is read once per process). */
export function _resetGuidanceConfigCache() {
  _configCache.clear();
}
