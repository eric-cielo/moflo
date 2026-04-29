# Ticket Phase

`-t` updates an existing ticket when given an issue number, or creates a new GitHub issue when given a title. Either way, the ticket should include the three sections below.

## Complexity assessment

After research, score the work. The score decides whether the issue stays a single ticket or gets promoted to an epic with sub-issues.

**Signals — count those that apply:**

| Signal | Weight | Example |
|--------|--------|---------|
| Multiple files changed (5+) | +2 | Touches models, API, tests, docs, config |
| New module or package | +2 | Requires a new directory structure |
| Cross-cutting concern | +2 | Auth, logging, error handling across layers |
| Database/schema changes | +2 | Migrations, new tables, index changes |
| Multiple independent work streams | +3 | Frontend + backend + infra |
| External API integration | +1 | Third-party service, webhook, OAuth |
| Breaking change / migration | +2 | Deprecation, data migration |
| Significant test surface | +1 | 10+ new test cases across categories |
| Security implications | +1 | Authentication, authorization, input validation |
| UI + backend changes together | +2 | Full-stack feature spanning layers |

**Thresholds:**

| Score | Classification | Action |
|-------|---------------|--------|
| 0–3 | Simple | Single ticket, proceed |
| 4–6 | Moderate | Single ticket; flag in description that splitting may help |
| 7+ | Complex | Promote to epic — decompose into sub-issues |

When promoting to epic:

1. Decompose the work into 2–6 independent, shippable stories.
2. Each story should be completable in a single PR.
3. Stories should have clear boundaries (one concern per story).
4. Order stories by dependency (independent ones first).
5. Create each story as a GitHub issue with its own Description, Acceptance Criteria, and Test Cases.
6. Convert the parent issue into an epic with a `## Stories` checklist.

## Epic decomposition (score >= 7)

```bash
# Step 1: create each sub-issue
gh issue create --title "Story: <story-title>" --body "<## Description + ## Acceptance Criteria + ## Suggested Test Cases>" --label "story"
# capture the new issue number from output

# Step 2: repeat for all stories (typically 2–6)

# Step 3: build the epic body with a checklist referencing every story number

# Step 4: update an existing issue into an epic
gh issue edit <parent-number> --add-label "epic" --body "<epic body with ## Stories checklist>"

# Step 5: or create a new epic
gh issue create --title "Epic: <title>" --label "epic" --body "<epic body>"
```

**Epic body format** — the `## Stories` checklist with `- [ ] #<number>` is what enables epic detection, story extraction, and progress tracking:

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

## Build the ticket

The issue should include all three of these sections:

**Detailed Description** — Clear explanation of what needs to be done and why:
- Root cause (bugs) or approach rationale (features)
- Impact and risk
- Affected files (with line numbers), new files, deletions
- Implementation plan: numbered steps with actions, dependencies, decision points

**Acceptance Criteria** — Specific, testable conditions for "done":
- [ ] Criterion 1 (e.g. "API returns 200 with valid token")
- [ ] Criterion 2 (e.g. "Error message shown when input exceeds 255 chars")
- [ ] …each criterion independently verifiable

**Suggested Test Cases** — Concrete scenarios covering happy path, edge cases, and errors:
- Test case 1: description, input, expected output
- Test case 2: description, input, expected output
- Include unit, integration, and E2E suggestions as appropriate.

## Create or update the GitHub issue

Update an existing issue:
```bash
gh issue edit <issue-number> --body "<original body + ## Description + ## Acceptance Criteria + ## Suggested Test Cases>"
gh issue comment <issue-number> --body "Ticket enhanced with description, acceptance criteria, and test cases. Ready for execution."
```

Create a new issue:
```bash
gh issue create --title "<title>" --body "<## Description + ## Acceptance Criteria + ## Suggested Test Cases>"
```

Print the new issue URL.
