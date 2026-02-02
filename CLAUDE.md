# Claude Code Configuration - Claude Flow V3

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS

- All operations MUST be concurrent/parallel in a single message
- Use Claude Code's Task tool for spawning agents, not just MCP

**Mandatory patterns:**
- ALWAYS batch ALL todos in ONE TodoWrite call (5-10+ minimum)
- ALWAYS spawn ALL agents in ONE message with full instructions via Task tool
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL terminal operations in ONE Bash message
- ALWAYS batch ALL memory store/retrieve operations in ONE message

---

## Automatic Swarm Orchestration

**When starting work on complex tasks, Claude Code MUST automatically:**

1. **Initialize the swarm** using MCP tools
2. **Spawn concurrent agents** using Claude Code's Task tool
3. **Coordinate via hooks** and memory

### CRITICAL: MCP + Task Tool in SAME Message

**When user says "spawn swarm" or requests complex work, Claude Code MUST in ONE message:**
1. Call MCP tools to initialize coordination
2. **IMMEDIATELY** call Task tool to spawn REAL working agents
3. Both MCP and Task calls must be in the SAME response

- Never use MCP tools alone for execution — Task tool agents do the actual work

### Intelligent 3-Tier Model Routing (ADR-026)

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster (WASM) | <1ms | $0 | Simple transforms (var→const, add types, etc.) — **Skip LLM entirely** |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, low complexity (<30%) |
| **3** | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning, architecture, security (>30%) |

**When you see these recommendations:**

1. `[AGENT_BOOSTER_AVAILABLE]` → Use the Edit tool directly for simple code transforms
   - Intent types: `var-to-const`, `add-types`, `add-error-handling`, `async-await`, `add-logging`, `remove-console`

2. `[TASK_MODEL_RECOMMENDATION] Use model="X"` → Use that model in Task tool:
```javascript
Task({
  prompt: "...",
  subagent_type: "coder",
  model: "opus"  // ← USE THE RECOMMENDED MODEL
})
```

**Model Selection Logic:**
| Complexity | Model | Use For |
|------------|-------|---------|
| Agent Booster intent detected | **Skip LLM** | var→const, add-types, remove-console (352x faster) |
| High (architecture, system design, security) | **opus** | Complex reasoning, multi-step planning |
| Medium (features, refactoring, debugging) | **sonnet** | Balanced capability and speed |
| Low (formatting, simple fixes, docs) | **haiku** | Fast, cost-effective tasks |

- Always check for `[AGENT_BOOSTER_AVAILABLE]` or `[TASK_MODEL_RECOMMENDATION]` before spawning agents

### Anti-Drift Coding Swarm (PREFERRED DEFAULT)

- ALWAYS use this configuration for coding swarms:

```javascript
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",  // Single coordinator enforces alignment
  maxAgents: 8,              // Smaller team = less drift surface
  strategy: "specialized"    // Clear roles reduce ambiguity
})
```

| Choice | Anti-Drift Benefit |
|--------|-------------------|
| **hierarchical** | Coordinator validates each output against goal, catches divergence early |
| **maxAgents: 6-8** | Fewer agents = less coordination overhead, easier alignment |
| **specialized** | Clear boundaries — each agent knows exactly what to do, no overlap |

- Use `raft` consensus for hive-mind (leader maintains authoritative state)

**Additional anti-drift measures:**
- Run frequent checkpoints via `post-task` hooks
- Keep shared memory namespace for all agents
- Keep task cycles short with verification gates

### Auto-Start Swarm Protocol

When the user requests a complex task (multi-file changes, feature implementation, refactoring), **immediately execute this pattern in a SINGLE message:**

