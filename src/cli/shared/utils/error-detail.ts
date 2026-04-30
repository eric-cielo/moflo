/**
 * Extract a human-readable detail string from an arbitrary thrown value.
 *
 * Repeats `e instanceof Error ? e.message : String(e)` lived inline at ~15
 * call sites before this helper landed. Centralising prevents subtle drift
 * (some sites also `.split('\n')[0]` to clip multiline messages, and
 * inconsistent use was masking which checks intentionally truncate).
 *
 * Issue #781 / #785 — required by the `no-restricted-syntax` rule that
 * forbids silent catches downgrading to `status: 'warn'` without including
 * the underlying error in the returned message.
 */
export function errorDetail(
  e: unknown,
  opts: { firstLineOnly?: boolean } = {},
): string {
  const raw = e instanceof Error ? e.message : String(e);
  return opts.firstLineOnly ? raw.split(/\r?\n/)[0] : raw;
}
