---
name: flo
description: MoFlo ticket workflow - analyze and execute GitHub issues
arguments: "[options] <issue-number>"
---

# /flo - MoFlo Ticket Workflow

Research, enhance, and execute GitHub issues automatically.

**Arguments:** $ARGUMENTS

## Usage

```
/flo <issue-number>                   # Full workflow with SWARM (default)
/flo -e <issue-number>                # Enhance only: research and update ticket, then STOP
/flo --enhance <issue-number>         # Same as -e
/flo -r <issue-number>                # Research only: analyze issue, output findings
/flo --research <issue-number>        # Same as -r
```

Also available as `/fl` (shorthand alias).

### Execution Mode (how work is done)

```
/flo 123                              # SWARM mode (default) - multi-agent coordination
/flo -sw 123                          # SWARM mode (explicit)
/flo --swarm 123                      # Same as -sw
/flo -hv 123                          # HIVE-MIND mode - consensus-based coordination
/flo --hive 123                       # Same as -hv
/flo -n 123                           # NAKED mode - single Claude, no agents
/flo --naked 123                      # Same as -n
```

### Epic Handling

```
/flo 42                               # If #42 is an epic, processes all stories sequentially
```

**Epic Detection:** Issues with `epic` label or containing `## Stories` / `## Tasks` sections are automatically detected as epics.

**Sequential Processing:** When an epic is selected:
1. List all child stories/tasks (from checklist or linked issues)
2. Process each story **one at a time** in order
3. Each story goes through the full workflow (research -> enhance -> implement -> test -> PR)
4. After each story's PR is created, move to the next story
5. Continue until all stories are complete

### Combined Examples

```
/flo 123                              # Swarm + full workflow (default) - includes ALL tests
/flo 42                               # If #42 is epic, processes stories sequentially
/flo -e 123                           # Swarm + enhance only (no implementation)
/flo -hv -e 123                       # Hive-mind + enhance only
/flo -n -r 123                        # Naked + research only
/flo --swarm --enhance 123            # Explicit swarm + enhance only
/flo -n 123                           # Naked + full workflow (still runs all tests)
```

## SWARM IS MANDATORY BY DEFAULT

Even if a task "looks simple", you MUST use swarm coordination unless
the user explicitly passes -n/--naked. "Simple" is a trap. Tasks have
hidden complexity. Swarm catches it.

THE ONLY WAY TO SKIP SWARM: User passes -n or --naked explicitly.

## COMPREHENSIVE TESTING REQUIREMENT

ALL tests MUST pass BEFORE PR creation - NO EXCEPTIONS.
- Unit Tests: MANDATORY for all new/modified code
- Integration Tests: MANDATORY for API endpoints and services
- E2E Tests: MANDATORY for user-facing features
PR CANNOT BE CREATED until all relevant tests pass.

## Workflow Overview

```
Research -> Enhance -> Execute -> Testing -> Simplify -> PR+Done

Research:    Fetch issue, search memory, read guidance, find files
Enhance:     Update GitHub issue with tech analysis, affected files, impl plan
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
| **HIVE-MIND** (-hv) | Consensus-based coordination for architecture decisions |
| **NAKED** (-n) | Single Claude, no agent spawning. Only when user explicitly requests. |

## Phase 1: Research (-r or default first step)

### 1.1 Fetch Issue Details
```bash
gh issue view <issue-number> --json number,title,body,labels,state,assignees,comments,milestone
```

### 1.2 Check Enhancement Status
Look for `## Implementation Plan` marker in issue body.
- **If present**: Issue already enhanced, skip to execute or confirm
- **If absent**: Proceed with research and enhancement

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

## Phase 2: Enhance (-e includes research + enhancement)

### 2.1 Build Enhancement
Compile research into structured enhancement:

**Technical Analysis** - Root cause (bugs) or approach (features), impact, risk factors

**Affected Files** - Files to modify (with line numbers), new files, deletions

**Implementation Plan** - Numbered steps with clear actions, dependencies, decision points

**Test Plan** - Unit tests to add/update, integration tests needed, manual testing checklist

**Estimates** - Complexity (Low/Medium/High), scope (# files, # new tests)

### 2.2 Update GitHub Issue
```bash
gh issue edit <issue-number> --body "<original body + Technical Analysis + Affected Files + Implementation Plan + Test Plan + Estimates>"
```

### 2.3 Add Enhancement Comment
```bash
gh issue comment <issue-number> --body "Issue enhanced with implementation plan. Ready for execution."
```

## Phase 3: Execute (default, runs automatically after enhance)

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
Follow the implementation plan from the enhanced issue. No prompts - execute all steps.

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
  if (issue.labels?.some(l => l.name === 'epic')) return true;
  if (issue.body?.includes('## Stories') || issue.body?.includes('## Tasks')) return true;
  const linkedIssuePattern = /- \[[ x]\] #\d+/;
  if (linkedIssuePattern.test(issue.body)) return true;
  return false;
}

function extractStories(epicBody) {
  const stories = [];
  const pattern = /- \[[ ]\] #(\d+)/g;
  let match;
  while ((match = pattern.exec(epicBody)) !== null) {
    stories.push(parseInt(match[1]));
  }
  return stories;
}
```

## Parse Arguments

```javascript
const args = "$ARGUMENTS".trim().split(/\s+/);
let workflowMode = "full";    // full, enhance, research
let execMode = "swarm";       // swarm (default), hive, naked
let issueNumber = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  // Workflow mode (what to do)
  if (arg === "-e" || arg === "--enhance") {
    workflowMode = "enhance";
  } else if (arg === "-r" || arg === "--research") {
    workflowMode = "research";
  }

  // Execution mode (how to do it)
  else if (arg === "-sw" || arg === "--swarm") {
    execMode = "swarm";
  } else if (arg === "-hv" || arg === "--hive") {
    execMode = "hive";
  } else if (arg === "-n" || arg === "--naked") {
    execMode = "naked";
  }

  // Issue number
  else if (/^\d+$/.test(arg)) {
    issueNumber = arg;
  }
}

if (!issueNumber) {
  throw new Error("Issue number required. Usage: /flo <issue-number>");
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
| **Full** (default) | `/flo 123` | Research -> Enhance -> Implement -> Test -> Simplify -> PR | PR created |
| **Epic** | `/flo 42` (epic) | For each story: Full workflow sequentially | All story PRs created |
| **Enhance** | `/flo -e 123` | Research -> Enhance | Issue updated |
| **Research** | `/flo -r 123` | Research | Findings output |

### Execution Modes (how to do it)

| Mode | Flag | Description | When to Use |
|------|------|-------------|-------------|
| **Swarm** (DEFAULT) | `-sw`, `--swarm` | Multi-agent via Task tool | Always, unless explicitly overridden |
| **Hive-Mind** | `-hv`, `--hive` | Consensus-based coordination | Architecture decisions, tradeoffs |
| **Naked** | `-n`, `--naked` | Single Claude, no agents | User explicitly wants simple mode |

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

### HIVE-MIND Mode (-hv, --hive)

Use for consensus-based decisions:
- Architecture choices
- Approach tradeoffs
- Design decisions with multiple valid options

### NAKED Mode (-n, --naked)

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
