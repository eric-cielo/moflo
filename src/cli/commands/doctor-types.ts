/**
 * Shared type declarations for the doctor command tree.
 *
 * Imported as `import type { HealthCheck } from './doctor-types.js'` so the
 * import is erased at runtime — keeps the doctor-registry → doctor-checks-*
 * module graph free of value-level cycles.
 */

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export type CheckFn = () => Promise<HealthCheck>;
