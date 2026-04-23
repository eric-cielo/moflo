/**
 * Hash-embedding regression guard (epic #527, story #532).
 *
 * Story 4 (#531) deleted every hash-embedding code path from moflo. This
 * config installs a standing guard so no future PR can silently reintroduce
 * one. The one rule below is the entire point of this file — do not add
 * unrelated lint rules here without a separate discussion.
 */

const BANNED_EMBEDDING_MESSAGE =
  'Hash embeddings are permanently banned (epic #527, story #532). ' +
  'Use the fastembed-backed IEmbeddingService from @moflo/embeddings instead. ' +
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

// Structural guard: any function that both constructs a Float32Array AND
// calls charCodeAt is a hash embedding regardless of method name. The
// identifier ban above missed the inline implementations removed in #542
// because their enclosing methods used generic names. Issue #545 unscoped
// this from `src/modules/swarm/` to repo-wide — the same anti-pattern was
// leaking into memory/CLI/hooks.
const INLINE_HASH_EMBEDDING_MESSAGE =
  'Inline hash-embedding pattern detected (Float32Array + charCodeAt in the ' +
  'same function). Inject a fastembed-backed IEmbeddingProvider from ' +
  '@moflo/embeddings instead.';

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
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: '@xenova/transformers',
          message:
            '@xenova/transformers was removed in epic #527. Import from @moflo/embeddings (fastembed-backed) instead.',
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
