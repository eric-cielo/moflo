/**
 * Structural guard against moflo issue attributions leaking into consumer-facing
 * prose.
 *
 * Guidance, skills, agents, commands, and the CLAUDE.md / moflo.yaml templates all
 * land inside somebody else's project. A moflo issue number written there is not
 * provenance — it is noise the reader cannot resolve, and `#1174` in a consumer's
 * `.claude/guidance/` points at *their* issue tracker, not ours. These surfaces are
 * also read, chunked, and RAG-retrieved constantly, so every unresolvable citation
 * is a permanent context tax that dilutes the rule it is attached to.
 *
 * The rule is the deliverable. The issue that produced it belongs in `git log`.
 *
 * Scope is what a consumer READS: the prose loaded as instructions, the templates
 * moflo renders into their repo, and — narrowly — the runtime strings the hook
 * helpers print into their terminal.
 *
 * Hook-helper COMMENTS are deliberately excluded, and that is a considered position
 * rather than an oversight. Stripping them was tried and reverted: it is 206 regex
 * edits across `bin/gate.cjs`, which runs on every tool call in every consumer
 * session, to remove text no consumer ever reads. An equivalence check proved the
 * sweep inert, but the cost/benefit did not justify the churn in that file. The one
 * thing that did justify a change was a citation inside the test gate's block
 * message, which every consumer with unrun tests saw in their terminal.
 *
 * `.claude/guidance/internal/**`, this repo's own CLAUDE.md files, and `src/**`
 * comments stay exempt: they are read inside moflo, where the number resolves to
 * something real, and `src/**` is compiled before it ships.
 *
 * The two template surfaces are checked by RENDERING them and scanning the output,
 * not by grepping the `.ts` sources. That is what keeps the exemption for TS comments
 * honest without maintaining an allowlist — a citation in a JSDoc block is invisible
 * here, and the same citation moved into the emitted string is caught.
 *
 * If a case here goes RED, delete the citation and keep the fact. Where the number is
 * structurally load-bearing (a case-study heading, a table keyed by attempt), relabel
 * with descriptive ordinals rather than dropping the column.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { defaultMofloYamlConfig, renderMofloYaml } from '../../src/cli/init/moflo-yaml-template.js';
import { generateClaudeMd } from '../../src/cli/init/claudemd-generator.js';
import { generateGateScript } from '../../src/cli/init/helpers-generator.js';

import { REPO_ROOT } from './_helpers/eslint-harness.js';
import { trackedFiles } from './_helpers/tracked-files.js';

/**
 * A `#` followed by 2–5 digits and nothing word-like after it. Two digits is the
 * floor because moflo's issue numbers start in the double digits; the ceiling keeps
 * long digit runs (hashes, ids) from matching.
 *
 * A trailing hyphen must NOT be excluded here. `pre-#1363-followup` is a citation
 * and survived an earlier version of this regex that treated `-` as word-like —
 * the one citation in the whole sweep that got through.
 */
const ISSUE_REF = /(?<![\w#])#(\d{2,5})(?!\w)/g;

/**
 * A CSS hex colour in a declaration — `color: #222;`. Digits-only colours of 3 or 4
 * hex digits are indistinguishable from an issue number in isolation, so they are
 * disambiguated by the full declaration around them. Guidance authoring docs carry
 * real stylesheet examples, so this is a live case, not a hypothetical.
 *
 * All three conditions are required, and each is deliberately strict, because every
 * loosening here is a citation this guard silently excuses. A tail of merely
 * `<word>:` matches ordinary prose — `### Case Study: #1053` — and an unrestricted
 * property name still matches `status: #1174;`. So the property must be one that
 * actually takes a colour, it must start a declaration (line start, `;`, or `{`),
 * and the value must be closed by `;` or `}`.
 */
const COLOUR_PROPERTIES = [
  'color',
  'background',
  'background-color',
  'border',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline',
  'outline-color',
  'caret-color',
  'accent-color',
  'text-decoration-color',
  'box-shadow',
  'text-shadow',
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
].join('|');
const CSS_PROPERTY_TAIL = new RegExp(`(?:^|[;{])\\s*(?:${COLOUR_PROPERTIES})\\s*:\\s*$`);
const CSS_VALUE_END = /^\s*[;}]/;
const CSS_HEX_LENGTHS = new Set([3, 4, 6, 8]);

export interface Attribution {
  ref: string;
  line: number;
}

/**
 * Pure scanner so the shape can be exercised without touching the tree. Scans line
 * by line: it keeps the CSS test anchored to one declaration, and splitting on
 * `\r?\n` means a CRLF checkout reports the same line numbers as an LF one.
 */
export function scanText(text: string): Attribution[] {
  const found: Attribution[] = [];

  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const m of lineText.matchAll(ISSUE_REF)) {
      const digits = m[1]!;
      const before = lineText.slice(0, m.index);
      const after = lineText.slice(m.index + m[0].length);

      // CSS colour, not a citation.
      if (
        CSS_HEX_LENGTHS.has(digits.length) &&
        CSS_PROPERTY_TAIL.test(before) &&
        CSS_VALUE_END.test(after)
      ) {
        continue;
      }

      found.push({ ref: `#${digits}`, line: index + 1 });
    }
  });

  return found;
}

