// YAML line-editor: rewrite `arguments.<key>.default` without a full
// round-trip through js-yaml (which would drop comments). Anchors and
// block-scalar defaults are listed in `skipped` so callers can surface them.

import * as yaml from 'js-yaml';

export interface UpdateArgDefaultsResult {
  readonly content: string;
  readonly updated: readonly string[];
  readonly skipped: readonly string[];
}

const ARGUMENTS_HEADER_RE = /^arguments\s*:\s*(?:#.*)?$/;
const KEY_LINE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const DEFAULT_LINE_RE = /^(\s*default\s*:\s*)(?:[^#\n]*?)(\s*#.*)?$/;
const BLOCK_SCALAR_DEFAULT_RE = /^\s*default\s*:\s*[|>][+-]?\d*\s*(?:#.*)?$/;

export function updateYamlArgDefaults(
  yamlContent: string,
  updates: Record<string, unknown>,
): UpdateArgDefaultsResult {
  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) {
    return { content: yamlContent, updated: [], skipped: [] };
  }

  const usesCRLF = /\r\n/.test(yamlContent);
  const normalized = usesCRLF ? yamlContent.replace(/\r\n/g, '\n') : yamlContent;
  const lines = normalized.split('\n');
  const argumentsLineIdx = findArgumentsHeader(lines);
  if (argumentsLineIdx === -1) {
    return { content: yamlContent, updated: [], skipped: updateKeys };
  }

  const argKeyIndent = findArgKeyIndent(lines, argumentsLineIdx);
  if (argKeyIndent === -1) {
    return { content: yamlContent, updated: [], skipped: updateKeys };
  }

  const remaining = new Set(updateKeys);
  const updated: string[] = [];
  const skippedExtra: string[] = [];
  let i = argumentsLineIdx + 1;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    if (!stripped || stripped.startsWith('#')) {
      i++;
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent === 0) break;

    if (indent !== argKeyIndent) {
      i++;
      continue;
    }

    const m = KEY_LINE_RE.exec(line);
    if (!m) { i++; continue; }
    const argName = m[2];

    if (!remaining.has(argName)) {
      i = skipBlock(lines, i + 1, argKeyIndent);
      continue;
    }

    const blockStart = i + 1;
    const blockEnd = skipBlock(lines, blockStart, argKeyIndent);
    const propIndent = findPropIndent(lines, blockStart, blockEnd, argKeyIndent);
    const defaultLineIdx = findDefaultLine(lines, blockStart, blockEnd, propIndent);
    const newValueStr = formatYamlValue(updates[argName]);

    // Refuse to touch block-scalar defaults — replacing the header line with
    // an inline scalar would orphan the continuation lines as sibling keys.
    if (defaultLineIdx !== -1 && BLOCK_SCALAR_DEFAULT_RE.test(lines[defaultLineIdx])) {
      skippedExtra.push(argName);
      remaining.delete(argName);
      i = skipBlock(lines, i + 1, argKeyIndent);
      continue;
    }
    // Refuse multi-line dumped values for the same orphan-line reason.
    if (newValueStr.includes('\n')) {
      skippedExtra.push(argName);
      remaining.delete(argName);
      i = skipBlock(lines, i + 1, argKeyIndent);
      continue;
    }

    if (defaultLineIdx !== -1) {
      lines[defaultLineIdx] = replaceDefaultValue(lines[defaultLineIdx], newValueStr);
    } else {
      const insertIndent = ' '.repeat(propIndent);
      lines.splice(blockStart, 0, `${insertIndent}default: ${newValueStr}`);
    }

    updated.push(argName);
    remaining.delete(argName);
    i = skipBlock(lines, i + 1, argKeyIndent);
  }

  const joined = lines.join('\n');
  const content = usesCRLF ? joined.replace(/\n/g, '\r\n') : joined;
  return {
    content,
    updated,
    skipped: [...remaining, ...skippedExtra],
  };
}

function findArgumentsHeader(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (leadingSpaces(lines[i]) === 0 && ARGUMENTS_HEADER_RE.test(lines[i].trim())) {
      return i;
    }
  }
  return -1;
}

function findArgKeyIndent(lines: readonly string[], headerIdx: number): number {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const indent = leadingSpaces(lines[i]);
    if (indent === 0) return -1;
    return indent;
  }
  return -1;
}

function findPropIndent(
  lines: readonly string[],
  blockStart: number,
  blockEnd: number,
  argKeyIndent: number,
): number {
  for (let j = blockStart; j < blockEnd; j++) {
    const stripped = lines[j].trim();
    if (!stripped || stripped.startsWith('#')) continue;
    return leadingSpaces(lines[j]);
  }
  return argKeyIndent + 2;
}

function findDefaultLine(
  lines: readonly string[],
  blockStart: number,
  blockEnd: number,
  propIndent: number,
): number {
  for (let j = blockStart; j < blockEnd; j++) {
    const stripped = lines[j].trim();
    if (!stripped || stripped.startsWith('#')) continue;
    if (leadingSpaces(lines[j]) !== propIndent) continue;
    if (/^default\s*:/.test(stripped)) return j;
  }
  return -1;
}

function skipBlock(lines: readonly string[], start: number, parentIndent: number): number {
  for (let i = start; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith('#')) continue;
    if (leadingSpaces(lines[i]) <= parentIndent) return i;
  }
  return lines.length;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function replaceDefaultValue(line: string, newValue: string): string {
  const m = DEFAULT_LINE_RE.exec(line);
  if (!m) return line;
  const prefix = m[1];
  const trailingComment = m[2] ?? '';
  return `${prefix}${newValue}${trailingComment}`;
}

export function formatYamlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  // js-yaml >=5 defaults newline-containing strings to a block scalar (`|`),
  // which is multi-line and gets rejected by the single-line `default:`
  // replacement below. Force inline double-quoting (escaped `\n`) for those so
  // they stay on one physical line — matching the pre-5 inline behavior.
  const needsInlineQuoting = typeof value === 'string' && /[\r\n]/.test(value);
  const dumped = yaml.dump(value, {
    flowLevel: 0,
    lineWidth: -1,
    noRefs: true,
    ...(needsInlineQuoting ? { forceQuotes: true, quotingType: '"' as const } : {}),
  }).replace(/\r?\n$/, '');
  return dumped;
}
