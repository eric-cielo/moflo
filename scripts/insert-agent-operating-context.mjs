#!/usr/bin/env node
/**
 * #1132 Fix 3 — idempotent insertion of "## Operating context (moflo)" into
 * every moflo-shipped agent `.md` file. Inserts immediately after the YAML
 * frontmatter block. Skips files that already contain the section header.
 *
 * Usage: node scripts/insert-agent-operating-context.mjs [--check]
 *   --check : exit 1 if any shipped agent is missing the section (for CI)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENTS_DIR = resolve(__dirname, '..', '.claude', 'agents');
const SECTION_HEADER = '## Operating context (moflo)';
const SECTION_BODY = `${SECTION_HEADER}

This project uses moflo memory. **Your first tool call must be \`mcp__moflo__memory_search\`** before any Read, Grep, Glob, or read-like Bash (cat/head/tail/grep/find/sed/awk and the Windows/PowerShell equivalents).

Search these namespaces depending on your task:
- \`guidance\` — coding rules, architectural decisions, project conventions
- \`code-map\` — file structure and module relationships
- \`patterns\` — proven solutions and reusable approaches
- \`learnings\` — past corrections, anti-patterns, gotchas
- \`tests\` — test inventory and coverage

On chunk hits where \`navigation\` is non-null, traverse via \`mcp__moflo__memory_get_neighbors\`. Bulk \`mcp__moflo__memory_retrieve\` is a protocol violation — see \`.claude/guidance/moflo-memory-protocol.md\`.
`;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function isShippedAgent(src) {
  // Shipped agents declare a `name:` line inside the leading frontmatter block.
  // Skip docs / READMEs that happen to live under .claude/agents.
  if (!src.startsWith('---')) return false;
  const end = src.indexOf('\n---', 3);
  if (end < 0) return false;
  return /\n\s*name\s*:/.test(src.slice(0, end));
}

function insertAfterFrontmatter(src) {
  if (src.includes(SECTION_HEADER)) return { src, changed: false };
  if (!src.startsWith('---')) return { src, changed: false };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { src, changed: false };
  const splitAt = end + '\n---'.length;
  const head = src.slice(0, splitAt);
  const tail = src.slice(splitAt);
  // Ensure exactly one blank line between frontmatter and the new section,
  // and one blank line between the new section and existing body.
  const tailTrimmed = tail.replace(/^\n+/, '');
  return {
    src: `${head}\n\n${SECTION_BODY}\n${tailTrimmed}`,
    changed: true,
  };
}

const check = process.argv.includes('--check');
const files = walk(AGENTS_DIR).sort();
const missing = [];
let updated = 0;
let skipped = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf-8');
  if (!isShippedAgent(src)) {
    continue;
  }
  if (src.includes(SECTION_HEADER)) {
    skipped++;
    continue;
  }
  if (check) {
    missing.push(file);
    continue;
  }
  const { src: next, changed } = insertAfterFrontmatter(src);
  if (changed) {
    writeFileSync(file, next, 'utf-8');
    updated++;
  }
}

if (check) {
  if (missing.length > 0) {
    console.error(`${missing.length} shipped agent(s) missing "${SECTION_HEADER}":`);
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  console.log(`OK: all ${files.length} agent file(s) audited; section present where required.`);
} else {
  console.log(`Updated ${updated} agent file(s); ${skipped} already had the section.`);
}