/**
 * Consumer-facing prose, by ship surface. Every entry here is copied into a consumer
 * project by `flo init` / the session-start launcher, or shipped in the npm tarball
 * (`package.json` `files`) and read from `node_modules/moflo/`.
 */
const SCANNED_DIRS = [
  '.claude/guidance/shipped',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
];

/**
 * Hook helpers, checked for citations in their RUNTIME STRINGS only.
 *
 * These files are code, and their comments are debugging provenance for moflo
 * developers — deliberately out of scope, because rewriting comments in the gate
 * that fires on every tool call is churn in the hottest file in the library for no
 * reader benefit. What is NOT acceptable is a citation inside a string the helper
 * prints: the test gate's block message carried one, so every consumer whose tests
 * hadn't run saw a moflo issue number in their terminal.
 *
 * Only string literals are scanned, via the TypeScript parser rather than a regex,
 * so a `'` inside a comment can never be mistaken for the start of a literal.
 *
 * `gate.cjs` is checked in all three of its incarnations, because none is derived
 * from another: `bin/gate.cjs`, its byte-identical `.claude/helpers/gate.cjs` mirror
 * (which is what `flo init` actually copies to a consumer — not `bin/`), and the
 * lighter variant `generateGateScript()` emits.
 *
 * The generator is checked by RENDERING it, never by parsing `helpers-generator.ts`
 * directly: that file holds each generated helper as one enormous template literal,
 * so its "string literals" include the generated file's COMMENTS, and scanning it
 * as source would silently re-impose the comment rule this guard deliberately drops.
 */
const HELPER_FILES_WITH_RUNTIME_TEXT = ['bin/gate.cjs', '.claude/helpers/gate.cjs'];

