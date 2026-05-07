/**
 * Daemon Autostart Lifecycle
 *
 * Reconciles the OS-native daemon login service against the count of enabled
 * scheduled spells. Replaces the old prompt-based flow in `daemon-readiness.ts`
 * (which left users with stale autostart entries when their last schedule was
 * cancelled — see #960, #961).
 *
 * Idempotent: callers invoke `reconcileDaemonAutostart` after every mutation
 * to `scheduled-spells`. It installs once, uninstalls once, and is a no-op
 * for every other transition.
 */

import {
  isDaemonInstalled as defaultIsDaemonInstalled,
  installDaemonService as defaultInstallDaemonService,
  uninstallDaemonService as defaultUninstallDaemonService,
  type ServiceInstallResult,
  type ServiceUninstallResult,
} from './daemon-service.js';

export type AutostartTransition = 'installed' | 'uninstalled' | 'noop';

export interface AutostartReconcileResult {
  /** Which side-effect, if any, the reconciler took. */
  readonly transition: AutostartTransition;
  /** User-facing one-liner explaining the transition (null when noop). */
  readonly message: string | null;
  /** Non-fatal warning surfaced when an install/uninstall failed. */
  readonly warning: string | null;
}

export interface AutostartReconcileOptions {
  /** Project root the daemon is anchored at — keys per-project install records. */
  readonly projectRoot: string;
  /** Number of currently enabled schedules in the `scheduled-spells` namespace. */
  readonly enabledScheduleCount: number;
  /** Caller opt-out (e.g. --no-autostart on create, --keep-autostart on cancel). */
  readonly skip?: boolean;
  /** Test injection. */
  readonly isDaemonInstalled?: (projectRoot: string) => boolean;
  readonly installDaemonService?: (projectRoot: string) => ServiceInstallResult;
  readonly uninstallDaemonService?: (projectRoot: string) => ServiceUninstallResult;
}

const NOOP: AutostartReconcileResult = { transition: 'noop', message: null, warning: null };

/**
 * Reconcile OS-native daemon autostart against schedule count.
 *
 * - count ≥ 1 + not installed → install
 * - count = 0 + installed     → uninstall
 * - all other states          → noop
 *
 * Never throws. Install/uninstall failures are returned as non-fatal warnings
 * — the caller decides whether to print them. The schedule mutation itself is
 * always considered the primary operation; autostart is best-effort.
 */
export function reconcileDaemonAutostart(
  options: AutostartReconcileOptions,
): AutostartReconcileResult {
  if (options.skip) return NOOP;

  const isInstalled = (options.isDaemonInstalled ?? defaultIsDaemonInstalled)(options.projectRoot);

  if (options.enabledScheduleCount >= 1 && !isInstalled) {
    const result = (options.installDaemonService ?? defaultInstallDaemonService)(options.projectRoot);
    if (result.success) {
      return {
        transition: 'installed',
        message: 'Daemon registered as OS login service so this schedule survives reboot.',
        warning: null,
      };
    }
    return {
      transition: 'noop',
      message: null,
      warning: `Could not register daemon as OS login service: ${result.message}`,
    };
  }

  if (options.enabledScheduleCount === 0 && isInstalled) {
    const result = (options.uninstallDaemonService ?? defaultUninstallDaemonService)(options.projectRoot);
    if (result.success) {
      return {
        transition: 'uninstalled',
        message: 'No enabled schedules remain — daemon unregistered from OS login services.',
        warning: null,
      };
    }
    return {
      transition: 'noop',
      message: null,
      warning: `Could not unregister daemon from OS login services: ${result.message}`,
    };
  }

  return NOOP;
}
