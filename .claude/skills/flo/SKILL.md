---
name: flo
description: MoFlo ticket workflow - analyze and execute GitHub issues
arguments: "[options] <issue-number | title>"
---

# /flo - MoFlo Ticket Workflow

Research, create tickets for, and execute GitHub issues automatically.

**Arguments:** $ARGUMENTS

## Usage

```
/flo <issue-number>                   # Full workflow in NORMAL mode (default)
/flo -t <issue-number>                # Ticket only: research and update ticket, then STOP
/flo -t <title>                       # Create a NEW ticket with description, acceptance criteria, test cases
/flo --ticket <issue-number|title>    # Same as -t
/flo -r <issue-number>                # Research only: analyze issue, output findings
/flo --research <issue-number>        # Same as -r
/flo --epic-branch <branch> <issue>   # Epic mode: commit to existing branch, skip branch creation and PR
```

Also available as `/fl` (shorthand alias).

### Workflow Engine Mode (-wf)

```
/flo -wf sa ./src            # Run security-audit workflow with target=./src
/flo -wf security-audit ./src  # Same, using full name
/flo -wf list                # List available workflows
/flo -wf info sa             # Show workflow details, arguments, steps
```

### Execution Mode (how work is done)

```
/flo 123                              # NORMAL mode (default) - single-agent execution
/flo -s 123                           # SWARM mode - multi-agent coordination
/flo --swarm 123                      # Same as -s
/flo -h 123                           # HIVE-MIND mode - consensus-based coordination
/flo --hive 123                       # Same as -h
/flo -n 123                           # NORMAL mode - single Claude, no agents
/flo --normal 123                     # Same as -n
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

**Epic processing:** When an epic is detected, use the same logic as `flo epic run`:
1. Extract stories using detection from `src/packages/cli/src/epic/detection.ts`
2. Determine strategy from `moflo.yaml` config (`epic.default_strategy`), defaulting to `single-branch`
3. For **single-branch**: create shared `epic/<number>-<slug>` branch, process each story via `/flo --epic-branch <branch> <issue>`, then create one consolidated PR
4. For **auto-merge**: process each story via `/flo <issue>`, merge its PR, then proceed to next

Individual stories within an epic are still processed via `/flo --epic-branch <branch> <issue>` (for single-branch) or `/flo <issue>` (for auto-merge).

### Combined Examples

```
/flo -wf sa ./src                     # Run security-audit workflow (abbreviation)
/flo -wf security-audit ./src         # Run security-audit workflow (full name)
/flo -wf list                         # List available workflows
/flo -wf info sa                      # Show workflow details + arguments
/flo 123                              # Normal + full workflow (default) - includes ALL tests
/flo 42                               # If #42 is epic, processes stories sequentially
/flo -s 123                           # Swarm + full workflow (multi-agent coordination)
/flo -t 123                           # Normal + ticket only (no implementation)
/flo -h -t 123                        # Hive-mind + ticket only
/flo -s -r 123                        # Swarm + research only
/flo --swarm --ticket 123             # Explicit swarm + ticket only
/flo -n 123                           # Normal (explicit, same as default)
```

## NORMAL MODE IS THE DEFAULT

By default, /flo runs in NORMAL mode — single-agent execution without
spawning sub-agents. This is efficient for most tasks.

Use `-s`/`--swarm` for multi-agent coordination when the task warrants it.
Use `-h`/`--hive` for consensus-based coordination on architecture decisions.

POST-TASK NEURAL LEARNING ALWAYS RUNS regardless of execution mode.
The hooks system collects learnings after every task completion — normal,
swarm, or hive-mind.

## COMPREHENSIVE TESTING REQUIREMENT

ALL tests MUST pass BEFORE PR creation - NO EXCEPTIONS.
- Unit Tests: MANDATORY for all new/modified code
- Integration Tests: MANDATORY for API endpoints and services
- E2E Tests: MANDATORY for user-facing features
PR CANNOT BE CREATED until all relevant tests pass.

## Workflow Overview

```
Research -> Ticket -> Execute -> Testing -> Simplify -> PR+Done

