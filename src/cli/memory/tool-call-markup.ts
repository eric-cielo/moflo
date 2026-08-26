/**
 * Detect Claude Code tool-call markup captured into a memory value (#1467).
 *
 * A model emitting a `memory_store` call can have the harness' own parameter
 * markup spill into the `value` string it is writing. The value then arrives at
 * moflo already malformed, always as a fragment the text trails off into:
 *
 *     ...the actual lesson text.",
 *     <parameter name="tags">["a","b","source:manual"]
 *
 * moflo does not cause this — the markup exists only in the model/harness layer —
 * but it is the last component that can catch it. Left alone it is written to
 * disk, embedded (so it degrades the vector for that entry and every search that
 * would have matched it), and shared to the team artifact, at which point it is
 * permanent and propagates to every machine that imports.
 *
 * ## Why the detector is anchored rather than a bare marker match
 *
 * The naive test — "does the value contain `</value>` or `<parameter name=`" —
 * rejects the lesson that documents this very bug, and every guidance doc that
 * quotes the markup. So a marker only counts when it is *structurally broken*
 * AND *trailing*:
 *
 * | Rule | Fires on | Passes |
 * |---|---|---|
 * | A — trailing unmatched closer | value ends on a `</value>` / `</parameter>` that never had an opener | balanced `<value>x</value>` prose; a closer mentioned mid-text |
 * | B — unterminated trailing opener | an opener with no closer, on its own line, within the last {@link TRAILING_WINDOW} chars | an opener quoted inline in a sentence; one explained in the 200+ chars that follow |
 *
 * A value that discusses the markup explains it, and the explanation is the
 * anchor. A value that was *cut off by* the markup has nothing after it.
 *
 * ## Accepted blind spots
 *
 * The detector is deliberately tuned to miss rather than over-reject, because a
 * false reject blocks a legitimate write in every consumer while a miss only
 * leaves one entry as bad as it is today:
 *
 * - A captured fragment longer than {@link TRAILING_WINDOW}. Every fragment
 *   observed in #1467 is under 60 characters; widening the window would start
 *   rejecting docs that quote the markup.
 * - A value that quotes `<value>` earlier and is *then* truncated by a stray
 *   `</value>`: the quotation's opener absorbs the closer and both rules go
 *   quiet. Matching by tag name is what makes the balanced-prose cases pass.
 * - A value that begins with markup, having lost all of its own text.
 *
 * Rule A's one accepted false positive is the mirror image: a truncated XML
 * snippet that happens to end on an unmatched `</value>`. It is refusable by
 * design — the ticket asks for that shape — and {@link MARKUP_OVERRIDE_ENV} is
 * the way through. Bulk writes (`storeEntries`, whose only caller is the
 * pattern pre-trainer) are not checked at all, which is where machine-generated
 * XML-bearing content actually arrives.
 *
 * Pure string logic — no fs, no db, no platform surface (Rule #1).
 *
 * @module memory/tool-call-markup
 */

/**
 * How close to the end of the value an unterminated opener must sit to count as
 * a captured fragment rather than a quotation. Observed fragments are short —
 * `<parameter name="tags">["a","b","source:manual"]` is 47 characters — while
 * prose that quotes an opener goes on to say something about it.
 */
export const TRAILING_WINDOW = 200;

/** Escape hatch for a value that is genuinely shaped like the corruption. */
export const MARKUP_OVERRIDE_ENV = 'MOFLO_ALLOW_TOOL_CALL_MARKUP';

/** How much of the offending tail the error message quotes back. */
const EXCERPT_LIMIT = 120;

export interface ToolCallMarkupHit {
  /** The exact markup that tripped the detector, e.g. `</value>`. */
  marker: string;
  /** Offset of `marker` within the value. */
  index: number;
  /** Which rule fired — see the table in the module header. */
  reason: 'trailing-closer' | 'unterminated-opener';
}

/** One `<value>` / `<parameter name="…">` token found in the text. */
interface Token {
  name: 'value' | 'parameter';
  kind: 'open' | 'close';
  text: string;
  index: number;
}

/**
 * Matches the four token shapes the harness emits. `[^"]*` for the attribute
 * keeps the pattern linear — no nested quantifier, so no backtracking blow-up
 * on a long value. Built per scan rather than shared, so no `lastIndex` state
 * outlives a call.
 */
function tokenPattern(): RegExp {
  return /<(\/?)(value|parameter)(\s+name="[^"]*")?\s*>/g;
}

/**
 * Visit every token in `text` at or after `from`. Streaming rather than
 * array-returning: Rule A has to see the whole value, and a 1 MB value of
 * repeated `<value>` would otherwise build a token object per match.
 */
function scanTokens(text: string, from: number, visit: (token: Token) => void): void {
  const re = tokenPattern();
  re.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [full, slash, name, attr] = match;
    // `<parameter>` without a name, or `<value name="x">`, is neither shape the
    // harness emits; ignoring them keeps the detector to what it can justify.
    if (name === 'parameter' && !slash && !attr) continue;
    if (name === 'value' && attr) continue;
    visit({
      name: name as 'value' | 'parameter',
      kind: slash ? 'close' : 'open',
      text: full,
      index: match.index,
    });
  }
}