/** String-literal text of a source file, comments excluded by construction. */
function stringLiterals(source: string, fileName: string): Array<{ text: string; line: number }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: Array<{ text: string; line: number }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({ text: node.text, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

/** Tracked markdown under the consumer-facing directories. */
function trackedProseFiles(): string[] {
  return trackedFiles({ dirs: SCANNED_DIRS, filter: (rel) => rel.endsWith('.md') });
}

describe('issue-attribution guard — the shape', () => {
  it('flags a trailing parenthetical citation', () => {
    expect(scanText('verify_before_done is on by default (#1294).')).toEqual([
      { ref: '#1294', line: 1 },
    ]);
  });

  it('flags inline "issue"/"Epic"/"PR" citations', () => {
    expect(scanText('bind to different daemons (issue #1174).')).toContainEqual({
      ref: '#1174',
      line: 1,
    });
    expect(scanText('Spec-Driven Development — Epic #1269.')).toContainEqual({
      ref: '#1269',
      line: 1,
    });
    expect(scanText('— PR #1053 commit')).toContainEqual({ ref: '#1053', line: 1 });
  });

  it('flags a citation used as a heading or table key', () => {
    expect(scanText('### Case Study: #1053 Memory Traversal')).toContainEqual({
      ref: '#1053',
      line: 1,
    });
    expect(scanText('| #1024 layer 1 | Detach adapter | Race narrowed |')).toContainEqual({
      ref: '#1024',
      line: 1,
    });
  });

  it('reports the line number of the offender', () => {
    expect(scanText('clean line\nanother clean line\ncited here (#932)')).toEqual([
      { ref: '#932', line: 3 },
    ]);
  });

  it('does not flag a CSS hex colour in a declaration', () => {
    expect(scanText('    color: #222;')).toEqual([]);
    expect(scanText('body { color: #e6e6e6; background: #14171a; }')).toEqual([]);
  });

  // The CSS exclusion is the guard's only escape hatch, so it must not generalize
  // to "any `word:` followed by a number". Prose of that shape is still a citation.
  it('still flags a citation on a line merely shaped like a declaration', () => {
    expect(scanText('status: #1174; done')).toContainEqual({ ref: '#1174', line: 1 });
    expect(scanText('see: #932;')).toContainEqual({ ref: '#932', line: 1 });
    expect(scanText('| Fixed in: #1053; | yes |')).toContainEqual({ ref: '#1053', line: 1 });
  });

  it('does not flag markdown headings or anchors', () => {
    expect(scanText('## 1. Structure for Scanability')).toEqual([]);
    expect(scanText('see [the rules](#writing-rules)')).toEqual([]);
  });

  it('does not flag digit runs outside the issue-number range', () => {
    expect(scanText('column #7')).toEqual([]);
    expect(scanText('commit #1234567')).toEqual([]);
  });

  it('flags a citation with a hyphenated suffix', () => {
    expect(scanText('// written by a pre-#1363-followup launcher')).toContainEqual({
      ref: '#1363',
      line: 1,
    });
  });
});

describe('issue-attribution guard — live fire over consumer-facing prose', () => {
  it('finds no issue attributions in shipped guidance, skills, agents, or commands', () => {
    const offenders: string[] = [];

    for (const rel of trackedProseFiles()) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // unreadable or removed between ls-files and read
      }

      for (const hit of scanText(text)) {
        offenders.push(`${rel}:${hit.line}: ${hit.ref}`);
      }
    }

    // Printed in full so a failure names every file, line, and reference directly.
    expect(offenders).toEqual([]);
  });

  it('scans a non-empty file set (guards against a silently empty glob)', () => {
    expect(trackedProseFiles().length).toBeGreaterThan(50);
  });

  it('finds no issue attributions in hook-helper runtime strings', () => {
    const offenders: string[] = [];

    for (const rel of HELPER_FILES_WITH_RUNTIME_TEXT) {
      let source: string;
      try {
        source = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        // A renamed helper must not silently drop out of coverage.
        offenders.push(`${rel}: unreadable — update HELPER_FILES_WITH_RUNTIME_TEXT`);
        continue;
      }

      for (const literal of stringLiterals(source, rel)) {
        for (const hit of scanText(literal.text)) {
          offenders.push(`${rel}:${literal.line}: ${hit.ref} in a runtime string`);
        }
      }
    }

    // The generator's variant, scanned as rendered output rather than as source.
    const rendered = generateGateScript();
    for (const literal of stringLiterals(rendered, 'generateGateScript.cjs')) {
      for (const hit of scanText(literal.text)) {
        offenders.push(`generateGateScript() output:${literal.line}: ${hit.ref} in a runtime string`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // The comments in these files are deliberately NOT scanned. Asserting that keeps
  // a later reader from "completing" the sweep and rewriting the hot path.
  it('deliberately leaves hook-helper comments alone', () => {
    const gate = readFileSync(join(REPO_ROOT, 'bin/gate.cjs'), 'utf8');
    expect(scanText(gate).length).toBeGreaterThan(0);
  });
});

describe('issue-attribution guard — live fire over rendered templates', () => {
  it('finds no issue attributions in the injected CLAUDE.md block', () => {
    expect(scanText(generateClaudeMd())).toEqual([]);
  });

  it('finds no issue attributions in the generated moflo.yaml', () => {
    const yaml = renderMofloYaml(defaultMofloYamlConfig(REPO_ROOT));
    expect(scanText(yaml)).toEqual([]);
  });
});
