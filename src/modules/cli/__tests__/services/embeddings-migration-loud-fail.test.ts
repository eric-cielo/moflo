/**
 * Source-guard for issue #583.
 *
 * The four `@moflo/*` dynamic-import call sites in cli/dist used to silently
 * swallow ERR_MODULE_NOT_FOUND, leaving consumers with a frozen
 * embeddings_version and no signal in their logs. Embeddings was inlined into
 * cli (#592 / epic #586), so the embeddings-specific behavioural test is moot
 * — the migration uses a direct relative import that can no longer resolve to
 * null. The structural invariants below still apply to the remaining
 * @moflo/* dynamic imports across these call sites: a future refactor that
 * reintroduces a silent catch fails here before it ships to consumers.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __tests__/services -> __tests__ -> cli -> ...
const cliRoot = resolve(__dirname, '..', '..');
const srcRoot = resolve(cliRoot, 'src');

describe('source-guard: no silent @moflo/* catches in cli (issue #583)', () => {
  // Each call site flagged in the issue body must avoid the silent patterns
  // we just removed. Pure source-text invariants — cheap, brittle in the
  // good way: a future refactor that reintroduces a silent catch fails here
  // before it ships to consumers.
  const callSites = [
    join(srcRoot, 'services', 'embeddings-migration.ts'),
    join(srcRoot, 'mcp-tools', 'hooks-tools.ts'),
    join(srcRoot, 'mcp-tools', 'neural-tools.ts'),
    join(srcRoot, 'mcp-tools', 'security-tools.ts'),
  ];

  for (const file of callSites) {
    it(`${file.replace(srcRoot, '<cli>')} has no silent @moflo/* catch`, () => {
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');

      // 1. No `.catch(() => null)` or `.catch(() => false)` immediately
      //    after a `@moflo/*` dynamic import.
      const silentChainCatch = /import\(\s*['"]@moflo\/[^'"]+['"]\s*\)[^;]{0,200}\.catch\(\s*\(\)\s*=>\s*(?:null|false)\s*\)/m;
      expect(text, 'silent .catch(() => null/false) on @moflo/* import')
        .not.toMatch(silentChainCatch);

      // 2. No `try { ... import('@moflo/...') ... } catch { return false }`
      //    block — i.e. a try whose only payload is a moflo import and whose
      //    catch is a bare `return false` / `return null`.
      const silentTryCatch = /try\s*\{[^}]*import\(\s*['"]@moflo\/[^'"]+['"]\s*\)[^}]*\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*return\s+(?:false|null)\s*;?\s*\}/m;
      expect(text, 'silent try/catch returning false/null around @moflo/* import')
        .not.toMatch(silentTryCatch);
    });
  }
});
