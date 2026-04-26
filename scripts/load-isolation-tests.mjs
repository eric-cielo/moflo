import { readFileSync } from 'fs';

// Strip comments before scanning for quoted strings — apostrophes inside
// `//` comments would otherwise throw quote pairing off and silently drop
// later entries. Contract: entries are simple test path string literals
// (no escaped quotes); a literal like `'it\'s'` would still mis-tokenize.
export function parseIsolationTests(configSource) {
  const match = configSource.match(/export\s+const\s+isolationTests\s*=\s*\[([\s\S]*?)\];/);
  if (!match) return [];
  const body = match[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const entries = [];
  for (const m of body.matchAll(/'([^']+)'|"([^"]+)"/g)) {
    entries.push(m[1] || m[2]);
  }
  return entries;
}

export function loadIsolationTests(configPath) {
  try {
    return parseIsolationTests(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error(`[test-runner] failed to load isolation tests from ${configPath}: ${err.message}`);
    return [];
  }
}
