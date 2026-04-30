/**
 * Cross-cutting source guards.
 *
 * Originated as the hash-embedding regression guard (epic #527, story #532)
 * and now hosts the small set of structural rules that protect consumer
 * installs from silent regressions:
 *   - Hash-embedding identifiers + inline patterns (epic #527 / #545)
 *   - Raw `writeFileSync(path, db.export())` non-atomic DB writes (#564)
 *   - Fixed-depth `../../../../modules/<pkg>/...` runtime/type paths (#575)
 *   - `path.resolve|join(<anchor>, '..', '..', ...)` traversal that bakes in
 *     fragile dist/source depth assumptions (#781 / #782 — use mofloPath())
 *
 * Each rule cluster has its own selectors block — keep new clusters
 * similarly delineated so the file stays scannable.
 */

const BANNED_EMBEDDING_MESSAGE =
  'Hash embeddings are permanently banned (epic #527, story #532). ' +
  'Use the fastembed-backed IEmbeddingService from cli/src/embeddings instead. ' +
  'Test-only deterministic mocks belong under __tests__/.';

// Issue #545: architect review of PR #539's whitelist flagged it as
// rename-circumventable. The additions below cover the names we have actually
// seen leak — `hashEmbed` and `embedWithFallback` were the live production
// call-sites deleted in PR #557. `generateEmbedding` is deliberately NOT
// added: it is the public fastembed-backed API exported by
// `memory/memory-initializer.js` and referenced in ~40 legitimate call-sites.
// Any real hash implementation hiding behind that name is caught by the
// structural Float32Array + charCodeAt rule below, which runs repo-wide.
const BANNED_IDENTIFIERS = [
  'HashEmbeddingProvider',
  'createHashEmbedding',
  'generateHashEmbedding',
  'hashEmbed',
  'embedWithFallback',
  'RvfEmbeddingService',
  'RvfEmbeddingCache',
];

const BANNED_IDENTIFIER_PATTERN = `^(${BANNED_IDENTIFIERS.join('|')})$`;
// Matches any literal starting with "domain-aware-hash", including the
// original `domain-aware-hash-384` dim variant, `domain-aware-hash-v1` model
// tag, and any future suffix a contributor might try to sneak through.
const BANNED_LITERAL_PATTERN = '^domain-aware-hash';

// Issue #564: Flag raw `fs.writeFileSync(path, <anything>.export())` and
// `writeFileSync(path, Buffer.from(<anything>.export()))` patterns. The
// `:has(...)` guard scopes the rule to writeFileSync calls whose argument
// tree contains a `.export()` call — the signature of a sql.js DB write.
// The canonical `atomicWriteFileSync` helper never nests a `.export()` under
// its own internal writeFileSync, so it doesn't self-trigger.
const RAW_DB_WRITE_MESSAGE =
  'Raw fs.writeFileSync(path, db.export()) is not atomic — SIGINT mid-write ' +
  'can truncate the DB file. Use atomicWriteFileSync from cli/src/shared/utils/atomic-file-write.js ' +
  '(see #564 / #548).';

const RAW_DB_WRITE_SELECTORS = [
  {
    selector:
      "CallExpression[callee.property.name='writeFileSync']" +
      ":has(CallExpression[callee.property.name='export'])",
    message: RAW_DB_WRITE_MESSAGE,
  },
];

// Issue #575 / feedback_no_fixed_depth_paths: ban 4+ deep `../` chains that
// cross a moflo package boundary. Source vs dist depths differ — these
// strings silently resolve to the wrong dir under installed and dev layouts.
const FIXED_DEPTH_MODULES_MESSAGE =
  'Fixed-depth `../../../../modules/<pkg>/...` paths break under installed ' +
  'and dev layouts because source/dist depths differ. Use ' +
  '`locateMofloModuleDist`/`locateMofloModulePath` from ' +
  '`services/moflo-require.js` (or the in-package equivalent) instead.';

// Slashes wrapped in character classes so the trailing `/` doesn't terminate
// the outer regex literal in the esquery selector.
const FIXED_DEPTH_MODULES_PATTERN = '(\\.\\.[/\\\\]){4,}modules[/\\\\]';

