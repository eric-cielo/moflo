/**
 * MCP Tool Call-site Guard (#1349)
 *
 * The inverse of `mcp-tools-drift-guard.test.ts`. That guard walks
 * registered → consumer ("is every tool used?"). This one walks
 * consumer → registered ("does every call resolve?").
 *
 * Before #1349, 23 shipped CLI subcommands called `callMCPTool('<name>')` with
 * names the registry never held. Each printed its normal progress output and
 * then failed with `MCP tool not found: <name>` — and two of them swallowed
 * that error and reported success for work that never happened, while a third
 * group dropped `flo status` into a fabricated all-zeros fallback on every
 * run. Nothing in CI noticed, because a missing handler is a runtime lookup
 * miss, not a type error: `callMCPTool` takes a plain `string`.
 *
 * Failure mode this catches: someone writes a CLI command against a tool they
 * intend to add and never adds it, or deletes/renames a handler while a call
 * site still references the old name.
 *
 * @module v3/cli/__tests__/mcp-tools-callsite-guard
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const TOOLS_DIR = join(REPO_ROOT, 'src', 'cli', 'mcp-tools');

/**
 * Call sites that intentionally reference a non-existent tool — negative-path
 * tests asserting the "not found" error, and doc examples. Keyed by the tool
 * name, valued with a justification.
 */
const ALLOWLIST: Record<string, string> = {};

interface CallSite {
  tool: string;
  file: string;
  line: number;
}

