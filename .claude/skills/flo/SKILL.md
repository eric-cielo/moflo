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
/flo <issue-number>                   # Full workflow with SWARM (default)
/flo -t <issue-number>                # Ticket only: research and update ticket, then STOP
/flo -t <title>                       # Create a NEW ticket with description, acceptance criteria, test cases
/flo --ticket <issue-number|title>    # Same as -t
/flo -r <issue-number>                # Research only: analyze issue, output findings
/flo --research <issue-number>        # Same as -r
```

Also available as `/fl` (shorthand alias).

### Execution Mode (how work is done)

```
/flo 123                              # SWARM mode (default) - multi-agent coordination
/flo -s 123                           # SWARM mode (explicit)
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

**Sequential Processing:** When an epic is selected:
1. List all child stories/tasks (from checklist or linked issues)
2. Process each story **one at a time** in order
3. Each story goes through the full workflow (research -> ticket -> implement -> test -> PR)
4. After each story's PR is created, move to the next story
5. Continue until all stories are complete

### Combined Examples

```
/flo 123                              # Swarm + full workflow (default) - includes ALL tests
/flo 42                               # If #42 is epic, processes stories sequentially
/flo -t 123                           # Swarm + ticket only (no implementation)
/flo -h -t 123                        # Hive-mind + ticket only
/flo -n -r 123                        # Normal + research only
/flo --swarm --ticket 123             # Explicit swarm + ticket only
/flo -n 123                           # Normal + full workflow (still runs all tests)
```

## SWARM IS MANDATORY BY DEFAULT

Even if a task "looks simple", you MUST use swarm coordination unless
the user explicitly passes -n/--normal. "Simple" is a trap. Tasks have
hidden complexity. Swarm catches it.

THE ONLY WAY TO SKIP SWARM: User passes -n or --normal explicitly.

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
| **SWARM** (default) | Multi-agent via Task tool: researcher, coder, tester, reviewer |
| **HIVE-MIND** (-h) | Consensus-based coordination for architecture decisions |
| **NORMAL** (-n) | Single Claude, no agent spawning. Only when user explicitly requests. |

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

Or via MCP: `mcp__claude-flow__memory_search`

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

When given an issue number, `-t` enhances the existing ticket. When given a title (non-numeric argument), `-t` creates a new GitHub issue. Either way, the ticket MUST include all three of the following sections:

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
Use the project's existing test runner and patterns.

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

### Detecting Epics

An issue is an **epic** if:
1. It has the `epic` label, OR
2. Its body contains `## Stories` or `## Tasks` sections, OR
3. It has linked child issues (via `- [ ] #123` checklist format)

### Epic Processing Flow

1. DETECT EPIC - Check labels, parse body for ## Stories / ## Tasks, extract issue references
2. LIST ALL STORIES - Extract from checklist, order top-to-bottom as listed
3. SEQUENTIAL PROCESSING - For each story: run full /flo workflow, wait for PR, update checklist
4. COMPLETION - All stories have PRs, epic marked as ready-for-review

ONE STORY AT A TIME - NO PARALLEL STORY EXECUTION.
Each story must complete (PR created) before starting next.

### Epic Detection Code

```javascript
function isEpic(issue) {
  // Label-based detection (case-insensitive)
  const epicLabels = ['epic', 'tracking', 'parent', 'umbrella'];
  if (issue.labels?.some(l => epicLabels.includes(l.name.toLowerCase()))) return true;
  // Section-based detection
  if (issue.body?.includes('## Stories') || issue.body?.includes('## Tasks')) return true;
  // Checklist-linked issues: - [ ] #123 or - [x] #123
  if (/- \[[ x]\] #\d+/.test(issue.body)) return true;
  // Numbered issue references: 1. #123
  if (/\d+\.\s+#\d+/.test(issue.body)) return true;
  // GitHub sub-issues API
  if (issue.subIssues?.length > 0) return true;
  return false;
}

function extractStories(epicBody) {
  const stories = [];
  // Checklist format: - [ ] #123
  const checklistPattern = /- \[[ ]\] #(\d+)/g;
  let match;
  while ((match = checklistPattern.exec(epicBody)) !== null) {
    stories.push(parseInt(match[1]));
  }
  // Numbered format: 1. #123
  if (stories.length === 0) {
    const numberedPattern = /\d+\.\s+#(\d+)/g;
    while ((match = numberedPattern.exec(epicBody)) !== null) {
      stories.push(parseInt(match[1]));
    }
  }
  return stories;
}
```

## Parse Arguments

```javascript
const args = "$ARGUMENTS".trim().split(/\s+/);
let workflowMode = "full";    // full, ticket, research
let execMode = "swarm";       // swarm (default), hive, normal
let issueNumber = null;
let titleWords = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  // Workflow mode (what to do)
  if (arg === "-t" || arg === "--ticket") {
    workflowMode = "ticket";
  } else if (arg === "-r" || arg === "--research") {
    workflowMode = "research";
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
```

## Execution Flow

### Workflow Modes (what to do)

| Mode | Command | Steps | Stops After |
|------|---------|-------|-------------|
| **Full** (default) | `/flo 123` | Research -> Ticket -> Implement -> Test -> Simplify -> PR | PR created |
| **Epic** | `/flo 42` (epic) | For each story: Full workflow sequentially | All story PRs created |
| **Ticket** | `/flo -t 123` | Research -> Ticket | Issue updated |
| **Research** | `/flo -r 123` | Research | Findings output |

### Execution Modes (how to do it)

| Mode | Flag | Description | When to Use |
|------|------|-------------|-------------|
| **Swarm** (DEFAULT) | `-s`, `--swarm` | Multi-agent via Task tool | Always, unless explicitly overridden |
| **Hive-Mind** | `-h`, `--hive` | Consensus-based coordination | Architecture decisions, tradeoffs |
| **Normal** | `-n`, `--normal` | Single Claude, no agents | User explicitly wants simple mode |

## Execution Mode Details

### SWARM Mode (Default) - ALWAYS USE UNLESS TOLD OTHERWISE

You MUST use the Task tool to spawn agents. No exceptions.

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

### NORMAL Mode (-n, --normal)

**Only when user explicitly requests.** Single Claude execution without agents.
- Still uses Task tool for tracking
- Still creates tasks for visibility
- Just doesn't spawn multiple agents

---

**Full mode executes without prompts.** It will:
1. Research the issue and codebase
2. Enhance the GitHub issue with implementation plan
3. Assign issue to self, add "in-progress" label
4. Create branch, implement, test
5. Run /simplify on changed code, re-test if changes made
6. Commit, create PR, update issue status
7. Store learnings
