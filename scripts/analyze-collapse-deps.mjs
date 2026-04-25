#!/usr/bin/env node
// Static dependency-graph scanner for @moflo/* imports.
//
// Scans a tree (default: src/modules + bin + src/index.ts) for every
// `@moflo/<pkg>` reference — static `from`, dynamic `import()`, `require()`,
// and string-only references inside `mofloImport(...)` / `requireMofloOrWarn(...)`.
// Each hit is mapped to the *source* package (which `src/modules/<pkg>/` it
// lives in) so we get an adjacency list `{ source: [target, ...] }`.
//
// Modes:
//   --src             scan src/modules/**/*.ts (excluding tests, dist, .d.ts)
//   --dist            scan src/modules/**/dist/**/*.js (shipped artifacts)
//   --tarball <dir>   scan an extracted `npm pack` tarball
//
// Output:
//   --json <file>     write adjacency list JSON
//   --md   <file>     write human-readable summary
//   (no flag)         pretty-print to stdout

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';

const KNOWN_PACKAGES = [
  'aidefence', 'claims', 'cli', 'embeddings', 'guidance', 'hooks',
  'memory', 'neural', 'plugins', 'security', 'shared', 'spells',
  'swarm', 'testing',
];

const MODES = {
  src: { label: 'TypeScript source tree' },
  dist: { label: 'compiled `dist/` artifacts' },
  tarball: { label: 'extracted `npm pack` tarball' },
};

function parseArgs(argv) {
  const args = { mode: 'src', json: null, md: null, root: process.cwd(), tarball: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') args.mode = 'src';
    else if (a === '--dist') args.mode = 'dist';
    else if (a === '--tarball') { args.mode = 'tarball'; args.tarball = argv[++i]; }
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--md') args.md = argv[++i];
    else if (a === '--root') args.root = argv[++i];
  }
  return args;
}

function* walk(dir, accept) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full, accept);
    } else if (entry.isFile() && accept(full)) {
      yield full;
    }
  }
}

// Returns either a package name from KNOWN_PACKAGES, or null when the file
// lives outside any module (root-level files like bin/, src/index.ts).
function ownerPackage(absPath, repoRoot) {
  const rel = relative(repoRoot, absPath).split(sep);
  const idx = rel.findIndex(p => p === 'modules');
  if (idx >= 0 && rel[idx - 1] === 'src' && rel[idx + 1]) {
    const pkg = rel[idx + 1];
    if (KNOWN_PACKAGES.includes(pkg)) return pkg;
  }
  // Tarball layout: package/src/modules/<pkg>/...
  const pkgIdx = rel.findIndex(p => p === 'package');
  if (pkgIdx >= 0) {
    const subIdx = rel.indexOf('modules', pkgIdx);
    if (subIdx > pkgIdx && rel[subIdx + 1] && KNOWN_PACKAGES.includes(rel[subIdx + 1])) {
      return rel[subIdx + 1];
    }
  }
  return null;
}

// We use a single regex with alternation rather than an AST walk because:
//   - tarballs ship .js without sourcemaps; AST parsing them is brittle
//   - the moflo-require helper takes the package as a *string* argument
//     (`mofloImport('@moflo/memory')`), which an AST walker would miss
//     unless taught about each helper.
const MOFLO_REF = /['"`]@moflo\/([a-z0-9-]+)['"`]/g;

// Strip /* ... */ block comments and // ... line comments, but keep string and
// template-literal contents verbatim — those are where the import strings we
// care about live. JSDoc references like `` `@moflo/cli` `` inside prose would
// otherwise show up as false-positive edges in the graph.
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
    } else if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i + 2);
      if (end === -1) break;
      i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      i = consumeStringLike(src, i, c, out, s => { out = s; });
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Consume a string/template literal starting at `i` (whose opening quote is
// `quote`), append its full text to `out` via `setOut`, and return the index
// just past the closing quote. Inside a template `${...}` expression, recurse
// into nested string-likes so that braces inside `'}'` etc. don't desync the
// brace-depth counter.
function consumeStringLike(src, i, quote, outInit, setOut) {
  let out = outInit + src[i];
  i++;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === '\\') {
      out += src[i] + (src[i + 1] || '');
      i += 2;
      continue;
    }
    if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
      out += '${';
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
          let inner = '';
          i = consumeStringLike(src, i, ch, '', s => { inner = s; });
          out += inner;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
        out += ch;
        i++;
      }
      out += '}';
      i++;
      continue;
    }
    out += src[i++];
  }
  if (i < src.length) { out += src[i]; i++; }
  setOut(out);
  return i;
}

