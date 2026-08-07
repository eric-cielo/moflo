'use strict';

/**
 * Does this Bash command actually invoke `gh pr create`?
 *
 * Issue #1410. The gates in `gate.cjs` (`check-before-pr`, `check-before-done`)
 * used to answer this with a single regex applied to raw command text:
 *
 *   /(?:^|&&\s*|\|\|\s*|;\s*)\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*gh\s+pr\s+create\b/
 *
 * That was wrong in both directions at once. It MISSED shapes people routinely
 * type — a newline-separated multi-line command, `cat body.md | gh pr create
 * --body-file -`, `( gh pr create )` — each of which opened a PR with every gate
 * silently skipped. And it FIRED on commands that merely quote the literal — a
 * `git commit -m "...gh pr create..."`, a `node -e '...'` probe, a heredoc body —
 * blocking work that has nothing to do with opening a PR.
 *
 * One cause, both symptoms: a regex over raw text cannot tell a command from a
 * string that quotes one. That is why the obvious repair (widen the separator
 * set to include newline and `|`) makes the over-match strictly worse — every
 * heredoc body line starting with the literal would become a match.
 *
 * So: two passes.
 *
 *   1. `sanitizeShellData` blanks the regions that are data rather than command
 *      — comments, heredoc bodies, all quote flavours, escapes — replacing them
 *      with spaces and PRESERVING LENGTH, so nothing outside a blanked region
 *      shifts or merges.
 *   2. `isPrCreateCommand` searches the sanitised text for the literal, then
 *      walks BACKWARDS from each hit to confirm it starts a command.
 *
 * Four traps, three of which are silent BYPASSES (the gate stops blocking with
 * no signal at all), are handled deliberately below and are marked `TRAP` at
 * their sites:
 *
 *   - `<<<` is a herestring, not a heredoc. Reading it as a heredoc opener
 *     means the delimiter is never found, the "body" blanks the rest of the
 *     input, and a real invocation on the next line is swallowed.
 *   - Heredoc headers are matched with a STICKY regex, never against a
 *     fixed-size `slice(i, i + N)` window. A window truncates a bare delimiter
 *     longer than it, registers the truncated prefix as the delimiter, and the
 *     real terminator line then never matches — body blanks to EOF.
 *   - `\` + newline is a line continuation, not a separator: the words after it
 *     are arguments, and heredoc bodies queued on that line do not start there.
 *   - Left-context stays OUT of the regex. `(?:^|[\n;&|(){}])\s*(?:NAME=val\s+)*gh…`
 *     is quadratic on sanitised input (long runs of spaces that `\s*` consumes,
 *     fails on, and backtracks through at every position). Searching for the
 *     literal first and walking back by hand is flat.
 *
 * Mirrored verbatim into `.claude/helpers/pr-create-command.cjs` — the dogfood
 * parity guard enforces byte-identity. Dependency-free CommonJS, `node:`
 * builtins only (it uses none), so it loads from either location.
 */

/**
 * Chars that can immediately precede a command word. `<` and `>` are absent on
 * purpose: `> out.txt gh pr create` is a redirect target followed by arguments
 * in the shapes we care about, not a fresh command.
 *
 * The backtick is present — and is deliberately NOT blanked as data the way
 * quotes are. #1410's write-up lists backticks with the quote flavours, but an
 * UNQUOTED backtick is command substitution: blanking it would make
 * `` `gh pr create` `` stop blocking, i.e. exactly the silent-bypass class the
 * issue is about. Backticks inside `"…"` are still blanked with the rest of the
 * quoted run, which is where the over-match risk actually lives.
 */
var SEPARATOR_CHARS = '\n;&|(){}`';

/**
 * Words that may sit between a separator and the command without changing the
 * fact that a command follows. Kept short and literal — anything not listed
 * (e.g. `echo`) correctly makes the walk fail, because its following words are
 * arguments, not a command.
 */
var PREFIX_WORDS = ['!', 'then', 'else', 'elif', 'do', 'time', 'command', 'builtin', 'exec', 'env', 'nohup', 'xargs', 'sudo'];

/** `NAME=value` prefix, e.g. `GH_TOKEN=x gh pr create`. Bounded to one word. */
var ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/**
 * Heredoc header, matched STICKY at a known index. Alternatives, in order:
 * `'DELIM'`, `"DELIM"`, `$'DELIM'`, bare DELIM. The quoted forms come first so
 * a quoted delimiter is never mis-read as a bare one starting with a quote.
 */
var HEREDOC_RE = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\$'([^'\n]*)'|([^\s;&|<>()'"`]+))/y;

/** The invocation itself. No left-context — see the fourth trap above. */
var PR_CREATE_RE = /gh\s+pr\s+create\b/g;

