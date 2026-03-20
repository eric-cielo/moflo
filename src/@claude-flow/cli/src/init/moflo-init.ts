/**
 * MoFlo Project Initializer
 *
 * One-stop setup that makes MoFlo work out of the box:
 * 1. Generate moflo.yaml (project config)
 * 2. Set up .claude/settings.json hooks
 * 3. Create .claude/skills/flo/ skill (with /fl alias)
 * 4. Append MoFlo section to CLAUDE.md
 * 5. Initialize memory DB
 * 6. Auto-index guidance + code map
 */
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface MofloInitOptions {
  projectRoot: string;
  force?: boolean;
  skipIndex?: boolean;
  interactive?: boolean;
  minimal?: boolean;
}

export interface MofloInitAnswers {
  guidance: boolean;
  guidanceDirs: string[];
  codeMap: boolean;
  srcDirs: string[];
  gates: boolean;
  stopHook: boolean;
}

export interface MofloInitResult {
  steps: { name: string; status: 'created' | 'updated' | 'skipped' | 'error'; detail?: string }[];
}

// ============================================================================
// Init
// ============================================================================

/**
 * Run interactive wizard to collect user preferences.
 */
async function runWizard(root: string): Promise<MofloInitAnswers> {
  const { confirm, input } = await import('../prompt.js');

  // Detect project structure
  const guidanceCandidates = ['.claude/guidance', 'docs/guides', 'docs', 'architecture', 'adr', '.cursor/rules'];
  const detectedGuidance = guidanceCandidates.filter(d => fs.existsSync(path.join(root, d)));

  const srcCandidates = ['src', 'packages', 'lib', 'app', 'apps', 'services', 'server', 'client'];
  const detectedSrc = srcCandidates.filter(d => fs.existsSync(path.join(root, d)));

  // Ask questions
  const guidance = await confirm({
    message: detectedGuidance.length > 0
      ? `Found guidance docs in ${detectedGuidance.join(', ')}. Enable guidance indexing?`
      : 'Do you have project guidance/documentation to index?',
    default: true,
  });

  let guidanceDirs = detectedGuidance.length > 0 ? detectedGuidance : ['.claude/guidance'];
  if (guidance) {
    const answer = await input({
      message: 'Guidance directories (comma-separated):',
      default: guidanceDirs.join(', '),
    });
    guidanceDirs = answer.split(',').map((d: string) => d.trim()).filter(Boolean);
  }

  const codeMap = await confirm({
    message: detectedSrc.length > 0
      ? `Found source in ${detectedSrc.join(', ')}. Enable code map for navigation?`
      : 'Enable code map for codebase navigation?',
    default: true,
  });

  let srcDirs = detectedSrc.length > 0 ? detectedSrc : ['src'];
  if (codeMap) {
    const answer = await input({
      message: 'Source directories (comma-separated):',
      default: srcDirs.join(', '),
    });
    srcDirs = answer.split(',').map((d: string) => d.trim()).filter(Boolean);
  }

  const gates = await confirm({
    message: 'Enable workflow gates (memory-first, task-create-before-agents)?',
    default: true,
  });

  const stopHook = await confirm({
    message: 'Enable session-end hook (saves session state)?',
    default: true,
  });

  return { guidance, guidanceDirs, codeMap, srcDirs, gates, stopHook };
}

/**
 * Get default answers (--yes mode).
 */
function defaultAnswers(root: string): MofloInitAnswers {
  const guidanceCandidates = ['.claude/guidance', 'docs/guides', 'docs', 'architecture', 'adr', '.cursor/rules'];
  const guidanceDirs = guidanceCandidates.filter(d => fs.existsSync(path.join(root, d)));
  if (guidanceDirs.length === 0) guidanceDirs.push('.claude/guidance');

  const srcCandidates = ['src', 'packages', 'lib', 'app', 'apps', 'services', 'server', 'client'];
  const srcDirs = srcCandidates.filter(d => fs.existsSync(path.join(root, d)));
  if (srcDirs.length === 0) srcDirs.push('src');

  return { guidance: true, guidanceDirs, codeMap: true, srcDirs, gates: true, stopHook: true };
}

/**
 * Get minimal answers (--minimal mode).
 */
function minimalAnswers(): MofloInitAnswers {
  return { guidance: false, guidanceDirs: [], codeMap: false, srcDirs: [], gates: false, stopHook: false };
}

