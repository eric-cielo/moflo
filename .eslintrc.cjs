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

const BANNED_IDENTIFIERS = [
  'HashEmbeddingProvider',
  'createHashEmbedding',
  'generateHashEmbedding',
  'RvfEmbeddingService',
  'RvfEmbeddingCache',
];

const BANNED_IDENTIFIER_PATTERN = `^(${BANNED_IDENTIFIERS.join('|')})$`;
// Matches any literal starting with "domain-aware-hash", including the
// original `domain-aware-hash-384` dim variant, `domain-aware-hash-v1` model
// tag, and any future suffix a contributor might try to sneak through.
const BANNED_LITERAL_PATTERN = '^domain-aware-hash';

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

// Structural guard: any function that both constructs a Float32Array AND
// calls charCodeAt is a hash embedding regardless of method name. The
// identifier ban above missed the inline implementations removed in #542
// because their enclosing methods used generic names.
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

const swarmSrcRules = {
  'no-restricted-syntax': [
    'error',
    ...bannedEmbeddingRules['no-restricted-syntax'].slice(1),
    ...INLINE_HASH_EMBEDDING_SELECTORS,
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
      files: [
        'src/**/*.js',
        'src/**/*.mjs',
        'src/**/*.cjs',
        'bin/**/*.js',
        'bin/**/*.mjs',
        'bin/**/*.cjs',
      ],
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      rules: bannedEmbeddingRules,
    },
    {
      // Issue #542: structural ban on inline hash embeddings in swarm
      // coordinators. Layered on top of the repo-wide identifier/literal ban.
      files: ['src/modules/swarm/src/**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      plugins: ['@typescript-eslint'],
      rules: swarmSrcRules,
    },
    {
      // Test-only deterministic mocks are explicitly allowed to reference the
      // hash-embedding identifiers so existing guidance-retriever test
      // fixtures continue to work. They are NOT exported from any package.
      files: [
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/**/*.test.js',
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
