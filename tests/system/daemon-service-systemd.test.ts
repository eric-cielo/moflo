/**
 * Integration guard: the daemon-service Linux branch against REAL systemd.
 *
 * The unit tests (`src/cli/__tests__/services/daemon-service.test.ts`) inject a
 * stub runner and never spawn a subprocess — that is what makes them fast and
 * host-independent. This file is the other half of #1412: it exercises the real
 * `execSync` path exactly once, so a change that breaks the actual command
 * strings cannot pass on stub assertions alone.
 *
 * Two properties this file must hold, both of them the reason #1412 was filed:
 *
 * 1. **Timeout headroom.** `installDaemonService` issues up to 2 × 10s
 *    subprocess calls and `uninstallDaemonService` up to 3 × 10s. A test that
 *    may wait on them must allow more than their sum — vitest's default 5s is
 *    less than a SINGLE call's budget, which is arithmetically unsatisfiable
 *    and is precisely how the old unit tests produced timeouts that read as
 *    random flakiness. Hence the explicit 90s below.
 *
 * 2. **No registration in the developer's session.** `homeDir` is a temp dir,
 *    so the unit file lands outside every path the user systemd manager
 *    searches. `systemctl --user enable` therefore fails with "unit file does
 *    not exist" — a real round-trip through the real binary, with no service
 *    actually registered. Running the suite on a Linux workstation must never
 *    leave state behind in `~/.config/systemd/user`.
 *
 * Skipped off Linux, and on Linux hosts without a responsive `systemctl --user`
 * (containers, CI runners with no user session bus).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  installDaemonService,
  uninstallDaemonService,
  isDaemonInstalled,
} from '../../src/cli/services/daemon-service.js';

/** Worst case is uninstall's 3 × 10s chain; allow 3× headroom over that. */
const SUBPROCESS_CEILING_MS = 90_000;

function hasUserSystemd(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    // Cheapest probe that proves the user manager is answering. Deliberately
    // capped well under the 10s the service code allows — a host this slow to
    // answer is one where the integration assertions prove nothing anyway.
    execSync('systemctl --user show --property=Version', { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = hasUserSystemd();

describe('daemon-service against real systemd', () => {
  let projectRoot: string;
  let homeDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'daemon-systemd-root-'));
    homeDir = mkdtempSync(join(tmpdir(), 'daemon-systemd-home-'));
    mkdirSync(join(projectRoot, '.moflo'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it.skipIf(!CAN_RUN)(
    'installs and uninstalls through real systemctl without registering a unit',
    () => {
      const options = { platform: 'linux', homeDir } as const;

      const install = installDaemonService(projectRoot, options);
      expect(install.success).toBe(true);
      expect(existsSync(install.servicePath!)).toBe(true);
      expect(isDaemonInstalled(projectRoot, options)).toBe(true);

      const unit = readFileSync(install.servicePath!, 'utf-8');
      expect(unit).toContain('[Service]');
      expect(unit).toContain(`WorkingDirectory=${projectRoot}`);

      // The unit went to the sandboxed home, not the real config tree.
      expect(install.servicePath!.startsWith(homeDir)).toBe(true);

      const uninstall = uninstallDaemonService(projectRoot, options);
      expect(uninstall.success).toBe(true);
      expect(existsSync(install.servicePath!)).toBe(false);
      expect(isDaemonInstalled(projectRoot, options)).toBe(false);
    },
    SUBPROCESS_CEILING_MS,
  );

  it.skipIf(!CAN_RUN)(
    'leaves the real user systemd session untouched',
    () => {
      const options = { platform: 'linux', homeDir } as const;
      const install = installDaemonService(projectRoot, options);
      // Key on THIS run's unit name, not the `moflo-daemon-` prefix — a
      // developer dogfooding moflo legitimately has a real unit registered for
      // their own project, and asserting the prefix is absent would fail on
      // their machine for the wrong reason.
      const unitName = basename(install.servicePath!);

      try {
        const registered = execSync('systemctl --user list-unit-files --no-pager --no-legend', {
          timeout: 10_000,
          encoding: 'utf-8',
        });
        expect(registered).not.toContain(unitName);
      } finally {
        uninstallDaemonService(projectRoot, options);
      }
    },
    SUBPROCESS_CEILING_MS,
  );
});
