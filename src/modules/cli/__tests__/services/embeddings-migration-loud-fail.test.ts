/**
 * Regression guard for issue #583.
 *
 * The four `@moflo/*` dynamic-import call sites in cli/dist used to silently
 * swallow ERR_MODULE_NOT_FOUND, leaving consumers with a frozen
 * embeddings_version and no signal in their logs. This test enforces two
 * things:
 *
 *   1. Behavioural: when @moflo/embeddings is unresolvable, the
 *      embeddings-migration entry point loud-fails (returns false AND writes
 *      a named warning to stderr).
 *   2. Structural: the four specific call sites do not contain the silent
 *      patterns we just removed (`catch { return false }` / `.catch(() => null)`
 *      / bare `await import('@moflo/...')` outside a sanctioned helper).
 *      A pure source-text guard so a future refactor can't quietly regress.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __tests__/services -> __tests__ -> cli -> ...
const cliRoot = resolve(__dirname, '..', '..');
const srcRoot = resolve(cliRoot, 'src');

describe('embeddings-migration loud-fail (issue #583)', () => {
  let stderrWrites: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(() => {
    stderrWrites = [];
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      });
    tmpRoot = mkdtempSync(join(tmpdir(), 'moflo-embed-mig-'));
    dbPath = join(tmpRoot, 'memory.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // "SQLi" magic-ish
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
    // vi.doMock + vi.resetModules is enough — vi.unmock here would be hoisted
    // to the top of the file by vitest, unmocking before the mock is set up.
  });

  it('writes a named warning to stderr and returns false when @moflo/embeddings is unresolvable', async () => {
    vi.doMock('../../src/services/moflo-require.js', async (importOriginal) => {
      const orig = await importOriginal<
        typeof import('../../src/services/moflo-require.js')
      >();
      return {
        ...orig,
        // Simulate the broken-install case: package not resolvable from this tree.
        mofloImport: vi.fn(async (specifier: string) => {
          if (specifier === '@moflo/embeddings') return null;
          return orig.mofloImport(specifier);
        }),
      };
    });

    const { runEmbeddingsMigrationIfNeeded } = await import(
      '../../src/services/embeddings-migration.js'
    );

    const result = await runEmbeddingsMigrationIfNeeded({ dbPath });
    expect(result).toBe(false);

    const combined = stderrWrites.join('');
    expect(combined).toContain('@moflo/embeddings');
    expect(combined).toContain('embeddings-migration');
    // The whole point of the fix: it must mention WHY the migration was
    // skipped, not just silently return false.
    expect(combined).toMatch(/skipped|not resolvable|broken moflo install/i);
  });
});

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
