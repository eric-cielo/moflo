/**
 * Extract a human-readable detail string from an arbitrary thrown value.
 *
 * The `e instanceof Error ? e.message : String(e)` pattern (sometimes with
 * a `.split('\n')[0]` clip) lives inline at ~170 call sites across `src/`.
 * This helper is the canonical replacement; doctor.ts adopts it in epic
 * #781, and the rest can migrate as touched.
 *
 * Issue #781 / #785 — the `no-restricted-syntax` rule that forbids silent
 * catches downgrading to `status: 'warn'` requires the underlying error in
 * the returned message; calling `errorDetail(e)` inside a template literal
 * is the canonical satisfying shape.
 */
export function errorDetail(
  e: unknown,
  opts: { firstLineOnly?: boolean } = {},
): string {
  const raw = e instanceof Error ? e.message : String(e);
  return opts.firstLineOnly ? raw.split(/\r?\n/)[0] : raw;
}
