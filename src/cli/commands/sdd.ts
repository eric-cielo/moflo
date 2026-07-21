/**
 * MoFlo SDD Command — Story #1273 (Epic #1269).
 *
 * Manages the spec → plan → implement → verify artifact spine that lives under
 * `.moflo/specs/<slug>/{spec,plan}.md`. The `/flo` skill's `--sdd` flow and
 * `/commune` shell out to these subcommands; nothing here writes source code.
 *
 * Usage:
 *   flo sdd spec "<title>"            Scaffold (or show) a spec.md for a unit of work
 *   flo sdd plan <slug>              Scaffold a plan.md (requires the spec be reviewed)
 *   flo sdd review <slug> [spec|plan] Mark an artifact reviewed (unlocks the next stage)
 *   flo sdd validate <slug> [spec|plan] Structural validation
 *   flo sdd check <slug> <plan|implement> Review-checkpoint gate (exit 2 if not ready)
 *   flo sdd status <slug>            Show one unit's spec/plan status
 *   flo sdd list                     List every spec slug
 *   flo sdd path <slug> [spec|plan]  Print the artifact path (for skill shell-out)
 *   flo sdd embed <slug>             Print spec+plan as a PR-body block (#1297)
 *   flo sdd index                    Re-index specs into memory now (also runs at session start)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { findProjectRoot } from '../services/project-root.js';
import { locateMofloRootPath } from '../services/moflo-require.js';
import {
  type SddArtifactKind,
  artifactPath,
  assertReviewed,
  listSpecs,
  newArtifact,
  readArtifact,
  slugify,
  specExists,
  validateArtifact,
  writeArtifact,
} from '../sdd/index.js';
import { defaultPlanBody, defaultSpecBody } from '../sdd/templates.js';

function projectRoot(ctx: CommandContext): string {
  return findProjectRoot({ cwd: ctx.cwd });
}

/**
 * Stamp the active SDD slug into `.claude/workflow-state.json` so the
 * `check-before-implement` gate (#1297) knows which unit this run is building.
 * Read-merge-write to preserve every other gate flag. Best-effort: a failure
 * here must never block spec authoring, so errors are swallowed. Cross-platform:
 * path via `join`, dir created recursively (Rule #1).
 */
function stampActiveSlug(root: string, slug: string): void {
  try {
    const statePath = join(root, '.claude', 'workflow-state.json');
    let state: Record<string, unknown> = {};
    if (existsSync(statePath)) {
      try {
        state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        state = {};
      }
    }
    state.sddMode = true;
    state.activeSddSlug = slug;
    mkdirSync(dirname(statePath), { recursive: true });
    // Atomic write — the gate hook writes this same file; a plain writeFileSync
    // racing it can leave torn JSON the gate then fails to parse (reuse #1297).
    atomicWriteFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    /* stamping is best-effort — never block the spec on it */
  }
}

function parseKindArg(raw: string | undefined, fallback: SddArtifactKind): SddArtifactKind {
  return raw === 'plan' ? 'plan' : raw === 'spec' ? 'spec' : fallback;
}

/** Read a --from <file> body override, or a `-` stdin sentinel. */
function bodyFromFlag(ctx: CommandContext): string | null {
  const from = ctx.flags.from;
  if (typeof from !== 'string' || !from) return null;
  if (from === '-') {
    try {
      return readFileSync(0, 'utf-8');
    } catch {
      return null;
    }
  }
  if (!existsSync(from)) return null;
  return readFileSync(from, 'utf-8');
}

function cmdSpec(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const title = ctx.args.slice(1).join(' ').trim();
  if (!title) {
    console.log('Usage: flo sdd spec "<title>"  [--from <file|->]');
    return { success: false, exitCode: 1 };
  }
  const slug = typeof ctx.flags.slug === 'string' ? slugify(ctx.flags.slug) : slugify(title);

  // Arm the implement gate for this unit (#1297) — whether we (re)author the
  // spec or it already exists, this run is now building `slug`.
  stampActiveSlug(root, slug);

  const existing = readArtifact(root, slug, 'spec');
  if (existing && !ctx.flags.force) {
    console.log(`Spec already exists: ${artifactPath(root, slug, 'spec')} (status: ${existing.status})`);
    console.log('Pass --force to overwrite, or edit the file directly.');
    return { success: true, data: { slug, status: existing.status } };
  }

  const body = bodyFromFlag(ctx) ?? defaultSpecBody(title);
  const artifact = newArtifact('spec', title, body, { slug });
  const filePath = writeArtifact(root, artifact);
  console.log(`✓ Spec written: ${filePath}`);
  console.log(`  slug: ${slug}   status: draft`);
  console.log('  Next: review it, then `flo sdd review ' + slug + '` to unlock the plan.');
  return { success: true, data: { slug, path: filePath } };
}