const FIXED_DEPTH_MODULES_SELECTORS = [
  {
    selector: `Literal[value=/${FIXED_DEPTH_MODULES_PATTERN}/]`,
    message: FIXED_DEPTH_MODULES_MESSAGE,
  },
  {
    selector: `TemplateElement[value.raw=/${FIXED_DEPTH_MODULES_PATTERN}/]`,
    message: FIXED_DEPTH_MODULES_MESSAGE,
  },
];

// Issue #781 / #782: ban `path.resolve|join(<anchor>, '..', '..', ...)`. Two
// or more adjacent `'..'` literal arguments means the call is walking *up*
// past its own package directory — a depth assumption that broke half a
// dozen times during workspace-collapse epic #586 because the math differs
// between source (`src/cli/<file>.ts`) and dist (`dist/src/cli/<file>.js`).
//
// The sanctioned alternative is `mofloPath(import.meta.url, ...segments)`
// from `shared/core/moflo-package-root.ts`, which walks up to the moflo
// `package.json` regardless of layout.
//
// `:has(Literal + Literal)` matches any CallExpression whose argument list
// contains two adjacent `'..'` Literals — covers `'..', '..'`, `'..', '..',
// 'bin'`, `'..', '..', '..', '..'`, etc. Single `'..'` is allowed (sibling
// lookups, relative-path utilities, fs.access existence probes).
const PATH_TRAVERSAL_MESSAGE =
  'Fixed-depth `..` traversal in path.resolve/join is banned (#781 / #782). ' +
  'The depth differs between source and dist layouts — use ' +
  '`mofloPath(import.meta.url, ...)` from `shared/core/moflo-package-root.ts` ' +
  'to anchor on the moflo package root instead.';

const ADJACENT_DOTDOT_HAS = `:has(Literal[value='..'] + Literal[value='..'])`;

const PATH_TRAVERSAL_SELECTORS = [
  // path.resolve(...) / path.join(...)
  {
    selector:
      `CallExpression[callee.object.name='path']` +
      `[callee.property.name=/^(resolve|join)$/]${ADJACENT_DOTDOT_HAS}`,
    message: PATH_TRAVERSAL_MESSAGE,
  },
  // path.posix.resolve(...) / path.posix.join(...) — different shape
  {
    selector:
      `CallExpression[callee.object.object.name='path']` +
      `[callee.object.property.name='posix']` +
      `[callee.property.name=/^(resolve|join)$/]${ADJACENT_DOTDOT_HAS}`,
    message: PATH_TRAVERSAL_MESSAGE,
  },
  // resolve(...) / join(...) imported directly from 'path' / 'node:path'
  {
    selector:
      `CallExpression[callee.type='Identifier']` +
      `[callee.name=/^(resolve|join)$/]${ADJACENT_DOTDOT_HAS}`,
    message: PATH_TRAVERSAL_MESSAGE,
  },
];

// Issue #781 / #785: catch blocks that downgrade an error to a `status: 'warn'`
// health-check result without surfacing the underlying cause. This is the exact
// shape that hid the 4.9.0-rc.11 doctor bug for ~6 months — a thrown
// `Cannot find module ../spells/dist/...` was wrapped in `try { ... } catch {
// return { ..., status: 'warn', message: 'Unable to detect: ...' } }`, and the
// real failure never reached stderr, telemetry, or the user-visible message.
//
// Acceptable shapes for a catch that returns `status: 'warn'`:
//   1. Include the error in the returned message via a template literal:
//      `} catch (e) { return { ..., status: 'warn', message: \`...: \${e}\` }; }`
//   2. Log to stderr / a logger:
//      `} catch (e) { console.error('X:', e); return { ..., status: 'warn' }; }`
//   3. Re-throw with context (no warn return at all)
//   4. Inline exemption: `// eslint-disable-next-line no-restricted-syntax -- <reason>`
//
// Selector matches a CatchClause whose body returns an object with the literal
// property `status: 'warn'`, AND has no `console.*` / `logger.*` call, AND has
// no TemplateLiteral anywhere in the body (heuristic for "the error is being
// formatted into a message"). Without all three, the rule fires.
const SILENT_WARN_CATCH_MESSAGE =
  'Catch block downgrades an error to status:"warn" without surfacing the ' +
  'underlying cause (#781 / #785). Include the error in the returned message ' +
  '(template literal), log via console.error/logger, return status:"fail", ' +
  'or re-throw. Hides the exact bug class that produced the 4.9.0-rc.11 ' +
  'silent-catch regression.';