Research:    Fetch issue, search memory, read guidance, find files
Ticket:      Create or update GitHub issue with description, acceptance criteria, test cases
Execute:     Assign self, create branch, implement changes
Testing:     Unit + Integration + E2E tests (ALL MUST PASS - gate)
Simplify:    Run /simplify on changed code (gate - must run before PR)
PR+Done:     Create PR, update issue status, store learnings
```

### Workflow Gates

| Gate | Requirement | Blocked Action |
|------|-------------|----------------|
| **Testing Gate** | Unit + Integration + E2E must pass | PR creation |
| **Simplification Gate** | /simplify must run on changed files | PR creation |

### Execution Mode (applies to all phases)

| Mode | Description |
|------|-------------|
| **NORMAL** (default) | Single Claude execution. Efficient for most tasks. |
| **SWARM** (-s) | Multi-agent via Task tool: researcher, coder, tester, reviewer |
| **HIVE-MIND** (-h) | Consensus-based coordination for architecture decisions |

## Phase 1: Research (-r or default first step)

### 1.1 Fetch Issue Details
```bash
gh issue view <issue-number> --json number,title,body,labels,state,assignees,comments,milestone
```

### 1.2 Check Ticket Status
Look for `## Acceptance Criteria` marker in issue body.
- **If present**: Ticket already enhanced, skip to execute or confirm
- **If absent**: Proceed with research and ticket update

### 1.3 Search Memory FIRST
ALWAYS search memory BEFORE reading guidance or docs files.
Memory has file paths, context, and patterns - often all you need.
Only read guidance files if memory search returns zero relevant results.

```bash
npx flo memory search --query "<issue title keywords>" --namespace patterns
npx flo memory search --query "<domain keywords>" --namespace guidance
```

Or via MCP: `mcp__moflo__memory_search`

### 1.4 Read Guidance Docs (ONLY if memory insufficient)
**Only if memory search returned < 3 relevant results**, read guidance files:
- Bug -> testing patterns, error handling
- Feature -> domain model, architecture
- UI -> frontend patterns, components

### 1.5 Research Codebase
Use Task tool with Explore agent to find:
- Affected files and their current state
- Related code and dependencies
- Existing patterns to follow
- Test coverage gaps

## Phase 2: Ticket (-t creates or updates a ticket)

When given an issue number, `-t` enhances the existing ticket. When given a title (non-numeric argument), `-t` creates a new GitHub issue. Either way, the ticket MUST include all three of the following sections.

### 2.0 Complexity Assessment (MANDATORY before building ticket)

After research, assess the complexity of the work. This determines whether the issue stays as a single ticket or gets promoted to an epic with sub-issues.

**Complexity Signals — count how many apply:**

| Signal | Weight | Example |
|--------|--------|---------|
| Multiple files changed (5+) | +2 | Touches models, API, tests, docs, config |
| New module or package | +2 | Requires new directory structure |
| Cross-cutting concern | +2 | Auth, logging, error handling across layers |
| Database/schema changes | +2 | Migrations, new tables, index changes |
| Multiple independent work streams | +3 | Frontend + backend + infra changes |
| External API integration | +1 | Third-party service, webhook, OAuth |
| Breaking change / migration | +2 | Requires deprecation, data migration |
| Significant test surface | +1 | Needs 10+ new test cases across categories |
| Security implications | +1 | Authentication, authorization, input validation |
| UI + backend changes together | +2 | Full-stack feature spanning layers |

**Complexity Thresholds:**

| Score | Classification | Action |
|-------|---------------|--------|
| 0–3 | **Simple** | Single ticket — proceed normally |
| 4–6 | **Moderate** | Single ticket — flag in description that it may benefit from splitting |
| 7+ | **Complex** | **PROMOTE TO EPIC** — decompose into sub-issues |

**When promoting to epic:**

1. Decompose the work into 2–6 independent, shippable stories
2. Each story should be completable in a single PR
3. Stories should have clear boundaries (one concern per story)
4. Order stories by dependency (independent ones first)
5. Create each story as a GitHub issue with its own Description, Acceptance Criteria, and Test Cases
6. Create or convert the parent issue into an epic with a `## Stories` checklist

```javascript
// Complexity assessment pseudocode
function assessComplexity(research) {
  let score = 0;
  if (research.affectedFiles.length >= 5) score += 2;
  if (research.requiresNewModule) score += 2;
  if (research.crossCutting) score += 2;
  if (research.schemaChanges) score += 2;
  if (research.independentWorkStreams >= 2) score += 3;
  if (research.externalAPIs) score += 1;
  if (research.breakingChanges) score += 2;
  if (research.estimatedTestCases >= 10) score += 1;
  if (research.securityImplications) score += 1;
  if (research.fullStack) score += 2;
  return score;
}
```

### 2.0.1 Epic Decomposition (when score >= 7)

When complexity warrants an epic, decompose into stories:

