/**
 * Pure-JS counterpart to src/cli/services/daemon-port.ts.
 *
 * Lives in bin/lib because session-start-launcher.mjs and other bin/ scripts
 * run before any TS compilation has happened. The TS file is the canonical
 * API; this file MUST stay algorithmically identical (asserted by
 * `tests/system/daemon-port-twin.test.ts`).
 *
 * See `src/cli/services/daemon-port.ts` for the full doc + history.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PORT_RANGE_BASE = 33000;
export const PORT_RANGE_SIZE = 1000;
export const LEGACY_DEFAULT_PORT = 3117;

export function readEnvPortOverride() {
  const raw = process.env.MOFLO_DAEMON_PORT;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}

export function resolveProjectPort(projectRoot) {
  const envPort = readEnvPortOverride();
  if (envPort != null) return envPort;
  const hash = createHash('sha256').update(projectRoot).digest();
  return PORT_RANGE_BASE + (hash.readUInt16BE(0) % PORT_RANGE_SIZE);
}

export function resolveClientPort(projectRoot) {
  const envPort = readEnvPortOverride();
  if (envPort != null) return envPort;

  try {
    const lockFile = join(projectRoot, '.moflo', 'daemon.lock');
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
      const lockPort = typeof lock?.port === 'number' ? lock.port : null;
      if (lockPort && Number.isFinite(lockPort) && lockPort > 0 && lockPort < 65536) {
        return lockPort;
      }
    }
  } catch {
    // fall through
  }

  return resolveProjectPort(projectRoot);
}

export function serverPortCandidates(projectRoot, maxAttempts = 10) {
  const envPort = readEnvPortOverride();
  if (envPort != null) return [envPort];

  const base = resolveProjectPort(projectRoot);
  const attempts = Math.min(Math.max(1, maxAttempts), PORT_RANGE_SIZE);
  const ports = [];
  for (let i = 0; i < attempts; i++) {
    const candidate = PORT_RANGE_BASE + ((base - PORT_RANGE_BASE + i) % PORT_RANGE_SIZE);
    ports.push(candidate);
  }
  return ports;
}