```javascript
// STEP 1: Initialize swarm coordination via MCP (in parallel with agent spawning)
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})

// STEP 2: Spawn agents concurrently using Claude Code's Task tool
// ALL Task calls MUST be in the SAME message for parallel execution
Task("Coordinator", "You are the swarm coordinator. Initialize session, coordinate other agents via memory. Run: npx claude-flow@v3alpha hooks session-start", "hierarchical-coordinator")
Task("Researcher", "Analyze requirements and existing code patterns. Store findings in memory via hooks.", "researcher")
Task("Architect", "Design implementation approach based on research. Document decisions in memory.", "system-architect")
Task("Coder", "Implement the solution following architect's design. Coordinate via hooks.", "coder")
Task("Tester", "Write tests for the implementation. Report coverage via hooks.", "tester")
Task("Reviewer", "Review code quality and security. Document findings.", "reviewer")

// STEP 3: Batch all todos
TodoWrite({ todos: [
  {content: "Initialize swarm coordination", status: "in_progress", activeForm: "Initializing swarm"},
  {content: "Research and analyze requirements", status: "in_progress", activeForm: "Researching requirements"},
  {content: "Design architecture", status: "pending", activeForm: "Designing architecture"},
  {content: "Implement solution", status: "pending", activeForm: "Implementing solution"},
  {content: "Write tests", status: "pending", activeForm: "Writing tests"},
  {content: "Review and finalize", status: "pending", activeForm: "Reviewing code"}
]})

// STEP 4: Store swarm state in memory
mcp__claude-flow__memory_usage({
  action: "store",
  namespace: "swarm",
  key: "current-session",
  value: JSON.stringify({task: "[user's task]", agents: 6, startedAt: new Date().toISOString()})
})
```

### Agent Routing (Anti-Drift)

| Code | Task | Agents |
|------|------|--------|
| 1 | Bug Fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, architect, coder, reviewer |
| 7 | Performance | coordinator, perf-engineer, coder |
| 9 | Security | coordinator, security-architect, auditor |
| 11 | Memory | coordinator, memory-specialist, perf-engineer |
| 13 | Docs | researcher, api-docs |

**Codes 1-11: hierarchical/specialized (anti-drift). Code 13: mesh/balanced**

### Task Complexity Detection

**AUTO-INVOKE SWARM when task involves:**
- Multiple files (3+)
- New feature implementation
- Refactoring across modules
- API changes with tests
- Security-related changes
- Performance optimization
- Database schema changes

**SKIP SWARM for:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes
- Quick questions/exploration

## Project Configuration

This project is configured with Claude Flow V3 (Anti-Drift Defaults):
- **Topology**: hierarchical (prevents drift via central coordination)
- **Max Agents**: 8 (smaller team = less drift)
- **Strategy**: specialized (clear roles, no overlap)
- **Consensus**: raft (leader maintains authoritative state)
- **Memory Backend**: hybrid (SQLite + AgentDB)
- **HNSW Indexing**: Enabled (150x-12,500x faster)
- **Neural Learning**: Enabled (SONA)

## V3 CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization with wizard, presets, skills, hooks |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 11 | AgentDB memory with vector search (150x-12,500x faster) |
| `mcp` | 9 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 7 | Session state management and persistence |
| `config` | 7 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `start` | 3 | Service startup and quick launch |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 17 | Self-learning hooks + 12 background workers |
| `hive-mind` | 6 | Queen-led Byzantine fault-tolerant consensus |

### Advanced Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `daemon` | 5 | Background worker daemon (start, stop, status, trigger, enable) |
| `neural` | 5 | Neural pattern training (train, status, patterns, predict, optimize) |
| `security` | 6 | Security scanning (scan, audit, cve, threats, validate, report) |
| `performance` | 5 | Performance profiling (benchmark, profile, metrics, optimize, report) |
| `providers` | 5 | AI providers (list, add, remove, test, configure) |
| `plugins` | 5 | Plugin management (list, install, uninstall, enable, disable) |
| `deployment` | 5 | Deployment management (deploy, rollback, status, environments, release) |
| `embeddings` | 4 | Vector embeddings (embed, batch, search, init) - 75x faster with agentic-flow |
| `claims` | 4 | Claims-based authorization (check, grant, revoke, list) |
| `migrate` | 5 | V2 to V3 migration with rollback support |
| `process` | 4 | Background process management |
| `doctor` | 1 | System diagnostics with health checks |
| `completions` | 4 | Shell completions (bash, zsh, fish, powershell) |