```bash
# Step 1: Create each sub-issue
gh issue create --title "Story: <story-title>" --body "<## Description + ## Acceptance Criteria + ## Suggested Test Cases>" --label "story"
# Capture the new issue number from output

# Step 2: Repeat for all stories (2-6 stories typically)

# Step 3: Build the epic body with checklist referencing ALL story issue numbers
# Step 4: If updating an existing issue, convert it to epic:
gh issue edit <parent-number> --add-label "epic" --body "<epic body with ## Stories checklist>"

# Step 5: If creating new, create the epic:
gh issue create --title "Epic: <title>" --label "epic" --body "<epic body>"
```

**Epic body format (MANDATORY — this is how tracking works):**

```markdown
## Overview
<High-level description of the epic goal>

## Stories

- [ ] #<story-1-number> <story-1-title>
- [ ] #<story-2-number> <story-2-title>
- [ ] #<story-3-number> <story-3-title>

## Complexity Assessment
Score: <N>/20 — <Simple|Moderate|Complex>
Signals: <list of signals that triggered>
```

The `## Stories` checklist with `- [ ] #<number>` format is **mandatory** — this is what enables:
- Epic detection by the `/flo` skill
- Story extraction for sequential processing
- Progress tracking via checked/unchecked items

### 2.1 Build Ticket Content
Compile research into a well-structured ticket. The issue MUST include all three of the following sections:

**Detailed Description** — Clear, thorough explanation of what needs to be done and why. Include:
- Root cause analysis (bugs) or approach rationale (features)
- Impact and risk factors
- Affected files (with line numbers), new files, deletions
- Implementation plan: numbered steps with clear actions, dependencies, decision points

**Acceptance Criteria** — Specific, testable conditions that must be true for this issue to be considered complete. Write as a checklist:
- [ ] Criterion 1 (e.g., "API returns 200 with valid token")
- [ ] Criterion 2 (e.g., "Error message shown when input exceeds 255 chars")
- [ ] ...each criterion must be independently verifiable

**Suggested Test Cases** — Concrete test scenarios covering happy path, edge cases, and error conditions:
- Test case 1: description, input, expected output
- Test case 2: description, input, expected output
- Include unit, integration, and E2E test suggestions as appropriate

### 2.2 Create or Update GitHub Issue

**If issue number was given** (update existing):
```bash
gh issue edit <issue-number> --body "<original body + ## Description + ## Acceptance Criteria + ## Suggested Test Cases>"
gh issue comment <issue-number> --body "Ticket enhanced with description, acceptance criteria, and test cases. Ready for execution."
```

**If title was given** (create new):
```bash
gh issue create --title "<title>" --body "<## Description + ## Acceptance Criteria + ## Suggested Test Cases>"
```
Print the new issue URL so the user can see it.

## Phase 3: Execute (default, runs automatically after ticket)

### 3.1 Assign Issue and Update Status
```bash
gh issue edit <issue-number> --add-assignee @me
gh issue edit <issue-number> --add-label "in-progress"
```

### 3.2 Create Branch

**If `--epic-branch <branch>` was passed** (epic mode):
Skip branch creation entirely. The epic orchestrator has already created and checked out the shared epic branch. Just verify you're on it:
```bash
git branch --show-current  # Should match the epic branch name
```

**Otherwise** (normal mode):
```bash
git checkout main && git pull origin main
git checkout -b <type>/<issue-number>-<short-desc>
```
Types: `feature/`, `fix/`, `refactor/`, `docs/`

### 3.3 Implement
Follow the implementation plan from the ticket. No prompts - execute all steps.

## Phase 4: Testing (MANDATORY GATE)

This is NOT optional. ALL applicable test types must pass for the change type.
WORKFLOW STOPS HERE until tests pass. No shortcuts. No exceptions.

### 4.1 Write and Run Tests
Write unit, integration, and E2E tests as appropriate for the change type.
Follow the project's established test style, runner, and patterns. If no existing tests or test guidance is present, choose the best options for the project's language and stack, taking compatibility with existing dependencies into account.

### 4.2 Test Auto-Fix Loop
If any tests fail, enter the auto-fix loop (max 3 retries OR 10 minutes):
1. Run all tests
2. If ALL pass -> proceed to simplification
3. If ANY fail: analyze failure, fix test or implementation code, retry
4. If retries exhausted -> STOP and report to user

## Phase 4.5: Code Simplification (MANDATORY)

The built-in /simplify command reviews ALL changed code for:
- Reuse opportunities and code quality
- Efficiency improvements
- Consistency with existing codebase patterns
- Preserves ALL functionality - no behavior changes

If /simplify makes changes -> re-run tests to confirm nothing broke.
If re-tests fail -> revert changes, proceed with original code.

## Phase 5: Commit and PR (only after tests pass)

