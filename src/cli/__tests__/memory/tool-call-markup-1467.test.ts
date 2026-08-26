/**
 * The captured-tool-call-markup detector (#1467).
 *
 * Two axes, and the second is the hard one. Catching the corruption is easy —
 * grep for `</value>`. Not rejecting the lesson that DOCUMENTS the corruption,
 * or the guidance doc that quotes it, is what the detector has to earn, and a
 * naive marker match fails every case in the "clean" block below.
 */

import { describe, expect, it } from 'vitest';

import {
  detectToolCallMarkup,
  toolCallMarkupError,
  TRAILING_WINDOW,
} from '../../memory/tool-call-markup.js';

/** Padding that pushes an earlier marker out of the trailing window. */
const PROSE = 'x'.repeat(TRAILING_WINDOW + 50);

describe('detectToolCallMarkup: captured markup (#1467)', () => {
  it('flags a value that ends on an unopened </value>', () => {
    const hit = detectToolCallMarkup('The lesson text, cut off mid-thought.\n</value>');
    expect(hit).not.toBeNull();
    expect(hit!.marker).toBe('</value>');
    expect(hit!.reason).toBe('trailing-closer');
  });

  it('flags the observed <parameter name="tags"> tail', () => {
    // The exact shape reported in #1467: the value ended, the harness resumed
    // emitting the call, and the next parameter landed inside the text.
    const value =
      'When rewriting a regex to kill backtracking, prove the behaviour diff.",\n'
      + '    <parameter name="tags">["regex","redos","source:manual"]';
    const hit = detectToolCallMarkup(value);
    expect(hit).not.toBeNull();
    expect(hit!.marker).toBe('<parameter name="tags">');
    expect(hit!.reason).toBe('unterminated-opener');
  });

  it('flags a trailing fragment even with whitespace after it', () => {
    expect(detectToolCallMarkup('a lesson\n</value>\n\n  ')).not.toBeNull();
  });

  it('flags an unterminated opener for any parameter name, not just tags', () => {
    const value = 'the lesson.",\n<parameter name="metadata">{"type":"lesson"}';
    expect(detectToolCallMarkup(value)?.marker).toBe('<parameter name="metadata">');
  });

  it('flags a trailing unopened </parameter>', () => {
    expect(detectToolCallMarkup('the lesson text.\n</parameter>')?.reason).toBe('trailing-closer');
  });
});

describe('detectToolCallMarkup: values that merely discuss markup (#1467)', () => {
  it('accepts a lesson ABOUT this very bug', () => {
    // The case the ticket calls out explicitly. It names both markers, then
    // explains them — and the explanation is the anchor that separates a
    // quotation from a fragment the value trailed off into.
    const lesson = [
      'memory_store values can arrive carrying the harness\' own tool-call markup:',
      'the value ends early and a `<parameter name="tags">` opener, or a stray',
      '`</value>` closer, is appended to the text.',
      '',
      'moflo is not the cause — the markup exists only in the model/harness layer —',
      'but it is the last component that can catch it, so the write is rejected at',
      'the storeEntry chokepoint rather than embedded and shared. Detect it by',
      'anchoring to the trailing position AND requiring the markup to be unbalanced;',
      'a bare marker match rejects this lesson.',
    ].join('\n');
    expect(detectToolCallMarkup(lesson)).toBeNull();
  });

  it('accepts balanced markup quoted in full', () => {
    expect(detectToolCallMarkup('The harness emits <value>the text</value> around it.')).toBeNull();
  });

  it('accepts an opener quoted inline mid-sentence', () => {
    // Not at a line start — the harness always puts the fragment on its own line.
    expect(detectToolCallMarkup('Never write <parameter name="tags"> into a value.')).toBeNull();
  });

  it('accepts an indented example followed by explanation', () => {
    // A guidance doc showing the corrupt shape as a code block, then explaining
    // it. Same line-start position as the real fragment; pushed out of the
    // trailing window by the prose that follows.
    const doc = `The corruption looks like this:\n\n    <parameter name="tags">["a"]\n\n${PROSE}`;
    expect(detectToolCallMarkup(doc)).toBeNull();
  });

  it('accepts a closer that appears mid-text', () => {
    expect(detectToolCallMarkup(`A stray </value> shows up in the tail.\n${PROSE}`)).toBeNull();
  });

  it('accepts ordinary text with angle brackets', () => {
    expect(detectToolCallMarkup('Guard with `if (a < b && c > d)` before the loop.')).toBeNull();
    expect(detectToolCallMarkup('<div class="x">html</div>')).toBeNull();
    expect(detectToolCallMarkup('')).toBeNull();
    expect(detectToolCallMarkup('a plain lesson with no markup at all')).toBeNull();
  });

  it('does NOT flag a fragment longer than the trailing window', () => {
    // A documented boundary, not an oversight: the window is what keeps a doc
    // that quotes the markup out of the reject path, and every fragment
    // observed in #1467 is under 60 characters. Pinned so a future widening is
    // a deliberate decision with this trade-off in view.
    const value = `the lesson.\n<parameter name="metadata">${'y'.repeat(TRAILING_WINDOW + 1)}`;
    expect(detectToolCallMarkup(value)).toBeNull();
  });

  it('accepts a short value whose FIRST line is an unmatched opener', () => {
    // Nothing precedes the markup, so no text was cut off — this is not the
    // shape the detector describes. Without the "after text" half of the
    // line-start rule, every value shorter than the window that opens with
    // markup was rejected no matter what followed it.
    expect(detectToolCallMarkup('<parameter name="tags">["a"]\nstill a short value')).toBeNull();
    expect(detectToolCallMarkup('<value>\nshort')).toBeNull();
  });

  it('accepts a bare <parameter> with no name attribute', () => {
    // Not a shape the harness emits; flagging it would be guessing.
    expect(detectToolCallMarkup('see <parameter>')).toBeNull();
  });
});

describe('toolCallMarkupError (#1467)', () => {
  it('names the namespace, key, and the offending text', () => {
    const value = 'the lesson.",\n<parameter name="tags">["a","b"]';
    const message = toolCallMarkupError(detectToolCallMarkup(value)!, value, 'learnings', 'my-lesson');
    expect(message).toContain('learnings/my-lesson');
    expect(message).toContain('<parameter name=');
    expect(message).toContain('MOFLO_ALLOW_TOOL_CALL_MARKUP');
  });

  it('truncates a long offending tail rather than echoing the whole value', () => {
    const value = `the lesson.\n<parameter name="tags">${'y'.repeat(150)}`;
    const message = toolCallMarkupError(detectToolCallMarkup(value)!, value, 'learnings', 'k');
    expect(message.length).toBeLessThan(600);
    expect(message).toContain('…');
  });
});
