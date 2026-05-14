/**
 * Retired-agent drift guard (issue #1134).
 *
 * Companion to `published-package-drift-guard.test.ts`. PR #932 retired ~49
 * aspirational agents (and follow-ups retired more skills/agents over time),
 * but the shipped guidance docs kept enumerating the retired names — every
 * consumer install picked up `.claude/guidance/shipped/...` references to
 * `memory-specialist`, `mobile-dev`, `sparc-coord`, etc. that no longer exist.
 *
 * This test fails the build if any name that is BOTH (a) present in
 * `retired-files.json` AND (b) NOT a currently-shipped agent/skill appears
 * in any shipped guidance markdown file as a whole word.
 *
 * Path basenames in `retired-files.json` often differ from the agent's
 * canonical `name:` frontmatter handle (e.g. `analysis/code-analyzer.md` →
 * `name: analyst`), and the same basename can be both retired (old hash) AND
 * shipped (new content under the same path or a renamed path). We therefore
 * compare retired *names* against the union of (current `name:` frontmatter,
 * current file basenames, current skill directory names) before scanning.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { findRepoRoot } from '../_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SHIPPED_GUIDANCE_ROOT = join(REPO_ROOT, '.claude', 'guidance', 'shipped');
const AGENTS_ROOT = join(REPO_ROOT, '.claude', 'agents');
const SKILLS_ROOT = join(REPO_ROOT, '.claude', 'skills');
const RETIRED_MANIFEST_PATH = join(REPO_ROOT, 'retired-files.json');

// Single-word retired path basenames (e.g. `agent`, `browser`, `architecture`,
// `swarm`) collide with common nouns in shipped prose, so we restrict the
// scan to hyphenated names — every real moflo-style agent identifier
// (`mobile-dev`, `sparc-coord`, `memory-specialist`, `byzantine-coordinator`,
// …) contains at least one hyphen. The unhyphenated retired names are also
// always either still-shipped under a different path or generic English; the
// existing `published-package-drift-guard.test.ts` already enforces inventory
// invariants for the high-signal single-word identifiers it cares about.
function isStructuredAgentName(name: string): boolean {
  return name.includes('-');
}

interface RetiredManifest {
  retired: Array<{ path: string }>;
}

function loadRetiredNames(): { agents: Set<string>; skills: Set<string> } {
  const raw = JSON.parse(readFileSync(RETIRED_MANIFEST_PATH, 'utf8')) as RetiredManifest;
  const agents = new Set<string>();
  const skills = new Set<string>();
  for (const entry of raw.retired ?? []) {
    const p = entry.path.replace(/\\/g, '/');
    if (p.startsWith('.claude/agents/') && p.endsWith('.md')) {
      const name = basename(p, '.md');
      if (name === 'README') continue;
      agents.add(name);
    } else if (p.startsWith('.claude/skills/')) {
      if (p.endsWith('/SKILL.md')) {
        skills.add(basename(dirname(p)));
      } else if (p.endsWith('.md')) {
        skills.add(basename(p, '.md'));
      }
    }
  }
  return { agents, skills };
}

function* walkMd(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMd(full);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) yield full;
  }
}

function extractFrontmatterName(text: string): string | null {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const m = /^name:\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function loadCurrentNames(): Set<string> {
  const names = new Set<string>();
  if (existsSync(AGENTS_ROOT)) {
    for (const file of walkMd(AGENTS_ROOT)) {
      names.add(basename(file, '.md'));
      const text = readFileSync(file, 'utf8');
      const fmName = extractFrontmatterName(text);
      if (fmName) names.add(fmName);
    }
  }
  if (existsSync(SKILLS_ROOT)) {
    for (const entry of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (existsSync(join(SKILLS_ROOT, entry.name, 'SKILL.md'))) {
          names.add(entry.name);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        names.add(basename(entry.name, '.md'));
      }
    }
  }
  return names;
}

function trulyRetired(): Set<string> {
  const { agents, skills } = loadRetiredNames();
  const current = loadCurrentNames();
  const out = new Set<string>();
  for (const name of [...agents, ...skills]) {
    if (current.has(name)) continue;
    if (!isStructuredAgentName(name)) continue;
    out.add(name);
  }
  return out;
}

describe('retired-agent drift guard (issue #1134)', () => {
  it('shipped guidance docs contain no whole-word references to retired agent/skill names', () => {
    const retired = trulyRetired();
    expect(retired.size, 'retired manifest produced an empty set — load logic regressed').toBeGreaterThan(0);

    const offenders: string[] = [];
    if (!existsSync(SHIPPED_GUIDANCE_ROOT)) {
      throw new Error(`shipped guidance root missing: ${SHIPPED_GUIDANCE_ROOT}`);
    }

    const retiredArr = [...retired].sort();
    // Intentionally NOT using the /g flag: with /g, RegExp.prototype.test and
    // .exec share `lastIndex` state across calls, which silently skips lines
    // after the first match in the same file. We only need a single match
    // per line, so a non-global pattern is correct.
    const pattern = new RegExp(`\\b(${retiredArr.map(escapeRegex).join('|')})\\b`);

    for (const file of walkMd(SHIPPED_GUIDANCE_ROOT)) {
      const text = readFileSync(file, 'utf8');
      if (!pattern.test(text)) continue;
      const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = pattern.exec(lines[i]);
        if (!m) continue;
        offenders.push(`${rel}:${i + 1}: ${m[1]} — ${lines[i].trim().slice(0, 120)}`);
      }
    }

    expect(
      offenders,
      `Stale retired agent/skill name(s) found in shipped guidance:\n  ${offenders.join('\n  ')}\n\n` +
        `Rewrite the doc to use a currently-shipped name. The scan is restricted to hyphenated retired ` +
        `identifiers; if you're seeing a false positive, the name probably needs to be reintroduced as a ` +
        `live agent in .claude/agents/ rather than allow-listed here.`,
    ).toEqual([]);
  });

  it('loadCurrentNames includes every agent file actually on disk', () => {
    // Sanity-check that the loader catches all agents — otherwise stale-name
    // detection would over-fire for legitimate currently-shipped names that
    // happen to share a basename with a retired path.
    const names = loadCurrentNames();
    const agentFiles: string[] = [];
    if (existsSync(AGENTS_ROOT)) {
      for (const file of walkMd(AGENTS_ROOT)) agentFiles.push(file);
    }
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const file of agentFiles) {
      const base = basename(file, '.md');
      expect(names.has(base), `loadCurrentNames missing file basename: ${base}`).toBe(true);
    }
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
