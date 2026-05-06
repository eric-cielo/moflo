/**
 * Consumer-bound reference gate (#934).
 *
 * Enforces `.claude/guidance/internal/consumer-bound-references.md`:
 * any text that ships to consumers (shipped guidance See Also, skill SKILL.md,
 * shipped agents/commands, runtime subagent directive, injected CLAUDE.md
 * templates) must reference moflo guidance docs at the consumer destination
 * path `.claude/guidance/<file>.md` — never the source `.claude/guidance/shipped/<file>.md`,
 * which only exists inside moflo's own repo and inside `node_modules/moflo/`.
 *
 * The gate distinguishes consumer-bound directives from descriptive source-tree
 * references. A path preceded by `moflo/` (covering both
 * `node_modules/moflo/.claude/guidance/shipped/moflo-…` and
 * `Source: moflo/.claude/guidance/shipped/moflo-…` style headers) is descriptive
 * context and allowed. Anything else is a directive Claude will try to resolve,
 * which will ENOENT on every consumer.
 *
 * If this test fires on a new file, either: (1) strip `shipped/` from the path
 * to use the consumer mirror, or (2) qualify the path with a `moflo/` prefix
 * if it's intentional descriptive context.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ROOT = resolve(__dirname, '../..');

// Directories whose contents ship to consumers (full recursive scan).
const CONSUMER_BOUND_DIRS = [
  '.claude/guidance/shipped',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
];

// Individual files that ship or generate consumer-bound text at runtime.
const CONSUMER_BOUND_FILES = [
  '.claude/helpers/subagent-bootstrap.json',
  '.claude/helpers/subagent-start.cjs',
  'src/cli/services/subagent-bootstrap.ts',
  'src/cli/init/claudemd-generator.ts',
  'src/cli/init/moflo-init.ts',
  'bin/setup-project.mjs',
];

// Globs to keep file enumeration tight — text-bearing surfaces only.
const TEXT_EXTENSIONS = ['.md', '.json', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sh'];

function walkText(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkText(abs));
    } else if (entry.isFile() && TEXT_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      out.push(abs);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(absFile: string): Violation[] {
  const violations: Violation[] = [];
  let content: string;
  try {
    content = readFileSync(absFile, 'utf-8');
  } catch {
    return violations;
  }
  // Fast path: skip files that don't contain the banned substring at all.
  // The vast majority of scanned files have zero matches.
  if (!content.includes('.claude/guidance/shipped/moflo-')) return violations;
  const lines = content.split(/\r?\n/);
  const rel = absFile.startsWith(ROOT + sep)
    ? absFile.slice(ROOT.length + 1).split(sep).join('/')
    : absFile;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const re = /\.claude\/guidance\/shipped\/moflo-/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const before = line.slice(0, match.index);
      // Allow when preceded by `moflo/` — descriptive source-tree path
      // (e.g. `node_modules/moflo/.claude/guidance/shipped/moflo-...`,
      //       `Source: moflo/.claude/guidance/shipped/moflo-...`).
      if (/moflo\/$/.test(before)) continue;
      violations.push({ file: rel, line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

function gatherTargets(): string[] {
  const targets: string[] = [];
  for (const rel of CONSUMER_BOUND_DIRS) {
    const abs = resolve(ROOT, rel);
    if (existsSync(abs)) targets.push(...walkText(abs));
  }
  for (const rel of CONSUMER_BOUND_FILES) {
    const abs = resolve(ROOT, rel);
    if (existsSync(abs)) targets.push(abs);
  }
  return targets;
}

describe('consumer-bound cross-reference paths', () => {
  const targets = gatherTargets();

  it('finds at least the expected consumer-bound surfaces', () => {
    // Sanity: if this drops to zero, the path lists above silently broke.
    expect(targets.length).toBeGreaterThan(20);
  });

  it('no consumer-bound file references `.claude/guidance/shipped/moflo-…` as a directive', () => {
    const allViolations: Violation[] = [];
    for (const abs of targets) {
      allViolations.push(...findViolations(abs));
    }
    if (allViolations.length > 0) {
      const summary = allViolations
        .slice(0, 30)
        .map(v => `  ${v.file}:${v.line}: ${v.text}`)
        .join('\n');
      const more = allViolations.length > 30 ? `\n  …and ${allViolations.length - 30} more` : '';
      expect.fail(
        `Found ${allViolations.length} consumer-bound \`shipped/\` reference(s).\n` +
        `Strip \`shipped/\` (use \`.claude/guidance/<file>.md\`) or qualify with \`moflo/\` if intentional descriptive context.\n` +
        `See .claude/guidance/internal/consumer-bound-references.md.\n\n` +
        summary + more,
      );
    }
  });
});
