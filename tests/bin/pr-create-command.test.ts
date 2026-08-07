/**
 * Unit tests for bin/pr-create-command.cjs — the `gh pr create` matcher behind
 * the `check-before-pr` and `check-before-done` gates (issue #1410).
 *
 * The matcher it replaced was wrong in both directions at once, so every test
 * here belongs to one of three groups and the file is organised that way:
 *
 *   - MATCHES     — shapes that open a PR. A miss here is a SILENT BYPASS: the
 *                   gate's only signal is blocking, so nothing says it didn't run.
 *   - NO MATCH    — text that merely quotes the literal. A hit here blocks work
 *                   that has nothing to do with opening a PR.
 *   - TRAPS       — the specific ways an "obvious" fix regresses. Three of the
 *                   four are bypasses introduced *while* fixing the original bug,
 *                   which is why they get their own cases rather than being
 *                   folded into the two groups above.
 *
 * In-process `require` — no subprocess per case, so the matrix stays cheap.
 * The gate-boundary behaviour (that the hook actually blocks/passes on these
 * shapes) is covered separately in gate-pr-create-matcher-1410.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { isPrCreateCommand, sanitizeShellData } from '../../bin/pr-create-command.cjs';

/** Readable multi-line fixtures without leaning on template-literal indentation. */
const lines = (...l: string[]): string => l.join('\n');

// ── Shapes that DO open a PR ─────────────────────────────────────────────────

describe('pr-create-command: invocations that must match', () => {
  const cases: Array<[string, string]> = [
    ['bare', 'gh pr create'],
    ['with flags', 'gh pr create --fill --base main'],
    ['extra whitespace between words', 'gh   pr\t create --fill'],
    ['indented', '    gh pr create --fill'],
    ['&&-chained', 'cd /repo && gh pr create'],
    ['||-chained', 'gh pr view || gh pr create'],
    [';-chained', 'git add -A; gh pr create'],
    ['env prefix', 'GH_TOKEN=x gh pr create'],
    ['several env prefixes', 'GH_TOKEN=x GH_HOST=github.com gh pr create --fill'],
    // The three shapes #1410 reported as missed outright.
    ['newline-separated', lines('cd /repo', 'gh pr create --fill')],
    ['piped body file', 'cat body.md | gh pr create --body-file -'],
    ['parenthesised subshell', '( gh pr create )'],
    // Neighbours of those three that the same repair has to cover.
    ['brace group', '{ gh pr create; }'],
    ['command substitution', 'echo $(gh pr create --fill)'],
    ['backtick substitution', 'echo `gh pr create --fill`'],
    ['negated', '! gh pr create'],
    ['env(1) prefix', 'env GH_TOKEN=x gh pr create'],
    ['CRLF-separated', 'cd /repo\r\ngh pr create --fill'],
    ['continued onto the next line', lines('gh pr create \\', '  --fill --base main')],
    ['heredoc body supplies the PR body', lines('gh pr create --body-file - <<EOF', 'some body', 'EOF')],
    ['after a comment line', lines('# open the PR with gh pr create once tests pass', 'gh pr create --fill')],
    ['after a completed heredoc', lines('cat <<EOF > body.md', 'run gh pr create when ready', 'EOF', 'gh pr create --body-file body.md')],
    ['after a herestring line', lines('grep -q x <<<"$BODY"', 'gh pr create --fill')],
    // Invocation by path. The token containing the hit is what's checked, so a
    // path ending in the binary still reads as a command — a character-before
    // check would reject all three of these.
    ['absolute path', '/usr/local/bin/gh pr create --fill'],
    ['relative path', './gh pr create --fill'],
    ['path after a chain', 'cd /repo && /usr/bin/gh pr create'],
    // Windows, in the forms that are actually valid command words for the shell
    // the Bash tool runs. A bare `C:\tools\gh` is NOT one of them — there the
    // backslashes are escapes, so the shell sees `C:toolsgh` and so do we.
    ['Windows drive path with forward slashes', 'C:/tools/gh pr create --fill'],
    ['Windows MSYS-style path', '/c/tools/gh pr create --fill'],
  ];

  for (const [label, cmd] of cases) {
    it(`matches: ${label}`, () => {
      expect(isPrCreateCommand(cmd)).toBe(true);
    });
  }
});

// ── Text that only quotes the literal ────────────────────────────────────────