const SILENT_WARN_CATCH_SELECTORS = [
  {
    selector:
      `CatchClause` +
      `:has(ReturnStatement Property[key.name='status'][value.type='Literal'][value.value='warn'])` +
      `:not(:has(CallExpression[callee.object.name=/^(console|logger|log)$/]))` +
      `:not(:has(TemplateLiteral))`,
    message: SILENT_WARN_CATCH_MESSAGE,
  },
];

// Structural guard: any function that both constructs a Float32Array AND
// calls charCodeAt is a hash embedding regardless of method name. The
// identifier ban above missed the inline implementations removed in #542
// because their enclosing methods used generic names. Issue #545 unscoped
// this from the swarm package to repo-wide — the same anti-pattern was
// leaking into memory/CLI/hooks.
const INLINE_HASH_EMBEDDING_MESSAGE =
  'Inline hash-embedding pattern detected (Float32Array + charCodeAt in the ' +
  'same function). Inject a fastembed-backed IEmbeddingProvider from ' +
  'cli/src/embeddings instead.';

const INLINE_HASH_EMBEDDING_SELECTORS = [
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'MethodDefinition > FunctionExpression',
].map(fn => ({
  selector:
    `${fn}:has(NewExpression[callee.name='Float32Array'])` +
    `:has(CallExpression[callee.property.name='charCodeAt'])`,
  message: INLINE_HASH_EMBEDDING_MESSAGE,
}));

const bannedEmbeddingRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: `Identifier[name=/${BANNED_IDENTIFIER_PATTERN}/]`,
      message: BANNED_EMBEDDING_MESSAGE,
    },
    {
      selector: `Literal[value=/${BANNED_LITERAL_PATTERN}/]`,
      message: BANNED_EMBEDDING_MESSAGE,
    },
    {
      selector: `TemplateElement[value.raw=/${BANNED_LITERAL_PATTERN}/]`,
      message: BANNED_EMBEDDING_MESSAGE,
    },
    ...INLINE_HASH_EMBEDDING_SELECTORS,
    ...RAW_DB_WRITE_SELECTORS,
    ...FIXED_DEPTH_MODULES_SELECTORS,
    ...PATH_TRAVERSAL_SELECTORS,
    ...SILENT_WARN_CATCH_SELECTORS,
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: '@xenova/transformers',
          message:
            '@xenova/transformers was removed in epic #527. Import from cli/src/embeddings (fastembed-backed) instead.',
        },
      ],
    },
  ],
};

