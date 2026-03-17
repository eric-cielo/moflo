/**
 * MoFlo Orc Command
 * Feature orchestrator that sequences GitHub issues through /mf workflows.
 *
 * Loads a feature YAML definition, resolves story dependencies via topological
 * sort, then executes each story sequentially by spawning `claude -p "/mf ..."`.
 *
 * Usage:
 *   moflo orc run <feature.yaml>              Execute a feature
 *   moflo orc run <feature.yaml> --dry-run    Show execution plan
 *   moflo orc status <feature-id>             Check progress
 *   moflo orc reset <feature-id>              Reset for re-run
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import type { Command, CommandContext, CommandResult } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

type StoryStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
type FeatureStatus = 'pending' | 'running' | 'completed' | 'failed';

interface StoryDefinition {
  id: string;
  name: string;
  issue: number;
  depends_on?: string[];
  cl_flags?: string;
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
  return join(repoPath, '.claude-orc', 'state.json');
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
// Feature Loading
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

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Helpers
// ═══════════════════════════════════════════════════════════════════════════════

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

async function runFeature(yamlPath: string, dryRun: boolean, verbose: boolean): Promise<CommandResult> {
  const featureDef = await loadFeatureDefinition(yamlPath);
  const feature = featureDef.feature;
  const autoMerge = feature.auto_merge !== false;
  const plan = resolveExecutionOrder(feature.stories);

  // ── Dry run ───────────────────────────────────────────────────────────
  if (dryRun) {
    console.log('');
    console.log('+-------------------------------------------------------------+');
    console.log(`| DRY RUN: ${pad(feature.name, 50)}|`);
    console.log(`| Base: ${pad(feature.base_branch, 53)}|`);
    console.log(`| Auto-merge: ${pad(autoMerge ? 'yes' : 'no', 47)}|`);
    console.log('+-------------------------------------------------------------+');
    console.log('| Stories (via /mf):                                          |');
    for (let i = 0; i < plan.order.length; i++) {
      const story = feature.stories.find((s) => s.id === plan.order[i])!;
      const deps = story.depends_on?.length ? ` -> after ${story.depends_on.join(', ')}` : '';
      const flags = story.cl_flags || '-sw';
      const line = `${i + 1}. /mf ${story.issue} ${flags}${deps}`;
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
    const flags = storyDef.cl_flags || '-sw';

    console.log('');
    console.log(`=== Starting story: ${storyId} (#${storyDef.issue}) ===`);
    console.log(`    ${storyDef.name}`);
    console.log(`    Command: /mf ${storyDef.issue} ${flags}`);
    console.log('');

    // Update state to running
    state.features[feature.id].stories[storyId].status = 'running';
    state.features[feature.id].stories[storyId].started_at = startedAt;
    saveState(feature.repository, state);

    // Pull latest main
    try {
      execSync(`git checkout ${feature.base_branch} && git pull origin ${feature.base_branch}`, {
        cwd: feature.repository,
        stdio: 'pipe',
      });
    } catch {
      console.log('[warn] Failed to pull base branch -- continuing anyway');
    }

    // Spawn claude
    const command = `/mf ${storyDef.issue} ${flags}`.trim();
    const runResult = await runClaudeSession(
      command,
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

    // Find the PR
    const prInfo = findPrForIssue(storyDef.issue, feature.repository);

    if (!prInfo) {
      console.log(`[FAIL] ${storyId}: No PR found after /mf completed`);
      state.features[feature.id].stories[storyId].status = 'failed';
      state.features[feature.id].stories[storyId].completed_at = new Date().toISOString();
      state.features[feature.id].stories[storyId].duration_ms = runResult.durationMs;
      state.features[feature.id].stories[storyId].error = 'No PR created by /mf';
      saveState(feature.repository, state);

      results.push({
        story_id: storyId, issue: storyDef.issue, status: 'failed',
        started_at: startedAt, completed_at: new Date().toISOString(),
        duration_ms: runResult.durationMs, pr_url: null, pr_number: null,
        merged: false, error: 'No PR created by /mf',
      });
      failed = true;
      break;
    }

    console.log(`[ok] PR found: #${prInfo.number} (${prInfo.url})`);

    // Auto-merge
    let merged = false;
    if (autoMerge) {
      try {
        execSync(`gh pr merge ${prInfo.number} --squash --delete-branch`, {
          cwd: feature.repository,
          stdio: 'pipe',
        });
        merged = true;
        console.log(`[ok] PR #${prInfo.number} merged`);

        // Pull merged changes
        execSync(`git checkout ${feature.base_branch} && git pull origin ${feature.base_branch}`, {
          cwd: feature.repository,
          stdio: 'pipe',
        });
      } catch (e) {
        console.log(`[warn] Failed to merge PR #${prInfo.number}: ${String(e)}`);
      }
    }

    // Update state
    state.features[feature.id].stories[storyId].status = 'passed';
    state.features[feature.id].stories[storyId].completed_at = new Date().toISOString();
    state.features[feature.id].stories[storyId].duration_ms = runResult.durationMs;
    state.features[feature.id].stories[storyId].pr_url = prInfo.url;
    state.features[feature.id].stories[storyId].pr_number = prInfo.number;
    state.features[feature.id].stories[storyId].merged = merged;
    saveState(feature.repository, state);

    results.push({
      story_id: storyId, issue: storyDef.issue, status: 'passed',
      started_at: startedAt, completed_at: new Date().toISOString(),
      duration_ms: runResult.durationMs, pr_url: prInfo.url, pr_number: prInfo.number,
      merged, error: null,
    });

    console.log(`=== Story completed: ${storyId} (${formatDuration(runResult.durationMs)}) ===`);
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

const orcCommand: Command = {
  name: 'orc',
  description: 'Feature orchestrator — sequences GitHub issues through /mf workflows',
  options: [],
  examples: [
    { command: 'moflo orc run feature.yaml', description: 'Execute a feature definition' },
    { command: 'moflo orc run feature.yaml --dry-run', description: 'Show execution plan without running' },
    { command: 'moflo orc run feature.yaml --verbose', description: 'Execute with Claude output streaming' },
    { command: 'moflo orc status my-feature', description: 'Check progress of a feature' },
    { command: 'moflo orc reset my-feature', description: 'Reset feature state for re-run' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const subcommand = ctx.args?.[0];

    if (!subcommand) {
      console.log('Usage: moflo orc <command> [args] [flags]');
      console.log('');
      console.log('Commands:');
      console.log('  run <feature.yaml>       Execute a feature definition');
      console.log('  status <feature-id>      Check feature progress');
      console.log('  reset <feature-id>       Reset feature state for re-run');
      console.log('');
      console.log('Flags:');
      console.log('  --dry-run                Show execution plan without running');
      console.log('  --verbose                Stream Claude output to terminal');
      return { success: true };
    }

    switch (subcommand) {
      case 'run': {
        const yamlPath = ctx.args[1];
        if (!yamlPath) {
          console.log('Usage: moflo orc run <feature.yaml> [--dry-run] [--verbose]');
          return { success: false, message: 'Missing feature YAML path' };
        }
        const dryRun = ctx.flags['dry-run'] === true || ctx.flags['dryRun'] === true;
        const verbose = ctx.flags['verbose'] === true;
        return runFeature(yamlPath, dryRun, verbose);
      }

      case 'status': {
        const featureId = ctx.args[1];
        if (!featureId) {
          console.log('Usage: moflo orc status <feature-id>');
          return { success: false, message: 'Missing feature ID' };
        }
        return showStatus(featureId);
      }

      case 'reset': {
        const featureId = ctx.args[1];
        if (!featureId) {
          console.log('Usage: moflo orc reset <feature-id>');
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

export default orcCommand;