/**
 * Pre-sanitise reject: `gh` as a whole token. A bare `indexOf('gh')` is far too
 * weak — "gh" is a common English digraph, so `highlight`, `github`, `though`,
 * and `flight` all fall through to the full two-pass scan on a hook that runs as
 * a fresh process on every Bash call, at both gate call sites.
 *
 * Safe against false negatives: `PR_CREATE_RE` requires whitespace after `gh`,
 * and sanitising only ever replaces characters with spaces — it never turns a
 * non-word character into a word one — so a `gh` that survives to match here
 * cannot have had a word character in front of it in the raw text.
 *
 * No quantifiers, so the scan is linear with no backtracking.
 */
var GH_TOKEN_RE = /(?:^|[^A-Za-z0-9_])gh(?![A-Za-z0-9_])/;

/** Horizontal whitespace only. `\n` is a separator and must not be skipped as blank. */
function isBlank(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

/** A `#` opens a comment only when it begins a word. */
function startsWord(cmd, i) {
  if (i === 0) return true;
  var prev = cmd.charAt(i - 1);
  return isBlank(prev) || prev === '\n' || SEPARATOR_CHARS.indexOf(prev) !== -1;
}

/**
 * How deep `$(…)` inside `"…"` inside `$(…)` is followed before giving up and
 * leaving the region blanked. Nothing real nests anywhere near this; the cap
 * exists so a pathological input cannot recurse into a stack overflow.
 */
var MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Replace every data region with spaces, preserving length. What remains is
 * command text — the only thing safe to match a command against.
 *
 * Exported for tests: asserting on the sanitised string is how the blanking
 * rules are pinned independently of the matcher on top of them.
 *
 * @param {string} cmd
 * @param {number} [depth] internal — substitution recursion depth
 * @returns {string} same length as `cmd`
 */
function sanitizeShellData(cmd, depth) {
  var n = cmd.length;
  var out = cmd.split('');
  var pending = [];
  var level = depth || 0;
  var i = 0;

  function blank(from, to) {
    var stop = to > n ? n : to;
    for (var k = from; k < stop; k++) out[k] = ' ';
  }

  /** Copy `raw`'s chars back into `out` at `from` — the inverse of `blank`. */
  function restore(from, raw) {
    for (var k = 0; k < raw.length; k++) out[from + k] = raw.charAt(k);
  }

  /** Scan a quoted run from `i` to its closing `close`, honouring `\` escapes if asked. */
  function closingIndex(from, close, escapes) {
    var j = from;
    while (j < n) {
      var ch = cmd.charAt(j);
      if (escapes && ch === '\\') { j += 2; continue; }
      if (ch === close) return j + 1;
      j++;
    }
    return n;
  }

  /**
   * Index of the `)` closing the `(` at `openIdx`, or -1 before `limit`.
   * Skips quoted runs so a `)` inside a string doesn't close the substitution.
   */
  function matchingParen(openIdx, limit) {
    var d = 0;
    var k = openIdx;
    while (k < limit) {
      var ch = cmd.charAt(k);
      if (ch === '\\') { k += 2; continue; }
      if (ch === "'") { k = closingIndex(k + 1, "'", false); continue; }
      if (ch === '"') { k = doubleQuoteEnd(k + 1); continue; }
      if (ch === '(') d++;
      else if (ch === ')') { d--; if (d === 0) return k; }
      k++;
    }
    return -1;
  }

  /**
   * Index just past the `"` that closes the run opened before `from`.
   *
   * Not `closingIndex(from, '"', true)`: quoting RESTARTS inside a command
   * substitution, so in `"a $(cmd "b") c"` the quotes around `b` belong to the
   * substitution and do not end the outer run. Scanning for the next unescaped
   * `"` would cut the run short at `b`'s opening quote and leave the second half
   * — including anything the substitution runs — mis-parsed.
   *
   * Mutually recursive with `matchingParen`; both only ever move forward, so the
   * pair terminates.
   */
  function doubleQuoteEnd(from) {
    var j = from;
    while (j < n) {
      var ch = cmd.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === '"') return j + 1;
      if (ch === '$' && cmd.charAt(j + 1) === '(') {
        var close = matchingParen(j + 1, n);
        if (close !== -1) { j = close + 1; continue; }
        j += 2;
        continue;
      }
      if (ch === '`') {
        var bt = cmd.indexOf('`', j + 1);
        if (bt !== -1) { j = bt + 1; continue; }
      }
      j++;
    }
    return n;
  }

  /**
   * A double-quoted run and an unquoted-delimiter heredoc body are data —
   * EXCEPT for the command substitutions inside them, which the shell still
   * runs. Blanking those wholesale would leave `echo "$(gh pr create)"` and its
   * heredoc equivalent as silent bypasses, so restore each `$(…)` / `` `…` ``
   * region over the already-blanked range: its delimiters (both of which the
   * backwards walk reads as separators) plus its body, sanitised in its own
   * right so quoting INSIDE the substitution still applies.
   *
   * `'…'`, `$'…'` and quoted-delimiter heredocs (`<<'EOF'`) are left blanked —
   * the shell does not expand those, so there is nothing to restore.
   */
  function restoreSubstitutions(from, to) {
    if (level >= MAX_SUBSTITUTION_DEPTH) return;
    var k = from;
    while (k < to) {
      var ch = cmd.charAt(k);
      if (ch === '\\') { k += 2; continue; }
      var openLen = 0;
      var close = -1;
      if (ch === '$' && cmd.charAt(k + 1) === '(') {
        openLen = 2;
        close = matchingParen(k + 1, to);
      } else if (ch === '`') {
        openLen = 1;
        close = cmd.indexOf('`', k + 1);
        if (close >= to) close = -1;
      }
      if (close === -1) { k++; continue; }
      restore(k, cmd.slice(k, k + openLen));
      restore(close, cmd.charAt(close));
      restore(k + openLen, sanitizeShellData(cmd.slice(k + openLen, close), level + 1));
      k = close + 1;
    }
  }

  /**
   * Blank one heredoc body, starting at `start` (the first char of the line
   * after the newline that ended the header's logical line).
   *
   * Blanks each body line's content and the terminator line's content, leaving
   * every newline in place — so the text after the heredoc still begins after a
   * real separator, and offsets outside the body are untouched.
   *
   * Returns the index to resume scanning from. An unterminated heredoc blanks to
   * end of input, which is what the shell does with it too.
   */
  function blankHeredocBody(start, delim, stripTabs, expands) {
    var pos = start;
    while (pos < n) {
      var eol = cmd.indexOf('\n', pos);
      var lineEnd = eol === -1 ? n : eol;
      var line = cmd.slice(pos, lineEnd);
      // CRLF: the terminator is the line's content, not its line ending.
      if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
      var candidate = stripTabs ? line.replace(/^\t+/, '') : line;
      blank(pos, lineEnd);
      if (expands) restoreSubstitutions(pos, lineEnd);
      if (candidate === delim) return eol === -1 ? n : eol + 1;
      if (eol === -1) return n;
      pos = eol + 1;
    }
    return n;
  }

  while (i < n) {
    var c = cmd.charAt(i);

    // TRAP: `\` + newline is a line continuation. Blanking BOTH characters keeps
    // the logical line going, so the words after it stay arguments — otherwise
    // `cat <<EOF \` + newline + `gh pr create` reads as a command when the shell
    // reads it as arguments to `cat`. Any other `\x` is an escape; blanking the
    // pair likewise stops `\;` and friends from reading as separators.
    if (c === '\\') {
      blank(i, i + 2);
      i += 2;
      continue;
    }

    if (c === '#' && startsWord(cmd, i)) {
      var eol = cmd.indexOf('\n', i);
      if (eol === -1) eol = n;
      blank(i, eol);
      i = eol;
      continue;
    }

    if (c === '<' && cmd.charAt(i + 1) === '<') {
      // TRAP: `<<<` is a herestring. Skip the operator — its word is handled by
      // the ordinary quote/plain-text rules below.
      if (cmd.charAt(i + 2) === '<') { i += 3; continue; }
      // TRAP: sticky match at `i`, no window, no substring copy.
      HEREDOC_RE.lastIndex = i;
      var h = HEREDOC_RE.exec(cmd);
      if (h) {
        var delim = h[2] !== undefined ? h[2] : h[3] !== undefined ? h[3] : h[4] !== undefined ? h[4] : h[5];
        // A BARE delimiter (`<<EOF`) expands `$(…)` in the body; any quoted form
        // (`<<'EOF'`, `<<"EOF"`, `<<$'EOF'`) suppresses expansion entirely.
        pending.push({ delim: delim, stripTabs: h[1] === '-', expands: h[5] !== undefined });
        blank(i, i + h[0].length);
        i += h[0].length;
        continue;
      }
      // Not a header we recognise (`<< ;`, `<<` at end of input) — treat as text.
      i += 2;
      continue;
    }

    // `$'...'` processes `\` escapes; plain `'...'` does not.
    if (c === '$' && cmd.charAt(i + 1) === "'") {
      var ansiEnd = closingIndex(i + 2, "'", true);
      blank(i, ansiEnd);
      i = ansiEnd;
      continue;
    }

    if (c === "'") {
      var sqEnd = closingIndex(i + 1, "'", false);
      blank(i, sqEnd);
      i = sqEnd;
      continue;
    }

    if (c === '"') {
      var dqEnd = doubleQuoteEnd(i + 1);
      blank(i, dqEnd);
      // Substitutions inside the run still execute — see restoreSubstitutions.
      restoreSubstitutions(i + 1, dqEnd - 1);
      i = dqEnd;
      continue;
    }

    if (c === '\n') {
      i++;
      // Bodies for every heredoc announced on the logical line just ended, in
      // the order they were announced (`cat <<A <<B` reads A's body then B's).
      while (pending.length > 0) {
        var hd = pending.shift();
        i = blankHeredocBody(i, hd.delim, hd.stripTabs, hd.expands);
      }
      continue;
    }

    i++;
  }

  return out.join('');
}