function cmdPlan(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const slug = slugify(ctx.args[1] || '');
  if (!slug || slug === 'untitled') {
    console.log('Usage: flo sdd plan <slug>  [--from <file|->] [--force]');
    return { success: false, exitCode: 1 };
  }
  const spec = readArtifact(root, slug, 'spec');
  if (!spec) {
    console.log(`No spec found for "${slug}". Create it first: flo sdd spec "<title>"`);
    return { success: false, exitCode: 1 };
  }

  // Review checkpoint: spec must be reviewed before a plan is authored.
  if (!ctx.flags.force) {
    const checkpoint = assertReviewed(root, slug, 'plan');
    if (!checkpoint.ok) {
      console.log(`✗ Checkpoint: ${checkpoint.reason}`);
      console.log(`  Run: flo sdd review ${slug}   (or pass --force to override)`);
      return { success: false, exitCode: 2 };
    }
  }

  const existing = readArtifact(root, slug, 'plan');
  if (existing && !ctx.flags.force) {
    console.log(`Plan already exists: ${artifactPath(root, slug, 'plan')} (status: ${existing.status})`);
    return { success: true, data: { slug, status: existing.status } };
  }

  const body = bodyFromFlag(ctx) ?? defaultPlanBody(spec.title);
  const artifact = newArtifact('plan', spec.title, body, { slug });
  const filePath = writeArtifact(root, artifact);
  console.log(`✓ Plan written: ${filePath}`);
  console.log(`  slug: ${slug}   status: draft`);
  console.log('  Next: review it, then `flo sdd review ' + slug + ' plan` to unlock implementation.');
  return { success: true, data: { slug, path: filePath } };
}

function cmdReview(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const slug = slugify(ctx.args[1] || '');
  const kind = parseKindArg(ctx.args[2], 'spec');
  if (!slug || slug === 'untitled') {
    console.log('Usage: flo sdd review <slug> [spec|plan]');
    return { success: false, exitCode: 1 };
  }
  const artifact = readArtifact(root, slug, kind);
  if (!artifact) {
    console.log(`No ${kind}.md found for "${slug}".`);
    return { success: false, exitCode: 1 };
  }
  if (artifact.status === 'reviewed') {
    console.log(`${kind}.md for "${slug}" is already reviewed.`);
    return { success: true };
  }
  artifact.status = 'reviewed';
  artifact.updated = new Date().toISOString();
  const filePath = writeArtifact(root, artifact);
  console.log(`✓ Marked ${kind} reviewed: ${filePath}`);
  return { success: true, data: { slug, kind } };
}

function cmdValidate(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const slug = slugify(ctx.args[1] || '');
  const kinds: SddArtifactKind[] = ctx.args[2]
    ? [parseKindArg(ctx.args[2], 'spec')]
    : ['spec', 'plan'];
  let allValid = true;
  for (const kind of kinds) {
    const filePath = artifactPath(root, slug, kind);
    if (!existsSync(filePath)) {
      if (ctx.args[2]) {
        console.log(`✗ ${kind}: file not found (${filePath})`);
        allValid = false;
      }
      continue;
    }
    const result = validateArtifact(kind, readFileSync(filePath, 'utf-8'));
    if (result.valid) {
      console.log(`✓ ${kind}: valid`);
    } else {
      allValid = false;
      console.log(`✗ ${kind}: ${result.errors.join('; ')}`);
    }
  }
  return { success: allValid, exitCode: allValid ? 0 : 2 };
}

function cmdCheck(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const slug = slugify(ctx.args[1] || '');
  const stage = ctx.args[2] === 'implement' ? 'implement' : 'plan';
  const checkpoint = assertReviewed(root, slug, stage);
  if (checkpoint.ok) {
    console.log(`✓ Checkpoint passed: ready to ${stage}.`);
    return { success: true };
  }
  console.error(`✗ Checkpoint blocked: ${checkpoint.reason}`);
  return { success: false, exitCode: 2 };
}

function cmdStatus(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const slug = slugify(ctx.args[1] || '');
  if (!specExists(root, slug)) {
    console.log(`No spec unit found for "${slug}".`);
    return { success: false, exitCode: 1 };
  }
  const spec = readArtifact(root, slug, 'spec');
  const plan = readArtifact(root, slug, 'plan');
  console.log(`SDD unit: ${slug}`);
  console.log(`  spec: ${spec ? spec.status : '—'}`);
  console.log(`  plan: ${plan ? plan.status : '—'}`);
  return { success: true, data: { slug, spec: spec?.status ?? null, plan: plan?.status ?? null } };
}