/**
 * True when `index` starts a line that already had text before it.
 *
 * Both halves matter. The harness always puts the captured fragment on its own
 * line, so prose that quotes an opener mid-sentence is excluded by the line
 * break. And a value that *starts* at index 0 with markup never had text to be
 * cut off from, so it is not the shape this detects — without the second half
 * every value shorter than {@link TRAILING_WINDOW} that opens with markup would
 * be rejected no matter what followed it.
 */
function startsOwnLineAfterText(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') return text.slice(0, i).trim().length > 0;
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return false; // reached the start of the value with no text before the markup
}

/**
 * Return the captured-markup fragment in `value`, or `null` when the value is
 * clean. See the module header for what "captured" means and why a value that
 * merely quotes the markup is not.
 */
export function detectToolCallMarkup(value: string): ToolCallMarkupHit | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!value.includes('<')) return null;

  const trimmed = value.trimEnd();

  // Rule A — the value ends on a closing tag that never had an opener. This is
  // the `</value>` shape: the harness closed the parameter and the closer
  // landed inside the text it was closing. Two counters, no allocation, so the
  // cost of a pathological value is time only.
  const depth: Record<'value' | 'parameter', number> = { value: 0, parameter: 0 };
  let trailingCloser: Token | null = null;
  scanTokens(trimmed, 0, (token) => {
    if (token.kind === 'open') {
      depth[token.name]++;
      return;
    }
    if (depth[token.name] > 0) {
      depth[token.name]--;
      return;
    }
    trailingCloser = token.index + token.text.length === trimmed.length ? token : null;
  });
  if (trailingCloser) {
    // The cast is for the narrowing only: TypeScript cannot see that the
    // callback above assigns, so it holds `trailingCloser` at its initial
    // `null` type. `scanTokens` is fully synchronous, so the assignment has
    // certainly happened by here.
    const hit = trailingCloser as Token;
    return { marker: hit.text, index: hit.index, reason: 'trailing-closer' };
  }

  // Rule B — an opener that is never closed, on its own line, near the end.
  // This is the `<parameter name="tags">` shape: the value was cut off and the
  // next parameter of the same call was appended to it.
  //
  // Scanned over the trailing window alone: nothing follows the end of the
  // value, so an opener inside the window can only be closed inside it, and the
  // cost is bounded no matter how large the value is.
  //
  // Not quite identical to a whole-value scan, in one direction only. A tag
  // that straddles `windowStart` is invisible to this scan, so if its closer
  // falls inside the window that closer reads as unmatched and can absorb a
  // genuinely unterminated opener found later in the backward walk. That is a
  // miss, never a false reject — the same direction every trade-off in this
  // module leans.
  const windowStart = Math.max(0, trimmed.length - TRAILING_WINDOW);
  const windowTokens: Token[] = [];
  scanTokens(trimmed, windowStart, (token) => { windowTokens.push(token); });

  const pendingClosers: Record<'value' | 'parameter', number> = { value: 0, parameter: 0 };
  for (let i = windowTokens.length - 1; i >= 0; i--) {
    const token = windowTokens[i];
    if (token.kind === 'close') {
      pendingClosers[token.name]++;
      continue;
    }
    if (pendingClosers[token.name] > 0) {
      pendingClosers[token.name]--;
      continue;
    }
    // First unmatched opener found scanning backwards — the last one in the
    // value, and the only one that can be the captured fragment: a fragment
    // runs to the end, so anything after it is part of it. Stopping here rather
    // than continuing to earlier openers is the miss-biased choice on purpose —
    // if the text running to the end started mid-sentence, it is prose.
    if (startsOwnLineAfterText(trimmed, token.index)) {
      return { marker: token.text, index: token.index, reason: 'unterminated-opener' };
    }
    break;
  }

  return null;
}

/** True when the operator has explicitly opted this process out of the check. */
export function markupCheckDisabled(): boolean {
  return process.env[MARKUP_OVERRIDE_ENV] === '1';
}

/**
 * The rejection message. It quotes the offending tail back so the caller can
 * see exactly what leaked and re-send the write — the silent `{success: true}`
 * this replaces is why 68 corrupted entries accumulated unnoticed.
 */
export function toolCallMarkupError(
  hit: ToolCallMarkupHit,
  value: string,
  namespace: string,
  key: string,
): string {
  const tail = value.trimEnd().slice(hit.index);
  const excerpt = tail.length > EXCERPT_LIMIT ? `${tail.slice(0, EXCERPT_LIMIT)}…` : tail;
  const shape = hit.reason === 'trailing-closer'
    ? 'the value ends on a closing tag that was never opened'
    : 'the value trails off into an unclosed opening tag';
  return (
    `Refusing to store ${namespace}/${key}: the value contains captured tool-call markup — `
    + `${shape}. Offending text at offset ${hit.index}: ${JSON.stringify(excerpt)}. `
    + `Re-send the write with the markup removed. `
    + `(Set ${MARKUP_OVERRIDE_ENV}=1 to store it anyway.)`
  );
}
