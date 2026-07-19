/**
 * MoFlo SDD (Spec-Driven Development) artifact model — Story #1273 (Epic #1269).
 *
 * Defines the on-disk convention and read/write/validate API for the two SDD
 * artifacts that anchor the spec → plan → implement → verify cycle:
 *
 *   .moflo/specs/<slug>/spec.md   — the "what" + acceptance criteria
 *   .moflo/specs/<slug>/plan.md   — the "steps"
 *
 * Both are reviewable Markdown with a small YAML frontmatter header. The
 * `status` field drives the review checkpoint between stages: a spec must be
 * `reviewed` before its plan is authored, and a plan must be `reviewed` before
 * implementation begins (see `assertReviewed`).
 *
 * The constitution layer (CLAUDE.md + .claude/guidance/) is referenced by the
 * workflow, NOT duplicated here — these artifacts carry only per-unit content.
 *
 * Cross-platform (Rule #1): every path is built with `path.join`; no separator
 * is ever hardcoded, and the frontmatter parser normalizes CRLF/LF.
 */

import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';

export type SddArtifactKind = 'spec' | 'plan';

/**
 * Review-checkpoint lifecycle. `draft` is the freshly-authored state; `reviewed`
 * means a human (or the workflow's review step) signed off, unlocking the next
 * stage. Kept deliberately tiny — richer workflow state belongs in memory, not
 * the artifact header.
 */
export type SddStatus = 'draft' | 'reviewed';

export const SDD_STATUSES: readonly SddStatus[] = ['draft', 'reviewed'] as const;

export interface SddFrontmatter {
  kind: SddArtifactKind;
  slug: string;
  title: string;
  status: SddStatus;
  created: string; // ISO 8601
  updated: string; // ISO 8601
}

export interface SddArtifact extends SddFrontmatter {
  /** Markdown body below the frontmatter block. */
  body: string;
}

export interface SddValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================================
// Paths — all via path.join (Rule #1)
// ============================================================================

/** Root directory holding every spec slug: `<projectRoot>/.moflo/specs`. */
export function specsRoot(projectRoot: string): string {
  return join(projectRoot, '.moflo', 'specs');
}

/** Per-unit directory: `<projectRoot>/.moflo/specs/<slug>`. */
export function specDir(projectRoot: string, slug: string): string {
  return join(specsRoot(projectRoot), slug);
}

/** Absolute path to a given artifact file. */
export function artifactPath(
  projectRoot: string,
  slug: string,
  kind: SddArtifactKind,
): string {
  return join(specDir(projectRoot, slug), `${kind}.md`);
}

/**
 * Derive a filesystem-safe slug from a free-form title. Lowercased, non-alnum
 * runs collapsed to single hyphens, trimmed. Case-folding keeps the path stable
 * on case-insensitive filesystems (macOS/Windows — Rule #1 #3).
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

// ============================================================================
// Serialize / parse — minimal, dependency-free frontmatter
// ============================================================================

const FRONTMATTER_KEYS: (keyof SddFrontmatter)[] = [
  'kind',
  'slug',
  'title',
  'status',
  'created',
  'updated',
];

/** Escape a frontmatter scalar. We only ever emit simple strings; quote to be safe. */
function emitScalar(value: string): string {
  // Double-quote and escape embedded quotes/backslashes so titles with `:` are safe.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return trimmed;
}

/** Render an artifact object to Markdown-with-frontmatter. */
export function serializeArtifact(artifact: SddArtifact): string {
  const lines = ['---'];
  for (const key of FRONTMATTER_KEYS) {
    lines.push(`${key}: ${emitScalar(String(artifact[key]))}`);
  }
  lines.push('---', '');
  // Normalize to LF; the caller writes with the platform's default EOL policy
  // via .gitattributes text=auto, so we keep a single canonical form on disk.
  const body = artifact.body.replace(/\r\n/g, '\n').replace(/\s*$/, '');
  return `${lines.join('\n')}\n${body}\n`;
}

/**
 * Parse Markdown-with-frontmatter into an artifact. Returns null when the
 * frontmatter block is missing or malformed — callers surface that as invalid.
 */
export function parseArtifact(markdown: string): SddArtifact | null {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const [, header, body] = match;
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    meta[key] = parseScalar(line.slice(idx + 1));
  }

  const kind = meta.kind as SddArtifactKind;
  if (kind !== 'spec' && kind !== 'plan') return null;
  const status = (meta.status as SddStatus) || 'draft';

  return {
    kind,
    slug: meta.slug || '',
    title: meta.title || '',
    status: SDD_STATUSES.includes(status) ? status : 'draft',
    created: meta.created || '',
    updated: meta.updated || '',
    body: body.replace(/^\n+/, ''),
  };
}

// ============================================================================
// Validation
// ============================================================================

const REQUIRED_SECTION: Record<SddArtifactKind, RegExp> = {
  // A spec must carry acceptance criteria (the "what" verify checks against).
  spec: /^##\s+Acceptance Criteria\s*$/im,
  // A plan must carry ordered steps.
  plan: /^##\s+(Steps|Plan)\s*$/im,
};

