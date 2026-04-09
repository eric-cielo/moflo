# `browser` — Web Automation via Playwright

**Purpose:** Use this step to drive a browser for scraping, testing, or web interaction. Choose this over `bash` + `curl` when you need JavaScript rendering, form filling, authentication flows, or page snapshots.

## Usage

```yaml
- id: scrape-dashboard
  type: browser
  config:
    headless: true
    userDataDir: "~/.moflo/browser-profiles/myapp"
    timeout: 45000
    actions:
      - action: open
        url: "https://dashboard.example.com/metrics"
      - action: fill
        selector: "#username"
        value: "{credentials.DASH_USER}"
      - action: fill
        selector: "#password"
        value: "{credentials.DASH_PASS}"
      - action: click
        selector: "#login-btn"
      - action: wait
        selector: ".metrics-table"
      - action: snapshot
        outputVar: metricsPage
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `actions` | Yes | — | Array of sequential browser actions |
| `headless` | No | `true` | Run without a visible browser window |
| `timeout` | No | `30000` | Default action timeout in milliseconds |
| `userDataDir` | No | — | Persistent browser profile path (preserves cookies/sessions) |

## Supported Actions

`open`, `click`, `fill`, `type`, `select`, `check`, `uncheck`, `hover`, `press`, `scroll`, `wait`, `snapshot`, `screenshot`, `evaluate`, `get-text`, `get-value`, `get-title`, `get-url`, `back`, `forward`, `reload`, `close`

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `html` | string | Page HTML (from `snapshot`) |
| `screenshot` | string | Base64-encoded screenshot |
| `text` | string | Extracted text content |
| *outputVar* | any | Custom variable set by actions with `outputVar` |

## Persistent Sessions

Set `userDataDir` to reuse login sessions across runs. Sign in once with `headless: false`, then all subsequent headless runs skip login automatically.

## Connector

Delegates to the `playwright` connector. See `connectors/playwright/README.md`.

## Source

`src/modules/spells/src/commands/browser-command.ts`