### Quick CLI Examples

```bash
# Initialize project
npx claude-flow@v3alpha init --wizard

# Start daemon with background workers
npx claude-flow@v3alpha daemon start

# Spawn an agent
npx claude-flow@v3alpha agent spawn -t coder --name my-coder

# Initialize swarm
npx claude-flow@v3alpha swarm init --v3-mode

# Search memory (HNSW-indexed)
npx claude-flow@v3alpha memory search -q "authentication patterns"

# System diagnostics
npx claude-flow@v3alpha doctor --fix

# Security scan
npx claude-flow@v3alpha security scan --depth full

# Performance benchmark
npx claude-flow@v3alpha performance benchmark --suite all
```

## Headless Background Instances (claude -p)

Use `claude -p` (print/pipe mode) to spawn headless Claude instances for parallel background work. These run non-interactively and return results to stdout.

### Basic Usage

```bash
# Single headless task
claude -p "Analyze the authentication module for security issues"

# With model selection
claude -p --model haiku "Format this config file"
claude -p --model opus "Design the database schema for user management"

# With output format
claude -p --output-format json "List all TODO comments in src/"
claude -p --output-format stream-json "Refactor the error handling in api.ts"

# With budget limits
claude -p --max-budget-usd 0.50 "Run comprehensive security audit"

# With specific tools allowed
claude -p --allowedTools "Read,Grep,Glob" "Find all files that import the auth module"

# Skip permissions (sandboxed environments only)
claude -p --dangerously-skip-permissions "Fix all lint errors in src/"
```

### Parallel Background Execution

```bash
# Spawn multiple headless instances in parallel
claude -p "Analyze src/auth/ for vulnerabilities" &
claude -p "Write tests for src/api/endpoints.ts" &
claude -p "Review src/models/ for performance issues" &
wait  # Wait for all to complete

# With results captured
SECURITY=$(claude -p "Security audit of auth module" &)
TESTS=$(claude -p "Generate test coverage report" &)
PERF=$(claude -p "Profile memory usage in workers" &)
wait
echo "$SECURITY" "$TESTS" "$PERF"
```

### Session Continuation

```bash
# Start a task, resume later
claude -p --session-id "abc-123" "Start analyzing the codebase"
claude -p --resume "abc-123" "Continue with the test files"

# Fork a session for parallel exploration
claude -p --resume "abc-123" --fork-session "Try approach A: event sourcing"
claude -p --resume "abc-123" --fork-session "Try approach B: CQRS pattern"
```

### Key Flags

| Flag | Purpose |
|------|---------|
| `-p, --print` | Non-interactive mode, print and exit |
| `--model <model>` | Select model (haiku, sonnet, opus) |
| `--output-format <fmt>` | Output: text, json, stream-json |
| `--max-budget-usd <amt>` | Spending cap per invocation |
| `--allowedTools <tools>` | Restrict available tools |
| `--append-system-prompt` | Add custom instructions |
| `--resume <id>` | Continue a previous session |
| `--fork-session` | Branch from resumed session |
| `--fallback-model <model>` | Auto-fallback if primary overloaded |
| `--permission-mode <mode>` | acceptEdits, bypassPermissions, plan, etc. |
| `--mcp-config <json>` | Load MCP servers from JSON |

## Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### V3 Specialized Agents
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### @claude-flow/security Module
CVE remediation, input validation, path security:
- `InputValidator` — Zod-based validation at boundaries
- `PathValidator` — Path traversal prevention
- `SafeExecutor` — Command injection protection
- `PasswordHasher` — bcrypt hashing
- `TokenGenerator` — Secure token generation

