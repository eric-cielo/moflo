# User-Facing Language Guidelines

**Purpose:** Ensure all text shown to end users is approachable and non-alarming. MoFlo is used by developers and non-technical users alike — the language we use in output, prompts, reports, and error messages must be clear to someone who has never written code.

---

## Principles

1. **Avoid technical jargon in user-visible output.** Terms like "destructive", "mutation", "elevated privileges", or "sandbox escape" are meaningful to engineers but alarming or confusing to non-technical users. Prefer plain risk-level language: "No risk", "Low risk", "Moderate risk", "Higher risk".

2. **Explain what happens, not the mechanism.** Instead of "shell command execution", say "Runs commands on your machine". Instead of "fs:write capability", say "Creates, overwrites, or deletes files".

3. **Reserve technical terms for internal code.** Type names, variable names, config keys, log prefixes, and developer documentation can use precise technical language. The boundary is: if the user sees it, simplify it.

4. **Err on the side of calm.** When something requires attention, state the facts without dramatizing. "This step modifies files" is better than "WARNING: DESTRUCTIVE OPERATION DETECTED".

---

## Where This Applies

- Permission disclosure / risk analysis reports
- Error messages shown to users (not debug logs)
- CLI output and status messages
- MCP tool descriptions and response messages
- Spell dry-run and acceptance gate output
- Any `console.log` that a user will see during normal operation

## Where This Does NOT Apply

- Internal type definitions and variable names
- Developer-facing config keys (e.g., `allowDestructive` in spell YAML)
- Debug/trace logs gated behind verbose flags
- Code comments and docstrings
- Test descriptions
