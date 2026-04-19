---
name: flo
description: MoFlo ticket spell - analyze and execute GitHub issues
arguments: "[options] <issue-number | title>"
---

# /flo - MoFlo Ticket Workflow

Research, create tickets for, and execute GitHub issues automatically.

**Arguments:** $ARGUMENTS

## Usage

```
/flo <issue-number>                        # Full spell in NORMAL mode (default)
/flo -t | --ticket <issue-number>          # Ticket only: research and update existing ticket, then STOP
/flo -t | --ticket <title>                 # Create a NEW ticket with description, acceptance criteria, test cases
/flo -r | --research <issue-number>        # Research only: analyze issue, output findings
/flo --epic-branch <branch> <issue>        # Epic mode: commit to existing branch, skip branch creation and PR
```

Also available as `/fl` (shorthand alias).

### Spell Engine Mode (-wf)

```
/flo -wf <name|abbreviation> [args]   # Run a spell (e.g. `-wf sa ./src` or `-wf security-audit ./src`)
/flo -wf list                          # List available spells
/flo -wf info <name|abbreviation>      # Show spell details, arguments, steps
```

### Execution Mode (how work is done)

```
/flo 123                              # NORMAL mode (default) - single-agent execution
/flo -s | --swarm 123                 # SWARM mode - multi-agent coordination via Task tool
/flo -h | --hive 123                  # HIVE-MIND mode - consensus-based coordination
/flo -n | --normal 123                # NORMAL mode - explicit single-Claude, no agents
```

### Epic Handling

```
/flo 42                               # If #42 is an epic, processes all stories sequentially
```

**Epic Detection:** An issue is automatically detected as an epic if ANY of these are true:
- Has a label matching: `epic`, `tracking`, `parent`, or `umbrella` (case-insensitive)
- Body contains `## Stories` or `## Tasks` sections
- Body has checklist-linked issues: `- [ ] #123`
- Body has numbered issue references: `1. #123`
- The issue has GitHub sub-issues (via `subIssues` API field)

When an epic is detected, processing runs inline (no shell-out) using `flo epic run` logic. **Read `./epic.md` before proceeding** — it has the strategy selection, branch handling, and checklist tracking details.

## Workflow Overview

```
Research -> Ticket -> Execute -> Testing -> Simplify -> Learnings -> PR+Done

Research:    Fetch issue, search memory, read guidance, find files
Ticket:      Create or update GitHub issue with description, acceptance criteria, test cases
Execute:     Assign self, create branch, implement changes
Testing:     Unit + Integration + E2E tests (ALL MUST PASS - gate)
Simplify:    Run /simplify on changed code (gate - must run before PR)
Learnings:   mcp__moflo__memory_store patterns (gate - MUST run before PR)
PR+Done:     Create PR, update issue status
```

### Workflow Gates

| Gate | Requirement | Blocked Action |
|------|-------------|----------------|
| **Testing Gate** | Unit + Integration + E2E must ALL pass | PR creation |
| **Simplification Gate** | /simplify must run on changed files | PR creation |
| **Learnings Gate** | mcp__moflo__memory_store must be called | PR creation |

### Execution Mode (applies to all phases)

| Mode | Description |
|------|-------------|
| **NORMAL** (default) | Single Claude execution. Efficient for most tasks. |
| **SWARM** (-s) | Multi-agent via Task tool: researcher, coder, tester, reviewer |
| **HIVE-MIND** (-h) | Consensus-based coordination for architecture decisions |

## Companion Files (progressive disclosure)

This skill is split across focused files. **You MUST read the relevant companion file before executing that phase or mode** — the details are not repeated here.

| File | Read when |
|------|-----------|
| `./phases.md` | Executing any full-run step: Research (Phase 1), Execute (Phase 3), Testing (Phase 4), Simplify (Phase 4.5), Commit/PR (Phase 5) |
| `./ticket.md` | Running `-t`, or whenever Phase 2 applies (complexity scoring, ticket content, epic promotion) |
| `./epic.md` | Processing a detected epic (strategies, inline orchestration, checklist tracking) |
| `./execution-modes.md` | Any `-s` / `--swarm` or `-h` / `--hive` invocation, or the details of NORMAL mode |
| `./spell-engine.md` | Any `-wf` / `--workflow` invocation (list, info, execute) |

Do not guess at companion content — read the file. This is a hard requirement, not a suggestion.

## Parse Arguments