/** Registered tool names, read from the modules `mcp-client.ts` actually imports. */
function collectRegisteredTools(): Set<string> {
  const client = readFileSync(join(TOOLS_DIR, '..', 'mcp-client.ts'), 'utf8');
  const importRe = /import\s+\{\s*(\w+)\s*\}\s+from\s+['"]\.\/mcp-tools\/([\w-]+)\.js['"]/g;
  const files = new Set<string>();
  for (const m of client.matchAll(importRe)) files.add(`${m[2]}.ts`);

  const names = new Set<string>();
  for (const fname of files) {
    const src = readFileSync(join(TOOLS_DIR, fname), 'utf8');
    // Same shape as the drift guard: `<category>_<action>` with an underscore,
    // so inner object keys like `{ name: 'mcp' }` don't register as tools.
    for (const m of src.matchAll(/^\s*name:\s*['"]([a-z][a-z0-9-]*_[a-z0-9_-]+)['"]/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** `export const TOOL_X = 'name' as const` → TOOL_X ↦ name. */
function loadToolNameConstants(): Map<string, string> {
  const map = new Map<string, string>();
  let src: string;
  try {
    src = readFileSync(join(TOOLS_DIR, 'tool-names.ts'), 'utf8');
  } catch {
    return map;
  }
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*['"]([\w-]+)['"]\s+as\s+const/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const entry of names) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(full, out);
    } else if (st.isFile() && /\.ts$/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out comments while preserving byte offsets and newlines, so a
 * `callMCPTool('example')` written in prose is not mistaken for a call site.
 *
 * This is load-bearing, not tidiness: the scan below spans an inline generic
 * type argument with `[^(]*`, which matches newlines — without stripping,
 * every JSDoc block that documents the call shape (including this file's own)
 * registers as a bogus call to a tool named `name`.
 */
/**
 * Is the `/` at `idx` the start of a regex literal rather than division?
 *
 * Decided by the previous non-whitespace token: after a value (identifier,
 * number, `)`, `]`) a slash is division; after an operator, punctuator, or a
 * keyword like `return` it opens a regex.
 */
function isRegexStart(src: string, idx: number): boolean {
  let j = idx - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  if ('(,=:[!&|?{};+-*~^%<>'.includes(prev)) return true;
  // `return /re/`, `typeof /re/`, `case /re/` — keyword, not a value.
  const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(Math.max(0, j - 11), j + 1));
  return word ? ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof'].includes(word[0]) : false;
}

function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && isRegexStart(src, i)) {
      // A regex literal, not division. Skipping it matters because regexes in
      // this codebase contain unbalanced quotes (`/['"]/` appears in this very
      // file); without this branch the scanner would enter string-skip mode at
      // that quote and swallow real code — potentially hiding an unregistered
      // call site, which is the one thing this guard must never do.
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '\n') break;           // unterminated — bail, don't consume
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i++; break; }
        i++;
      }
    } else if (c === '"' || c === "'" || c === '`') {
      // Skip the string body so a `//` or `/*` inside it isn't treated as a
      // comment opener. String contents themselves stay intact.
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Collect every literal and constant-mediated `callMCPTool` call site.
 *
 * The `[^(]*` span skips an inline generic type argument, since call sites are
 * written with a multi-line inline result type. Type arguments contain no open
 * paren, so the first one reached belongs to the call itself.
 */
function collectCallSites(files: string[]): CallSite[] {
  const constants = loadToolNameConstants();
  const callRe = /callMCPTool\b[^(]*\(\s*(?:['"]([\w-]+)['"]|([A-Z][A-Z0-9_]+))/g;
  const sites: CallSite[] = [];

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes('callMCPTool')) continue;
    // The client defines callMCPTool; its own examples are not call sites.
    if (file.endsWith(join('cli', 'mcp-client.ts'))) continue;

    const src = stripComments(raw);
    for (const m of src.matchAll(callRe)) {
      const tool = m[1] ?? constants.get(m[2]!);
      // An unresolvable SCREAMING_CONSTANT is a dynamic name, not a literal
      // call site — out of scope for this guard.
      if (!tool) continue;
      const line = src.slice(0, m.index).split('\n').length;
      sites.push({ tool, file: relative(REPO_ROOT, file), line });
    }
  }
  return sites;
}

let registered: Set<string>;
let callSites: CallSite[];

describe('MCP Tool Call-site Guard (#1349)', () => {
  beforeAll(() => {
    registered = collectRegisteredTools();
    callSites = collectCallSites(walk(SRC_DIR));
  });

  it('finds call sites and registered tools to compare', () => {
    expect(registered.size).toBeGreaterThan(50);
    expect(callSites.length).toBeGreaterThan(50);
  });

  it('every callMCPTool call site names a registered tool', () => {
    const unresolved = callSites.filter(
      s => !registered.has(s.tool) && !(s.tool in ALLOWLIST)
    );

    const byTool = new Map<string, CallSite[]>();
    for (const site of unresolved) {
      if (!byTool.has(site.tool)) byTool.set(site.tool, []);
      byTool.get(site.tool)!.push(site);
    }

    const hint = byTool.size === 0 ? '' :
      `\n\n${byTool.size} MCP tool name(s) called but never registered:\n` +
      [...byTool.entries()]
        .map(([tool, sites]) =>
          `  - ${tool}\n${sites.map(s => `      ${s.file}:${s.line}`).join('\n')}`)
        .join('\n') +
      `\n\nEach one fails at runtime with "MCP tool not found: <name>" the moment ` +
      `the command runs.\nFix: register a handler in src/cli/mcp-tools/ (and import it in ` +
      `mcp-client.ts),\nremove the CLI surface, or — for a deliberate negative-path test — ` +
      `add the name\nto ALLOWLIST in this file with a justification.`;

    expect([...byTool.keys()], hint).toEqual([]);
  });

  it('no allowlist entry names a tool that is now registered or uncalled', () => {
    const called = new Set(callSites.map(s => s.tool));
    const stale = Object.keys(ALLOWLIST).filter(
      name => registered.has(name) || !called.has(name)
    );
    expect(stale, `Stale allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('every allowlist entry has a real justification', () => {
    for (const [name, why] of Object.entries(ALLOWLIST)) {
      expect(why.trim().length, `${name} needs a justification`).toBeGreaterThan(10);
    }
  });
});
