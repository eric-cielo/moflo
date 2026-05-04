/**
 * Smoke-harness reporting: structured status records + summary output.
 * status values: 'pass' | 'fail' | 'warn' | 'info'
 *
 * Summary mode (issue #907): suppress per-check PASS/INFO rows and section
 * dividers when the run is going to a log file or an LLM tool. Section
 * headers are deferred and only emitted lazily when a FAIL/WARN lands inside
 * the section — so the reader sees the failure with its breadcrumb.
 */

const results = [];
let started = Date.now();
let jsonMode = false;
let summaryMode = false;
let pendingSection = null;

export function configure({ json, summary } = {}) {
  jsonMode = !!json;
  summaryMode = !!summary;
}

export function log(...args) {
  if (jsonMode || summaryMode) return;
  console.log(...args);
}

function emitSection(title) {
  const bar = '─'.repeat(Math.max(1, 60 - title.length - 4));
  console.log(`\n── ${title} ${bar}`);
}

export function section(title) {
  if (jsonMode) return;
  if (summaryMode) {
    pendingSection = title;
    return;
  }
  emitSection(title);
}

export function record(step, status, detail) {
  results.push({ step, status, detail });
  if (jsonMode) return;
  if (summaryMode && status !== 'fail' && status !== 'warn') return;
  if (summaryMode && pendingSection) {
    emitSection(pendingSection);
    pendingSection = null;
  }
  const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' }[status] ?? '----';
  console.log(`[${icon}] ${step}${detail ? ` — ${detail}` : ''}`);
}

export function getResults() { return results; }

/**
 * Issue #907: resolve summary mode from argv. Explicit `--summary` /
 * `--no-summary` win; otherwise default to summary when stdout is non-TTY
 * (piped to a file or LLM tool) and not in --json mode. Shared by both
 * harness runners so flag semantics can't drift.
 */
export function resolveSummaryMode(argv, { isTTY = process.stdout.isTTY } = {}) {
  if (argv.includes('--no-summary')) return false;
  if (argv.includes('--summary')) return true;
  if (argv.includes('--json')) return false;
  return isTTY === false;
}

/** Test-only: reset module-level state between cases. */
export function _resetForTest() {
  results.length = 0;
  jsonMode = false;
  summaryMode = false;
  pendingSection = null;
  started = Date.now();
}

/**
 * Collapse the `record(step, res.code === 0 ? 'pass' : 'fail', res.code === 0 ? '' : 'exit N…')`
 * pattern that repeats for almost every subprocess check. okCodes lets checks
 * treat multiple exit codes as success (e.g. doctor returns 1 on warnings).
 */
export function recordExit(step, res, { okCodes = [0], detailOk = '' } = {}) {
  if (okCodes.includes(res.code)) {
    record(step, 'pass', detailOk || (okCodes.length > 1 ? `exit ${res.code}` : ''));
    return true;
  }
  const tail = (res.stderr || res.stdout).trim().slice(0, 200);
  record(step, 'fail', `exit ${res.code}${tail ? `: ${tail}` : ''}`);
  return false;
}

export function printSummary() {
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const warn = results.filter(r => r.status === 'warn').length;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (jsonMode) {
    console.log(JSON.stringify({ pass, fail, warn, elapsed, results }, null, 2));
    return;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Summary: ${pass} passed, ${fail} failed, ${warn} warn in ${elapsed}s`);
  if (fail > 0) {
    console.log('\nFailed:');
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`  - ${r.step}: ${r.detail || '(no detail)'}`);
    }
  }
  if (warn > 0) {
    console.log('\nWarnings (known regressions, do not block):');
    for (const r of results.filter(r => r.status === 'warn')) {
      console.log(`  - ${r.step}: ${r.detail || '(no detail)'}`);
    }
  }
  console.log('═'.repeat(60));
}