### Token Optimizer (Agent Booster)
Integrates agentic-flow optimizations for 30-50% token reduction:
```typescript
import { getTokenOptimizer } from '@claude-flow/integration';
const optimizer = await getTokenOptimizer();

// Compact context (32% fewer tokens)
const ctx = await optimizer.getCompactContext("auth patterns");

// 352x faster edits = fewer retries
await optimizer.optimizedEdit(file, old, new, "typescript");

// Optimal config (100% success rate)
const config = optimizer.getOptimalConfig(agentCount);
```
| Feature | Token Savings |
|---------|---------------|
| ReasoningBank retrieval | -32% |
| Agent Booster edits | -15% |
| Cache (95% hit rate) | -10% |
| Optimal batch size | -20% |

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

### Consensus & Distributed
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

### Performance & Optimization
`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

### GitHub & Repository
`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

### Specialized Development
`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

### Testing & Validation
`tdd-london-swarm`, `production-validator`

## V3 Hooks System (17 Hooks + 12 Workers)

### Hook Categories

| Category | Hooks | Purpose |
|----------|-------|---------|
| **Core** | `pre-edit`, `post-edit`, `pre-command`, `post-command`, `pre-task`, `post-task` | Tool lifecycle |
| **Session** | `session-start`, `session-end`, `session-restore`, `notify` | Context management |
| **Intelligence** | `route`, `explain`, `pretrain`, `build-agents`, `transfer` | Neural learning |
| **Learning** | `intelligence` (trajectory-start/step/end, pattern-store/search, stats, attention) | Reinforcement |

### 12 Background Workers

| Worker | Priority | Description |
|--------|----------|-------------|
| `ultralearn` | normal | Deep knowledge acquisition |
| `optimize` | high | Performance optimization |
| `consolidate` | low | Memory consolidation |
| `predict` | normal | Predictive preloading |
| `audit` | critical | Security analysis |
| `map` | normal | Codebase mapping |
| `preload` | low | Resource preloading |
| `deepdive` | normal | Deep code analysis |
| `document` | normal | Auto-documentation |
| `refactor` | normal | Refactoring suggestions |
| `benchmark` | normal | Performance benchmarking |
| `testgaps` | normal | Test coverage analysis |

### Essential Hook Commands

```bash
# Core hooks
npx claude-flow@v3alpha hooks pre-task --description "[task]"
npx claude-flow@v3alpha hooks post-task --task-id "[id]" --success true
npx claude-flow@v3alpha hooks post-edit --file "[file]" --train-patterns

# Session management
npx claude-flow@v3alpha hooks session-start --session-id "[id]"
npx claude-flow@v3alpha hooks session-end --export-metrics true
npx claude-flow@v3alpha hooks session-restore --session-id "[id]"

# Intelligence routing
npx claude-flow@v3alpha hooks route --task "[task]"
npx claude-flow@v3alpha hooks explain --topic "[topic]"

# Neural learning
npx claude-flow@v3alpha hooks pretrain --model-type moe --epochs 10
npx claude-flow@v3alpha hooks build-agents --agent-types coder,tester

