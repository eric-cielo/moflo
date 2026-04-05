/**
 * Epic Module — shared epic detection, extraction, and execution ordering.
 *
 * Story #195: Shared epic detection & extraction module.
 */

export type {
  GitHubIssue,
  StoryDefinition,
  StoryStatus,
  FeatureStatus,
  EpicStrategy,
  FeatureDefinition,
  ReviewDefinition,
  ExecutionPlan,
  StoryResult,
} from './types.js';

export {
  isEpicIssue,
  extractStories,
  extractUncheckedStories,
  fetchEpicIssue,
  enrichStoryNames,
  findPrForIssue,
} from './detection.js';

export { resolveExecutionOrder } from './execution-order.js';
