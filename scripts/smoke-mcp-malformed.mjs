// One-off consumer-realistic smoke for the #1126 healer fix.
// Stages a `.mcp.json` shaped like the motailz failure (unescaped Windows
// backslashes), runs the shipped checkMcpServers + autoFixCheck against it,
// and reports before/after state. Not part of the test suite — manual repro
// for verifying consumer behavior after a dist rebuild.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-consumer-smoke-'));
fs.writeFileSync(
  path.join(consumer, 'package.json'),
  JSON.stringify({ name: 'fake-consumer', version: '0.0.0' }, null, 2),
);

// The exact motailz failure shape: backslash-Windows path inside JSON string
// without the `\\` escapes. JSON.parse throws on `\U`, `\m`, etc.
const cliPath = path.join(consumer, 'node_modules', 'moflo', 'bin', 'cli.js');
const bad =
  '{\n' +
  '  "mcpServers": {\n' +
  '    "moflo": {\n' +
  '      "command": "cmd",\n' +
  `      "args": ["/c", "node", "${cliPath}", "mcp", "start"]\n` +
  '    }\n' +
  '  }\n' +
  '}\n';

fs.writeFileSync(path.join(consumer, '.mcp.json'), bad);

try {
  JSON.parse(bad);
  console.log('BEFORE: malformed file parses?! unexpected');
} catch (e) {
  console.log('BEFORE: parseable=false,', e.message);
}

console.log('consumer dir:', consumer);
console.log('---');

const { inspectMcpConfigs, checkMcpServers } = await import(
  pathToFileURL(path.join(repoRoot, 'dist', 'src', 'cli', 'commands', 'doctor-checks-config.js')).href,
);

// Anchor the unified resolver on the synthetic consumer root.
process.env.CLAUDE_PROJECT_DIR = consumer;

const before = inspectMcpConfigs();
console.log('BEFORE inspectMcpConfigs.status:', before.status);
console.log('BEFORE inspectMcpConfigs.parseError:', before.parseError);

const checkBefore = await checkMcpServers();
console.log('BEFORE checkMcpServers:', { status: checkBefore.status, message: checkBefore.message, fix: checkBefore.fix });
console.log('---');

const { autoFixCheck } = await import(
  pathToFileURL(path.join(repoRoot, 'dist', 'src', 'cli', 'commands', 'doctor-fixes.js')).href,
);
const ok = await autoFixCheck(checkBefore);
console.log('autoFixCheck returned:', ok);

const regenerated = fs.readFileSync(path.join(consumer, '.mcp.json'), 'utf8');
let parsed;
try {
  parsed = JSON.parse(regenerated);
  console.log('AFTER: parseable=true');
} catch (e) {
  console.log('AFTER: parseable=false (REGRESSION),', e.message);
  process.exit(2);
}

console.log('AFTER: mcpServers keys:', Object.keys(parsed.mcpServers || {}));
console.log('AFTER: moflo.command:', parsed.mcpServers.moflo?.command);
console.log('AFTER: moflo.args:', parsed.mcpServers.moflo?.args);
console.log('AFTER: backup files:', fs.readdirSync(consumer).filter((f) => f.startsWith('.mcp.json.malformed-')));
console.log('AFTER: temp debris:', fs.readdirSync(consumer).filter((f) => f.includes('.tmp.')));

const checkAfter = await checkMcpServers();
console.log('AFTER checkMcpServers:', { status: checkAfter.status, message: checkAfter.message });

fs.rmSync(consumer, { recursive: true, force: true });