function scanFile(absPath) {
  const src = stripComments(readFileSync(absPath, 'utf8'));
  const refs = new Set();
  for (const match of src.matchAll(MOFLO_REF)) {
    const pkg = match[1];
    if (KNOWN_PACKAGES.includes(pkg)) refs.add(pkg);
  }
  return refs;
}

function buildGraph({ mode, root, tarball }) {
  const graph = Object.fromEntries(KNOWN_PACKAGES.map(p => [p, new Set()]));
  const rootRefs = new Set();

  let scanRoot;
  let accept;
  if (mode === 'src') {
    scanRoot = root;
    accept = full => {
      if (full.includes(`${sep}node_modules${sep}`)) return false;
      if (full.includes(`${sep}dist${sep}`)) return false;
      if (full.endsWith('.d.ts')) return false;
      return /\.(ts|tsx|mts|cts|mjs|js)$/.test(full);
    };
  } else if (mode === 'dist') {
    scanRoot = join(root, 'src', 'modules');
    accept = full => {
      if (full.includes(`${sep}node_modules${sep}`)) return false;
      if (!full.includes(`${sep}dist${sep}`)) return false;
      if (full.endsWith('.d.ts')) return false;
      return /\.(js|mjs|cjs)$/.test(full);
    };
  } else if (mode === 'tarball') {
    if (!tarball || !existsSync(tarball)) {
      throw new Error(`Tarball directory not found: ${tarball}`);
    }
    scanRoot = tarball;
    accept = full => {
      if (full.endsWith('.d.ts')) return false;
      return /\.(js|mjs|cjs)$/.test(full);
    };
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  let scannedFiles = 0;
  for (const file of walk(scanRoot, accept)) {
    scannedFiles++;
    const owner = ownerPackage(file, root);
    const target = owner === null ? rootRefs : graph[owner];
    for (const ref of scanFile(file)) {
      if (ref !== owner) target.add(ref);
    }
  }

  return {
    files: scannedFiles,
    graph: Object.fromEntries(
      KNOWN_PACKAGES.map(p => [p, [...graph[p]].sort()]),
    ),
    rootRefs: [...rootRefs].sort(),
  };
}

function topoSort(graph) {
  const order = [];
  const remaining = new Set(KNOWN_PACKAGES);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(n => graph[n].every(d => !remaining.has(d)))
      .sort();
    if (ready.length === 0) {
      const stuck = [...remaining].sort();
      order.push(`<cycle:${stuck.join(',')}>`);
      break;
    }
    for (const n of ready) {
      order.push(n);
      remaining.delete(n);
    }
  }
  return order;
}

// Strongly-connected-components (Tarjan) over the package graph. Returns the
// non-trivial SCCs (size >= 2) so the JSON output can record cycles as data.
function findCycles(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const cycles = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph[v] || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length >= 2) cycles.push(component.sort());
    }
  }

  for (const n of KNOWN_PACKAGES) if (!indices.has(n)) strongConnect(n);
  return cycles;
}

function classify(graph) {
  const inboundCount = Object.fromEntries(KNOWN_PACKAGES.map(n => [n, 0]));
  for (const n of KNOWN_PACKAGES) {
    for (const dep of graph[n]) {
      if (dep in inboundCount) inboundCount[dep]++;
    }
  }
  const leaves = KNOWN_PACKAGES.filter(n => graph[n].length === 0).sort();
  const trunk = KNOWN_PACKAGES.filter(n => inboundCount[n] >= 3).sort();
  const earlyCollapse = KNOWN_PACKAGES
    .filter(n => graph[n].length <= 1 && !trunk.includes(n))
    .sort();
  return { inboundCount, leaves, trunk, earlyCollapse };
}