describe('pr-create-command: quoted text that must not match', () => {
  const cases: Array<[string, string]> = [
    // The two over-matches observed in real sessions.
    ['commit message', 'git commit -m "run cd /r && gh pr create next"'],
    ['node -e script string', `node -e 'const s = "cd /r && gh pr create"'`],
    // Filing a ticket *about* the matcher was blocked by the matcher.
    ['issue body describing the chained form', 'gh issue create --title x --body "use cd /r && gh pr create"'],
    ['single-quoted grep pattern', `git log --grep 'gh pr create'`],
    ["$'...' ANSI-C string", `printf $'cd /r && gh pr create\\n'`],
    ['heredoc body', lines('cat <<EOF', 'cd /r && gh pr create', 'EOF')],
    ['quoted-delimiter heredoc body', lines("cat <<'EOF'", 'cd /r && gh pr create', 'EOF')],
    ['tab-stripped heredoc body', lines('cat <<-EOF', '\t\tgh pr create', '\tEOF')],
    ['second of two heredocs on one line', lines('cat <<A <<B', 'foo', 'A', 'gh pr create', 'B')],
    ['CRLF heredoc body', 'cat <<EOF\r\ngh pr create\r\nEOF\r\n'],
    ['comment', '# gh pr create once the tests pass'],
    ['trailing comment', 'git status  # then gh pr create'],
    // A comment quoting the CHAINED form. Distinct from the two above: the `&&`
    // inside it is a separator, so without comment blanking the backwards walk
    // stops there and reports a command start. Mutation-confirmed — dropping
    // comment blanking leaves the two cases above green and only this one red.
    ['comment quoting the chained form', '# first cd /repo && gh pr create, then merge'],
    // Single-quoted with no inner double quotes. The `node -e` case above stays
    // green even without single-quote blanking, because its inner `"…"` gets
    // blanked instead — this one has nothing to fall back on.
    ['single-quoted chained form', `node -e 'cd /r && gh pr create'`],
    // Near-misses on the command itself.
    ['different subcommand', 'gh pr list --state open'],
    ['longer word', 'gh pr createx'],
    ['no space', 'ghpr create'],
    ['argument to another command', 'echo gh pr create'],
    ['argument to a two-word command', 'git config alias.x gh pr create'],
    // The literal search carries no leading \b, so a hit can land MID-TOKEN. The
    // backwards walk would then read a truncated prefix as a command prefix:
    // `do` is in PREFIX_WORDS, `FOO=bar` matches ASSIGNMENT_RE. Both of these are
    // one unrelated token, and both used to over-match.
    ['mid-token hit whose prefix is a command keyword', 'dogh pr create'],
    ['mid-token hit whose prefix looks like an assignment', 'FOO=bargh pr create'],
    ['mid-token hit after other keywords', 'timegh pr create'],
    // `gh` as an assignment VALUE — the command here is `pr`, not `gh`. A leading
    // \b would admit this one, because `=` is a non-word character.
    ['gh as an assignment value', 'FOO=gh pr create'],
  ];

  for (const [label, cmd] of cases) {
    it(`does not match: ${label}`, () => {
      expect(isPrCreateCommand(cmd)).toBe(false);
    });
  }

  it('does not match empty or non-string input', () => {
    expect(isPrCreateCommand('')).toBe(false);
    expect(isPrCreateCommand(undefined as unknown as string)).toBe(false);
    expect(isPrCreateCommand(null as unknown as string)).toBe(false);
  });
});

// ── The four traps ───────────────────────────────────────────────────────────

describe('pr-create-command: trap — `<<<` is a herestring, not a heredoc', () => {
  // Reading `<<<` as a heredoc opener never finds a delimiter, so the "body"
  // blanks the rest of the input and swallows the real invocation below it.
  it('does not swallow the following line (bare word)', () => {
    expect(isPrCreateCommand(lines('grep -q x <<<EOF', 'gh pr create --fill'))).toBe(true);
  });

  it('does not swallow the following line (quoted word)', () => {
    expect(isPrCreateCommand(lines(`grep -q x <<<'some text'`, 'gh pr create --fill'))).toBe(true);
  });

  it('treats the herestring word itself as data, not a command', () => {
    expect(isPrCreateCommand(`grep -q x <<<'gh pr create'`)).toBe(false);
  });
});

