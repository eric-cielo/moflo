/**
 * Sandbox image name drift guard.
 *
 * The sandbox image `ghcr.io/eric-cielo/moflo-sandbox` is referenced in three
 * places that can drift independently:
 *
 *   1. `docker/sandbox/Dockerfile`                   (header comment)
 *   2. `.github/workflows/sandbox-image.yml`         (env.IMAGE — what CI publishes)
 *   3. `src/cli/spells/core/platform-sandbox.ts`
 *                                                   (RECOMMENDED_DOCKER_IMAGE — what the
 *                                                    runtime pulls)
 *
 * If any one moves (org rename, image rename, tag-scheme change) without the
 * others being updated in the same PR, local sandboxes will pull a different
 * image than CI publishes — a silent "works on my machine" bug.
 *
 * This test fails if those three sources disagree on the base image name.
 *
 * @see https://github.com/eric-cielo/moflo/issues/579
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECOMMENDED_DOCKER_IMAGE } from '../../spells/core/platform-sandbox.js';
import { findRepoRoot } from '../_helpers/repo-walk.js';

const EXPECTED_IMAGE_BASE = 'ghcr.io/eric-cielo/moflo-sandbox';

const REPO_ROOT = findRepoRoot(import.meta.url);

function stripTag(image: string): string {
  // Strip `:<tag>` but preserve `:` in a port like `registry:5000/...`.
  const lastSlash = image.lastIndexOf('/');
  const colonAfterSlash = image.indexOf(':', lastSlash + 1);
  return colonAfterSlash === -1 ? image : image.slice(0, colonAfterSlash);
}

describe('sandbox image name drift guard (#579)', () => {
  it('Dockerfile references only the canonical sandbox image', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'docker/sandbox/Dockerfile'), 'utf-8');
    const refs = dockerfile.match(/ghcr\.io\/[\w./-]+/g) ?? [];
    expect(refs.length, 'Expected at least one ghcr.io reference in Dockerfile').toBeGreaterThan(0);
    const bases = new Set(refs.map(stripTag));
    expect([...bases]).toEqual([EXPECTED_IMAGE_BASE]);
  });

  it('sandbox-image.yml env.IMAGE matches the canonical base', () => {
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/sandbox-image.yml'),
      'utf-8',
    );
    const match = workflow.match(/^\s*IMAGE:\s*(\S+)\s*$/m);
    expect(match, 'env.IMAGE not found in .github/workflows/sandbox-image.yml').not.toBeNull();
    expect(match![1]).toBe(EXPECTED_IMAGE_BASE);
  });

  it('RECOMMENDED_DOCKER_IMAGE has the canonical base', () => {
    expect(stripTag(RECOMMENDED_DOCKER_IMAGE)).toBe(EXPECTED_IMAGE_BASE);
  });
});
