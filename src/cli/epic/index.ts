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

export type { CheckOffResult } from './detection.js';

export {
  isEpicIssue,
  extractStories,
  extractUncheckedStories,
  fetchEpicIssue,
  enrichStoryNames,
  findPrForIssue,
  computeEpicCheckoff,
  checkOffStoryInEpic,
} from './detection.js';