### 5.1 Commit
```bash
git add <specific files>
git commit -m "type(scope): description

Closes #<issue-number>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### 5.2 Create PR

**If `--epic-branch` was passed** (epic mode):
**SKIP PR creation entirely.** The commit from 5.1 (with `Closes #<issue-number>`) is sufficient.
The epic orchestrator will create a single consolidated PR after all stories complete.
Also skip pushing — the epic orchestrator handles the final push.

Proceed directly to 5.3 (update issue status only).

**Otherwise** (normal mode):
```bash
git push -u origin <branch-name>
gh pr create --title "type(scope): description" --body "## Summary
<brief description>

## Changes
<bullet list>

## Testing
- [x] Unit tests pass
- [x] Integration tests pass
- [x] E2E tests pass
- [ ] Manual testing done

Closes #<issue-number>"
```

### 5.3 Update Issue Status
```bash
gh issue edit <issue-number> --remove-label "in-progress" --add-label "ready-for-review"
gh issue comment <issue-number> --body "PR created: <pr-url>"
```

## Epic Handling

### Unified Epic Processing

When `/flo <issue>` detects an epic, it follows the same orchestration logic as `flo epic run`.
The `/flo` skill does NOT shell out — it processes the epic inline within the current Claude session,
following the strategy steps described below. This keeps the full context (memory, guidance, session state)
available throughout story processing.

### Detecting Epics

An issue is an **epic** if:
1. It has the `epic` label (or `tracking`, `parent`, `umbrella`), OR
2. Its body contains `## Stories` or `## Tasks` sections, OR
3. It has linked child issues (via `- [ ] #123` checklist format), OR
4. It has numbered issue references (e.g., `1. #123`), OR
5. It has GitHub sub-issues (via `subIssues` API field)

Detection uses `isEpicIssue()` from `src/packages/cli/src/epic/detection.ts`.

### Epic Strategies

| Strategy | Default | Description |
|----------|---------|-------------|
| `single-branch` | **Yes** | One shared branch, one commit per story, one PR at the end |
| `auto-merge` | No | Per-story branches and PRs, each auto-merged before the next story |

Strategy is determined by (in priority order):
1. CLI flag: `--strategy auto-merge`
2. Feature definition: `strategy` field in YAML
3. Config: `epic.default_strategy` in `moflo.yaml`
4. Default: `single-branch`

### How It Works

The `flo epic run` command:
1. Fetches the epic issue and validates it
2. Extracts and orders stories (topological sort for dependencies)
3. Loads the appropriate workflow YAML template
4. Runs via the workflow engine (WorkflowRunner)
5. The workflow template handles branch creation, story iteration, PR creation, and checklist tracking

Individual stories within an epic are processed via `/flo --epic-branch <branch> <issue>`,
which the workflow engine invokes automatically. The `--epic-branch` flag tells `/flo` to
commit to the existing branch and skip branch creation and PR creation.

### Epic Checklist Tracking

The workflow templates automatically check off stories in the epic body after each commit.
The checklist state (`[ ]` vs `[x]`) is the **single source of truth** for epic progress.

## Parse Arguments

