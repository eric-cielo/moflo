/**
 * Epic Types — shared type definitions for epic detection and extraction.
 */

export type EpicStrategy = 'single-branch' | 'auto-merge';

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly state: string;
}

export interface StoryDefinition {
  id: string;
  name: string;
  issue: number;
}