export async function initMoflo(options: MofloInitOptions): Promise<MofloInitResult> {
  const { projectRoot, force, interactive, minimal } = options;
  const steps: MofloInitResult['steps'] = [];

  // Collect answers based on mode
  const answers = minimal
    ? minimalAnswers()
    : interactive
      ? await runWizard(projectRoot)
      : defaultAnswers(projectRoot);

  // Step 1: moflo.yaml
  steps.push(generateConfig(projectRoot, force, answers));

  // Step 2: .claude/settings.json hooks
  steps.push(generateHooks(projectRoot, force, answers));

  // Step 3: .claude/skills/flo/ (with /fl alias)
  steps.push(generateSkill(projectRoot, force));

  // Step 4: CLAUDE.md MoFlo section
  steps.push(generateClaudeMd(projectRoot, force));

  // Step 5: .gitignore entries
  steps.push(updateGitignore(projectRoot));

  return { steps };
}

// ============================================================================
// Step 1: moflo.yaml
// ============================================================================

function generateConfig(root: string, force?: boolean, answers?: MofloInitAnswers): MofloInitResult['steps'][0] {
  const configPath = path.join(root, 'moflo.yaml');

  if (fs.existsSync(configPath) && !force) {
    return { name: 'moflo.yaml', status: 'skipped', detail: 'Already exists (use --force to overwrite)' };
  }

  const projectName = path.basename(root);
  const guidanceDirs = answers?.guidanceDirs ?? ['.claude/guidance'];
  const srcDirs = answers?.srcDirs ?? ['src'];
  const gatesEnabled = answers?.gates ?? true;

  // Detect languages
  const extensions = new Set<string>();
  for (const dir of srcDirs) {
    const fullDir = path.join(root, dir);
    if (fs.existsSync(fullDir)) {
      try {
        scanExtensions(fullDir, extensions, 0, 3);
      } catch { /* skip */ }
    }
  }
  const detectedExts = extensions.size > 0
    ? [...extensions].sort()
    : ['.ts', '.tsx', '.js', '.jsx'];

  const yaml = `# MoFlo — Project Configuration
# Generated by: moflo init
# Docs: https://github.com/eric-cielo/moflo

project:
  name: "${projectName}"

# Guidance/knowledge docs to index for semantic search
guidance:
  directories:
${guidanceDirs.map(d => `    - ${d}`).join('\n')}
  namespace: guidance

# Source directories for code navigation map
code_map:
  directories:
${srcDirs.map(d => `    - ${d}`).join('\n')}
  extensions: [${detectedExts.map(e => `"${e}"`).join(', ')}]
  exclude: [node_modules, dist, .next, coverage, build, __pycache__, target, .git]
  namespace: code-map

# Workflow gates (enforced via Claude Code hooks)
gates:
  memory_first: ${gatesEnabled}
  task_create_first: ${gatesEnabled}
  context_tracking: ${gatesEnabled}

# Auto-index on session start
auto_index:
  guidance: ${answers?.guidance ?? true}
  code_map: ${answers?.codeMap ?? true}

# Memory backend
memory:
  backend: sql.js
  embedding_model: Xenova/all-MiniLM-L6-v2
  namespace: default

# Hook toggles (all on by default — disable to slim down)
hooks:
  pre_edit: true               # Track file edits for learning
  post_edit: true              # Record edit outcomes, train neural patterns
  pre_task: true               # Get agent routing before task spawn
  post_task: true              # Record task results for learning
  gate: ${gatesEnabled}                   # Workflow gate enforcement (memory-first, task-create-first)
  route: true                  # Intelligent task routing on each prompt
  stop_hook: ${answers?.stopHook ?? true}              # Session-end persistence and metric export
  session_restore: true        # Restore session state on start
  notification: true           # Hook into Claude Code notifications

# Status line display (shown at bottom of Claude Code)
# mode: "single-line" (concise, default) or "dashboard" (full multi-line)
status_line:
  enabled: true
  mode: single-line
  branding: "MoFlo V4"
  show_git: true
  show_model: true
  show_session: true

# Model preferences (haiku, sonnet, opus)
models:
  default: opus        # Model for general tasks
  research: sonnet     # Model for research/exploration agents
  review: opus         # Model for code review agents
  test: sonnet         # Model for test-writing agents

# Intelligent model routing (auto-selects haiku/sonnet/opus per task)
# When enabled, overrides the static model preferences above
# by analyzing task complexity and routing to the cheapest capable model.
model_routing:
  enabled: false                   # Set to true to enable dynamic routing
  confidence_threshold: 0.85       # Min confidence before escalating to a more capable model
  cost_optimization: true          # Prefer cheaper models when confidence is high
  circuit_breaker: true            # Penalize models that fail repeatedly
  # Per-agent overrides (set to "inherit" to use routing, or a specific model to pin)
  # agent_overrides:
  #   security-architect: opus     # Always use opus for security
  #   researcher: sonnet           # Pin research to sonnet
`;

  fs.writeFileSync(configPath, yaml, 'utf-8');
  return { name: 'moflo.yaml', status: 'created', detail: `Detected: ${srcDirs.join(', ')} | ${detectedExts.join(', ')}` };
}