module.exports = {
  root: true,
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '**/dist/**',
    '.moflo/',
    '.claude-flow/',
    '.swarm/',
    'harness/**/.work/**',
    'spells/',
    'scripts/',
    'examples/',
    'data/',
    'docs/',
    'tests/fixtures/**',
    '**/*.d.ts',
    // Issue #545: ESLint ignores dot-prefixed paths by default. Negations
    // below put the shipped helper scripts back under the guard — they ride
    // into consumer installs via the scriptFiles sync list and need the
    // same hash-fallback protection as src/ + bin/. The parent path has to
    // be un-ignored first (ESLint evaluates patterns top-down and can't
    // traverse into an ignored dir), then the specific subtree is allowed.
    '!.claude',
    '!.claude/scripts',
    '!.claude/scripts/**',
  ],
  overrides: [
    {
      files: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.mts', 'src/**/*.cts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      // Plugin is registered here only so existing `eslint-disable-next-line
      // @typescript-eslint/*` comments in source do not trip "rule not found"
      // errors. No rules from this plugin are enabled — this config is
      // intentionally scoped to the hash-embedding guard.
      plugins: ['@typescript-eslint'],
      rules: bannedEmbeddingRules,
    },
    {
      // JS/MJS/CJS across src, bin, and the shipped `.claude/scripts/` helpers
      // (issue #545 pulled the last group in — it was previously invisible to
      // the guard because lint only targeted src/ + bin/).
      files: [
        'src/**/*.js',
        'src/**/*.mjs',
        'src/**/*.cjs',
        'bin/**/*.js',
        'bin/**/*.mjs',
        'bin/**/*.cjs',
        '.claude/scripts/**/*.js',
        '.claude/scripts/**/*.mjs',
        '.claude/scripts/**/*.cjs',
      ],
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      rules: bannedEmbeddingRules,
    },
    {
      // The embedding-hygiene doctor is the legitimate detector for the banned
      // `domain-aware-hash*` model tag — its entire purpose is to find rows in
      // the user's memory DB that still carry the retired model label. The
      // identifier-rule still applies (no ressurrected hashEmbed/HashEmbedding*
      // function names), but the literal-prefix selector is allowed here.
      files: ['src/cli/commands/doctor-embedding-hygiene.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: `Identifier[name=/${BANNED_IDENTIFIER_PATTERN}/]`,
            message: BANNED_EMBEDDING_MESSAGE,
          },
          ...INLINE_HASH_EMBEDDING_SELECTORS,
          ...RAW_DB_WRITE_SELECTORS,
          ...FIXED_DEPTH_MODULES_SELECTORS,
          ...PATH_TRAVERSAL_SELECTORS,
          ...SILENT_WARN_CATCH_SELECTORS,
        ],
      },
    },
    {
      // Issue #782: the canonical `mofloPath()` helper is itself the
      // sanctioned escape hatch from the path-traversal rule. It does NOT
      // use `'..', '..'` literals (it walks via `dirname()` until it finds
      // the moflo package.json), so this exemption is defensive — keeps the
      // rule from accidentally firing if the helper is ever rewritten.
      files: ['src/cli/shared/core/moflo-package-root.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          // Drop PATH_TRAVERSAL_SELECTORS only; keep every other guard.
          {
            selector: `Identifier[name=/${BANNED_IDENTIFIER_PATTERN}/]`,
            message: BANNED_EMBEDDING_MESSAGE,
          },
          {
            selector: `Literal[value=/${BANNED_LITERAL_PATTERN}/]`,
            message: BANNED_EMBEDDING_MESSAGE,
          },
          {
            selector: `TemplateElement[value.raw=/${BANNED_LITERAL_PATTERN}/]`,
            message: BANNED_EMBEDDING_MESSAGE,
          },
          ...INLINE_HASH_EMBEDDING_SELECTORS,
          ...RAW_DB_WRITE_SELECTORS,
          ...FIXED_DEPTH_MODULES_SELECTORS,
          ...SILENT_WARN_CATCH_SELECTORS,
        ],
      },
    },
    {
      // Test-only deterministic mocks are explicitly allowed to reference the
      // hash-embedding identifiers so existing guidance-retriever test
      // fixtures continue to work. They are NOT exported from any package.
      //
      // Patterns cover every test/mock/benchmark convention we actually use:
      //  - `__tests__/`, `*.test.*`, `*.spec.*` — standard vitest layouts
      //  - `__mocks__/` — vitest manual mock dirs (incl. production-adjacent
      //    mock-provider modules imported from prod via `useMockEmbeddings`)
      //  - `tests/` — package-level alt layout (e.g. guidance package)
      //  - `benchmarks/` — microbenchmarks that simulate hash embeddings
      //    intentionally to measure vector-math throughput
      files: [
        'src/**/__tests__/**',
        'src/**/__mocks__/**',
        'src/**/tests/**',
        'src/**/benchmarks/**',
        'src/**/*.test.ts',
        'src/**/*.test.js',
        'src/**/*.bench.ts',
        'src/**/*.spec.ts',
        'src/**/*.spec.js',
        'src/__tests__/**',
      ],
      rules: {
        'no-restricted-syntax': 'off',
        'no-restricted-imports': 'off',
      },
    },
  ],
};
