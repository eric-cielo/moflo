/**
 * Guard: a worked example in a shipped agent persona must be executable (#1330).
 *
 * `planner.md` demonstrated task orchestration by storing a subtask breakdown as
 * a JSON blob in memory and then polling `task_status { taskId:
 * "auth-implementation" }`. That ID was never submitted to anything —
 * `task_create` / `task_orchestrate` were never called — so the poll could only
 * ever come back empty. Both calls individually "succeed", so nothing errors;
 * the reader just gets a breakdown nothing dispatches.
 *
 * The cost was not hypothetical: an external audit read that example and
 * concluded `mcp__moflo__task_*` was "wired to nothing" and should be retired.
 * The tools are fully wired (#1329) — the example was what was broken. A
 * persona is the worked example someone copies, so a wrong one is worse than
 * none.
 *
 * These personas ship to every consumer (`.claude/agents/**` is synced by
 * `flo init`), which is why this is pinned rather than fixed once. The checks
 * run against the LIVE tool registry, so a schema change that invalidates a
 * documented call fails here rather than in a consumer's session.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

import { listMCPTools } from '../../src/cli/mcp-client.js';

const REPO_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(REPO_ROOT, '.claude/agents');

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const PERSONAS = markdownFiles(AGENTS_DIR).map((path) => ({
  path,
  rel: relative(REPO_ROOT, path).replace(/\\/g, '/'), // Rule #1: stable ids on Windows
  text: readFileSync(path, 'utf-8').replace(/\r\n/g, '\n'),
}));

/**
 * Tool schemas as the server actually exposes them — not a copy.
 *
 * The registry keys are BARE names (`memory_store`); the `mcp__moflo__` prefix
 * is what the MCP server prepends when publishing them, and is how personas
 * spell them. Keyed both ways so the guard reads naturally either side.
 */
const SCHEMAS = new Map(
  listMCPTools().flatMap((t) => [
    [t.name, t.inputSchema] as const,
    [`mcp__moflo__${t.name}`, t.inputSchema] as const,
  ]),
);

/**
 * Documented `mcp__moflo__<tool> { ... }` calls, with the argument names used.
 *
 * Deliberately shallow: it reads the top-level `key:` tokens of the call's
 * brace block and ignores nested object bodies, which is all the schema check
 * needs and keeps the parser from needing to be a JS parser. Known limit — a
 * brace inside a string literal would throw the depth count off. No persona
 * has one; if that changes, this fails loudly rather than passing silently,
 * which is the right way round for a guard.
 */
function documentedCalls(text: string): Array<{ tool: string; args: string[]; line: number }> {
  const calls: Array<{ tool: string; args: string[]; line: number }> = [];
  const re = /mcp__moflo__([a-z0-9_-]+)\s*\{/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const tool = `mcp__moflo__${m[1]}`;
    // Walk to the matching close brace, tracking depth.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = text.slice(start + 1, i);
    // Top-level keys only: blank out nested brace/bracket bodies first.
    let flat = body;
    let prev = '';
    while (flat !== prev) {
      prev = flat;
      flat = flat.replace(/\{[^{}]*\}/g, '').replace(/\[[^[\]]*\]/g, '');
    }
    const args = [...flat.matchAll(/(?:^|,)\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/g)].map((a) => a[1]);
    calls.push({ tool, args, line: text.slice(0, m.index).split('\n').length });
  }
  return calls;
}

