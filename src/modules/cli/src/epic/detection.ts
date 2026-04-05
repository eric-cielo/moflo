/**
 * Epic Detection & Extraction
 *
 * Shared logic for detecting epics and extracting stories from issue bodies.
 * Used by both `flo epic` CLI command and `/flo` skill auto-detection.
 *
 * Story #195: Shared epic detection & extraction module.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubIssue, StoryDefinition } from './types.js';

const execAsync = promisify(exec);

// ============================================================================
// Epic Detection
// ============================================================================

const EPIC_LABELS = ['epic', 'tracking', 'parent', 'umbrella'];

/**
 * Determine whether a GitHub issue is an epic.
 *
 * Checks (in order):
 * 1. Label-based: epic, tracking, parent, umbrella (case-insensitive)
 * 2. Section-based: body contains `## Stories` or `## Tasks`
 * 3. Checklist-linked: `- [ ] #123` or `- [x] #123`
 * 4. Numbered references: `1. #123`
 */
export function isEpicIssue(issue: GitHubIssue): boolean {
  if (issue.labels.some(l => EPIC_LABELS.includes(l.name.toLowerCase()))) return true;

  const body = issue.body || '';
  if (/##\s*(?:Stories|Tasks)/i.test(body)) return true;
  if (/^[\s]*-\s*\[[ x]\]\s*#\d+/m.test(body)) return true;
  if (/^\s*\d+\.\s*(?:.*?)#\d+/m.test(body)) return true;

  return false;
}

// ============================================================================
// Story Extraction
// ============================================================================

/**
 * Extract story definitions from an epic issue body.
 *
 * Recognizes three patterns:
 * 1. Checklist: `- [ ] #123` or `- [x] #123`
 * 2. Numbered: `1. #123` or `1. Title (#123)`
 * 3. Bare references in `## Stories` / `## Tasks` sections
 *
 * Deduplicates by issue number; returns stories in document order.
 * Optionally enriches story names from GitHub (async).
 */
export function extractStories(issue: GitHubIssue): StoryDefinition[] {
  const stories: StoryDefinition[] = [];
  const body = issue.body || '';
  const seen = new Set<number>();

  function addStory(num: number): void {
    if (seen.has(num)) return;
    seen.add(num);
    stories.push({ id: `story-${num}`, name: `Issue #${num}`, issue: num });
  }

  // Pattern 1: Checklist — - [ ] #123 or - [x] #123
  const checklistPattern = /^[\s]*-\s*\[[ x]\]\s*#(\d+)/gm;
  let match;
  while ((match = checklistPattern.exec(body)) !== null) {
    addStory(parseInt(match[1], 10));
  }

  // Pattern 2: Numbered — 1. #123 or 1. Title (#123)
  const numberedPattern = /^\s*\d+\.\s*(?:.*?)#(\d+)/gm;
  while ((match = numberedPattern.exec(body)) !== null) {
    addStory(parseInt(match[1], 10));
  }

  // Pattern 3: Bare refs in Stories/Tasks section
  const sectionPattern = /##\s*(?:Stories|Tasks)\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i;
  const sectionMatch = sectionPattern.exec(body);
  if (sectionMatch) {
    const refPattern = /#(\d+)/g;
    while ((match = refPattern.exec(sectionMatch[1])) !== null) {
      addStory(parseInt(match[1], 10));
    }
  }

  return stories;
}

/**
 * Extract unchecked stories (not yet completed) from an epic body.
 */
export function extractUncheckedStories(issue: GitHubIssue): number[] {
  const unchecked: number[] = [];
  const body = issue.body || '';
  const pattern = /^[\s]*-\s*\[ \]\s*#(\d+)/gm;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    unchecked.push(parseInt(match[1], 10));
  }
  return unchecked;
}

// ============================================================================
// GitHub API
// ============================================================================

/**
 * Fetch a GitHub issue via the `gh` CLI.
 */
export async function fetchEpicIssue(issueNumber: number): Promise<GitHubIssue> {
  const { stdout } = await execAsync(
    `gh issue view ${issueNumber} --json number,title,body,labels,state`,
  );
  return JSON.parse(stdout.trim());
}

/**
 * Enrich story names by fetching titles from GitHub.
 * Failures are silently ignored (keeps default names).
 */
export async function enrichStoryNames(stories: StoryDefinition[]): Promise<void> {
  await Promise.all(
    stories.map(async (story) => {
      try {
        const issue = await fetchEpicIssue(story.issue);
        story.name = issue.title;
      } catch {
        // Keep default name
      }
    }),
  );
}

/**
 * Find a PR associated with an issue number.
 */
export async function findPrForIssue(
  issueNumber: number,
): Promise<{ number: number; url: string } | null> {
  try {
    const { stdout } = await execAsync(
      `gh pr list --state all --search "Closes #${issueNumber}" --json number,url --limit 1`,
    );
    const prs = JSON.parse(stdout.trim());
    if (prs.length > 0) return { number: prs[0].number, url: prs[0].url };

    // Fallback: search by issue number in title
    const { stdout: stdout2 } = await execAsync(
      `gh pr list --state all --search "#${issueNumber}" --json number,url --limit 1`,
    );
    const prs2 = JSON.parse(stdout2.trim());
    if (prs2.length > 0) return { number: prs2[0].number, url: prs2[0].url };

    return null;
  } catch {
    return null;
  }
}