```javascript
const args = "$ARGUMENTS".trim().split(/\s+/);
let workflowMode = "full";    // full, ticket, research, workflow
let execMode = "normal";      // normal (default), swarm, hive
let epicBranch = null;        // when set, skip branch creation and PR (epic mode)
let issueNumber = null;
let titleWords = [];

// Workflow engine (-wf) state
let wfName = null;             // workflow name or abbreviation
let wfSubcommand = null;       // "list" or "info"
let wfArgs = [];               // positional args after workflow name
let wfNamedArgs = {};          // --key=value or --key value args

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  // Workflow engine mode
  if (arg === "-wf" || arg === "--workflow") {
    workflowMode = "workflow";
    // Next arg is the workflow name or subcommand
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
    // Collect remaining args as workflow arguments
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
if (workflowMode === "workflow") {
  if (!wfName && !wfSubcommand) {
    throw new Error("Workflow name or subcommand required. Usage: /flo -wf <name|list|info> [args]");
  }
  console.log("WORKFLOW ENGINE MODE: " + (wfSubcommand || wfName));
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

| Mode | Command | Steps | Stops After |
|------|---------|-------|-------------|
| **Full** (default) | `/flo 123` | Research -> Ticket -> Implement -> Test -> Simplify -> PR | PR created |
| **Epic** | `/flo 42` (epic) | Inline epic processing: extract stories, run each via /flo | All stories complete |
| **Ticket** | `/flo -t 123` | Research -> Ticket | Issue updated |
| **Research** | `/flo -r 123` | Research | Findings output |
| **Workflow** | `/flo -wf sa ./src` | Load registry -> Resolve workflow -> Execute with args | Workflow complete |
| **WF List** | `/flo -wf list` | Load registry -> Print all workflows | List printed |
| **WF Info** | `/flo -wf info sa` | Load registry -> Print workflow details | Info printed |

### Execution Modes (how to do it)

| Mode | Flag | Description | When to Use |
|------|------|-------------|-------------|
| **Normal** (DEFAULT) | `-n`, `--normal` | Single Claude, no agents | Default for most tasks |
| **Swarm** | `-s`, `--swarm` | Multi-agent via Task tool | Complex multi-file changes |
| **Hive-Mind** | `-h`, `--hive` | Consensus-based coordination | Architecture decisions, tradeoffs |

## Execution Mode Details

### SWARM Mode (-s, --swarm)

When swarm is requested, you MUST use the Task tool to spawn agents. No exceptions.

**Swarm spawns these agents via Task tool:**
- `researcher` - Analyzes issue, searches memory, finds patterns
- `coder` - Implements changes following plan
- `tester` - Writes and runs tests
- `/simplify` - Built-in command that reviews changed code before PR
- `reviewer` - Reviews code before PR

**Swarm execution pattern:**
```javascript
// 1. Create task list FIRST
TaskCreate({ subject: "Research issue #123", ... })
TaskCreate({ subject: "Implement changes", ... })
TaskCreate({ subject: "Test implementation", ... })
TaskCreate({ subject: "Run /simplify on changed files", ... })
TaskCreate({ subject: "Review and PR", ... })

// 2. Init swarm
Bash("npx flo swarm init --topology hierarchical --max-agents 8 --strategy specialized")

// 3. Spawn agents with Task tool (run_in_background: true)
Task({ prompt: "...", subagent_type: "researcher", run_in_background: true })
Task({ prompt: "...", subagent_type: "coder", run_in_background: true })

// 4. Wait for results, synthesize, continue
```

### HIVE-MIND Mode (-h, --hive)

Use for consensus-based decisions:
- Architecture choices
- Approach tradeoffs
- Design decisions with multiple valid options

### NORMAL Mode (Default)

Single Claude execution without spawning sub-agents.
- Still uses Task tool for tracking
- Still creates tasks for visibility
- Post-task neural learning hooks still fire
- Just doesn't spawn multiple agents

### WORKFLOW ENGINE Mode (-wf, --workflow)

When `-wf` is used, the /flo skill switches to the generalized workflow engine
instead of the hardcoded coding workflow. This uses the `WorkflowRegistry` from
`@moflo/workflows` to resolve and run YAML/JSON workflow definitions.

**Scan directories** (in priority order):
1. Shipped: `src/packages/workflows/definitions/` (bundled with moflo)
2. User: `workflows/` and `.claude/workflows/` (project-level overrides)

**Registry behavior:**
- Each workflow file defines `name` and optional `abbreviation` in frontmatter
- Registry builds lookup map: abbreviation -> file path, full name -> file path
- Duplicate abbreviations produce a collision error on load
- User definitions override shipped ones by name match

**Subcommands:**

`/flo -wf list` — List all available workflows:
```
Use WorkflowRegistry.list() to get all registered workflows.
Print a table: name | abbreviation | description | tier (shipped/user)
```

`/flo -wf info <name|abbreviation>` — Show workflow details:
```
Use WorkflowRegistry.info(query) to get detailed info.
Print: name, abbreviation, description, version, source file, arguments, step count, step types
```

`/flo -wf <name|abbreviation> [positional-args] [--named-args]` — Execute a workflow:
```
1. Use WorkflowRegistry.resolve(wfName) to find the workflow
2. Map positional args to required arguments in order
3. Parse named args: --key=value or --key value
4. Use runWorkflowFromContent() or createRunner().run() to execute
5. Print step-by-step progress and final result
```

**Argument mapping:**
- Positional args mapped to required arguments in definition order
- Named args: `--severity=critical` or `--severity critical`
- Boolean flags: `--autofix` (true if present)
- Example: `/flo -wf sa ./src --severity critical --autofix`
  Maps to: `{ target: "./src", severity: "critical", autofix: "true" }`

---

**Full mode executes without prompts.** It will:
1. Research the issue and codebase
2. Enhance the GitHub issue with implementation plan
3. Assign issue to self, add "in-progress" label
4. Create branch, implement, test
5. Run /simplify on changed code, re-test if changes made
6. Commit, create PR, update issue status
7. Store learnings
