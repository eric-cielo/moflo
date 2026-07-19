/**
 * Default SDD artifact bodies — Story #1273 (Epic #1269).
 *
 * These seed the reviewable Markdown a `flo sdd` scaffold produces. They mirror
 * the shape `/commune` synthesizes (Problem / Goal / Scope / Acceptance
 * Criteria), so a spec handed off from `/commune` drops straight in.
 *
 * The constitution layer is referenced, not restated: every spec body links out
 * to CLAUDE.md + .claude/guidance/ rather than copying invariants inline.
 */

/** Default `spec.md` body (below the frontmatter). Requires `## Acceptance Criteria`. */
export function defaultSpecBody(title: string): string {
  return `# Spec: ${title}

## Problem
<the pain, who feels it, why now>

## Goal & non-goals
- **Goal:** <one sentence>
- **Non-goals:** <what this deliberately does not do>

## Scope
- **MVP:** <smallest valuable slice>
- **Out of scope:** <deferred items>

## Constraints
<technical, dependency, perf, security, cross-platform, consumer-blast-radius>

## Acceptance Criteria
- [ ] <observable/measurable condition for "done">

## Constitution
Invariants this work must respect live in the project's constitution layer, by
reference — do not restate them here:
- \`CLAUDE.md\` (root + nearest directory-scoped)
- \`.claude/guidance/\`
`;
}

/** Default `plan.md` body (below the frontmatter). Requires `## Steps`. */
export function defaultPlanBody(title: string): string {
  return `# Plan: ${title}

## Approach
<the chosen approach in plain terms; alternatives considered + why-not>

## Steps
1. <first concrete step>
2. <next step>

## Verification
How each Acceptance Criterion in the spec will be proven end-to-end before done
(this is what the verify-before-done gate checks against):
- <criterion> → <how it's verified>

## Risks
- <risk or unknown> — <mitigation or "needs a spike">
`;
}