# Background workers
npx claude-flow@v3alpha hooks worker list
npx claude-flow@v3alpha hooks worker dispatch --trigger audit
npx claude-flow@v3alpha hooks worker status
```

## Intelligence System (RuVector)

V3 includes the RuVector Intelligence System:
- **SONA**: Self-Optimizing Neural Architecture (<0.05ms adaptation)
- **MoE**: Mixture of Experts for specialized routing
- **HNSW**: 150x-12,500x faster pattern search
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: 2.49x-7.47x speedup

The 4-step intelligence pipeline:
1. **RETRIEVE** — Fetch relevant patterns via HNSW
2. **JUDGE** — Evaluate with verdicts (success/failure)
3. **DISTILL** — Extract key learnings via LoRA
4. **CONSOLIDATE** — Prevent catastrophic forgetting via EWC++

## Embeddings Package (v3.0.0-alpha.12)

Features:
- **sql.js**: Cross-platform SQLite persistent cache (WASM, no native compilation)
- **Document chunking**: Configurable overlap and size
- **Normalization**: L2, L1, min-max, z-score
- **Hyperbolic embeddings**: Poincare ball model for hierarchical data
- **75x faster**: With agentic-flow ONNX integration
- **Neural substrate**: Integration with RuVector

## Hive-Mind Consensus

### Topologies
- `hierarchical` — Queen controls workers directly
- `mesh` — Fully connected peer network
- `hierarchical-mesh` — Hybrid (recommended)
- `adaptive` — Dynamic based on load

### Consensus Strategies
- `byzantine` — BFT (tolerates f < n/3 faulty)
- `raft` — Leader-based (tolerates f < n/2)
- `gossip` — Epidemic for eventual consistency
- `crdt` — Conflict-free replicated data types
- `quorum` — Configurable quorum-based

## V3 Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| HNSW Search | 150x-12,500x faster | **Implemented** (persistent) |
| Memory Reduction | 50-75% with quantization | **Implemented** (3.92x Int8) |
| SONA Integration | Pattern learning | **Implemented** (ReasoningBank) |
| Flash Attention | 2.49x-7.47x speedup | In progress |
| MCP Response | <100ms | Achieved |
| CLI Startup | <500ms | Achieved |
| SONA Adaptation | <0.05ms | In progress |

## Environment Variables

```bash
# Configuration
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_LOG_LEVEL=info

# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# MCP Server
CLAUDE_FLOW_MCP_PORT=3000
CLAUDE_FLOW_MCP_HOST=localhost
CLAUDE_FLOW_MCP_TRANSPORT=stdio

# Memory
CLAUDE_FLOW_MEMORY_BACKEND=hybrid
CLAUDE_FLOW_MEMORY_PATH=./data/memory
```

## Doctor Health Checks

Run `npx claude-flow@v3alpha doctor` to check:
- Node.js version (20+)
- npm version (9+)
- Git installation
- Config file validity
- Daemon status
- Memory database
- API keys
- MCP servers
- Disk space
- TypeScript installation

## Quick Setup

```bash
# Add MCP servers
claude mcp add claude-flow npx claude-flow@v3alpha mcp start
claude mcp add ruv-swarm npx ruv-swarm mcp start  # Optional
claude mcp add flow-nexus npx flow-nexus@latest mcp start  # Optional

# Start daemon
npx claude-flow@v3alpha daemon start

# Run doctor
npx claude-flow@v3alpha doctor --fix
```

## Claude Code vs MCP Tools

### Claude Code Handles ALL EXECUTION:
- **Task tool**: Spawn and run agents concurrently
- File operations (Read, Write, Edit, MultiEdit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- TodoWrite and task management
- Git operations

### MCP Tools ONLY COORDINATE:
- Swarm initialization (topology setup)
- Agent type definitions
- Task orchestration
- Memory management
- Neural features
- Performance tracking

**KEY**: MCP coordinates the strategy, Claude Code's Task tool executes with real agents.

## Publishing to npm

### CRITICAL: ALWAYS PUBLISH BOTH PACKAGES + UPDATE ALL TAGS

**When publishing CLI changes, you MUST:**
1. Publish `@claude-flow/cli`
2. Publish `claude-flow` (umbrella)
3. Update ALL dist-tags for BOTH packages

```bash
# STEP 1: Build and publish CLI
cd v3/@claude-flow/cli
npm version 3.0.0-alpha.XXX --no-git-tag-version
npm run build
npm publish --tag alpha
npm dist-tag add @claude-flow/cli@3.0.0-alpha.XXX latest