function scanExtensions(dir: string, extensions: Set<string>, depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.slice(0, 100)) {
    if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
      scanExtensions(path.join(dir, entry.name), extensions, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.cs'].includes(ext)) {
        extensions.add(ext);
      }
    }
  }
}

// ============================================================================
// Step 2: .claude/settings.json hooks
// ============================================================================

function generateHooks(root: string, force?: boolean, answers?: MofloInitAnswers): MofloInitResult['steps'][0] {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const settingsDir = path.dirname(settingsPath);

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  let existing: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }

    // Check if MoFlo hooks already set up
    const settingsStr = JSON.stringify(existing);
    const hasGateHooks = settingsStr.includes('flo gate') || settingsStr.includes('moflo gate');
    if (hasGateHooks && !force) {
      return { name: '.claude/settings.json', status: 'skipped', detail: 'MoFlo hooks already configured' };
    }
  }

  // Build hooks config — all on by default (opinionated pit-of-success)
  const hooks: Record<string, any[]> = {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks pre-edit",
          "timeout": 5000
        }]
      },
      {
        "matcher": "^(Glob|Grep)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate check-before-scan",
          "timeout": 3000
        }]
      },
      {
        "matcher": "^Read$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate check-before-read",
          "timeout": 3000
        }]
      },
      {
        "matcher": "^Task$",
        "hooks": [
          {
            "type": "command",
            "command": "npx flo gate check-before-agent",
            "timeout": 3000
          },
          {
            "type": "command",
            "command": "npx flo hooks pre-task",
            "timeout": 5000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks post-edit",
          "timeout": 5000
        }]
      },
      {
        "matcher": "^Task$",
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks post-task",
          "timeout": 5000
        }]
      },
      {
        "matcher": "^TaskCreate$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate record-task-created",
          "timeout": 2000
        }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate check-bash-memory",
          "timeout": 2000
        }]
      },
      {
        "matcher": "^mcp__claude-flow__memory_(search|retrieve)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate record-memory-searched",
          "timeout": 2000
        }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx flo gate prompt-reminder",
            "timeout": 2000
          },
          {
            "type": "command",
            "command": "npx flo hooks route",
            "timeout": 5000
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/scripts/session-start-launcher.mjs\"",
            "timeout": 3000
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks session-end",
          "timeout": 5000
        }]
      }
    ],
    "Notification": [
      {
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks notification",
          "timeout": 3000
        }]
      }
    ]
  };

  // Merge: preserve existing non-MoFlo hooks, add MoFlo hooks
  existing.hooks = hooks;

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
  return { name: '.claude/settings.json', status: existing.hooks ? 'updated' : 'created', detail: '14 hooks configured (gates, lifecycle, routing, session)' };
}

// ============================================================================
// Step 3: .claude/skills/flo/ skill (with /fl alias)
// ============================================================================

