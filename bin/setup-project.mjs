#!/usr/bin/env node
/**
 * MoFlo Project Setup
 *
 * Copies the agent-bootstrap guidance into the consuming project and
 * adds a CLAUDE.md section so subagents automatically follow the protocol.
 *
 * Usage:
 *   npx moflo-setup            # First-time setup
 *   npx moflo-setup --update   # Refresh bootstrap file after moflo upgrade
 *   npx moflo-setup --check    # Check if setup is current
 *
 * What it does:
 *   1. Copies .claude/guidance/agent-bootstrap.md → project's .claude/guidance/moflo-bootstrap.md
 *   2. Appends a subagent protocol section to CLAUDE.md (idempotent, with markers)
 *
 * The project can layer its own .claude/guidance/agent-bootstrap.md on top for
 * project-specific rules (companyId, entity templates, etc.).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mofloRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const updateOnly = args.includes('--update');
const checkOnly = args.includes('--check');

// Markers for idempotent CLAUDE.md updates
const MARKER_START = '<!-- MOFLO:SUBAGENT-PROTOCOL:START -->';
const MARKER_END = '<!-- MOFLO:SUBAGENT-PROTOCOL:END -->';

const CLAUDE_MD_SECTION = `${MARKER_START}
## FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call for every new user prompt MUST be a memory search. Do this BEFORE Glob, Grep, Read, or any file exploration. No exceptions.

WHY: Memory contains curated solutions, patterns, and architectural context from previous work. Without it, you will miss existing solutions, repeat mistakes that were already solved, and waste time re-discovering what is already known. Memory search is faster than file scanning.

HOW: Use ToolSearch to load \`mcp__claude-flow__memory_search\`, then call it with a query describing your task. If MCP is unavailable, use:
\`node .claude/scripts/semantic-search.mjs "[task description]" --namespace guidance\`

### Namespaces to search:

| Namespace | When to search | What it returns |
|-----------|---------------|-----------------|
| \`guidance\` | Always — understanding patterns, rules, conventions | Guidance docs, coding rules, domain context |
| \`patterns\` | Always — prior solutions and implementation patterns | Learned patterns from previous task execution |
| \`code-map\` | Finding where code lives (files, types, services) | Type-to-file mappings, directory contents, project overviews |

**Always search both \`guidance\` and \`patterns\` namespaces.** The \`patterns\` namespace contains solutions to problems already solved — skipping it means repeating past mistakes.

For **codebase navigation** (finding where a type/service/component lives), also search the \`code-map\` namespace.

## Memory System Access (MoFlo)

### Primary: MCP Tools (preferred)
\`\`\`
mcp__claude-flow__memory_search   — query, namespace
mcp__claude-flow__memory_store    — key, value, namespace
mcp__claude-flow__memory_retrieve — key, namespace
mcp__claude-flow__memory_list     — namespace, limit
\`\`\`
Load via ToolSearch first: \`+claude-flow memory\`

### Fallback: CLI Scripts
\`\`\`bash
npx moflo-search "[query]" --namespace guidance   # Semantic search
npx moflo-embeddings                               # Rebuild embeddings
npx moflo-index                                    # Re-index guidance docs
npx moflo-codemap --force                          # Regenerate code-map
\`\`\`

### Where Content Goes

| Content Type | Destination | How to Write |
|-------------|-------------|--------------|
| Debugging lessons (bug found, root cause, fix) | Memory DB — \`patterns\` namespace | \`mcp__claude-flow__memory_store\` |
| Architectural decisions (chose X over Y, why) | Memory DB — \`decisions\` namespace | \`mcp__claude-flow__memory_store\` |
| Learned patterns (task succeeded/failed, what worked) | Memory DB — \`patterns\` namespace | \`mcp__claude-flow__memory_store\` |
| Coding rules (always/never do X in code) | \`.claude/guidance/\` files | Edit directly |
| Process/workflow rules (CI, PR, gates) | \`CLAUDE.md\` | Edit directly |

## Subagent Protocol (MoFlo)

All subagents MUST read \`.claude/guidance/moflo-bootstrap.md\` before starting any work.
It contains the memory-first protocol, discovery storage rules, and universal conventions.

If \`.claude/guidance/agent-bootstrap.md\` also exists, read it next for project-specific rules.
${MARKER_END}`;

function log(msg) {
  console.log(`[moflo-setup] ${msg}`);
}

function findProjectRoot() {
  // Walk up from cwd looking for package.json that depends on moflo
  let dir = process.cwd();
  const root = resolve(dir, '/');

  while (dir !== root) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps && deps.moflo) {
          return dir;
        }
      } catch { /* ignore parse errors */ }
    }
    dir = dirname(dir);
  }

  // Fallback: use cwd if it has a package.json
  if (existsSync(join(process.cwd(), 'package.json'))) {
    return process.cwd();
  }

  return null;
}