```javascript
const args = "$ARGUMENTS".trim().split(/\s+/);
let workflowMode = "full";    // full, ticket, research, spell-engine
let execMode = "normal";      // normal (default), swarm, hive
let epicBranch = null;        // when set, skip branch creation and PR (epic mode)
let issueNumber = null;
let titleWords = [];

// Workflow engine (-wf) state
let wfName = null;             // spell name or abbreviation
let wfSubcommand = null;       // "list" or "info"
let wfArgs = [];               // positional args after spell name
let wfNamedArgs = {};          // --key=value or --key value args

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  // Workflow engine mode
  if (arg === "-wf" || arg === "--workflow") {
    workflowMode = "spell-engine";
    // Next arg is the spell name or subcommand
    if (i + 1 < args.length) {
      const next = args[++i];
      if (next === "list") {
        wfSubcommand = "list";
      } else if (next === "info") {
        wfSubcommand = "info";
        // Next arg after "info" is the query
        if (i + 1 < args.length) {
          wfName = args[++i];
        }
      } else {
        wfName = next;
      }
    }
    // Collect remaining args as spell arguments
    for (let j = i + 1; j < args.length; j++) {
      const wa = args[j];
      if (wa.startsWith("--")) {
        const eqIdx = wa.indexOf("=");
        if (eqIdx !== -1) {
          wfNamedArgs[wa.slice(2, eqIdx)] = wa.slice(eqIdx + 1);
        } else if (j + 1 < args.length && !args[j + 1].startsWith("-")) {
          wfNamedArgs[wa.slice(2)] = args[++j];
        } else {
          wfNamedArgs[wa.slice(2)] = "true";
        }
      } else {
        wfArgs.push(wa);
      }
    }
    break; // -wf consumes all remaining args
  }

  // Workflow mode (what to do)
  else if (arg === "-t" || arg === "--ticket") {
    workflowMode = "ticket";
  } else if (arg === "-r" || arg === "--research") {
    workflowMode = "research";
  }

  // Epic mode (used by epic orchestrator — skip branch creation and PR)
  else if (arg === "--epic-branch") {
    epicBranch = args[++i]; // next arg is the branch name
  }

  // Execution mode (how to do it)
  else if (arg === "-s" || arg === "--swarm") {
    execMode = "swarm";
  } else if (arg === "-h" || arg === "--hive") {
    execMode = "hive";
  } else if (arg === "-n" || arg === "--normal") {
    execMode = "normal";
  }

  // Issue number or title text
  else if (/^\d+$/.test(arg)) {
    issueNumber = arg;
  } else {
    // Non-flag, non-numeric argument — collect as title words
    titleWords.push(arg);
  }
}

// Validation
if (workflowMode === "spell-engine") {
  if (!wfName && !wfSubcommand) {
    throw new Error("Spell name or subcommand required. Usage: /flo -wf <name|list|info> [args]");
  }
  console.log("SPELL ENGINE MODE: " + (wfSubcommand || wfName));
} else {
  // In ticket mode, a title can be given instead of an issue number
  let ticketTitle = titleWords.join(" ");
  if (!issueNumber && !ticketTitle) {
    throw new Error("Issue number or title required. Usage: /flo <issue-number | title>");
  }
  if (!issueNumber && workflowMode !== "ticket") {
    throw new Error("Issue number required for full/research mode. Use -t for new tickets.");
  }

  // Log execution mode to prevent silent skipping
  console.log("Execution mode: " + execMode.toUpperCase());
  if (execMode === "swarm") {
    console.log("SWARM MODE: Will spawn agents via Task tool. Do NOT skip this.");
  }
  console.log("TESTING: Unit + Integration + E2E tests REQUIRED before PR.");
  console.log("SIMPLIFY: /simplify command runs on changed code before PR.");
}
```

## Execution Flow

### Workflow Modes (what to do)

| Mode | Command | Steps | Stops After | Read |
|------|---------|-------|-------------|------|
| **Full** (default) | `/flo 123` | Research -> Ticket -> Implement -> Test -> Simplify -> PR | PR created | `./phases.md` + `./ticket.md` |
| **Epic** | `/flo 42` (epic) | Inline epic processing: extract stories, run each via /flo | All stories complete | `./epic.md` |
| **Ticket** | `/flo -t 123` | Research -> Ticket | Issue updated | `./ticket.md` |
| **Research** | `/flo -r 123` | Research | Findings output | `./phases.md` (Phase 1) |
| **Workflow** | `/flo -wf sa ./src` | Load registry -> Resolve spell -> Execute with args | Spell complete | `./spell-engine.md` |
| **WF List** | `/flo -wf list` | Load registry -> Print all spells | List printed | `./spell-engine.md` |
| **WF Info** | `/flo -wf info sa` | Load registry -> Print spell details | Info printed | `./spell-engine.md` |

Execution modes (normal/swarm/hive) are defined in the table under **Workflow Overview > Execution Mode** above. Full agent-spawning details and swarm patterns live in `./execution-modes.md`.

---

**Full mode executes without prompts.** It will:
1. Research the issue and codebase (see `./phases.md` Phase 1)
2. Enhance the GitHub issue with implementation plan (see `./ticket.md`)
3. Assign issue to self, add "in-progress" label (see `./phases.md` Phase 3)
4. Create branch, implement, test (see `./phases.md` Phases 3–4)
5. Run /simplify on changed code, re-test if changes made (see `./phases.md` Phase 4.5)
6. Commit changes (see `./phases.md` Phase 5.1)
7. Store learnings via mcp__moflo__memory_store (REQUIRED before PR — gate enforced; see `./phases.md` Phase 5.2)
8. Create PR, update issue status (see `./phases.md` Phases 5.3–5.4)