/** Does the body contain at least one list item under the required section? */
function hasListItemUnderSection(body: string, sectionRe: RegExp): boolean {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let inSection = false;
  for (const line of lines) {
    if (sectionRe.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^##\s+/.test(line)) break; // next section — stop
      if (/^\s*(?:[-*+]|\d+\.)\s+\S/.test(line)) return true; // a real list item
    }
  }
  return false;
}

/**
 * Validate an artifact's structure. A well-formed spec has a title and a
 * non-empty `## Acceptance Criteria` section; a well-formed plan has a title and
 * a non-empty `## Steps` (or `## Plan`) section. Malformed frontmatter, wrong
 * `kind`, or a missing/empty required section all fail.
 */
export function validateArtifact(
  kind: SddArtifactKind,
  markdown: string,
): SddValidationResult {
  const errors: string[] = [];
  const parsed = parseArtifact(markdown);

  if (!parsed) {
    return { valid: false, errors: ['missing or malformed frontmatter block'] };
  }
  if (parsed.kind !== kind) {
    errors.push(`frontmatter kind "${parsed.kind}" does not match expected "${kind}"`);
  }
  if (!parsed.title.trim()) errors.push('missing title');
  if (!parsed.slug.trim()) errors.push('missing slug');
  if (!SDD_STATUSES.includes(parsed.status)) {
    errors.push(`invalid status "${parsed.status}"`);
  }

  const sectionRe = REQUIRED_SECTION[kind];
  if (!sectionRe.test(parsed.body)) {
    errors.push(
      kind === 'spec'
        ? 'missing "## Acceptance Criteria" section'
        : 'missing "## Steps" section',
    );
  } else if (!hasListItemUnderSection(parsed.body, sectionRe)) {
    errors.push(
      kind === 'spec'
        ? '"## Acceptance Criteria" section has no list items'
        : '"## Steps" section has no list items',
    );
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Read / write / list
// ============================================================================

/** Write an artifact to its conventional path, creating the slug dir as needed. */
export function writeArtifact(projectRoot: string, artifact: SddArtifact): string {
  const dir = specDir(projectRoot, artifact.slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = artifactPath(projectRoot, artifact.slug, artifact.kind);
  writeFileSync(filePath, serializeArtifact(artifact), 'utf-8');
  return filePath;
}

/** Read + parse an artifact; returns null when the file is absent or malformed. */
export function readArtifact(
  projectRoot: string,
  slug: string,
  kind: SddArtifactKind,
): SddArtifact | null {
  const filePath = artifactPath(projectRoot, slug, kind);
  if (!existsSync(filePath)) return null;
  try {
    return parseArtifact(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export interface SddSlugInfo {
  slug: string;
  hasSpec: boolean;
  hasPlan: boolean;
  specStatus: SddStatus | null;
  planStatus: SddStatus | null;
}

/** Enumerate every spec slug on disk with a quick status summary. */
export function listSpecs(projectRoot: string): SddSlugInfo[] {
  const root = specsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const out: SddSlugInfo[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const spec = readArtifact(projectRoot, slug, 'spec');
    const plan = readArtifact(projectRoot, slug, 'plan');
    out.push({
      slug,
      hasSpec: existsSync(artifactPath(projectRoot, slug, 'spec')),
      hasPlan: existsSync(artifactPath(projectRoot, slug, 'plan')),
      specStatus: spec ? spec.status : null,
      planStatus: plan ? plan.status : null,
    });
  }
  // Deterministic order (stable across platforms — readdir order is not).
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ============================================================================
// Review checkpoint
// ============================================================================

export interface CheckpointResult {
  ok: boolean;
  reason?: string;
}

/**
 * Enforce the review checkpoint that gates the next stage:
 *   - before authoring a plan → the spec must exist and be `reviewed`
 *   - before implementing     → the plan must exist and be `reviewed`
 *
 * Returns `{ ok: false, reason }` rather than throwing so callers (CLI, skill)
 * can surface a friendly message and let the human advance the artifact.
 */
export function assertReviewed(
  projectRoot: string,
  slug: string,
  stage: 'plan' | 'implement',
): CheckpointResult {
  const kind: SddArtifactKind = stage === 'plan' ? 'spec' : 'plan';
  const artifact = readArtifact(projectRoot, slug, kind);
  if (!artifact) {
    return { ok: false, reason: `no ${kind}.md found for slug "${slug}"` };
  }
  if (artifact.status !== 'reviewed') {
    return {
      ok: false,
      reason: `${kind}.md for "${slug}" is "${artifact.status}", not "reviewed" — review it before ${stage === 'plan' ? 'planning' : 'implementing'}`,
    };
  }
  return { ok: true };
}

/** Build a fresh artifact object with timestamps stamped now. */
export function newArtifact(
  kind: SddArtifactKind,
  title: string,
  body: string,
  opts: { slug?: string; status?: SddStatus; now?: string } = {},
): SddArtifact {
  const now = opts.now || new Date().toISOString();
  return {
    kind,
    slug: opts.slug || slugify(title),
    title,
    status: opts.status || 'draft',
    created: now,
    updated: now,
    body,
  };
}

/** Return true if a spec dir exists for the slug. */
export function specExists(projectRoot: string, slug: string): boolean {
  try {
    return statSync(specDir(projectRoot, slug)).isDirectory();
  } catch {
    return false;
  }
}
