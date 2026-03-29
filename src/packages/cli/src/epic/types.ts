/**
 * Epic Types
 *
 * Shared type definitions for epic detection, extraction, and execution.
 * Used by both the `flo epic` CLI command and the `/flo` skill.
 *
 * Story #195: Shared epic detection & extraction module.
 */

// ============================================================================
// Status Types
// ============================================================================

export type StoryStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type FeatureStatus = 'pending' | 'running' | 'completed' | 'failed';
export type EpicStrategy = 'single-branch' | 'auto-merge';

// ============================================================================
// GitHub API
// ============================================================================

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly state: string;
}

// ============================================================================
// Story & Feature Definitions
// ============================================================================

export interface StoryDefinition {
  id: string;
  name: string;
  issue: number;
  depends_on?: string[];
  flo_flags?: string;
}

export interface ReviewDefinition {
  readonly enabled: boolean;
  readonly focus_areas: string[];
  readonly output: string;
  readonly fail_on_critical: boolean;
}

export interface FeatureDefinition {
  readonly feature: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly repository: string;
    readonly base_branch: string;
    readonly context?: string;
    readonly auto_merge?: boolean;
    readonly strategy?: EpicStrategy;
    readonly stories: StoryDefinition[];
    readonly review: ReviewDefinition;
  };
}

// ============================================================================
// Execution Plan
// ============================================================================

export interface ExecutionPlan {
  readonly order: string[];
  readonly independent_groups: string[][];
}

// ============================================================================
// Story Result
// ============================================================================

export interface StoryResult {
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
