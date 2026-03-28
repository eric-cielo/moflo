/**
 * MoFlo Epic Command
 * Epic orchestrator that sequences GitHub issues through /flo workflows.
 *
 * Accepts either a GitHub epic issue number or a YAML feature definition.
 * When given an issue number, fetches the epic from GitHub and extracts
 * child stories automatically. When given a YAML file, uses the explicit
 * story definitions with dependency ordering.
 *
 * Usage:
 *   flo epic run 42                          Execute an epic from GitHub
 *   flo epic run 42 --dry-run                Show execution plan from GitHub epic
 *   flo epic run feature.yaml                Execute a YAML feature definition
 *   flo epic run feature.yaml --dry-run      Show execution plan
 *   flo epic status <feature-id>             Check progress
 *   flo epic reset <feature-id>              Reset for re-run
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { loadMofloConfig } from '../config/moflo-config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

type StoryStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
type FeatureStatus = 'pending' | 'running' | 'completed' | 'failed';
type EpicStrategy = 'single-branch' | 'auto-merge';

interface StoryDefinition {
  id: string;
  name: string;
  issue: number;
  depends_on?: string[];
  flo_flags?: string;
}

interface ReviewDefinition {
  enabled: boolean;
  focus_areas: string[];
  output: string;
  fail_on_critical: boolean;
}

interface FeatureDefinition {
  feature: {
    id: string;
    name: string;
    description: string;
    repository: string;
    base_branch: string;
    context?: string;
    auto_merge?: boolean;
    strategy?: EpicStrategy;
    stories: StoryDefinition[];
    review: ReviewDefinition;
  };
}

interface StoryResult {
  story_id: string;
  status: StoryStatus;
  issue: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  pr_url: string | null;
  pr_number: number | null;
  merged: boolean;
  error: string | null;
}

interface ExecutionPlan {
  order: string[];
  independent_groups: string[][];
}

interface OrcState {
  features: Record<string, {
    id: string;
    name: string;
    status: FeatureStatus;
    started_at: string | null;
    completed_at: string | null;
    stories: Record<string, {
      id: string;
      name: string;
      status: StoryStatus;
      started_at: string | null;
      completed_at: string | null;
      duration_ms: number;
      pr_url: string | null;
      pr_number: number | null;
      merged: boolean;
      error: string | null;
    }>;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const STORY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// YAML Parsing (js-yaml optional — fallback to simple parser)
// ═══════════════════════════════════════════════════════════════════════════════

async function parseYaml(content: string): Promise<unknown> {
  try {
    const yaml = await import('js-yaml');
    return yaml.load(content);
  } catch {
    // Fallback: try JSON (YAML is a superset of JSON)
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(
        'Failed to parse feature file. Install js-yaml (`npm i js-yaml`) or use JSON format.',
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation (inline zod-like validation, no external dependency required)
// ═══════════════════════════════════════════════════════════════════════════════

function validateFeatureDefinition(raw: unknown): FeatureDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Feature definition must be an object');
  }

  const obj = raw as Record<string, unknown>;
  if (!obj.feature || typeof obj.feature !== 'object') {
    throw new Error('Feature definition must have a "feature" key');
  }

  const f = obj.feature as Record<string, unknown>;
  const errors: string[] = [];

  // Required string fields
  for (const field of ['id', 'name', 'description', 'repository', 'base_branch']) {
    if (!f[field] || typeof f[field] !== 'string') {
      errors.push(`feature.${field} is required and must be a string`);
    }
  }

  // Repository must exist and be a git repo
  if (typeof f.repository === 'string') {
    if (!existsSync(f.repository)) {
      errors.push(`Repository path does not exist: "${f.repository}"`);
    } else if (!existsSync(join(f.repository, '.git'))) {
      errors.push(`Repository path is not a git repo: "${f.repository}"`);
    }
  }

  // Stories
  if (!Array.isArray(f.stories) || f.stories.length === 0) {
    errors.push('feature.stories must be a non-empty array');
  } else {
    const storyIds = new Set<string>();
    const issueNumbers = new Set<number>();

    for (let i = 0; i < f.stories.length; i++) {
      const s = f.stories[i] as Record<string, unknown>;
      if (!s.id || typeof s.id !== 'string') errors.push(`stories[${i}].id is required`);
      if (!s.name || typeof s.name !== 'string') errors.push(`stories[${i}].name is required`);
      if (typeof s.issue !== 'number' || s.issue <= 0) errors.push(`stories[${i}].issue must be a positive number`);

      if (typeof s.id === 'string') {
        if (storyIds.has(s.id)) errors.push(`Duplicate story ID: "${s.id}"`);
        storyIds.add(s.id);
      }
      if (typeof s.issue === 'number') {
        if (issueNumbers.has(s.issue)) errors.push(`Duplicate issue number: ${s.issue}`);
        issueNumbers.add(s.issue);
      }

      // Validate depends_on references
      if (Array.isArray(s.depends_on)) {
        for (const dep of s.depends_on) {
          if (typeof dep !== 'string') errors.push(`stories[${i}].depends_on must contain strings`);
        }
      }
    }

    // Validate depends_on references exist (second pass)
    for (const s of f.stories as StoryDefinition[]) {
      if (s.depends_on) {
        for (const dep of s.depends_on) {
          if (!storyIds.has(dep)) {
            errors.push(`Story "${s.id}" depends on "${dep}" which does not exist`);
          }
        }
      }
    }
  }

  // Review
  if (!f.review || typeof f.review !== 'object') {
    errors.push('feature.review is required');
  } else {
    const r = f.review as Record<string, unknown>;
    if (typeof r.enabled !== 'boolean') errors.push('review.enabled must be a boolean');
    if (!Array.isArray(r.focus_areas)) errors.push('review.focus_areas must be an array');
    if (!r.output || typeof r.output !== 'string') errors.push('review.output is required');
    if (typeof r.fail_on_critical !== 'boolean') errors.push('review.fail_on_critical must be a boolean');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid feature definition:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  // Check for circular dependencies
  resolveExecutionOrder(f.stories as StoryDefinition[]);

  return raw as FeatureDefinition;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Topological Sort (Kahn's Algorithm)
// ═══════════════════════════════════════════════════════════════════════════════

function resolveExecutionOrder(stories: StoryDefinition[]): ExecutionPlan {
  const ids = stories.map((s) => s.id);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const story of stories) {
    if (story.depends_on) {
      for (const dep of story.depends_on) {
        adjacency.get(dep)?.push(story.id);
        inDegree.set(story.id, (inDegree.get(story.id) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(id);
  }

  const order: string[] = [];
  const groups: string[][] = [];

  while (queue.length > 0) {
    const currentLevel = [...queue];
    groups.push(currentLevel);
    queue.length = 0;

    for (const id of currentLevel) {
      order.push(id);
      for (const neighbor of adjacency.get(id) || []) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }
  }

  if (order.length !== ids.length) {
    const remaining = ids.filter((id) => !order.includes(id));
    throw new Error(`Circular dependency detected involving: ${remaining.join(', ')}`);
  }

  return { order, independent_groups: groups };
}

// ═══════════════════════════════════════════════════════════════════════════════
// State Management (JSON file)
// ═══════════════════════════════════════════════════════════════════════════════

function getStatePath(repoPath: string): string {
  return join(repoPath, '.claude-epic', 'state.json');
}

function loadState(repoPath: string): OrcState {
  const statePath = getStatePath(repoPath);
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  }
  return { features: {} };
}

function saveState(repoPath: string, state: OrcState): void {
  const statePath = getStatePath(repoPath);
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Epic Fetching
// ═══════════════════════════════════════════════════════════════════════════════

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state: string;
}

function detectRepoFromGit(): string | null {
  try {
    const url = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    return url || null;
  } catch {
    return null;
  }
}

function fetchGitHubIssue(issueNumber: number): GitHubIssue {
  const output = execSync(
    `gh issue view ${issueNumber} --json number,title,body,labels,state`,
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ).toString().trim();
  return JSON.parse(output);
}

function extractStoriesFromEpic(issue: GitHubIssue): StoryDefinition[] {
  const stories: StoryDefinition[] = [];
  const body = issue.body || '';

  // Pattern 1: Checklist-linked issues — - [ ] #123 or - [x] #123
  const checklistPattern = /^[\s]*-\s*\[[ x]\]\s*#(\d+)/gm;
  let match;
  while ((match = checklistPattern.exec(body)) !== null) {
    const num = parseInt(match[1], 10);
    if (!stories.some((s) => s.issue === num)) {
      stories.push({ id: `story-${num}`, name: `Issue #${num}`, issue: num });
    }
  }

  // Pattern 2: Numbered issue references — 1. #123 or 1. Title (#123)
  const numberedPattern = /^\s*\d+\.\s*(?:.*?)#(\d+)/gm;
  while ((match = numberedPattern.exec(body)) !== null) {
    const num = parseInt(match[1], 10);
    if (!stories.some((s) => s.issue === num)) {
      stories.push({ id: `story-${num}`, name: `Issue #${num}`, issue: num });
    }
  }

  // Pattern 3: Bare issue references in Stories/Tasks sections
  const sectionPattern = /##\s*(?:Stories|Tasks)\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i;
  const sectionMatch = sectionPattern.exec(body);
  if (sectionMatch) {
    const sectionBody = sectionMatch[1];
    const refPattern = /#(\d+)/g;
    while ((match = refPattern.exec(sectionBody)) !== null) {
      const num = parseInt(match[1], 10);
      if (!stories.some((s) => s.issue === num)) {
        stories.push({ id: `story-${num}`, name: `Issue #${num}`, issue: num });
      }
    }
  }

  // Enrich story names from GitHub if we have stories
  for (const story of stories) {
    try {
      const storyIssue = fetchGitHubIssue(story.issue);
      story.name = storyIssue.title;
    } catch {
      // Keep the default name if fetch fails
    }
  }

  return stories;
}

function isEpicIssue(issue: GitHubIssue): boolean {
  const epicLabels = ['epic', 'tracking', 'parent', 'umbrella'];
  if (issue.labels.some((l) => epicLabels.includes(l.name.toLowerCase()))) return true;

  const body = issue.body || '';
  if (/##\s*(?:Stories|Tasks)/i.test(body)) return true;
  if (/^[\s]*-\s*\[[ x]\]\s*#\d+/m.test(body)) return true;
  if (/^\s*\d+\.\s*(?:.*?)#\d+/m.test(body)) return true;

  return false;
}

function buildFeatureFromEpic(issue: GitHubIssue, repoPath: string, baseBranch: string): FeatureDefinition {
  const stories = extractStoriesFromEpic(issue);

  if (stories.length === 0) {
    throw new Error(
      `Issue #${issue.number} doesn't appear to be an epic (no linked stories found).\n` +
      `Expected: checklist items (- [ ] #123), numbered references (1. #123), or a ## Stories section.`,
    );
  }

  return {
    feature: {
      id: `epic-${issue.number}`,
      name: issue.title,
      description: `Auto-generated from GitHub epic #${issue.number}`,
      repository: repoPath,
      base_branch: baseBranch,
      auto_merge: true,
      strategy: 'single-branch',
      stories,
      review: {
        enabled: false,
        focus_areas: [],
        output: '',
        fail_on_critical: false,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature Loading (YAML or GitHub)
// ═══════════════════════════════════════════════════════════════════════════════

async function loadFeatureDefinition(yamlPath: string): Promise<FeatureDefinition> {
  const absPath = resolve(yamlPath);
  if (!existsSync(absPath)) {
    throw new Error(`Feature file not found: ${absPath}`);
  }
  const content = readFileSync(absPath, 'utf-8');
  const raw = await parseYaml(content);
  return validateFeatureDefinition(raw);
}

async function loadFeatureFromIssue(issueNumber: number): Promise<FeatureDefinition> {
  console.log(`[epic] Fetching issue #${issueNumber} from GitHub...`);
  const issue = fetchGitHubIssue(issueNumber);

  if (!isEpicIssue(issue)) {
    throw new Error(
      `Issue #${issueNumber} ("${issue.title}") is not an epic.\n` +
      `To orchestrate it, add child stories as checklist items (- [ ] #123) or a ## Stories section.\n` +
      `For a single issue, use /flo ${issueNumber} instead.`,
    );
  }

  const repoPath = process.cwd();
  let baseBranch = 'main';
  try {
    baseBranch = execSync('gh repo view --json defaultBranchRef -q .defaultBranchRef.name', {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim() || 'main';
  } catch { /* use default */ }

  const featureDef = buildFeatureFromEpic(issue, repoPath, baseBranch);

  console.log(`[epic] Epic: ${issue.title}`);
  console.log(`[epic] Stories found: ${featureDef.feature.stories.length}`);
  for (const s of featureDef.feature.stories) {
    console.log(`  - #${s.issue}: ${s.name}`);
  }
  console.log('');

  return featureDef;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeEpicBranchName(epicNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  return `epic/${epicNumber}-${slug}`;
}