describe('pr-create-command: trap — heredoc delimiters longer than any window', () => {
  // Matching the header against `cmd.slice(i, i + N)` truncates a bare delimiter
  // longer than N: the truncated prefix registers as the delimiter, the real
  // terminator never matches, and the body blanks to EOF — swallowing whatever
  // follows the heredoc.
  const long = 'D'.repeat(200);

  it('terminates a bare over-long delimiter', () => {
    const cmd = lines(`cat <<${long}`, 'gh pr create inside the body', long, 'gh pr create --fill');
    expect(isPrCreateCommand(cmd)).toBe(true);
    // and the body copy is still data
    expect(isPrCreateCommand(lines(`cat <<${long}`, 'gh pr create inside the body', long))).toBe(false);
  });

  it('terminates a quoted over-long delimiter', () => {
    const cmd = lines(`cat <<'${long}'`, 'gh pr create inside the body', long, 'gh pr create --fill');
    expect(isPrCreateCommand(cmd)).toBe(true);
  });

  it('blanks an unterminated heredoc through end of input', () => {
    expect(isPrCreateCommand(lines('cat <<EOF', 'gh pr create'))).toBe(false);
  });

  // `<<-` strips leading tabs from the TERMINATOR too. Getting that wrong fails
  // in the safe-looking direction on a body-only fixture (the terminator is
  // never found, so the body blanks to EOF and the literal inside it still
  // doesn't match) — it only shows up as a bypass on what comes AFTER.
  it('finds a tab-indented terminator so the heredoc does not run to EOF', () => {
    expect(isPrCreateCommand(lines('cat <<-EOF', '\tbody text', '\tEOF', 'gh pr create --fill'))).toBe(true);
  });
});

describe('pr-create-command: trap — `\\` + newline is a continuation, not a separator', () => {
  // The logical line keeps going, so the words after it are arguments to `cat`,
  // and the heredoc queued on that line does not start until the next real newline.
  it('does not treat the continued words as a new command', () => {
    expect(isPrCreateCommand(lines('cat <<EOF \\', 'gh pr create', 'EOF'))).toBe(false);
  });

  it('still starts the heredoc body after the real newline', () => {
    const cmd = lines('cat <<EOF \\', '  --flag', 'gh pr create in the body', 'EOF', 'gh pr create --fill');
    expect(isPrCreateCommand(cmd)).toBe(true);
    expect(isPrCreateCommand(lines('cat <<EOF \\', '  --flag', 'gh pr create in the body', 'EOF'))).toBe(false);
  });

  it('does not let an escaped separator start a command', () => {
    expect(isPrCreateCommand('echo a\\; gh pr create')).toBe(false);
  });

  // The heredoc cases above stay green even if the newline is left unblanked —
  // the heredoc body then swallows the literal, so the answer is right for the
  // wrong reason. Without a heredoc there is nothing to swallow it: leaving the
  // newline turns a continuation into a separator and the arguments read as a
  // command. Mutation-confirmed as the only case that catches this directly.
  it('treats continued words as arguments, not a new command', () => {
    expect(isPrCreateCommand(lines('echo some args \\', 'gh pr create'))).toBe(false);
  });
});

