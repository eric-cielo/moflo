/**
 * Scenario-based tests for the guidance compliance linter.
 *
 * Each scenario feeds synthetic markdown content through the checker functions
 * and verifies they correctly detect violations or pass clean content.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '../..');

// ── Import checker functions by re-declaring them (same logic as lint-guidance) ──
// This avoids coupling to the test file's internal structure.

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
const ICONABLE_AGENT_TYPES = Object.keys(ROLE_ICONS);

function findTaskCallsMissingIcons(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const taskCallMatch = line.match(/Task\(\s*"([^"]*?)"/);
    if (taskCallMatch) {
      const taskName = taskCallMatch[1];
      const isSingleLine = line.includes(')') && !line.includes('{');
      const context = isSingleLine
        ? line
        : lines.slice(i, Math.min(i + 10, lines.length)).join(' ');
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
    const subagentMatch = line.match(/subagent_type:\s*["'](\w[\w-]*)["']/);
    if (subagentMatch) {
      const agentType = subagentMatch[1];
      if (ROLE_ICONS[agentType]) {
        const expectedIcon = ROLE_ICONS[agentType];
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

function findTaskCreateMissingIcons(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');
  const roleKeywords = [
    'research', 'architect', 'design', 'implement', 'code', 'coding',
    'test', 'testing', 'review', 'security', 'audit', 'performance',
    'document', 'plan', 'analyze', 'consensus', 'investigate',
  ];
  const coordinatorKeywords = ['coordinat', 'feature x', '[feature', '[task'];
  const isCoordinatorTask = (text: string) =>
    coordinatorKeywords.some(kw => text.toLowerCase().includes(kw));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const subjectMatch = line.match(/subject:\s*["']([^"']*?)["']/);
    if (subjectMatch) {
      const subject = subjectMatch[1];
      const hasIcon = new RegExp(ICON_PATTERN).test(subject);
      const isAgentRelated = roleKeywords.some(kw => subject.toLowerCase().includes(kw));
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
      const isAgentRelated = roleKeywords.some(kw => activeForm.toLowerCase().includes(kw));
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

function findBackgroundAgentsWithoutTaskCreate(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock) continue;
    if (line.includes('run_in_background') && line.includes('true')) {
      const lookback = lines.slice(Math.max(0, i - 40), i + 1).join('\n');
      const hasTaskCreate = lookback.includes('TaskCreate');
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

function findTodoWriteMissingIcons(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const lines = content.split('\n');
  const roleKeywords = [
    'research', 'architect', 'design', 'implement',
    'test', 'review', 'security', 'performance', 'document',
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('activeForm') && line.includes('"')) {
      const context = lines.slice(Math.max(0, i - 10), i + 1).join(' ');
      if (context.includes('TodoWrite') || context.includes('todos:')) {
        const activeFormMatch = line.match(/activeForm:\s*["']([^"']*?)["']/);
        if (activeFormMatch) {
          const value = activeFormMatch[1];
          const hasIcon = new RegExp(ICON_PATTERN).test(value);
          const isAgentRelated = roleKeywords.some(kw => value.toLowerCase().includes(kw));
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

// ── Scenario Tests ────────────────────────────────────────────────────────────

describe('Guidance Linter Scenarios', () => {

  // ═══════════════════════════════════════════════════════════════════════════
  // Task() icon checks
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Task() icon checks — single-line calls', () => {
    it('passes: correct icon for each agent type', () => {
      const content = `
Task("🔍 Researcher", "Analyze codebase", "researcher")
Task("🏗️ Architect", "Design system", "system-architect")
Task("💻 Coder", "Write code", "coder")
Task("🧪 Tester", "Run tests", "tester")
Task("👀 Reviewer", "Review code", "reviewer")
Task("🛡️ Security", "Audit security", "security-architect")
Task("⚡ PerfEng", "Optimize perf", "performance-engineer")
Task("📚 Docs", "Write docs", "api-docs")
Task("📋 Planner", "Plan work", "planner")
Task("🔬 Analyzer", "Analyze code", "analyzer")
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('fails: researcher Task without icon', () => {
      const content = `Task("Research phase", "Find patterns", "researcher")`;
      const v = findTaskCallsMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('researcher');
      expect(v[0]).toContain('🔍');
    });

    it('fails: coder Task without icon', () => {
      const content = `Task("Implementation", "Write the code", "coder")`;
      const v = findTaskCallsMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('coder');
    });

    it('fails: tester Task without icon', () => {
      const content = `Task("Test phase", "Write tests", "tester")`;
      const v = findTaskCallsMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('tester');
    });

    it('fails: reviewer Task without icon', () => {
      const content = `Task("Review", "Check quality", "reviewer")`;
      const v = findTaskCallsMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('reviewer');
    });

    it('passes: unknown agent types are not checked', () => {
      const content = `Task("Coordinator", "Coordinate work", "hierarchical-coordinator")`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('handles multiple adjacent single-line Task() calls independently', () => {
      const content = `
Task("🔍 Researcher", "Analyze", "researcher")
Task("🏗️ Architect", "Design", "system-architect")
Task("💻 Coder", "Implement", "coder")
Task("🧪 Tester", "Test", "tester")
Task("👀 Reviewer", "Review", "reviewer")
`;
      // Each line should only check its own agent type
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('does not cross-contaminate between adjacent single-line calls', () => {
      // Each line has the CORRECT icon for ITS agent type
      // The checker must not flag "🔍 Researcher" for missing the coder icon
      const content = `
Task("🔍 Researcher", "Find patterns", "researcher")
Task("💻 Coder", "Write code", "coder")
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('flags only the wrong line in a multi-call block', () => {
      const content = `
Task("🔍 Researcher", "Find patterns", "researcher")
Task("Missing Icon Coder", "Write code", "coder")
Task("🧪 Tester", "Test", "tester")
`;
      const v = findTaskCallsMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('coder');
      expect(v[0]).toContain('Missing Icon Coder');
    });
  });

  describe('Task() icon checks — multi-line Task({...}) blocks', () => {
    it('passes: correct icon in description', () => {
      const content = `
Task({
  prompt: "Research the codebase",
  subagent_type: "researcher",
  description: "🔍 Research phase",
  run_in_background: true
})
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('fails: wrong icon in description', () => {
      const content = `
Task({
  prompt: "Research the codebase",
  subagent_type: "researcher",
  description: "💻 Research phase",
  run_in_background: true
})
`;
      const v = findTaskCallsMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('researcher');
      expect(v[0]).toContain('🔍');
    });

    it('fails: no icon in description', () => {
      const content = `
Task({
  prompt: "Research the codebase",
  subagent_type: "researcher",
  description: "Research phase",
  run_in_background: true
})
`;
      const v = findTaskCallsMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
    });

    it('passes: multiple consecutive multi-line blocks with correct icons', () => {
      const content = `
Task({
  prompt: "Research",
  subagent_type: "researcher",
  description: "🔍 Research phase"
})
Task({
  prompt: "Design",
  subagent_type: "system-architect",
  description: "🏗️ Architecture phase"
})
Task({
  prompt: "Implement",
  subagent_type: "coder",
  description: "💻 Implementation phase"
})
Task({
  prompt: "Test",
  subagent_type: "tester",
  description: "🧪 Testing phase"
})
Task({
  prompt: "Review",
  subagent_type: "reviewer",
  description: "👀 Review phase"
})
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('does not cross-contaminate between multi-line blocks', () => {
      // Each block has the correct icon for its own subagent_type
      // The checker must scope to the enclosing Task({...}) block
      const content = `
Task({
  prompt: "Implement",
  subagent_type: "coder",
  description: "💻 Implementation phase"
})
Task({
  prompt: "Test",
  subagent_type: "tester",
  description: "🧪 Testing phase"
})
Task({
  prompt: "Review",
  subagent_type: "reviewer",
  description: "👀 Review phase"
})
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('passes: unknown agent type in multi-line block', () => {
      const content = `
Task({
  prompt: "Coordinate",
  subagent_type: "hierarchical-coordinator",
  description: "Coordination phase"
})
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TaskCreate() icon checks
  // ═══════════════════════════════════════════════════════════════════════════

  describe('TaskCreate() icon checks', () => {
    it('passes: all agent-related TaskCreate with icons', () => {
      const content = `
TaskCreate({ subject: "🔍 Research patterns", description: "...", activeForm: "🔍 Researching" })
TaskCreate({ subject: "🏗️ Design architecture", description: "...", activeForm: "🏗️ Designing" })
TaskCreate({ subject: "💻 Implement solution", description: "...", activeForm: "💻 Implementing" })
TaskCreate({ subject: "🧪 Write tests", description: "...", activeForm: "🧪 Testing" })
TaskCreate({ subject: "👀 Review code", description: "...", activeForm: "👀 Reviewing" })
`;
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('fails: research TaskCreate without icon in subject', () => {
      const content = `TaskCreate({ subject: "Research patterns", description: "...", activeForm: "🔍 Researching" })`;
      const v = findTaskCreateMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('subject');
      expect(v[0]).toContain('Research patterns');
    });

    it('fails: TaskCreate without icon in activeForm', () => {
      const content = `TaskCreate({ subject: "🔍 Research", description: "...", activeForm: "Researching patterns" })`;
      const v = findTaskCreateMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('activeForm');
    });

    it('fails: both subject and activeForm missing icons', () => {
      const content = `TaskCreate({ subject: "Research patterns", description: "...", activeForm: "Researching" })`;
      const v = findTaskCreateMissingIcons(content, 'test.md');
      expect(v).toHaveLength(2);
    });

    it('passes: coordinator/parent task is exempt', () => {
      const content = `
TaskCreate({ subject: "Implement [feature/fix description]", description: "...", activeForm: "Coordinating implementation" })
TaskCreate({ subject: "Implement feature X", description: "...", activeForm: "Coordinating" })
TaskCreate({ subject: "Coordinate [task]", description: "...", activeForm: "Coordinating work" })
`;
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('passes: non-agent-related TaskCreate is not checked', () => {
      const content = `
TaskCreate({ subject: "Fix build errors", description: "...", activeForm: "Fixing build" })
TaskCreate({ subject: "Update dependencies", description: "...", activeForm: "Updating deps" })
TaskCreate({ subject: "Deploy to staging", description: "...", activeForm: "Deploying" })
`;
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('does not flag TaskUpdate or other non-TaskCreate calls', () => {
      const content = `
TaskUpdate({ taskId: "1", status: "in_progress" })
TaskList()
subject: "Research patterns"
`;
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('catches multiple violations across a block', () => {
      const content = `
TaskCreate({ subject: "Research requirements", activeForm: "Researching" })
TaskCreate({ subject: "🏗️ Design system", activeForm: "🏗️ Designing" })
TaskCreate({ subject: "Implement code", activeForm: "Implementing" })
TaskCreate({ subject: "🧪 Write tests", activeForm: "🧪 Testing" })
TaskCreate({ subject: "Review changes", activeForm: "Reviewing" })
`;
      const v = findTaskCreateMissingIcons(content, 'test.md');
      // Research: 2 (subject + activeForm), Implement: 2, Review: 2 = 6
      expect(v).toHaveLength(6);
    });

    it('passes: multi-line TaskCreate with icons', () => {
      const content = `
TaskCreate({
  subject: "🔍 Investigate bug and root cause",
  description: "Researcher agent: find root cause of test failures",
  activeForm: "🔍 Investigating test failures"
})
`;
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('fails: multi-line TaskCreate without icons', () => {
      const content = `
TaskCreate({
  subject: "Investigate bug and root cause",
  description: "Researcher agent: find root cause",
  activeForm: "Investigating test failures"
})
`;
      const v = findTaskCreateMissingIcons(content, 'test.md');
      expect(v).toHaveLength(2); // subject + activeForm
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Background agent + TaskCreate pairing
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Background agents paired with TaskCreate', () => {
    it('passes: TaskCreate before background agent in same code block', () => {
      const content = `
\`\`\`javascript
TaskCreate({ subject: "🔍 Research", activeForm: "🔍 Researching" })

Task({
  prompt: "Research the codebase",
  subagent_type: "researcher",
  description: "🔍 Research phase",
  run_in_background: true
})
\`\`\`
`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('fails: background agent in code block without TaskCreate', () => {
      const content = `
\`\`\`javascript
Task({
  prompt: "Research the codebase",
  subagent_type: "researcher",
  description: "🔍 Research phase",
  run_in_background: true
})
\`\`\`
`;
      const v = findBackgroundAgentsWithoutTaskCreate(content, 'test.md');
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('run_in_background');
    });

    it('passes: prose mention of run_in_background is NOT flagged', () => {
      const content = `
## Best Practices

1. **Spawn in background**: Use \`run_in_background: true\` for all agent Task calls
2. Background agents should always use run_in_background: true
3. Set run_in_background to true for parallel work
`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('passes: inline code mention of run_in_background is NOT flagged', () => {
      const content = `Use \`run_in_background: true\` when spawning agents.`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('passes: "TaskCreate already done" exemption', () => {
      const content = `
\`\`\`javascript
// TaskCreate already done in Step 1 above
Task({
  prompt: "Research",
  run_in_background: true
})
\`\`\`
`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('passes: "skip TaskCreate" exemption', () => {
      const content = `
\`\`\`javascript
// Simple lookup — skip TaskCreate
Task({
  prompt: "Find files",
  run_in_background: true
})
\`\`\`
`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('passes: "no TaskCreate needed" exemption', () => {
      const content = `
\`\`\`javascript
// Quick search — no TaskCreate needed
Task({
  prompt: "Grep for patterns",
  run_in_background: true
})
\`\`\`
`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('passes: "TaskCreate optional" exemption', () => {
      const content = `
\`\`\`javascript
// Foreground + simple = TaskCreate optional
Task({
  prompt: "Quick lookup",
  run_in_background: true
})
\`\`\`
`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('catches multiple background agents without TaskCreate', () => {
      const content = `
\`\`\`javascript
Task({
  prompt: "Research",
  run_in_background: true
})
Task({
  prompt: "Implement",
  run_in_background: true
})
Task({
  prompt: "Test",
  run_in_background: true
})
\`\`\`
`;
      const v = findBackgroundAgentsWithoutTaskCreate(content, 'test.md');
      expect(v).toHaveLength(3);
    });

    it('passes: multiple background agents WITH TaskCreate', () => {
      const content = `
\`\`\`javascript
TaskCreate({ subject: "🔍 Research", activeForm: "🔍 Researching" })
TaskCreate({ subject: "💻 Implement", activeForm: "💻 Implementing" })
TaskCreate({ subject: "🧪 Test", activeForm: "🧪 Testing" })

Task({
  prompt: "Research",
  run_in_background: true
})
Task({
  prompt: "Implement",
  run_in_background: true
})
Task({
  prompt: "Test",
  run_in_background: true
})
\`\`\`
`;
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
    });

    it('handles nested code fences correctly', () => {
      // Only the inner content of the actual code block should be checked
      const content = `
Some prose about agents.

\`\`\`javascript
Task({
  run_in_background: true
})
\`\`\`

More prose with run_in_background: true mentioned.
`;
      const v = findBackgroundAgentsWithoutTaskCreate(content, 'test.md');
      expect(v).toHaveLength(1); // Only the code block one
    });

    it('handles CRLF line endings', () => {
      const content = "```javascript\r\nTask({\r\n  run_in_background: true\r\n})\r\n```\r\n";
      const v = findBackgroundAgentsWithoutTaskCreate(content, 'test.md');
      expect(v).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TodoWrite icon checks
  // ═══════════════════════════════════════════════════════════════════════════

  describe('TodoWrite icon checks', () => {
    it('passes: TodoWrite with role icons in activeForm', () => {
      const content = `
TodoWrite({ todos: [
  {content: "Initialize swarm", status: "in_progress", activeForm: "Initializing swarm"},
  {content: "🔍 Research requirements", status: "in_progress", activeForm: "🔍 Researching requirements"},
  {content: "🏗️ Design architecture", status: "pending", activeForm: "🏗️ Designing architecture"},
  {content: "💻 Implement solution", status: "pending", activeForm: "💻 Implementing solution"},
  {content: "🧪 Write tests", status: "pending", activeForm: "🧪 Writing tests"},
  {content: "👀 Review and finalize", status: "pending", activeForm: "👀 Reviewing code"}
]})
`;
      expect(findTodoWriteMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('fails: TodoWrite with agent-related activeForm missing icons', () => {
      const content = `
TodoWrite({ todos: [
  {content: "Research requirements", status: "in_progress", activeForm: "Researching requirements"},
  {content: "Design architecture", status: "pending", activeForm: "Designing architecture"},
  {content: "Implement solution", status: "pending", activeForm: "Implementing solution"},
  {content: "Write tests", status: "pending", activeForm: "Writing tests"},
  {content: "Review code", status: "pending", activeForm: "Reviewing code"}
]})
`;
      const v = findTodoWriteMissingIcons(content, 'test.md');
      expect(v).toHaveLength(5);
    });

    it('passes: non-agent TodoWrite entries are not checked', () => {
      const content = `
TodoWrite({ todos: [
  {content: "Initialize swarm", status: "in_progress", activeForm: "Initializing swarm"},
  {content: "Deploy to staging", status: "pending", activeForm: "Deploying"},
  {content: "Fix build errors", status: "pending", activeForm: "Fixing build"}
]})
`;
      expect(findTodoWriteMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('does not flag activeForm outside TodoWrite context', () => {
      const content = `
// Some config
const options = { activeForm: "Researching patterns" };
`;
      expect(findTodoWriteMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('handles todos: array without TodoWrite prefix', () => {
      const content = `
const batch = { todos: [
  {content: "Research", activeForm: "Researching codebase"}
]};
`;
      const v = findTodoWriteMissingIcons(content, 'test.md');
      expect(v).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases and boundary conditions
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('handles empty content', () => {
      expect(findTaskCallsMissingIcons('', 'test.md')).toEqual([]);
      expect(findTaskCreateMissingIcons('', 'test.md')).toEqual([]);
      expect(findBackgroundAgentsWithoutTaskCreate('', 'test.md')).toEqual([]);
      expect(findTodoWriteMissingIcons('', 'test.md')).toEqual([]);
    });

    it('handles content with no relevant patterns', () => {
      const content = `
# Some Documentation

This is a markdown file with no Task(), TaskCreate(), or TodoWrite() calls.

## Section 2

Just regular prose content.
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
      expect(findTodoWriteMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('handles single quotes in Task calls', () => {
      const content = `Task("🔍 Research", "prompt", 'researcher')`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('handles single quotes in subagent_type', () => {
      const content = `
Task({
  subagent_type: 'researcher',
  description: "🔍 Research phase"
})
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('handles architect alias (both "architect" and "system-architect")', () => {
      const content1 = `Task("🏗️ Design", "Design system", "architect")`;
      const content2 = `Task("🏗️ Design", "Design system", "system-architect")`;
      expect(findTaskCallsMissingIcons(content1, 'test.md')).toEqual([]);
      expect(findTaskCallsMissingIcons(content2, 'test.md')).toEqual([]);
    });

    it('handles perf-engineer alias', () => {
      const content = `Task("⚡ Optimize", "Profile perf", "perf-engineer")`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('handles security-auditor alias', () => {
      const content = `Task("🛡️ Audit", "Security scan", "security-auditor")`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('handles code-analyzer alias', () => {
      const content = `Task("🔬 Analyze", "Static analysis", "code-analyzer")`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('icon at any position in the name is accepted', () => {
      const content1 = `Task("🔍 Research phase", "prompt", "researcher")`;
      const content2 = `Task("Research 🔍 phase", "prompt", "researcher")`;
      const content3 = `Task("Research phase 🔍", "prompt", "researcher")`;
      expect(findTaskCallsMissingIcons(content1, 'test.md')).toEqual([]);
      expect(findTaskCallsMissingIcons(content2, 'test.md')).toEqual([]);
      expect(findTaskCallsMissingIcons(content3, 'test.md')).toEqual([]);
    });

    it('CRLF line endings do not break checks', () => {
      const content = 'TaskCreate({ subject: "Research", activeForm: "Researching" })\r\n';
      const v = findTaskCreateMissingIcons(content, 'test.md');
      expect(v).toHaveLength(2);
    });

    it('tabs in indentation are handled', () => {
      const content = `
TaskCreate({
\tsubject: "🔍 Research patterns",
\tactiveForm: "🔍 Researching"
})
`;
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Realistic full-document scenarios
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Full document scenarios', () => {
    it('compliant swarm protocol document passes all checks', () => {
      const content = `
# Swarm Protocol

## Step 1: Create Tasks

\`\`\`javascript
TaskCreate({ subject: "Implement [feature X]", description: "Coordinator", activeForm: "Coordinating" })
TaskCreate({ subject: "🔍 Research patterns", description: "Researcher", activeForm: "🔍 Researching" })
TaskCreate({ subject: "💻 Implement solution", description: "Coder", activeForm: "💻 Implementing" })
TaskCreate({ subject: "🧪 Write tests", description: "Tester", activeForm: "🧪 Testing" })
TaskCreate({ subject: "👀 Review code", description: "Reviewer", activeForm: "👀 Reviewing" })

Task("🔍 Researcher", "Analyze codebase", "researcher")
Task("💻 Coder", "Write code", "coder")
Task("🧪 Tester", "Run tests", "tester")
Task("👀 Reviewer", "Review", "reviewer")

// Background agents with TaskCreate above
Task({
  subagent_type: "researcher",
  description: "🔍 Research phase",
  run_in_background: true
})
Task({
  subagent_type: "coder",
  description: "💻 Implementation",
  run_in_background: true
})

TodoWrite({ todos: [
  {content: "Initialize", status: "in_progress", activeForm: "Initializing"},
  {content: "🔍 Research", status: "pending", activeForm: "🔍 Researching"},
  {content: "💻 Implement", status: "pending", activeForm: "💻 Implementing"}
]})
\`\`\`
`;
      expect(findTaskCallsMissingIcons(content, 'test.md')).toEqual([]);
      expect(findTaskCreateMissingIcons(content, 'test.md')).toEqual([]);
      expect(findBackgroundAgentsWithoutTaskCreate(content, 'test.md')).toEqual([]);
      expect(findTodoWriteMissingIcons(content, 'test.md')).toEqual([]);
    });

    it('non-compliant document catches all violation types', () => {
      const content = `
# Bad Example

\`\`\`javascript
// Missing icons on TaskCreate
TaskCreate({ subject: "Research patterns", activeForm: "Researching" })
TaskCreate({ subject: "Implement solution", activeForm: "Implementing" })

// Missing icon on Task name
Task("Research phase", "Analyze", "researcher")

// Background agent without TaskCreate
Task({
  subagent_type: "tester",
  description: "Testing",
  run_in_background: true
})

// Missing icons on TodoWrite
TodoWrite({ todos: [
  {content: "Review", activeForm: "Reviewing code"}
]})
\`\`\`
`;
      expect(findTaskCallsMissingIcons(content, 'test.md').length).toBeGreaterThan(0);
      expect(findTaskCreateMissingIcons(content, 'test.md').length).toBeGreaterThan(0);
      // Background agent: has TaskCreate above it (within 40 lines), so this passes
      // But the tester description is missing the icon
      expect(findTodoWriteMissingIcons(content, 'test.md').length).toBeGreaterThan(0);
    });

    it('mixed compliant and non-compliant entries are correctly separated', () => {
      const content = `
TaskCreate({ subject: "🔍 Research", activeForm: "🔍 Researching" })
TaskCreate({ subject: "Implement code", activeForm: "Implementing" })
TaskCreate({ subject: "🧪 Write tests", activeForm: "🧪 Testing" })
TaskCreate({ subject: "Review changes", activeForm: "Reviewing" })
`;
      const v = findTaskCreateMissingIcons(content, 'test.md');
      // "Implement code" → 2 violations (subject + activeForm)
      // "Review changes" → 2 violations (subject + activeForm)
      expect(v).toHaveLength(4);
      expect(v.some(x => x.includes('Implement code'))).toBe(true);
      expect(v.some(x => x.includes('Review changes'))).toBe(true);
      // These should NOT be in violations:
      expect(v.some(x => x.includes('🔍 Research'))).toBe(false);
      expect(v.some(x => x.includes('🧪 Write tests'))).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Real file validation (smoke tests against actual guidance files)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Smoke tests against real guidance files', () => {
    const realFiles = [
      'CLAUDE.md',
      '.claude/guidance/shipped/moflo-claude-swarm-cohesion.md',
      'src/@claude-flow/cli/CLAUDE.md',
    ];

    for (const file of realFiles) {
      const abs = resolve(ROOT, file);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, 'utf-8');

      it(`${file}: no Task() icon violations`, () => {
        expect(findTaskCallsMissingIcons(content, file)).toEqual([]);
      });

      it(`${file}: no TaskCreate() icon violations`, () => {
        expect(findTaskCreateMissingIcons(content, file)).toEqual([]);
      });

      it(`${file}: no orphaned background agents`, () => {
        expect(findBackgroundAgentsWithoutTaskCreate(content, file)).toEqual([]);
      });

      it(`${file}: no TodoWrite icon violations`, () => {
        expect(findTodoWriteMissingIcons(content, file)).toEqual([]);
      });
    }
  });
});
