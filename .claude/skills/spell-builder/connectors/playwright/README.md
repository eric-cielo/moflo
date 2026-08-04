# `playwright` — Browser Automation Connector

**Purpose:** Use this connector for low-level browser automation via Playwright. Choose this when you need direct browser control from a step command, or when building browser-based connectors like `local-outlook`.

## Usage

From a spell, reach this connector through the `browser` step, which delegates to it:

```yaml
- id: take-screenshot
  type: browser
  config:
    actions:
      - action: navigate
        url: "https://myapp.com"
      - action: screenshot
```

> Earlier revisions of this file showed an `agent` step calling `context.tools.execute(...)` from a prompt. The `agent` step type has never been executable — use the `browser` step, a composite step's `tool` action, or a custom step command.

## Actions

| Action | Parameters | Description |
|--------|------------|-------------|
| `navigate` | `url` | Navigate to a URL |
| `click` | `selector` | Click an element matching the selector |
| `fill` | `selector`, `value` | Fill an input field with a value |
| `screenshot` | — | Capture a screenshot of the current page |
| `evaluate` | `expression` | Run JavaScript in the page context |

## Direct Usage

```javascript
await context.tools.execute('playwright', 'navigate', {
  url: 'https://dashboard.example.com/login'
});
await context.tools.execute('playwright', 'fill', {
  selector: '#email',
  value: 'admin@example.com'
});
await context.tools.execute('playwright', 'click', {
  selector: 'button[type="submit"]'
});
const shot = await context.tools.execute('playwright', 'screenshot', {});
```

## Capabilities

`read`, `write`

## Prerequisites

Requires `playwright` as a peer dependency.

## Source

`src/cli/spells/connectors/playwright.ts`