function findPrForIssue(
  issue: number,
  repoPath: string,
): { number: number; url: string } | null {
  try {
    const output = execSync(
      `gh pr list --state all --search "Closes #${issue}" --json number,url --limit 1`,
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();

    const prs = JSON.parse(output);
    if (prs.length > 0) {
      return { number: prs[0].number, url: prs[0].url };
    }

    // Fallback: search by issue number in title
    const output2 = execSync(
      `gh pr list --state all --search "#${issue}" --json number,url --limit 1`,
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();

    const prs2 = JSON.parse(output2);
    if (prs2.length > 0) {
      return { number: prs2[0].number, url: prs2[0].url };
    }

    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Story Runner
// ═══════════════════════════════════════════════════════════════════════════════

function runClaudeSession(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput?: (text: string) => void,
): Promise<{ success: boolean; output: string; durationMs: number; error: string | null }> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const args = ['-p', command, '--model', 'opus', '--verbose'];

    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: true,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      onOutput?.(chunk);
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        resolve({ success: false, output: stdout, durationMs, error: `Timed out after ${timeoutMs}ms` });
        return;
      }

      if (code !== 0) {
        resolve({ success: false, output: stdout, durationMs, error: `Claude exited with code ${code}: ${stderr.substring(0, 500)}` });
        return;
      }

      resolve({ success: true, output: stdout, durationMs, error: null });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude: ${error.message}`));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Formatting Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Subcommand: run
// ═══════════════════════════════════════════════════════════════════════════════

async function runFeature(
  source: string,
  dryRun: boolean,
  verbose: boolean,
  strategyOverride?: EpicStrategy,
): Promise<CommandResult> {
  // Detect whether source is a GitHub issue number or a YAML file path
  const isIssueNumber = /^\d+$/.test(source.trim());
  const featureDef = isIssueNumber
    ? await loadFeatureFromIssue(parseInt(source, 10))
    : await loadFeatureDefinition(source);
  const feature = featureDef.feature;
  const mofloConfig = loadMofloConfig(feature.repository);
  const strategy: EpicStrategy = strategyOverride || feature.strategy || mofloConfig.epic.default_strategy;
  const plan = resolveExecutionOrder(feature.stories);

  // ── Dry run ───────────────────────────────────────────────────────────
  if (dryRun) {
    console.log('');
    console.log('+-------------------------------------------------------------+');
    console.log(`| DRY RUN: ${pad(feature.name, 50)}|`);
    console.log(`| Base: ${pad(feature.base_branch, 53)}|`);
    console.log(`| Strategy: ${pad(strategy, 49)}|`);
    console.log('+-------------------------------------------------------------+');
    console.log('| Stories (via /flo):                                         |');
    for (let i = 0; i < plan.order.length; i++) {
      const story = feature.stories.find((s) => s.id === plan.order[i])!;
      const deps = story.depends_on?.length ? ` -> after ${story.depends_on.join(', ')}` : '';
      const flags = story.flo_flags || '-sw';
      const line = `${i + 1}. /flo ${story.issue} ${flags}${deps}`;
      console.log(`|  ${pad(line, 57)}|`);
      console.log(`|     ${pad(story.name.substring(0, 55), 55)}|`);
    }
    console.log('+-------------------------------------------------------------+');
    console.log(`| Review: ${pad(feature.review.enabled ? 'enabled' : 'disabled', 51)}|`);
    console.log('+-------------------------------------------------------------+');
    console.log('');
    return { success: true };
  }

  // ── Initialize state ──────────────────────────────────────────────────
  const state = loadState(feature.repository);

  if (!state.features[feature.id]) {
    state.features[feature.id] = {
      id: feature.id,
      name: feature.name,
      status: 'pending',
      started_at: null,
      completed_at: null,
      stories: {},
    };
    for (const storyId of plan.order) {
      const storyDef = feature.stories.find((s) => s.id === storyId)!;
      state.features[feature.id].stories[storyId] = {
        id: storyId,
        name: storyDef.name,
        status: 'pending',
        started_at: null,
        completed_at: null,
        duration_ms: 0,
        pr_url: null,
        pr_number: null,
        merged: false,
        error: null,
      };
    }
  }

  state.features[feature.id].status = 'running';
  state.features[feature.id].started_at = new Date().toISOString();
  saveState(feature.repository, state);

  console.log(`[epic] Strategy: ${strategy}`);

  // ── Single-branch: create one epic branch up front ────────────────────
  let epicBranch: string | null = null;
  if (strategy === 'single-branch') {
    const epicNumber = parseInt(feature.id.replace('epic-', ''), 10) || 0;
    epicBranch = makeEpicBranchName(epicNumber, feature.name);

    try {
      execSync(`git checkout ${feature.base_branch} && git pull origin ${feature.base_branch}`, {
        cwd: feature.repository,
        stdio: 'pipe',
      });
      execSync(`git checkout -b ${epicBranch}`, {
        cwd: feature.repository,
        stdio: 'pipe',
      });
      console.log(`[epic] Created branch: ${epicBranch}`);
    } catch {
      // Branch may already exist from a resumed run
      try {
        execSync(`git checkout ${epicBranch}`, {
          cwd: feature.repository,
          stdio: 'pipe',
        });
        console.log(`[epic] Resumed on existing branch: ${epicBranch}`);
      } catch (e) {
        console.log(`[FAIL] Could not create or checkout epic branch ${epicBranch}: ${String(e)}`);
        return { success: false };
      }
    }
  }

  // ── Execute stories ───────────────────────────────────────────────────
  const results: StoryResult[] = [];
  let failed = false;

  for (const storyId of plan.order) {
    const storyDef = feature.stories.find((s) => s.id === storyId)!;
    const storyState = state.features[feature.id].stories[storyId];

    // Skip already-passed stories (resume support)
    if (storyState && storyState.status === 'passed') {
      console.log(`[skip] ${storyId} (#${storyDef.issue}) -- already passed`);
      results.push({
        story_id: storyId,
        issue: storyDef.issue,
        status: 'passed',
        started_at: storyState.started_at || '',
        completed_at: storyState.completed_at || '',
        duration_ms: storyState.duration_ms,
        pr_url: storyState.pr_url,
        pr_number: storyState.pr_number,
        merged: storyState.merged,
        error: null,
      });
      continue;
    }

    // Check dependencies
    if (storyDef.depends_on?.length) {
      const unmet = storyDef.depends_on.filter(
        (dep) => !results.some((r) => r.story_id === dep && r.status === 'passed'),
      );
      if (unmet.length > 0) {
        console.log(`[skip] ${storyId} -- unmet dependencies: ${unmet.join(', ')}`);
        state.features[feature.id].stories[storyId].status = 'skipped';
        state.features[feature.id].stories[storyId].error = `Unmet deps: ${unmet.join(', ')}`;
        saveState(feature.repository, state);
        continue;
      }
    }

    // ── Run the story ─────────────────────────────────────────────────
    const startedAt = new Date().toISOString();
    const flags = storyDef.flo_flags || '-sw';

    // Build the /flo command based on strategy
    const epicFlag = epicBranch ? `--epic-branch ${epicBranch} ` : '';
    const floCommand = `/flo ${epicFlag}${storyDef.issue} ${flags}`.trim();

    console.log('');
    console.log(`=== Starting story: ${storyId} (#${storyDef.issue}) ===`);
    console.log(`    ${storyDef.name}`);
    console.log(`    Command: ${floCommand}`);
    console.log('');

    // Update state to running
    state.features[feature.id].stories[storyId].status = 'running';
    state.features[feature.id].stories[storyId].started_at = startedAt;
    saveState(feature.repository, state);

    if (strategy === 'auto-merge') {
      // Auto-merge strategy: checkout base branch before each story
      try {
        execSync(`git checkout ${feature.base_branch} && git pull origin ${feature.base_branch}`, {
          cwd: feature.repository,
          stdio: 'pipe',
        });
      } catch {
        console.log('[warn] Failed to pull base branch -- continuing anyway');
      }
    }
    // single-branch: stay on the epic branch — each story builds on the last

    // Spawn claude
    const runResult = await runClaudeSession(
      floCommand,
      feature.repository,
      STORY_TIMEOUT_MS,
      verbose ? (text) => process.stdout.write(text) : undefined,
    );

    if (!runResult.success) {
      console.log(`[FAIL] ${storyId}: ${runResult.error}`);
      state.features[feature.id].stories[storyId].status = 'failed';
      state.features[feature.id].stories[storyId].completed_at = new Date().toISOString();
      state.features[feature.id].stories[storyId].duration_ms = runResult.durationMs;
      state.features[feature.id].stories[storyId].error = runResult.error;
      saveState(feature.repository, state);

      results.push({
        story_id: storyId, issue: storyDef.issue, status: 'failed',
        started_at: startedAt, completed_at: new Date().toISOString(),
        duration_ms: runResult.durationMs, pr_url: null, pr_number: null,
        merged: false, error: runResult.error,
      });
      failed = true;
      break;
    }

    // ── Post-story handling depends on strategy ─────────────────────
    let prUrl: string | null = null;
    let prNumber: number | null = null;
    let merged = false;

    if (strategy === 'auto-merge') {
      // Auto-merge: find the PR that /flo created, then merge it
      const prInfo = findPrForIssue(storyDef.issue, feature.repository);

      if (!prInfo) {
        console.log(`[FAIL] ${storyId}: No PR found after /flo completed`);
        state.features[feature.id].stories[storyId].status = 'failed';
        state.features[feature.id].stories[storyId].completed_at = new Date().toISOString();
        state.features[feature.id].stories[storyId].duration_ms = runResult.durationMs;
        state.features[feature.id].stories[storyId].error = 'No PR created by /flo';
        saveState(feature.repository, state);

        results.push({
          story_id: storyId, issue: storyDef.issue, status: 'failed',
          started_at: startedAt, completed_at: new Date().toISOString(),
          duration_ms: runResult.durationMs, pr_url: null, pr_number: null,
          merged: false, error: 'No PR created by /flo',
        });
        failed = true;
        break;
      }

      console.log(`[ok] PR found: #${prInfo.number} (${prInfo.url})`);
      prUrl = prInfo.url;
      prNumber = prInfo.number;

      try {
        const adminFlag = mofloConfig.epic.admin_merge ? ' --admin' : '';
        execSync(`gh pr merge ${prInfo.number} --squash --delete-branch${adminFlag}`, {
          cwd: feature.repository,
          stdio: 'pipe',
        });
        merged = true;
        console.log(`[ok] PR #${prInfo.number} merged`);

        // Pull merged changes for next story
        execSync(`git checkout ${feature.base_branch} && git pull origin ${feature.base_branch}`, {
          cwd: feature.repository,
          stdio: 'pipe',
        });
      } catch (e) {
        console.log(`[warn] Failed to merge PR #${prInfo.number}: ${String(e)}`);
      }
    } else {
      // Single-branch: /flo committed but didn't push or create a PR.
      // Verify a commit was made for this story.
      try {
        const lastMsg = execSync('git log -1 --format=%s', {
          cwd: feature.repository,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString().trim();
        console.log(`[ok] Committed: ${lastMsg}`);
      } catch {
        console.log(`[ok] Story ${storyId} completed on epic branch`);
      }
    }

    // Update state
    state.features[feature.id].stories[storyId].status = 'passed';
    state.features[feature.id].stories[storyId].completed_at = new Date().toISOString();
    state.features[feature.id].stories[storyId].duration_ms = runResult.durationMs;
    state.features[feature.id].stories[storyId].pr_url = prUrl;
    state.features[feature.id].stories[storyId].pr_number = prNumber;
    state.features[feature.id].stories[storyId].merged = merged;
    saveState(feature.repository, state);

    results.push({
      story_id: storyId, issue: storyDef.issue, status: 'passed',
      started_at: startedAt, completed_at: new Date().toISOString(),
      duration_ms: runResult.durationMs, pr_url: prUrl, pr_number: prNumber,
      merged, error: null,
    });

    console.log(`=== Story completed: ${storyId} (${formatDuration(runResult.durationMs)}) ===`);
  }

  // ── Single-branch: push and create consolidated PR ────────────────────
  if (strategy === 'single-branch' && epicBranch && !failed) {
    console.log('');
    console.log(`[epic] All stories completed. Creating consolidated PR...`);

    try {
      execSync(`git push -u origin ${epicBranch}`, {
        cwd: feature.repository,
        stdio: 'pipe',
      });
    } catch (e) {
      console.log(`[FAIL] Failed to push epic branch: ${String(e)}`);
      failed = true;
    }

    if (!failed) {
      // Build the PR body with story list
      const storyLines = results
        .filter((r) => r.status === 'passed')
        .map((r) => {
          const storyDef = feature.stories.find((s) => s.issue === r.issue);
          return `- #${r.issue}: ${storyDef?.name || r.story_id}`;
        })
        .join('\n');

      const epicNumber = feature.id.replace('epic-', '');
      const prBody = [
        '## Summary',
        `Consolidated implementation for epic #${epicNumber}: ${feature.name}`,
        '',
        '## Stories Completed',
        storyLines,
        '',
        '## Testing',
        '- [x] Each story tested individually via /flo',
        '- [ ] Manual integration testing',
        '',
        `Closes #${epicNumber}`,
      ].join('\n');

      try {
        const prOutput = execSync(
          `gh pr create --title "epic: ${feature.name}" --body "${prBody.replace(/"/g, '\\"')}" --base ${feature.base_branch}`,
          { cwd: feature.repository, stdio: ['pipe', 'pipe', 'pipe'] },
        ).toString().trim();
        console.log(`[ok] Consolidated PR created: ${prOutput}`);

        // Extract PR URL and number from the output
        const prUrlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
        if (prUrlMatch) {
          const consolidatedPrUrl = prUrlMatch[0];
          const consolidatedPrNumber = parseInt(prUrlMatch[1], 10);
          // Update all story results with the consolidated PR info
          for (const r of results) {
            if (r.status === 'passed') {
              r.pr_url = consolidatedPrUrl;
              r.pr_number = consolidatedPrNumber;
              state.features[feature.id].stories[r.story_id].pr_url = consolidatedPrUrl;
              state.features[feature.id].stories[r.story_id].pr_number = consolidatedPrNumber;
            }
          }
        }
      } catch (e) {
        console.log(`[FAIL] Failed to create consolidated PR: ${String(e)}`);
        console.log(`[info] Epic branch '${epicBranch}' has been pushed — create PR manually`);
        failed = true;
      }
    }
  }

  // ── Finalize ──────────────────────────────────────────────────────────
  state.features[feature.id].status = failed ? 'failed' : 'completed';
  state.features[feature.id].completed_at = new Date().toISOString();
  saveState(feature.repository, state);

  // ── Summary ───────────────────────────────────────────────────────────
  printSummary(feature, results, plan.order);

  return { success: !failed };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Subcommand: status
// ═══════════════════════════════════════════════════════════════════════════════

function showStatus(featureId: string): CommandResult {
  // Search for state file in cwd
  const cwd = process.cwd();
  const state = loadState(cwd);

  const featureState = state.features[featureId];
  if (!featureState) {
    console.log(`No state found for feature "${featureId}"`);
    console.log(`Looked in: ${getStatePath(cwd)}`);
    return { success: false };
  }

  console.log('');
  console.log(`Feature: ${featureState.name} (${featureState.id})`);
  console.log(`Status:  ${featureState.status}`);
  console.log(`Started: ${featureState.started_at || '-'}`);
  console.log('');
  console.log(`${pad('Story', 22)} ${pad('Status', 10)} ${pad('Duration', 10)} ${pad('PR', 15)} Error`);
  console.log(`${'-'.repeat(22)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(15)} ${'─'.repeat(20)}`);

  for (const [, story] of Object.entries(featureState.stories)) {
    const duration = story.duration_ms > 0 ? formatDuration(story.duration_ms) : '-';
    const pr = story.pr_number ? `#${story.pr_number}${story.merged ? ' (merged)' : ''}` : '-';
    const error = story.error ? story.error.substring(0, 30) : '';
    console.log(`${pad(story.id, 22)} ${pad(story.status, 10)} ${pad(duration, 10)} ${pad(pr, 15)} ${error}`);
  }
  console.log('');

  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Subcommand: reset
// ═══════════════════════════════════════════════════════════════════════════════

function resetFeature(featureId: string): CommandResult {
  const cwd = process.cwd();
  const state = loadState(cwd);

  if (!state.features[featureId]) {
    console.log(`No state found for feature "${featureId}"`);
    return { success: false };
  }

  delete state.features[featureId];
  saveState(cwd, state);
  console.log(`Reset state for feature "${featureId}"`);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary Output
// ═══════════════════════════════════════════════════════════════════════════════

function printSummary(
  feature: FeatureDefinition['feature'],
  results: StoryResult[],
  order: string[],
): void {
  const featureStatus = results.some((r) => r.status === 'failed') ? 'FAILED' : 'COMPLETED';
  let totalDuration = 0;

  console.log('');
  console.log('+---------------------------------------------------------------------+');
  console.log(`| Feature: ${pad(feature.name, 58)}|`);
  console.log(`| Status: ${pad(featureStatus, 59)}|`);
  console.log('+----------------------+--------+----------+----------+---------------+');
  console.log('| Story                | Issue  | Status   | Duration | PR            |');
  console.log('+----------------------+--------+----------+----------+---------------+');

  for (const storyId of order) {
    const r = results.find((s) => s.story_id === storyId);
    const story = feature.stories.find((s) => s.id === storyId)!;
    const status = r?.status || 'pending';
    const icon = status === 'passed' ? '[ok]' : status === 'failed' ? '[!!]' : status === 'skipped' ? '[--]' : '[..]';
    const duration = r ? formatDuration(r.duration_ms) : '-';
    const pr = r?.pr_number ? `#${r.pr_number}${r.merged ? ' ok' : ''}` : '-';

    if (r) totalDuration += r.duration_ms;

    console.log(
      `| ${pad(storyId.substring(0, 20), 20)} | #${pad(String(story.issue), 5)} | ${icon} ${pad(status.substring(0, 6), 4)} | ${pad(duration, 8)} | ${pad(pr, 13)} |`,
    );
  }

  console.log('+----------------------+--------+----------+----------+---------------+');
  console.log(`| Total: ${pad(formatDuration(totalDuration), 61)}|`);
  console.log('+---------------------------------------------------------------------+');
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Command Definition
// ═══════════════════════════════════════════════════════════════════════════════

const epicCommand: Command = {
  name: 'epic',
  description: 'Epic orchestrator — sequences GitHub epics or YAML features through /flo workflows',
  options: [],
  examples: [
    { command: 'flo epic run 42', description: 'Execute epic (default: single-branch strategy)' },
    { command: 'flo epic run 42 --strategy auto-merge', description: 'Execute with per-story PRs and auto-merge' },
    { command: 'flo epic run 42 --dry-run', description: 'Show execution plan from GitHub epic' },
    { command: 'flo epic run feature.yaml', description: 'Execute a YAML feature definition' },
    { command: 'flo epic run feature.yaml --verbose', description: 'Execute with Claude output streaming' },
    { command: 'flo epic status my-feature', description: 'Check progress of a feature' },
    { command: 'flo epic reset my-feature', description: 'Reset feature state for re-run' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const subcommand = ctx.args?.[0];

    if (!subcommand) {
      console.log('Usage: flo epic <command> [args] [flags]');
      console.log('');
      console.log('Commands:');
      console.log('  run <issue | yaml>       Execute a GitHub epic or YAML feature');
      console.log('  status <feature-id>      Check feature progress');
      console.log('  reset <feature-id>       Reset feature state for re-run');
      console.log('');
      console.log('Examples:');
      console.log('  flo epic run 42           Fetch epic #42 from GitHub, run stories');
      console.log('  flo epic run feature.yaml Execute from YAML with dependencies');
      console.log('');
      console.log('Flags:');
      console.log('  --strategy <name>        Branching strategy: single-branch (default) or auto-merge');
      console.log('  --dry-run                Show execution plan without running');
      console.log('  --verbose                Stream Claude output to terminal');
      console.log('');
      console.log('Strategies:');
      console.log('  single-branch            One shared branch, one commit per story, one PR at end (default)');
      console.log('  auto-merge               Per-story branches and PRs, auto-merged sequentially');
      return { success: true };
    }

    switch (subcommand) {
      case 'run': {
        const source = ctx.args[1];
        if (!source) {
          console.log('Usage: flo epic run <issue-number | feature.yaml> [--strategy single-branch|auto-merge] [--dry-run] [--verbose]');
          return { success: false, message: 'Missing issue number or feature YAML path' };
        }
        const dryRun = ctx.flags['dry-run'] === true || ctx.flags['dryRun'] === true;
        const verbose = ctx.flags['verbose'] === true;
        const strategyFlag = ctx.flags['strategy'] as string | undefined;
        let strategyOverride: EpicStrategy | undefined;
        if (strategyFlag) {
          if (strategyFlag !== 'single-branch' && strategyFlag !== 'auto-merge') {
            console.log(`Unknown strategy: "${strategyFlag}". Use "single-branch" or "auto-merge".`);
            return { success: false, message: `Unknown strategy: ${strategyFlag}` };
          }
          strategyOverride = strategyFlag;
        }
        return runFeature(source, dryRun, verbose, strategyOverride);
      }

      case 'status': {
        const featureId = ctx.args[1];
        if (!featureId) {
          console.log('Usage: flo epic status <feature-id>');
          return { success: false, message: 'Missing feature ID' };
        }
        return showStatus(featureId);
      }

      case 'reset': {
        const featureId = ctx.args[1];
        if (!featureId) {
          console.log('Usage: flo epic reset <feature-id>');
          return { success: false, message: 'Missing feature ID' };
        }
        return resetFeature(featureId);
      }

      default:
        console.log(`Unknown subcommand: ${subcommand}`);
        console.log('Available: run, status, reset');
        return { success: false, message: `Unknown subcommand: ${subcommand}` };
    }
  },
};

export default epicCommand;
