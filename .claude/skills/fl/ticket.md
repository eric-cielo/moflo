# Ticket Phase (-t creates or updates a ticket)

When given an issue number, `-t` enhances the existing ticket. When given a title (non-numeric argument), `-t` creates a new GitHub issue. Either way, the ticket MUST include all three of the following sections.

## Complexity Assessment (MANDATORY before building ticket)

After research, assess the complexity of the work. This determines whether the issue stays as a single ticket or gets promoted to an epic with sub-issues.

**Complexity Signals — count how many apply:**

| Signal | Weight | Example |
|--------|--------|---------|
| Multiple files changed (5+) | +2 | Touches models, API, tests, docs, config |
| New module or package | +2 | Requires new directory structure |
| Cross-cutting concern | +2 | Auth, logging, error handling across layers |
| Database/schema changes | +2 | Migrations, new tables, index changes |
| Multiple independent work streams | +3 | Frontend + backend + infra changes |
| External API integration | +1 | Third-party service, webhook, OAuth |
| Breaking change / migration | +2 | Requires deprecation, data migration |
| Significant test surface | +1 | Needs 10+ new test cases across categories |
| Security implications | +1 | Authentication, authorization, input validation |
| UI + backend changes together | +2 | Full-stack feature spanning layers |

**Complexity Thresholds:**

| Score | Classification | Action |
|-------|---------------|--------|
| 0–3 | **Simple** | Single ticket — proceed normally |
| 4–6 | **Moderate** | Single ticket — flag in description that it may benefit from splitting |
| 7+ | **Complex** | **PROMOTE TO EPIC** — decompose into sub-issues |

**When promoting to epic:**

1. Decompose the work into 2–6 independent, shippable stories
2. Each story should be completable in a single PR
3. Stories should have clear boundaries (one concern per story)
4. Order stories by dependency (independent ones first)
5. Create each story as a GitHub issue with its own Description, Acceptance Criteria, and Test Cases
6. Create or convert the parent issue into an epic with a `## Stories` checklist

## Epic Decomposition (when score >= 7)

When complexity warrants an epic, decompose into stories:

```bash
# Step 1: Create each sub-issue
gh issue create --title "Story: <story-title>" --body "<## Description + ## Acceptance Criteria + ## Suggested Test Cases>" --label "story"
# Capture the new issue number from output

# Step 2: Repeat for all stories (2-6 stories typically)

# Step 3: Build the epic body with checklist referencing ALL story issue numbers
# Step 4: If updating an existing issue, convert it to epic:
gh issue edit <parent-number> --add-label "epic" --body "<epic body with ## Stories checklist>"

# Step 5: If creating new, create the epic:
gh issue create --title "Epic: <title>" --label "epic" --body "<epic body>"
```

**Epic body format (MANDATORY — this is how tracking works):**

```markdown
## Overview
<High-level description of the epic goal>

## Stories

- [ ] #<story-1-number> <story-1-title>
- [ ] #<story-2-number> <story-2-title>
- [ ] #<story-3-number> <story-3-title>

## Complexity Assessment
Score: <N>/20 — <Simple|Moderate|Complex>
Signals: <list of signals that triggered>
```

The `## Stories` checklist with `- [ ] #<number>` format is **mandatory** — this is what enables:
- Epic detection by the `/flo` skill
- Story extraction for sequential processing
- Progress tracking via checked/unchecked items

## Build Ticket Content

Compile research into a well-structured ticket. The issue MUST include all three of the following sections:

**Detailed Description** — Clear, thorough explanation of what needs to be done and why. Include:
- Root cause analysis (bugs) or approach rationale (features)
- Impact and risk factors
- Affected files (with line numbers), new files, deletions
- Implementation plan: numbered steps with clear actions, dependencies, decision points

**Acceptance Criteria** — Specific, testable conditions that must be true for this issue to be considered complete. Write as a checklist:
- [ ] Criterion 1 (e.g., "API returns 200 with valid token")
- [ ] Criterion 2 (e.g., "Error message shown when input exceeds 255 chars")
- [ ] ...each criterion must be independently verifiable

**Suggested Test Cases** — Concrete test scenarios covering happy path, edge cases, and error conditions:
- Test case 1: description, input, expected output
- Test case 2: description, input, expected output
- Include unit, integration, and E2E test suggestions as appropriate

## Create or Update GitHub Issue

**If issue number was given** (update existing):
```bash
gh issue edit <issue-number> --body "<original body + ## Description + ## Acceptance Criteria + ## Suggested Test Cases>"
gh issue comment <issue-number> --body "Ticket enhanced with description, acceptance criteria, and test cases. Ready for execution."
```

**If title was given** (create new):
```bash
gh issue create --title "<title>" --body "<## Description + ## Acceptance Criteria + ## Suggested Test Cases>"
```
Print the new issue URL so the user can see it.