describe('pr-create-command: command substitutions inside quoted data', () => {
  // A double-quoted run and a bare-delimiter heredoc body are data, EXCEPT for
  // the substitutions inside them — those still run. Blanking them wholesale
  // (the obvious reading of "blank the quoted regions") makes each of these a
  // silent bypass. `'…'` and `<<'EOF'` suppress expansion, so they stay data.
  const SQ = "'";
  const BT = '`';

  const expand: Array<[string, string]> = [
    ['$( ) inside double quotes', 'echo "PR: $(gh pr create --fill)"'],
    ['backtick inside double quotes', `echo "PR: ${BT}gh pr create${BT}"`],
    ['nested double quotes inside the substitution', 'echo "PR: $(gh pr create --title "x" --fill)"'],
    ['nested single quotes inside the substitution', `echo "PR: $(gh pr create --title ${SQ}x${SQ})"`],
    ['two levels of substitution', 'echo "a $(echo "b $(gh pr create)")"'],
    ['bare-delimiter heredoc body', lines('cat <<EOF', 'url: $(gh pr create --fill)', 'EOF')],
  ];
  for (const [label, cmd] of expand) {
    it(`matches: ${label}`, () => expect(isPrCreateCommand(cmd)).toBe(true));
  }

  const suppressed: Array<[string, string]> = [
    ['single quotes suppress expansion', `echo ${SQ}$(gh pr create)${SQ}`],
    ['quoted-delimiter heredoc suppresses expansion', lines(`cat <<${SQ}EOF${SQ}`, 'url: $(gh pr create)', 'EOF')],
    // Restoring a substitution must not un-blank the literal text around it.
    ['literal text after a substitution in the same run', 'echo "$(date) then gh pr create here"'],
  ];
  for (const [label, cmd] of suppressed) {
    it(`does not match: ${label}`, () => expect(isPrCreateCommand(cmd)).toBe(false));
  }

  it('does not hang or throw on unbalanced input', () => {
    expect(isPrCreateCommand('echo "$(gh pr create')).toBe(false);
    expect(isPrCreateCommand('echo "$(gh pr create "')).toBe(false);
  });

  it('caps pathological nesting instead of overflowing the stack', () => {
    // The cap trades a miss for a crash — and a crash in a PreToolUse hook is
    // not a missed gate, it is every Bash call blocked.
    const deep = '"$('.repeat(40) + 'gh pr create' + ')"'.repeat(40);
    expect(typeof isPrCreateCommand(deep)).toBe('boolean');
  });
});

describe('pr-create-command: trap — cost stays bounded on every Bash call', () => {
  // These gates run on EVERY Bash call, so the two failure modes are (a) paying
  // the two-pass cost for commands that obviously cannot match, and (b) the
  // quadratic backtracking a leading-context regex causes on sanitised input
  // (long runs of spaces that `\s*` consumes, fails on, and backtracks through).
  //
  // The bounds below are deliberately loose — they exist to catch catastrophic
  // blowup, not to police microseconds, because a tight timing assertion under
  // CI fork contention is a flake generator.
  it('does not pay the two-pass cost for the `gh` digraph in ordinary words', () => {
    // "gh" is a common English digraph, so a bare indexOf('gh') screen lets
    // highlight/github/though/flight through to the full scan on every Bash call.
    const words = ['highlight', 'github.com/org/repo', 'though', 'flight', 'ghost'];
    const big = words.join(' ') + ' ' + 'x'.repeat(200_000);
    const t0 = process.hrtime.bigint();
    expect(isPrCreateCommand(big)).toBe(false);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(50);
  });

  it('fast-rejects a large command with no `gh` in it', () => {
    const big = lines('cat <<EOF', 'x'.repeat(100_000), 'EOF');
    const t0 = process.hrtime.bigint();
    expect(isPrCreateCommand(big)).toBe(false);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(50);
  });

  it('stays responsive on heredoc-heavy input that does contain `gh`', () => {
    const blocks: string[] = [];
    for (let i = 0; i < 800; i++) blocks.push(`cat <<EOF${i}`, 'gh pr create in a body', `EOF${i}`);
    blocks.push('gh pr create --fill');
    const cmd = lines(...blocks);
    const t0 = process.hrtime.bigint();
    expect(isPrCreateCommand(cmd)).toBe(true);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(500);
  });
});

// ── Sanitiser invariants ─────────────────────────────────────────────────────

describe('pr-create-command: sanitizeShellData', () => {
  it('preserves length so offsets outside blanked regions do not shift', () => {
    const fixtures = [
      'git commit -m "cd /r && gh pr create"',
      lines('cat <<EOF', 'body', 'EOF', 'gh pr create'),
      lines('cat <<EOF \\', '  --flag', 'body', 'EOF'),
      `printf $'a\\nb'`,
      '# comment only',
      'grep x <<<"word"',
    ];
    for (const f of fixtures) expect(sanitizeShellData(f)).toHaveLength(f.length);
  });

  it('blanks quoted data but leaves command text intact', () => {
    expect(sanitizeShellData('git commit -m "gh pr create"')).toBe('git commit -m' + ' '.repeat(15));
  });

  it('keeps newlines outside blanked regions so separators survive', () => {
    const out = sanitizeShellData(lines('cat <<EOF', 'body', 'EOF', 'gh pr create'));
    expect(out.split('\n')).toHaveLength(4);
    expect(out.split('\n')[3]).toBe('gh pr create');
  });
});
