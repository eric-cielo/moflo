/**
 * Epic Module — shared epic detection and extraction.
 *
 * Story #195: Shared epic detection & extraction module.
 */

export type {
  GitHubIssue,
  StoryDefinition,
  EpicStrategy,
} from './types.js';

export {
  isEpicIssue,
  extractStories,
  extractUncheckedStories,
  fetchEpicIssue,
  enrichStoryNames,
  findPrForIssue,
} from './detection.js';