function copyBootstrap(projectRoot) {
  const source = join(mofloRoot, '.claude', 'guidance', 'agent-bootstrap.md');
  const targetDir = join(projectRoot, '.claude', 'guidance');
  const target = join(targetDir, 'moflo-bootstrap.md');

  if (!existsSync(source)) {
    log('❌ Source bootstrap not found in moflo package');
    return false;
  }

  // Read source content and prepend auto-generated notice
  const content = readFileSync(source, 'utf-8');
  const header = `<!-- AUTO-GENERATED by moflo-setup. Do not edit — changes will be overwritten. -->
<!-- Source: node_modules/moflo/.claude/guidance/agent-bootstrap.md -->
<!-- To customize, create .claude/guidance/agent-bootstrap.md for project-specific rules. -->

`;

  mkdirSync(targetDir, { recursive: true });

  // Check if file exists and is current
  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf-8');
    const newContent = header + content;
    if (existing === newContent) {
      log('✅ moflo-bootstrap.md is current');
      return true;
    }
    log('📝 Updating moflo-bootstrap.md');
  } else {
    log('📝 Creating .claude/guidance/moflo-bootstrap.md');
  }

  if (!checkOnly) {
    writeFileSync(target, header + content, 'utf-8');
  }
  return true;
}

function updateClaudeMd(projectRoot) {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');

  if (!existsSync(claudeMdPath)) {
    if (checkOnly) {
      log('⚠️  No CLAUDE.md found');
      return false;
    }
    log('📝 Creating CLAUDE.md with subagent protocol section');
    writeFileSync(claudeMdPath, `# Project Configuration\n\n${CLAUDE_MD_SECTION}\n`, 'utf-8');
    return true;
  }

  const content = readFileSync(claudeMdPath, 'utf-8');

  // Check if markers already exist
  if (content.includes(MARKER_START)) {
    // Extract existing section and compare
    const startIdx = content.indexOf(MARKER_START);
    const endIdx = content.indexOf(MARKER_END);

    if (endIdx > startIdx) {
      const existingSection = content.substring(startIdx, endIdx + MARKER_END.length);
      if (existingSection === CLAUDE_MD_SECTION) {
        log('✅ CLAUDE.md subagent section is current');
        return true;
      }

      // Update existing section
      if (!checkOnly) {
        const updated = content.substring(0, startIdx) + CLAUDE_MD_SECTION + content.substring(endIdx + MARKER_END.length);
        writeFileSync(claudeMdPath, updated, 'utf-8');
        log('📝 Updated CLAUDE.md subagent protocol section');
      } else {
        log('⚠️  CLAUDE.md subagent section needs update');
      }
      return true;
    }
  }

  if (updateOnly) {
    log('⚠️  CLAUDE.md has no moflo section (run without --update to add)');
    return false;
  }

  if (checkOnly) {
    log('⚠️  CLAUDE.md missing subagent protocol section');
    return false;
  }

  // Append section to end of CLAUDE.md
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(claudeMdPath, content + separator + CLAUDE_MD_SECTION + '\n', 'utf-8');
  log('📝 Added subagent protocol section to CLAUDE.md');
  return true;
}

function main() {
  console.log('');
  console.log('MoFlo Project Setup');
  console.log('───────────────────');

  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    log('❌ Could not find project root (no package.json with moflo dependency)');
    process.exit(1);
  }

  log(`Project: ${projectRoot}`);
  console.log('');

  // Step 1: Copy bootstrap file
  const bootstrapOk = copyBootstrap(projectRoot);

  // Step 2: Update CLAUDE.md (skip on --update, only refresh the file)
  const claudeOk = updateOnly ? true : updateClaudeMd(projectRoot);

  console.log('');
  if (checkOnly) {
    log(bootstrapOk && claudeOk ? '✅ Setup is current' : '⚠️  Setup needs attention');
  } else {
    log('✅ Done. Subagents will now follow the MoFlo bootstrap protocol.');
  }
  console.log('');
}

main();
