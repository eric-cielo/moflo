#!/usr/bin/env bash
# Publish-skill fingerprint: pattern-matches the diff since last publish
# against the manual-check triggers from pre-publish-rules.md (gates 1/2/6).
# Prints `Triggered manual checks: ...` (or `none`) on stdout. Pure shell —
# no Claude tokens. Errs toward triggering on ambiguity.
#
# Usage: bash .claude/skills/publish/fingerprint.sh
#
# Exit codes: 0 always (output is what the skill consumes).

set -euo pipefail

# Find the commit that installed the most recently published moflo. The
# /publish skill's Step 10 makes a `chore: install moflo@<version>` commit, so
# everything between that commit and HEAD is what the next publish will ship.
LAST_PUBLISH=$(git log --grep='^chore: install moflo@' -n 1 --format=%H 2>/dev/null || true)

if [ -z "$LAST_PUBLISH" ]; then
  # No prior publish commit found — fingerprint can't bound the diff. Trigger
  # everything and let the manual walk decide. False positive > false negative.
  echo "Triggered manual checks: split-newlines homedir-tmpdir bwrap-permissions posix-only-spell-bash bin-scriptfiles-sync helper-static-files shipped-guidance-prefix files-glob-coverage info-loss-audit (no prior publish commit found — running full audit)"
  exit 0
fi

CHANGED=$(git diff --name-only "$LAST_PUBLISH..HEAD" || true)
DELETED=$(git diff --name-only --diff-filter=DR "$LAST_PUBLISH..HEAD" || true)

triggered=()

# Gate 1 — TS/JS files reading file content → check `.split(/\r?\n/)` review.
if echo "$CHANGED" | grep -qE '\.(ts|tsx|js|mjs|cjs)$'; then
  # Build EXISTING as an array so paths with spaces survive (consumer projects
  # may live under "C:\Users\Some Name\..." on Windows).
  EXISTING=()
  while IFS= read -r f; do
    [ -f "$f" ] && EXISTING+=("$f")
  done < <(echo "$CHANGED" | grep -E '\.(ts|tsx|js|mjs|cjs)$')
  if [ "${#EXISTING[@]}" -gt 0 ] && grep -lE 'readFile|readFileSync|fs\.read' "${EXISTING[@]}" >/dev/null 2>&1; then
    triggered+=("split-newlines")
  fi
  # Gate 1 — `os.homedir()` / `os.tmpdir()` review when env-var literals appear.
  if [ "${#EXISTING[@]}" -gt 0 ] && grep -lE "process\.env\.(HOME|TMPDIR|TMP|TEMP)|['\"]\\/tmp\\/" "${EXISTING[@]}" >/dev/null 2>&1; then
    triggered+=("homedir-tmpdir")
  fi
fi

# Gate 1 — spell yaml or spell bash steps changed.
if echo "$CHANGED" | grep -qE '(^spells/|spells/.*\.(ya?ml|sh|bash)$|\.spell\.ya?ml$)'; then
  triggered+=("bwrap-permissions" "posix-only-spell-bash")
fi

# Gate 2 — new file added under bin/ (only adds, not modifications, count for
# scriptFiles sync). Guard the `--diff-filter=A` lookup separately from the
# generic CHANGED set so a touched-but-not-added file doesn't fire it.
ADDED=$(git diff --name-only --diff-filter=A "$LAST_PUBLISH..HEAD" || true)
if echo "$ADDED" | grep -q '^bin/'; then
  triggered+=("bin-scriptfiles-sync")
fi

# Gate 2 — anything in bin/ or init/ script-generation logic changed.
if echo "$CHANGED" | grep -qE '^(bin/|init/|src/cli/init/)'; then
  triggered+=("helper-static-files")
fi

# Gate 2 — new file added under .claude/guidance/shipped/ (prefix + partition).
if echo "$ADDED" | grep -q '^\.claude/guidance/shipped/'; then
  triggered+=("shipped-guidance-prefix")
fi

# Gate 6 — new shipped file class. Conservative trigger: any new top-level
# directory under .claude/ or any new pattern under shipped/. We approximate
# "new file class" as "any added file the existing files-glob might miss".
if echo "$ADDED" | grep -qE '^\.claude/(skills|guidance/shipped|scripts|hooks)/'; then
  triggered+=("files-glob-coverage")
fi

# Gate 6 — any file deleted or renamed → information-loss audit.
if [ -n "$DELETED" ]; then
  triggered+=("info-loss-audit")
fi

# Dedupe (bash 4+ assoc array). Skip dedupe entirely on older bash — duplicates
# are harmless (Claude reads them either way), so a degraded run still works.
if declare -A seen 2>/dev/null; then
  unique=()
  if [ "${#triggered[@]}" -gt 0 ]; then
    for t in "${triggered[@]}"; do
      [ -z "$t" ] && continue
      if [ -z "${seen[$t]:-}" ]; then
        seen[$t]=1
        unique+=("$t")
      fi
    done
  fi
  triggered=()
  if [ "${#unique[@]}" -gt 0 ]; then
    triggered=("${unique[@]}")
  fi
fi

# Count non-empty lines without tripping `set -e`. `grep -c .` succeeds with
# exit 1 on zero matches and `... || echo 0` then double-prints; use awk.
CHANGED_COUNT=$(printf '%s\n' "$CHANGED" | awk 'NF { n++ } END { print n+0 }')

if [ "${#triggered[@]}" -eq 0 ]; then
  echo "Triggered manual checks: none"
else
  echo "Triggered manual checks: ${triggered[*]}"
fi
echo "Diff range: $LAST_PUBLISH..HEAD"
echo "Changed files: $CHANGED_COUNT"