function renderJson(result, outFile) {
  const payload = {
    packages: KNOWN_PACKAGES,
    adjacency: result.graph,
    rootRefs: result.rootRefs,
    cycles: findCycles(result.graph),
    files: result.files,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
}

function renderList(items, formatter, emptyText) {
  if (items.length === 0) return [emptyText];
  return items.map(formatter);
}

function renderMd(result, mode, outFile) {
  const { graph, rootRefs } = result;
  const { inboundCount, leaves, trunk, earlyCollapse } = classify(graph);
  const order = topoSort(graph);
  const sourceLabel = MODES[mode].label;

  const lines = [];
  lines.push('# `@moflo/*` Workspace Collapse — Dependency Graph');
  lines.push('');
  lines.push(`Generated by \`scripts/analyze-collapse-deps.mjs --${mode}\` against the **${sourceLabel}**.`);
  lines.push('');
  lines.push(`Files scanned: **${result.files}**.`);
  lines.push('');
  lines.push('## Adjacency list');
  lines.push('');
  lines.push('Each row lists the `@moflo/*` packages a given module imports (static `from`, dynamic `import()`, or string-arg `mofloImport`).');
  lines.push('');
  lines.push('| Package | Outbound count | Imports |');
  lines.push('|---------|----------------|---------|');
  for (const pkg of KNOWN_PACKAGES) {
    const deps = graph[pkg];
    lines.push(`| \`${pkg}\` | ${deps.length} | ${deps.length ? deps.map(d => `\`${d}\``).join(', ') : '—'} |`);
  }
  lines.push('');
  lines.push('## Inbound count (how many other packages import this one)');
  lines.push('');
  lines.push('| Package | Inbound count |');
  lines.push('|---------|---------------|');
  for (const pkg of KNOWN_PACKAGES) {
    lines.push(`| \`${pkg}\` | ${inboundCount[pkg]} |`);
  }
  lines.push('');
  lines.push('## Leaves (zero outbound `@moflo/*` imports)');
  lines.push('');
  lines.push('Safe to merge first — no relative paths to other moflo packages will need rewriting.');
  lines.push('');
  lines.push(...renderList(leaves, p => `- \`@moflo/${p}\``, '_(none)_'));
  lines.push('');
  lines.push('## Early-collapse candidates (outbound ≤ 1, not trunk)');
  lines.push('');
  lines.push('After leaves, collapse these next — single relative-path rewrite each.');
  lines.push('');
  lines.push(...renderList(
    earlyCollapse,
    p => `- \`@moflo/${p}\` → ${graph[p].length ? graph[p].map(d => `\`${d}\``).join(', ') : '_leaf_'}`,
    '_(none)_',
  ));
  lines.push('');
  lines.push('## Trunk (≥ 3 inbound)');
  lines.push('');
  lines.push('Collapse last — these are widely depended on, so flipping them changes many call sites.');
  lines.push('');
  lines.push(...renderList(trunk, p => `- \`@moflo/${p}\` (inbound = ${inboundCount[p]})`, '_(none)_'));
  lines.push('');
  lines.push('## Topological collapse order (leaves first)');
  lines.push('');
  lines.push('Recommended merge order. Each subsequent step has all of its dependencies already merged into the root package, so its own internal `@moflo/*` imports become local relative paths.');
  lines.push('');
  for (let i = 0; i < order.length; i++) {
    lines.push(`${i + 1}. \`@moflo/${order[i]}\``);
  }
  lines.push('');
  if (rootRefs.length > 0) {
    lines.push('## Root-level references');
    lines.push('');
    lines.push('Files outside `src/modules/` (e.g. `bin/`, `src/index.ts`, `scripts/`) that reference `@moflo/*`. After collapse, these become local imports.');
    lines.push('');
    for (const p of rootRefs) lines.push(`- \`@moflo/${p}\``);
    lines.push('');
  }

  writeFileSync(outFile, lines.join('\n'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildGraph(args);

  if (args.json) renderJson(result, args.json);
  if (args.md) renderMd(result, args.mode, args.md);

  if (!args.json && !args.md) {
    console.log(JSON.stringify(result.graph, null, 2));
  } else {
    console.log(`Mode: ${args.mode}`);
    console.log(`Scanned ${result.files} files`);
    if (args.json) console.log(`JSON → ${args.json}`);
    if (args.md) console.log(`MD   → ${args.md}`);
  }
}

main();
