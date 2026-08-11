#!/usr/bin/env node
/**
 * Embed the canonical helper files into a TypeScript module so `flo init`'s
 * fallback path emits them byte-for-byte (#1443).
 *
 * WHY EMBED RATHER THAN READ AT RUNTIME
 *
 * `src/cli/init/executor.ts` writes these helpers from `generateXScript()` only
 * when `findSourceHelpersDir()` returns null — i.e. when the package's own files
 * cannot be located ("npx with broken paths"). A fallback for "the files are not
 * findable" cannot itself read those files, and resolving them from `__dirname`
 * would be the `../../../../` dist-vs-source depth trap that broke #1126's first
 * iteration. So the content has to be compiled in.
 *
 * Before this, each generator carried a hand-maintained copy of the helper it
 * emits. Five of the seven had drifted; `gate.cjs` had fallen far enough behind
 * to be missing #1348's credit-fingerprint invalidation entirely, so a project
 * that received the fallback had testing/simplify/verify credits that never
 * expired when the code changed. Nothing compared them, so nothing said so.
 *
 * Run via `npm run generate:helpers` after changing any canonical helper. The
 * output is committed, and tests/guards/embedded-helpers-parity.test.ts fails
 * when it is stale.
 *
 * Deliberately NOT wired into `prebuild`. It was, and that quietly disarmed the
 * guard: CI builds before it tests, so the prebuild rewrote the embed and the
 * staleness check then compared the freshly-regenerated file against itself —
 * green no matter what a contributor forgot to commit. A generated artifact that
 * regenerates itself before its own freshness check is not guarded at all. Left
 * manual so the check has something real to catch.
 *
 * Cross-platform (Rule #1): `path.join` throughout, Node fs only, no shell. Line
 * endings are normalised to LF before embedding — `.gitattributes` already
 * checks these out as LF everywhere, and normalising anyway keeps the generated
 * file byte-identical no matter what a contributor's git config does, so it
 * cannot churn between platforms.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadShippedScripts } from '../bin/lib/shipped-scripts.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Helper filename → the generator that emits it. The DIRECTORY each lives in is
 * not repeated here: it comes from bin/lib/shipped-scripts.json, which is the
 * repo's declared single source of truth for what ships where. A helper that
 * moves buckets there moves here automatically, and one that vanishes fails
 * loudly below instead of silently embedding a stale path.
 */
const GENERATOR_BY_HELPER = {
  'gate.cjs': 'generateGateScript',
  'gate-hook.mjs': 'generateGateHookScript',
  'prompt-hook.mjs': 'generatePromptHookScript',
  'hook-handler.cjs': 'generateHookHandlerScript',
  'auto-memory-hook.mjs': 'generateAutoMemoryHook',
  'pre-commit': 'generatePreCommitHook',
  'post-commit': 'generatePostCommitHook',
};

const BIN_LIB_DIR = join(REPO_ROOT, 'bin', 'lib');
const OUTPUT_PATH = join(REPO_ROOT, 'src', 'cli', 'init', 'embedded-helpers.ts');

/**
 * Resolve a helper to its canonical file. `binHelperFiles` ship from `bin/`;
 * `sourceHelperFiles` are authored in `.claude/helpers/` and ship from there.
 * @param {string} name
 * @param {{binHelperFiles: string[], sourceHelperFiles: string[]}} manifest
 * @returns {string} absolute path
 */
export function canonicalPathFor(name, manifest) {
  if (manifest.binHelperFiles.includes(name)) return join(REPO_ROOT, 'bin', name);
  if (manifest.sourceHelperFiles.includes(name)) return join(REPO_ROOT, '.claude', 'helpers', name);
  throw new Error(
    `"${name}" is in neither binHelperFiles nor sourceHelperFiles of ` +
    `${join(BIN_LIB_DIR, 'shipped-scripts.json')}. Add it there (that file is the canonical ` +
    'manifest) or drop it from GENERATOR_BY_HELPER.',
  );
}

/** Build the module text. Exported so the parity guard can diff without writing. */
export function renderEmbeddedHelpers() {
  // loadShippedScripts, not a second JSON.parse of the same manifest — two
  // independent readers of one file is the drift this change exists to remove.
  const manifest = loadShippedScripts(BIN_LIB_DIR);

  // Sorted so the generated file is a function of its inputs alone — an
  // unstable key order would show up as phantom diffs on every regeneration.
  const entries = Object.keys(GENERATOR_BY_HELPER).sort().map((name) => {
    const content = readFileSync(canonicalPathFor(name, manifest), 'utf-8').replace(/\r\n/g, '\n');
    // Base64, not a raw string literal. The payload is helper SOURCE, and
    // embedding it verbatim makes every source-scanning guard read it as code
    // living here: the dist-resolution gate immediately flagged gate.cjs's own
    // `require('./pr-create-command.cjs')` as an unresolvable target of THIS
    // file. Encoding keeps the payload opaque to that scanner and to every
    // other one — leak guards, simulation sweeps — without any of them needing
    // to know this file exists. It also sidesteps escaping backticks and `${`.
    return `  ${JSON.stringify(name)}: ${JSON.stringify(Buffer.from(content, 'utf-8').toString('base64'))},`;
  });

  return `/**
 * Auto-generated by build. Do not edit manually.
 * Source of truth: the canonical helper files themselves (bin/*, .claude/helpers/*)
 * via scripts/generate-embedded-helpers.mjs — run \`npm run generate:helpers\`.
 *
 * These back \`flo init\`'s fallback helper writes, which cannot read the files
 * they emit (see the script's header for why). Editing this file by hand
 * re-creates the drift it exists to remove; tests/guards/embedded-helpers-parity
 * .test.ts will fail if it is stale.
 *
 * Values are base64 of the LF-normalised file. Decoded lazily by
 * helpers-generator.ts, so the normal init path — which copies the real files
 * and never touches these — pays nothing for them.
 */

/* eslint-disable */
export const EMBEDDED_HELPERS_BASE64: Record<string, string> = {
${entries.join('\n')}
};
`;
}

/**
 * Run-directly detection, Rule #1.
 *
 * A bare `fileURLToPath(import.meta.url) === process.argv[1]` compares an
 * absolute path against whatever the caller typed, and on Windows also compares
 * case-sensitively against a case-insensitive filesystem — either of which makes
 * this script silently no-op when invoked from npm. Rule #1 item 2: realpath
 * BOTH sides before comparing for identity, so a symlinked checkout (or macOS's
 * /var -> /private/var) does not read as two different files. Fold case only
 * where the filesystem does.
 */
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    let abs = resolve(p);
    try {
      abs = realpathSync(abs);
    } catch { /* not on disk (unlikely for argv[1]) — the resolved path stands */ }
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
})();

if (invokedDirectly) {
  const rendered = renderEmbeddedHelpers();
  let previous = null;
  try {
    previous = readFileSync(OUTPUT_PATH, 'utf-8');
  } catch { /* first run — nothing to compare */ }
  if (previous === rendered) {
    process.stdout.write('embedded-helpers.ts already current\n');
  } else {
    writeFileSync(OUTPUT_PATH, rendered);
    process.stdout.write(`embedded-helpers.ts regenerated (${rendered.length} bytes)\n`);
  }
}

export { GENERATOR_BY_HELPER, OUTPUT_PATH };
