# `playwright` — Browser Automation Connector

**Purpose:** Use this connector for low-level browser automation via Playwright. Choose this when you need direct browser control from agent steps, or when building browser-based connectors like `local-outlook`.

## Usage

```yaml
- id: take-screenshot
  type: agent
  config:
    prompt: |
      Use the playwright connector to screenshot the homepage.
      Call context.tools.execute('playwright', 'navigate', {
        url: 'https://myapp.com'
      })
      Then call context.tools.execute('playwright', 'screenshot', {})
```

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