function generateSkill(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const skillDir = path.join(root, '.claude', 'skills', 'flo');
  const skillFile = path.join(skillDir, 'SKILL.md');
  const aliasDir = path.join(root, '.claude', 'skills', 'fl');
  const aliasFile = path.join(aliasDir, 'SKILL.md');

  if (fs.existsSync(skillFile) && !force) {
    return { name: '.claude/skills/flo/', status: 'skipped', detail: 'Already exists' };
  }

  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  const skillContent = `---
name: flo
description: MoFlo ticket workflow - analyze and execute GitHub issues
arguments: "[options] <issue-number>"
---

# /flo - MoFlo Ticket Workflow

Research, enhance, and execute GitHub issues automatically.

**Arguments:** $ARGUMENTS

## Usage

\`\`\`
/flo <issue-number>                   # Full workflow with SWARM (default)
/flo -e <issue-number>                # Enhance only: research and update ticket, then STOP
/flo --enhance <issue-number>         # Same as -e
/flo -r <issue-number>                # Research only: analyze issue, output findings
/flo --research <issue-number>        # Same as -r
\`\`\`

Also available as \`/fl\` (shorthand alias).

### Execution Mode (how work is done)

\`\`\`
/flo 123                              # SWARM mode (default) - multi-agent coordination
/flo -sw 123                          # SWARM mode (explicit)
/flo --swarm 123                      # Same as -sw
/flo -hv 123                          # HIVE-MIND mode - consensus-based coordination
/flo --hive 123                       # Same as -hv
/flo -n 123                           # NAKED mode - single Claude, no agents
/flo --naked 123                      # Same as -n
\`\`\`

### Epic Handling

\`\`\`
/flo 42                               # If #42 is an epic, processes all stories sequentially
\`\`\`

**Epic Detection:** Issues with \`epic\` label or containing \`## Stories\` / \`## Tasks\` sections are automatically detected as epics.

**Sequential Processing:** When an epic is selected:
1. List all child stories/tasks (from checklist or linked issues)
2. Process each story **one at a time** in order
3. Each story goes through the full workflow (research -> enhance -> implement -> test -> PR)
4. After each story's PR is created, move to the next story
5. Continue until all stories are complete

### Combined Examples

\`\`\`
/flo 123                              # Swarm + full workflow (default) - includes ALL tests
/flo 42                               # If #42 is epic, processes stories sequentially
/flo -e 123                           # Swarm + enhance only (no implementation)
/flo -hv -e 123                       # Hive-mind + enhance only
/flo -n -r 123                        # Naked + research only
/flo --swarm --enhance 123            # Explicit swarm + enhance only
/flo -n 123                           # Naked + full workflow (still runs all tests)
\`\`\`

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

\`\`\`
Research -> Enhance -> Execute -> Testing -> Simplify -> PR+Done

Research:    Fetch issue, search memory, read guidance, find files
Enhance:     Update GitHub issue with tech analysis, affected files, impl plan
Execute:     Assign self, create branch, implement changes
Testing:     Unit + Integration + E2E tests (ALL MUST PASS - gate)
Simplify:    Run /simplify on changed code (gate - must run before PR)
PR+Done:     Create PR, update issue status, store learnings
\`\`\`

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
\`\`\`bash
gh issue view <issue-number> --json number,title,body,labels,state,assignees,comments,milestone
\`\`\`

### 1.2 Check Enhancement Status
Look for \`## Implementation Plan\` marker in issue body.
- **If present**: Issue already enhanced, skip to execute or confirm
- **If absent**: Proceed with research and enhancement

### 1.3 Search Memory FIRST
ALWAYS search memory BEFORE reading guidance or docs files.
Memory has file paths, context, and patterns - often all you need.
Only read guidance files if memory search returns zero relevant results.

\`\`\`bash
npx flo memory search --query "<issue title keywords>" --namespace patterns
npx flo memory search --query "<domain keywords>" --namespace guidance
\`\`\`

Or via MCP: \`mcp__claude-flow__memory_search\`

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
\`\`\`bash
gh issue edit <issue-number> --body "<original body + Technical Analysis + Affected Files + Implementation Plan + Test Plan + Estimates>"
\`\`\`

### 2.3 Add Enhancement Comment
\`\`\`bash
gh issue comment <issue-number> --body "Issue enhanced with implementation plan. Ready for execution."
\`\`\`

## Phase 3: Execute (default, runs automatically after enhance)

### 3.1 Assign Issue and Update Status
\`\`\`bash
gh issue edit <issue-number> --add-assignee @me
gh issue edit <issue-number> --add-label "in-progress"
\`\`\`

### 3.2 Create Branch
\`\`\`bash
git checkout main && git pull origin main
git checkout -b <type>/<issue-number>-<short-desc>
\`\`\`
Types: \`feature/\`, \`fix/\`, \`refactor/\`, \`docs/\`

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
\`\`\`bash
git add <specific files>
git commit -m "type(scope): description

Closes #<issue-number>

Co-Authored-By: Claude <noreply@anthropic.com>"
\`\`\`

### 5.2 Create PR
\`\`\`bash
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
\`\`\`

### 5.3 Update Issue Status
\`\`\`bash
gh issue edit <issue-number> --remove-label "in-progress" --add-label "ready-for-review"
gh issue comment <issue-number> --body "PR created: <pr-url>"
\`\`\`

## Epic Handling

### Detecting Epics

An issue is an **epic** if:
1. It has the \`epic\` label, OR
2. Its body contains \`## Stories\` or \`## Tasks\` sections, OR
3. It has linked child issues (via \`- [ ] #123\` checklist format)

### Epic Processing Flow

1. DETECT EPIC - Check labels, parse body for ## Stories / ## Tasks, extract issue references
2. LIST ALL STORIES - Extract from checklist, order top-to-bottom as listed
3. SEQUENTIAL PROCESSING - For each story: run full /flo workflow, wait for PR, update checklist
4. COMPLETION - All stories have PRs, epic marked as ready-for-review

ONE STORY AT A TIME - NO PARALLEL STORY EXECUTION.
Each story must complete (PR created) before starting next.

### Epic Detection Code

\`\`\`javascript
function isEpic(issue) {
  if (issue.labels?.some(l => l.name === 'epic')) return true;
  if (issue.body?.includes('## Stories') || issue.body?.includes('## Tasks')) return true;
  const linkedIssuePattern = /- \\[[ x]\\] #\\d+/;
  if (linkedIssuePattern.test(issue.body)) return true;
  return false;
}

function extractStories(epicBody) {
  const stories = [];
  const pattern = /- \\[[ ]\\] #(\\d+)/g;
  let match;
  while ((match = pattern.exec(epicBody)) !== null) {
    stories.push(parseInt(match[1]));
  }
  return stories;
}
\`\`\`

## Parse Arguments

\`\`\`javascript
const args = "$ARGUMENTS".trim().split(/\\s+/);
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
  else if (/^\\d+$/.test(arg)) {
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
\`\`\`

## Execution Flow

### Workflow Modes (what to do)

| Mode | Command | Steps | Stops After |
|------|---------|-------|-------------|
| **Full** (default) | \`/flo 123\` | Research -> Enhance -> Implement -> Test -> Simplify -> PR | PR created |
| **Epic** | \`/flo 42\` (epic) | For each story: Full workflow sequentially | All story PRs created |
| **Enhance** | \`/flo -e 123\` | Research -> Enhance | Issue updated |
| **Research** | \`/flo -r 123\` | Research | Findings output |

### Execution Modes (how to do it)

| Mode | Flag | Description | When to Use |
|------|------|-------------|-------------|
| **Swarm** (DEFAULT) | \`-sw\`, \`--swarm\` | Multi-agent via Task tool | Always, unless explicitly overridden |
| **Hive-Mind** | \`-hv\`, \`--hive\` | Consensus-based coordination | Architecture decisions, tradeoffs |
| **Naked** | \`-n\`, \`--naked\` | Single Claude, no agents | User explicitly wants simple mode |

## Execution Mode Details

### SWARM Mode (Default) - ALWAYS USE UNLESS TOLD OTHERWISE

You MUST use the Task tool to spawn agents. No exceptions.

**Swarm spawns these agents via Task tool:**
- \`researcher\` - Analyzes issue, searches memory, finds patterns
- \`coder\` - Implements changes following plan
- \`tester\` - Writes and runs tests
- \`/simplify\` - Built-in command that reviews changed code before PR
- \`reviewer\` - Reviews code before PR

**Swarm execution pattern:**
\`\`\`javascript
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
\`\`\`

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
`;

  fs.writeFileSync(skillFile, skillContent, 'utf-8');

  // Create /fl alias (same content)
  if (!fs.existsSync(aliasDir)) {
    fs.mkdirSync(aliasDir, { recursive: true });
  }
  fs.writeFileSync(aliasFile, skillContent.replace('name: flo', 'name: fl'), 'utf-8');

  // Clean up old /mf skill directory if it exists
  const oldSkillDir = path.join(root, '.claude', 'skills', 'mf');
  if (fs.existsSync(oldSkillDir)) {
    fs.rmSync(oldSkillDir, { recursive: true });
  }

  return { name: '.claude/skills/flo/', status: 'created', detail: '/flo skill ready (alias: /fl)' };
}

