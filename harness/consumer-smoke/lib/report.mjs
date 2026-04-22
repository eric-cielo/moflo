/**
 * Smoke-harness reporting: structured status records + summary output.
 * status values: 'pass' | 'fail' | 'warn' | 'info'
 */

const results = [];
const started = Date.now();
let jsonMode = false;

export function configure({ json }) { jsonMode = !!json; }

export function log(...args) { if (!jsonMode) console.log(...args); }

export function section(title) {
  if (jsonMode) return;
  const bar = '─'.repeat(Math.max(1, 60 - title.length - 4));
  log(`\n── ${title} ${bar}`);
}

export function record(step, status, detail) {
  results.push({ step, status, detail });
  if (jsonMode) return;
  const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' }[status] ?? '----';
  log(`[${icon}] ${step}${detail ? ` — ${detail}` : ''}`);
}

export function getResults() { return results; }

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
