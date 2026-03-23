/**
 * Guidance Compliance Linter
 *
 * Deterministic checks that guidance files follow established rules:
 * 1. Task() calls with agent roles must include role icons in description/name
 * 2. TaskCreate() examples must include role icons in subject/activeForm
 * 3. Background agents (run_in_background: true) must have paired TaskCreate
 * 4. TodoWrite entries must include role icons in activeForm
 * 5. Agent routing tables must include role icons
 *
 * These are grep/regex checks — no AI judgment, no prior knowledge.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'fs';

const ROOT = resolve(__dirname, '../..');

/** Simple recursive glob for .md files */
function globMd(dir: string, ignore: string[] = []): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = dir === ROOT ? entry.name : `${dir.slice(ROOT.length + 1).replace(/\\/g, '/')}/${entry.name}`;
      if (ignore.some(p => rel.startsWith(p.replace('/**', '')))) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...globMd(full, ignore));
      } else if (entry.name.endsWith('.md')) {
        results.push(rel);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

// ── Known role icons ──────────────────────────────────────────────────────────

const ROLE_ICONS: Record<string, string> = {
  researcher: '🔍',
  'system-architect': '🏗️',
  architect: '🏗️',
  coder: '💻',
  tester: '🧪',
  reviewer: '👀',
  'security-architect': '🛡️',
  'security-auditor': '🛡️',
  'performance-engineer': '⚡',
  'perf-engineer': '⚡',
  'api-docs': '📚',
  planner: '📋',
  consensus: '🤝',
  analyzer: '🔬',
  'code-analyzer': '🔬',
};

const ALL_ICONS = [...new Set(Object.values(ROLE_ICONS))];
const ICON_PATTERN = ALL_ICONS.map(i => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

// Agent types that MUST have icons when used in Task/TaskCreate examples
const ICONABLE_AGENT_TYPES = Object.keys(ROLE_ICONS);

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFile(relPath: string): string {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf-8');
}

function getGuidanceFiles(): string[] {
  return globMd(ROOT, ['node_modules', 'dist', '.git']).filter(f =>
    f.startsWith('.claude/guidance/') ||
    f === 'CLAUDE.md' ||
    f === 'src/@claude-flow/cli/CLAUDE.md'
  );
}

/**
 * Find Task() calls with subagent_type matching a known role.
 * Returns lines where the icon is missing from the description/name/prompt args.
 */
function findTaskCallsMissingIcons(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: Task("Name", "prompt...", "agent-type") style
    const taskCallMatch = line.match(/Task\(\s*"([^"]*?)"/);
    if (taskCallMatch) {
      const taskName = taskCallMatch[1];

      // For single-line Task() calls, only check agent type on the SAME line
      // For multi-line Task({...}) calls, look within the block
      const isSingleLine = line.includes(')') && !line.includes('{');
      const context = isSingleLine
        ? line
        : lines.slice(i, Math.min(i + 10, lines.length)).join(' ');

      // Find the LAST quoted string as the agent type (standard Task("name","prompt","type") pattern)
      for (const agentType of ICONABLE_AGENT_TYPES) {
        const typePattern = new RegExp(`["']${agentType}["']`);
        if (typePattern.test(context)) {
          const expectedIcon = ROLE_ICONS[agentType];
          if (!taskName.includes(expectedIcon)) {
            violations.push(
              `${filePath}:${i + 1}: Task() with agent type "${agentType}" missing icon ${expectedIcon} in name "${taskName}"`
            );
          }
        }
      }
    }

    // Match: subagent_type: "agent-type" with description: "..." in same Task({}) block
    const subagentMatch = line.match(/subagent_type:\s*["'](\w[\w-]*)["']/);
    if (subagentMatch) {
      const agentType = subagentMatch[1];
      if (ROLE_ICONS[agentType]) {
        const expectedIcon = ROLE_ICONS[agentType];
        // Find the enclosing Task({...}) block by scanning backward for "Task({" and forward for "})"
        let blockStart = i;
        for (let b = i; b >= Math.max(0, i - 10); b--) {
          if (lines[b].includes('Task(')) { blockStart = b; break; }
        }
        let blockEnd = i;
        for (let b = i; b < Math.min(i + 10, lines.length); b++) {
          if (lines[b].includes('})')) { blockEnd = b; break; }
        }
        const blockContext = lines.slice(blockStart, blockEnd + 1).join(' ');
        const descMatch = blockContext.match(/description:\s*["']([^"']*?)["']/);
        if (descMatch && !descMatch[1].includes(expectedIcon)) {
          violations.push(
            `${filePath}:${i + 1}: Agent spawn with subagent_type "${agentType}" missing icon ${expectedIcon} in description "${descMatch[1]}"`
          );
        }
      }
    }
  }

  return violations;
}

/**
 * Find TaskCreate() calls missing role icons in subject or activeForm.
 * Only flags TaskCreate calls that appear to be agent-related (contain role keywords).
 */
function findTaskCreateMissingIcons(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');

  // Role keywords that indicate a TaskCreate is agent-related
  const roleKeywords = [
    'research', 'architect', 'design', 'implement', 'code', 'coding',
    'test', 'testing', 'review', 'security', 'audit', 'performance',
    'document', 'plan', 'analyze', 'consensus', 'investigate',
  ];

  // Coordinator/parent task keywords — these are exempt from icon requirements
  const coordinatorKeywords = ['coordinat', 'feature x', '[feature', '[task'];
  const isCoordinatorTask = (text: string) =>
    coordinatorKeywords.some(kw => text.toLowerCase().includes(kw));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match TaskCreate subject or activeForm fields
    const subjectMatch = line.match(/subject:\s*["']([^"']*?)["']/);
    if (subjectMatch) {
      const subject = subjectMatch[1];
      const hasIcon = new RegExp(ICON_PATTERN).test(subject);
      const isAgentRelated = roleKeywords.some(kw =>
        subject.toLowerCase().includes(kw)
      );

      // Look for TaskCreate in nearby context
      const context = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
      if (context.includes('TaskCreate') && isAgentRelated && !hasIcon && !isCoordinatorTask(subject)) {
        violations.push(
          `${filePath}:${i + 1}: TaskCreate subject missing role icon: "${subject}"`
        );
      }
    }

    const activeFormMatch = line.match(/activeForm:\s*["']([^"']*?)["']/);
    if (activeFormMatch) {
      const activeForm = activeFormMatch[1];
      const hasIcon = new RegExp(ICON_PATTERN).test(activeForm);
      const isAgentRelated = roleKeywords.some(kw =>
        activeForm.toLowerCase().includes(kw)
      );

      const context = lines.slice(Math.max(0, i - 5), i + 1).join(' ');
      if (context.includes('TaskCreate') && isAgentRelated && !hasIcon && !isCoordinatorTask(activeForm)) {
        violations.push(
          `${filePath}:${i + 1}: TaskCreate activeForm missing role icon: "${activeForm}"`
        );
      }
    }
  }

  return violations;
}

/**
 * Find background agent spawns without a nearby TaskCreate.
 * Checks for run_in_background: true without a corresponding TaskCreate in the same code block.
 */
function findBackgroundAgentsWithoutTaskCreate(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');

  // Track whether we're inside a code block (``` fence)
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Only flag run_in_background inside code blocks (skip prose/rules)
    if (!inCodeBlock) continue;

    if (line.includes('run_in_background') && line.includes('true')) {
      // Look backwards up to 40 lines for a TaskCreate in the same code block
      const lookback = lines.slice(Math.max(0, i - 40), i + 1).join('\n');
      const hasTaskCreate = lookback.includes('TaskCreate');

      // Also check if this is inside a "skip TaskCreate" or "optional" section
      const isExemptSection = lookback.match(
        /skip\s+TaskCreate|TaskCreate\s+optional|no\s+TaskCreate\s+needed|TaskCreate\s+already/i
      );

      if (!hasTaskCreate && !isExemptSection) {
        violations.push(
          `${filePath}:${i + 1}: Background agent (run_in_background: true) without paired TaskCreate in surrounding context`
        );
      }
    }
  }

  return violations;
}

/**
 * Find TodoWrite entries with agent-related content missing role icons.
 */
function findTodoWriteMissingIcons(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');

  const roleKeywords = [
    'research', 'architect', 'design', 'implement',
    'test', 'review', 'security', 'performance', 'document',
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check TodoWrite activeForm fields
    if (line.includes('activeForm') && line.includes('"')) {
      const context = lines.slice(Math.max(0, i - 10), i + 1).join(' ');
      if (context.includes('TodoWrite') || context.includes('todos:')) {
        const activeFormMatch = line.match(/activeForm:\s*["']([^"']*?)["']/);
        if (activeFormMatch) {
          const value = activeFormMatch[1];
          const hasIcon = new RegExp(ICON_PATTERN).test(value);
          const isAgentRelated = roleKeywords.some(kw =>
            value.toLowerCase().includes(kw)
          );

          if (isAgentRelated && !hasIcon) {
            violations.push(
              `${filePath}:${i + 1}: TodoWrite activeForm missing role icon: "${value}"`
            );
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Verify that the role icon reference table exists in task-swarm-integration.md.
 */
function hasIconReferenceTable(content: string): boolean {
  return content.includes('Agent Role Icons') &&
    ALL_ICONS.every(icon => content.includes(icon));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Guidance Compliance Linter', () => {
  const guidanceFiles = getGuidanceFiles();

  describe('Role icon reference table', () => {
    it('task-swarm-integration.md has complete icon reference table', () => {
      const content = readFile('.claude/guidance/shipped/task-swarm-integration.md');
      expect(content).toBeTruthy();
      expect(hasIconReferenceTable(content)).toBe(true);
    });

    it('all known agent roles have icon mappings', () => {
      const missingIcons = ICONABLE_AGENT_TYPES.filter(t => !ROLE_ICONS[t]);
      expect(missingIcons).toEqual([]);
    });
  });

  describe('Task() calls include role icons', () => {
    for (const file of guidanceFiles) {
      it(`${file}: Task() calls have role icons`, () => {
        const content = readFile(file);
        if (!content) return; // file doesn't exist, skip
        const violations = findTaskCallsMissingIcons(content, file);
        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} Task() calls missing role icons:\n` +
            violations.map(v => `  - ${v}`).join('\n')
          );
        }
      });
    }
  });

  describe('TaskCreate() calls include role icons', () => {
    for (const file of guidanceFiles) {
      it(`${file}: TaskCreate() calls have role icons`, () => {
        const content = readFile(file);
        if (!content) return;
        const violations = findTaskCreateMissingIcons(content, file);
        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} TaskCreate() calls missing role icons:\n` +
            violations.map(v => `  - ${v}`).join('\n')
          );
        }
      });
    }
  });

  describe('Background agents paired with TaskCreate', () => {
    for (const file of guidanceFiles) {
      it(`${file}: background agents have TaskCreate`, () => {
        const content = readFile(file);
        if (!content) return;
        const violations = findBackgroundAgentsWithoutTaskCreate(content, file);
        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} background agents without TaskCreate:\n` +
            violations.map(v => `  - ${v}`).join('\n')
          );
        }
      });
    }
  });

  describe('TodoWrite entries include role icons', () => {
    for (const file of guidanceFiles) {
      it(`${file}: TodoWrite activeForm has role icons`, () => {
        const content = readFile(file);
        if (!content) return;
        const violations = findTodoWriteMissingIcons(content, file);
        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} TodoWrite entries missing role icons:\n` +
            violations.map(v => `  - ${v}`).join('\n')
          );
        }
      });
    }
  });

  describe('Structural requirements', () => {
    it('CLAUDE.md exists and has MoFlo section', () => {
      const content = readFile('CLAUDE.md');
      expect(content).toContain('MoFlo');
      expect(content).toContain('mcp__moflo__memory_search');
    });

    it('task-swarm-integration.md has TaskCreate decision checklist', () => {
      const content = readFile('.claude/guidance/shipped/task-swarm-integration.md');
      expect(content).toContain('When to Use TaskCreate');
      expect(content).toContain('Decision Checklist');
    });

    it('task-swarm-integration.md has non-swarm TaskCreate examples', () => {
      const content = readFile('.claude/guidance/shipped/task-swarm-integration.md');
      expect(content).toContain('Non-Swarm Example');
      expect(content).toContain('Single Background Agent');
    });

    it('CLAUDE.md references full docs in guidance', () => {
      const content = readFile('CLAUDE.md');
      expect(content).toContain('.claude/guidance/shipped/moflo.md');
    });
  });
});