// ============================================================================
// Step 4: CLAUDE.md MoFlo section
// ============================================================================

const MOFLO_MARKER = '<!-- MOFLO:START -->';
const MOFLO_MARKER_END = '<!-- MOFLO:END -->';

function generateClaudeMd(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  let existing = '';

  if (fs.existsSync(claudeMdPath)) {
    existing = fs.readFileSync(claudeMdPath, 'utf-8');

    // Check if MoFlo section already exists
    if (existing.includes(MOFLO_MARKER)) {
      if (!force) {
        return { name: 'CLAUDE.md', status: 'skipped', detail: 'MoFlo section already present' };
      }
      // Remove existing MoFlo section for replacement
      const startIdx = existing.indexOf(MOFLO_MARKER);
      const endIdx = existing.indexOf(MOFLO_MARKER_END);
      if (endIdx > startIdx) {
        existing = existing.substring(0, startIdx) + existing.substring(endIdx + MOFLO_MARKER_END.length);
      }
    }
  }

  const mofloSection = `
${MOFLO_MARKER}
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development workflows.

### FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call for every new user prompt MUST be a memory search. Do this BEFORE Glob, Grep, Read, or any file exploration.

\`\`\`
mcp__claude-flow__memory_search  — query: "<task description>", namespace: "guidance" or "patterns" or "code-map"
\`\`\`

For codebase navigation, search the \`code-map\` namespace first. For patterns and domain knowledge, search \`patterns\` and \`guidance\`.

### Workflow Gates (enforced automatically)

These are enforced by hooks — you cannot bypass them:
- **Memory-first**: Must search memory before Glob/Grep/Read on guidance files
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool
- **Context tracking**: Session tracked as FRESH → MODERATE → DEPLETED → CRITICAL

### /flo Skill — Issue Execution

Use \`/flo <issue-number>\` (or \`/fl\`) to execute GitHub issues through the full workflow:
Research → Enhance → Implement → Test → Simplify → PR

### MCP Tools Reference

| Tool | Purpose |
|------|---------|
| \`mcp__claude-flow__memory_search\` | Semantic search across indexed knowledge |
| \`mcp__claude-flow__memory_store\` | Store patterns and decisions |
| \`mcp__claude-flow__hooks_route\` | Route task to optimal agent type |
| \`mcp__claude-flow__hooks_pre-task\` | Record task start |
| \`mcp__claude-flow__hooks_post-task\` | Record task completion for learning |

### Agent Icon Mapping

| Icon | Agent Type | Use For |
|------|------------|---------|
| 🔍 | Explore | Research, codebase exploration |
| 📐 | Plan | Architecture, design |
| ⚙️ | General | General coding tasks |
| 🧪 | Test | Writing tests |
| 🔬 | Analyzer | Code review, analysis |
| 🔧 | Backend | API implementation |

### Non-Trivial Task Workflow

For any task beyond a single-line fix:
1. Search memory first (mandatory gate)
2. Create tasks with TaskCreate (mandatory gate)
3. Spawn agents in waves (Explore first, then Implement + Test)
4. Update task status as you go
5. Store learnings after completion
${MOFLO_MARKER_END}
`;

  const finalContent = existing.trimEnd() + '\n' + mofloSection;
  fs.writeFileSync(claudeMdPath, finalContent, 'utf-8');

  return {
    name: 'CLAUDE.md',
    status: existing ? 'updated' : 'created',
    detail: 'MoFlo workflow section appended',
  };
}

// ============================================================================
// Step 5: .gitignore
// ============================================================================

function updateGitignore(root: string): MofloInitResult['steps'][0] {
  const gitignorePath = path.join(root, '.gitignore');
  const entries = ['.claude-orc/', '.swarm/', '.moflo/'];

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, entries.join('\n') + '\n', 'utf-8');
    return { name: '.gitignore', status: 'created', detail: entries.join(', ') };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  const toAdd = entries.filter(e => !existing.includes(e));

  if (toAdd.length === 0) {
    return { name: '.gitignore', status: 'skipped', detail: 'Entries already present' };
  }

  fs.appendFileSync(gitignorePath, '\n# MoFlo state (gitignored)\n' + toAdd.join('\n') + '\n');
  return { name: '.gitignore', status: 'updated', detail: `Added: ${toAdd.join(', ')}` };
}