describe('every mcp__moflo__ call documented in an agent persona is executable', () => {
  it('finds calls to check (guards against a parser that silently matches nothing)', () => {
    const total = PERSONAS.reduce((n, p) => n + documentedCalls(p.text).length, 0);
    expect(total).toBeGreaterThan(5);
  });

  it('names only tools the server actually registers', () => {
    const unknown: string[] = [];
    for (const p of PERSONAS) {
      for (const c of documentedCalls(p.text)) {
        if (!SCHEMAS.has(c.tool)) unknown.push(`${p.rel}:${c.line} → ${c.tool}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('passes only arguments the tool schema declares', () => {
    // This is the check that catches the #1330 class directly: researcher.md
    // called memory_search with `pattern: "swarm/shared/research-*"`, an
    // argument memory_search has never had.
    const bogus: string[] = [];
    for (const p of PERSONAS) {
      for (const c of documentedCalls(p.text)) {
        const schema = SCHEMAS.get(c.tool);
        const props = Object.keys((schema?.properties ?? {}) as Record<string, unknown>);
        if (!props.length) continue;
        for (const arg of c.args) {
          if (!props.includes(arg)) bogus.push(`${p.rel}:${c.line} → ${c.tool} has no argument "${arg}"`);
        }
      }
    }
    expect(bogus).toEqual([]);
  });

  it('supplies every argument the tool schema requires', () => {
    const missing: string[] = [];
    for (const p of PERSONAS) {
      for (const c of documentedCalls(p.text)) {
        const schema = SCHEMAS.get(c.tool);
        const required = (schema?.required ?? []) as string[];
        for (const req of required) {
          if (!c.args.includes(req)) missing.push(`${p.rel}:${c.line} → ${c.tool} omits required "${req}"`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('a persona never names a namespace its own operating context omits', () => {
  // The self-consistency check. `coordination` was named twice in planner.md
  // while the header six lines above listed the real namespaces — the file
  // contradicted itself, and four sibling personas carried the same blob.
  // Deriving the allowed set from each file means no hardcoded list to rot.
  function declaredNamespaces(text: string): Set<string> {
    const header = text.split('Search these namespaces depending on your task:')[1];
    if (!header) return new Set();
    const block = header.split(/\n\s*\n/)[0];
    return new Set([...block.matchAll(/^-\s+`([a-z0-9-]+)`/gim)].map((m) => m[1]));
  }

  function namespacesUsed(text: string): string[] {
    return [...new Set([...text.matchAll(/namespace:\s*["']([a-z0-9-]+)["']/gi)].map((m) => m[1]))];
  }

  // Every persona, not just the ones that happen to use a namespace today —
  // so the declaration block itself is pinned, and a persona that starts using
  // namespaces tomorrow is already covered.
  for (const p of PERSONAS) {
    it(p.rel, () => {
      const declared = declaredNamespaces(p.text);
      const used = namespacesUsed(p.text);

      // A persona that names namespaces must declare them, or there is nothing
      // to check it against — that omission is itself the failure.
      if (used.length > 0) expect(declared.size).toBeGreaterThan(0);

      expect(used.filter((ns) => !declared.has(ns))).toEqual([]);
    });
  }
});

describe('planner.md — every task ID queried traces to a call that produced one', () => {
  const planner = PERSONAS.find((p) => p.rel.endsWith('core/planner.md'))!;

  /** One `### <title>` section, stopping at the next heading of any level. */
  function section(title: string): string {
    const after = planner.text.split(`### ${title}`)[1] ?? '';
    return after.split(/\n#{1,4}\s/)[0];
  }

  it('submits to the coordinator before querying status', () => {
    const submitAt = planner.text.search(/mcp__moflo__task_(orchestrate|create)\s*\{/);
    const statusAt = planner.text.search(/mcp__moflo__task_status\s*\{/);
    expect(submitAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(submitAt);
  });

  it('never polls a hand-written task ID', () => {
    // The original: `task_status { taskId: "auth-implementation" }` — an ID no
    // call ever returned. A literal here is the defect; a placeholder that
    // points back at the response is the fix.
    const polls = [...planner.text.matchAll(/task_status\s*\{[^}]*taskId:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(polls.length).toBeGreaterThan(0);
    for (const id of polls) {
      expect(id).toMatch(/^</); // e.g. "<taskId from the response above>"
    }
  });

  it('does not present memory_store as the dispatch mechanism', () => {
    // Storing a breakdown dispatches nothing. The orchestration section must
    // reach the coordinator; memory is for what outlives the run.
    const orchestration = section('Task Orchestration');
    expect(orchestration).toContain('task_orchestrate');
    expect(orchestration).not.toContain('memory_store');
  });

  it('does not imply task_create accepts dependencies', () => {
    // buildTaskInput hardcodes `dependencies: []` — the MCP layer takes none.
    // Documenting one would recreate this ticket's defect in a new form.
    const createSchema = SCHEMAS.get('mcp__moflo__task_create');
    const props = Object.keys((createSchema?.properties ?? {}) as Record<string, unknown>);
    expect(props).not.toContain('dependencies');

    const orchestration = section('Task Orchestration');
    expect(orchestration).not.toMatch(/dependencies:\s*[{[]/);
    // ...and says where ordering actually belongs, so the reader isn't stranded.
    expect(orchestration).toContain('addBlockedBy');
  });
});