# STEP 2: Publish umbrella
cd /workspaces/claude-flow
npm version 3.0.0-alpha.YYY --no-git-tag-version
npm publish --tag v3alpha

# STEP 3: Update ALL umbrella tags (CRITICAL - DON'T SKIP!)
npm dist-tag add claude-flow@3.0.0-alpha.YYY latest
npm dist-tag add claude-flow@3.0.0-alpha.YYY alpha
```

**Verification (MUST DO before telling user):**
```bash
npm view @claude-flow/cli dist-tags --json
npm view claude-flow dist-tags --json
# BOTH packages need: alpha AND latest pointing to newest version
```

### All Tags That Must Be Updated
| Package | Tag | Command Users Run |
|---------|-----|-------------------|
| `@claude-flow/cli` | `alpha` | `npx @claude-flow/cli@alpha` |
| `@claude-flow/cli` | `latest` | `npx @claude-flow/cli@latest` |
| `claude-flow` | `alpha` | `npx claude-flow@alpha` — EASY TO FORGET |
| `claude-flow` | `latest` | `npx claude-flow@latest` |
| `claude-flow` | `v3alpha` | `npx claude-flow@v3alpha` |

**The umbrella `alpha` tag is MOST commonly forgotten — users run `npx claude-flow@alpha`!**

## Plugin Registry Maintenance (IPFS/Pinata)

The plugin registry is stored on IPFS via Pinata for decentralized, immutable distribution.

### Registry Location
- **Current CID**: Stored in `v3/@claude-flow/cli/src/plugins/store/discovery.ts`
- **Gateway**: `https://gateway.pinata.cloud/ipfs/{CID}`
- **Format**: JSON with plugin metadata, categories, featured/trending lists

### Required Environment Variables
Add to `.env` (NEVER commit actual values):
```bash
PINATA_API_KEY=your-api-key
PINATA_API_SECRET=your-api-secret
PINATA_API_JWT=your-jwt-token
```

### Adding a New Plugin to Registry

1. **Fetch current registry**:
```bash
curl -s "https://gateway.pinata.cloud/ipfs/$(grep LIVE_REGISTRY_CID v3/@claude-flow/cli/src/plugins/store/discovery.ts | cut -d"'" -f2)" > /tmp/registry.json
```

2. **Add plugin entry** to the `plugins` array:
```json
{
  "id": "@claude-flow/your-plugin",
  "name": "@claude-flow/your-plugin",
  "displayName": "Your Plugin",
  "description": "Plugin description",
  "version": "1.0.0-alpha.1",
  "size": 100000,
  "checksum": "sha256:abc123",
  "author": {"id": "claude-flow-team", "displayName": "Claude Flow Team", "verified": true},
  "license": "MIT",
  "categories": ["official"],
  "tags": ["your", "tags"],
  "downloads": 0,
  "rating": 5,
  "lastUpdated": "2026-01-25T00:00:00.000Z",
  "minClaudeFlowVersion": "3.0.0",
  "type": "integration",
  "hooks": [],
  "commands": [],
  "permissions": ["memory"],
  "exports": ["YourExport"],
  "verified": true,
  "trustLevel": "official"
}
```

3. **Update counts and arrays**:
   - Increment `totalPlugins`
   - Add to `official` array
   - Add to `featured`/`newest` if applicable
   - Update category `pluginCount`

4. **Upload to Pinata** (read credentials from .env):
```bash
# Source credentials from .env
PINATA_JWT=$(grep "^PINATA_API_JWT=" .env | cut -d'=' -f2-)

# Upload updated registry
curl -X POST "https://api.pinata.cloud/pinning/pinJSONToIPFS" \
  -H "Authorization: Bearer $PINATA_JWT" \
  -H "Content-Type: application/json" \
  -d @/tmp/registry.json
```

5. **Update discovery.ts** with new CID:
```typescript
export const LIVE_REGISTRY_CID = 'NEW_CID_FROM_PINATA';
```