/**
 * Does the token at `idx` in sanitised text `s` begin a command? True when what
 * precedes it is the start of input, a separator, or a run of `NAME=value` /
 * command-prefix words that itself bottoms out at one of those.
 */
function startsCommand(s, idx) {
  // The hit must be the whole command word. `PR_CREATE_RE` carries no leading
  // `\b`, so it can land mid-token — and the backwards walk below would then
  // read a TRUNCATED prefix as a command prefix: `dogh pr create` yields `do`,
  // which is in PREFIX_WORDS, and `FOO=bargh pr create` yields `FOO=bar`, which
  // matches ASSIGNMENT_RE. Both are one unrelated token; both used to over-match.
  //
  // A leading `\b` would not fix it on its own — `\b` admits `=`, so the command
  // in `FOO=gh pr create` (which is `pr`, not `gh`) would still walk back over
  // `FOO=` and report a command start.
  //
  // Checking the whole token rather than just the character before it also keeps
  // an invocation BY PATH working: `/usr/bin/gh pr create`, `./gh pr create`, and
  // on Windows `C:/tools/gh` or `/c/tools/gh` — the forms that are valid command
  // words for the shell the Bash tool runs.
  //
  // Only `/` is accepted as the separator, deliberately. A `\` is an ESCAPE here
  // and is blanked in pass 1, so it can never reach this token; accepting it too
  // would be unreachable code. The cost is that a backslash-escaped invocation
  // (`C:\tools\gh`, or `\gh`) is not recognised — a miss, not an over-block, and
  // the same miss the pre-#1410 regex had. Blanking the escape is what makes
  // `echo a\; gh pr create` correctly NOT read as a command, which is worth more.
  var tokenStart = idx;
  while (tokenStart > 0 && !isBlank(s.charAt(tokenStart - 1)) && SEPARATOR_CHARS.indexOf(s.charAt(tokenStart - 1)) === -1) tokenStart--;
  var token = s.slice(tokenStart, idx + 2);
  if (token !== 'gh' && !/\/gh$/.test(token)) return false;

  var i = tokenStart;
  for (;;) {
    while (i > 0 && isBlank(s.charAt(i - 1))) i--;
    if (i === 0) return true;
    if (SEPARATOR_CHARS.indexOf(s.charAt(i - 1)) !== -1) return true;
    var end = i;
    while (i > 0 && !isBlank(s.charAt(i - 1)) && SEPARATOR_CHARS.indexOf(s.charAt(i - 1)) === -1) i--;
    if (i === end) return false;
    var word = s.slice(i, end);
    if (!ASSIGNMENT_RE.test(word) && PREFIX_WORDS.indexOf(word) === -1) return false;
  }
}

/**
 * True when `cmd` invokes `gh pr create` as a command — not when it merely
 * contains those words inside a string, comment, or heredoc body.
 *
 * @param {string} cmd raw Bash command text (Claude Code's `tool_input.command`)
 * @returns {boolean}
 */
function isPrCreateCommand(cmd) {
  // Fast reject before sanitising. These gates run on EVERY Bash call, and a
  // large non-`gh` command would otherwise pay the full two-pass cost. `indexOf`
  // first because it is the cheapest possible screen; the token check then
  // discards the digraph false positives (`highlight`, `github`, `though`) that
  // `indexOf` alone lets through.
  if (typeof cmd !== 'string' || cmd.indexOf('gh') === -1) return false;
  if (!GH_TOKEN_RE.test(cmd)) return false;
  var s = sanitizeShellData(cmd);
  PR_CREATE_RE.lastIndex = 0;
  var m;
  while ((m = PR_CREATE_RE.exec(s)) !== null) {
    if (startsCommand(s, m.index)) return true;
  }
  return false;
}

module.exports = { isPrCreateCommand: isPrCreateCommand, sanitizeShellData: sanitizeShellData };
