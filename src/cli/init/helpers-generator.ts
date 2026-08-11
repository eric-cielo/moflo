/**
 * Helpers Generator
 * Creates utility scripts in .claude/helpers/
 *
 * Each generator below returns the CANONICAL helper file verbatim, embedded at
 * build time by scripts/generate-embedded-helpers.mjs (#1443).
 *
 * These are used by `flo init`'s fallback path — `src/cli/init/executor.ts`
 * reaches for them only when `findSourceHelpersDir()` cannot locate the
 * package's own files. Each function used to carry a hand-maintained COPY of
 * the helper it emits, and five of the seven had drifted; `gate.cjs` had fallen
 * far enough behind to be missing #1348's credit-fingerprint invalidation
 * entirely, so a project that received the fallback kept crediting tests that
 * no longer matched the code. Nothing compared the copies, so nothing said so.
 *
 * Embedding, rather than reading at runtime: a fallback for "the package files
 * are not findable" cannot read those files, and resolving them relative to
 * `__dirname` is the dist-vs-source depth trap from #1126. See the generator
 * script's header.
 *
 * To change what a consumer receives, edit the canonical file (`bin/gate.cjs`,
 * `.claude/helpers/pre-commit`, …) and run `npm run generate:helpers`. Editing
 * this file cannot change it — and tests/guards/embedded-helpers-parity.test.ts
 * fails if the embed is stale.
 */

import type { InitOptions } from './types.js';
import { EMBEDDED_HELPERS_BASE64 } from './embedded-helpers.js';

/** Decoded helpers, memoised — the fallback can ask for the same one twice. */
const decodedCache = new Map<string, string>();

/**
 * Decode an embedded helper, loudly.
 *
 * A missing key would otherwise return `undefined` and write the string
 * "undefined" into a consumer's `.claude/helpers/gate.cjs` — a corrupt gate,
 * which is worse than the degraded install the fallback exists to rescue.
 * Throwing is the survivable outcome: `flo init` reports it and writes nothing.
 *
 * Note that this is NOT fallback-only. `executor.writeHelpers` builds its record
 * by calling all seven of these unconditionally, on every init — and with
 * `--force` it writes them over the files it just copied. That is precisely how
 * the drift this replaced reached healthy installs, not only broken ones.
 *
 * Decoding is lazy and memoised, so an init that ends up writing none of them
 * pays only for the base64 the module already holds — the ~180KB constant loads
 * with the module either way.
 */
function embedded(name: string): string {
  const cached = decodedCache.get(name);
  if (cached !== undefined) return cached;

  const encoded = EMBEDDED_HELPERS_BASE64[name];
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error(
      `Embedded helper "${name}" is missing or empty. Run \`npm run generate:helpers\` ` +
      '(scripts/generate-embedded-helpers.mjs) to rebuild src/cli/init/embedded-helpers.ts.',
    );
  }
  const content = Buffer.from(encoded, 'base64').toString('utf-8');
  if (content.length === 0) {
    throw new Error(`Embedded helper "${name}" decoded to nothing — the embed is corrupt.`);
  }
  decodedCache.set(name, content);
  return content;
}

/** Generate pre-commit hook script */
export function generatePreCommitHook(): string {
  return embedded('pre-commit');
}

/** Generate post-commit hook script */
export function generatePostCommitHook(): string {
  return embedded('post-commit');
}

/** Generate the auto-memory bridge hook */
export function generateAutoMemoryHook(): string {
  return embedded('auto-memory-hook.mjs');
}

/**
 * Generate all helper files
 */
export function generateHelpers(options: InitOptions): Record<string, string> {
  const helpers: Record<string, string> = {};

  if (options.components.helpers) {
    helpers['pre-commit'] = generatePreCommitHook();
    helpers['post-commit'] = generatePostCommitHook();
    helpers['gate.cjs'] = generateGateScript();
    helpers['gate-hook.mjs'] = generateGateHookScript();
    helpers['prompt-hook.mjs'] = generatePromptHookScript();
    helpers['hook-handler.cjs'] = generateHookHandlerScript();
  }

  // statusline.cjs is intentionally NOT generated here — it is shipped as a
  // static file in `.claude/helpers/statusline.cjs` and copied during init/
  // upgrade by executor.writeStatusline (#715). One source of truth.

  return helpers;
}

/**
 * Lightweight gate.cjs — spell gates without CLI bootstrap. Replaces
 * `npx flo gate <command>` to avoid spawning a full CLI process on every tool
 * call (~500ms npx overhead -> ~20ms direct node).
 */
export function generateGateScript(): string {
  return embedded('gate.cjs');
}

/** The gate bridge Claude Code's hooks invoke, which shells into gate.cjs */
export function generateGateHookScript(): string {
  return embedded('gate-hook.mjs');
}

/** The UserPromptSubmit bridge */
export function generatePromptHookScript(): string {
  return embedded('prompt-hook.mjs');
}

/** The PostToolUse / Stop / Notification handler */
export function generateHookHandlerScript(): string {
  return embedded('hook-handler.cjs');
}