function cmdList(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const specs = listSpecs(root);
  if (specs.length === 0) {
    console.log('No SDD specs yet. Create one: flo sdd spec "<title>"');
    return { success: true, data: [] };
  }
  console.log(`SDD specs (${specs.length}):`);
  for (const s of specs) {
    console.log(`  ${s.slug}  [spec: ${s.specStatus ?? '—'}, plan: ${s.planStatus ?? '—'}]`);
  }
  return { success: true, data: specs };
}

function cmdPath(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const slug = slugify(ctx.args[1] || '');
  const kind = parseKindArg(ctx.args[2], 'spec');
  console.log(artifactPath(root, slug, kind));
  return { success: true };
}

/**
 * Print a collapsible Markdown block containing the spec + plan for a slug, for
 * `/flo` to append to the PR body (#1297, option B). This makes the SDD
 * reasoning reviewable in the PR even when `specs_dir` stays local/gitignored —
 * orthogonal to pointing `specs_dir` at a tracked path. Emits nothing (exit 0)
 * when no spec exists, so the skill can pipe it unconditionally.
 */
function cmdEmbed(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const slug = slugify(ctx.args[1] || '');
  if (!slug || slug === 'untitled') {
    console.log('Usage: flo sdd embed <slug>');
    return { success: false, exitCode: 1 };
  }
  const spec = readArtifact(root, slug, 'spec');
  if (!spec) {
    // No spec — nothing to embed. Silent success so `/flo` can call it blindly.
    return { success: true, data: { slug, embedded: false } };
  }
  const plan = readArtifact(root, slug, 'plan');
  const parts: string[] = [
    '<details>',
    '<summary>📋 SDD spec &amp; plan</summary>',
    '',
    `### Spec — ${spec.title} (${spec.status})`,
    '',
    spec.body.trim(),
  ];
  if (plan) {
    parts.push('', `### Plan (${plan.status})`, '', plan.body.trim());
  }
  parts.push('', '</details>');
  console.log(parts.join('\n'));
  return { success: true, data: { slug, embedded: true, hasPlan: !!plan } };
}

function cmdIndex(ctx: CommandContext): CommandResult {
  const root = projectRoot(ctx);
  const indexer = locateMofloRootPath(join('bin', 'index-guidance.mjs'));
  if (!indexer) {
    console.log('Guidance indexer not found; specs will be indexed at next session start.');
    return { success: true };
  }
  const res = spawnSync(process.execPath, [indexer], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { success: res.status === 0, exitCode: res.status ?? 0 };
}

const HELP = `Usage: flo sdd <command>

Spec-Driven Development artifacts (.moflo/specs/<slug>/{spec,plan}.md):
  spec "<title>"            Scaffold or show a spec (the "what" + acceptance criteria)
  plan <slug>              Scaffold a plan (requires the spec be reviewed)
  review <slug> [spec|plan] Mark an artifact reviewed — unlocks the next stage
  validate <slug> [spec|plan] Structural validation
  check <slug> <plan|implement> Review-checkpoint gate (exit 2 if not ready)
  status <slug>            Show one unit's spec/plan status
  list                     List every spec slug
  path <slug> [spec|plan]  Print the artifact path
  embed <slug>             Print spec+plan as a collapsible block for the PR body
  index                    Re-index specs into memory now`;

const sddCommand: Command = {
  name: 'sdd',
  description: 'Spec-Driven Development artifacts (spec → plan → implement → verify)',
  options: [],
  examples: [
    { command: 'flo sdd spec "Add rate limiting"', description: 'Scaffold a spec' },
    { command: 'flo sdd review add-rate-limiting', description: 'Mark the spec reviewed' },
    { command: 'flo sdd plan add-rate-limiting', description: 'Scaffold the plan (spec must be reviewed)' },
    { command: 'flo sdd check add-rate-limiting implement', description: 'Gate implementation on a reviewed plan' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sub = ctx.args?.[0];
    switch (sub) {
      case 'spec':
        return cmdSpec(ctx);
      case 'plan':
        return cmdPlan(ctx);
      case 'review':
        return cmdReview(ctx);
      case 'validate':
        return cmdValidate(ctx);
      case 'check':
        return cmdCheck(ctx);
      case 'status':
        return cmdStatus(ctx);
      case 'list':
        return cmdList(ctx);
      case 'path':
        return cmdPath(ctx);
      case 'embed':
        return cmdEmbed(ctx);
      case 'index':
        return cmdIndex(ctx);
      default:
        console.log(HELP);
        return { success: !sub, exitCode: sub ? 1 : 0 };
    }
  },
};

export default sddCommand;