6. **Also update demo registry** in discovery.ts `demoPluginRegistry` for offline fallback

### Security Rules
- NEVER hardcode API keys in scripts or source files
- NEVER commit .env (already in .gitignore)
- Always source credentials from environment at runtime
- Always delete temporary scripts after one-time uploads

### Verification
```bash
# Verify new registry is accessible
curl -s "https://gateway.pinata.cloud/ipfs/{NEW_CID}" | jq '.totalPlugins'
```

## Optional Plugins (20 Available)

Plugins are distributed via IPFS and can be installed with the CLI. Browse and install from the official registry:

```bash
# List all available plugins
npx claude-flow@v3alpha plugins list

# Install a plugin
npx claude-flow@v3alpha plugins install @claude-flow/plugin-name

# Enable/disable
npx claude-flow@v3alpha plugins enable @claude-flow/plugin-name
npx claude-flow@v3alpha plugins disable @claude-flow/plugin-name
```

### Core Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| `@claude-flow/embeddings` | 3.0.0-alpha.1 | Vector embeddings with sql.js, HNSW, hyperbolic support |
| `@claude-flow/security` | 3.0.0-alpha.1 | Input validation, path security, CVE remediation |
| `@claude-flow/claims` | 3.0.0-alpha.8 | Claims-based authorization (check, grant, revoke, list) |
| `@claude-flow/neural` | 3.0.0-alpha.7 | Neural pattern training (SONA, MoE, EWC++) |
| `@claude-flow/plugins` | 3.0.0-alpha.1 | Plugin system core (manager, discovery, store) |
| `@claude-flow/performance` | 3.0.0-alpha.1 | Performance profiling and benchmarking |

### Integration Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| `@claude-flow/plugin-agentic-qe` | 3.0.0-alpha.4 | Agentic quality engineering integration |
| `@claude-flow/plugin-prime-radiant` | 0.1.5 | Prime Radiant intelligence integration |
| `@claude-flow/plugin-gastown-bridge` | 3.0.0-alpha.1 | Gastown bridge protocol integration |
| `@claude-flow/teammate-plugin` | 1.0.0-alpha.1 | Multi-agent teammate coordination |
| `@claude-flow/plugin-code-intelligence` | 0.1.0 | Advanced code analysis and intelligence |
| `@claude-flow/plugin-test-intelligence` | 0.1.0 | Intelligent test generation and gap analysis |
| `@claude-flow/plugin-perf-optimizer` | 0.1.0 | Performance optimization automation |
| `@claude-flow/plugin-neural-coordinator` | 0.1.0 | Neural network coordination across agents |
| `@claude-flow/plugin-cognitive-kernel` | 0.1.0 | Core cognitive processing kernel |
| `@claude-flow/plugin-quantum-optimizer` | 0.1.0 | Quantum-inspired optimization algorithms |
| `@claude-flow/plugin-hyperbolic-reasoning` | 0.1.0 | Hyperbolic space reasoning for hierarchical data |

### Domain-Specific Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| `@claude-flow/plugin-healthcare-clinical` | 0.1.0 | Healthcare clinical workflow automation |
| `@claude-flow/plugin-financial-risk` | 0.1.0 | Financial risk assessment and modeling |
| `@claude-flow/plugin-legal-contracts` | 0.1.0 | Legal contract analysis and generation |

### Plugin Development

```bash
# Create a new plugin from template
npx claude-flow@v3alpha plugins create my-plugin

# Test locally
npx claude-flow@v3alpha plugins install ./path/to/my-plugin

# Publish to registry (requires Pinata credentials)
npx claude-flow@v3alpha plugins publish
```

Registry source: IPFS via Pinata (`QmXbfEAaR7D2Ujm4GAkbwcGZQMHqAMpwDoje4583uNP834`)

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues

---

Remember: **Claude Flow coordinates, Claude Code creates!**
