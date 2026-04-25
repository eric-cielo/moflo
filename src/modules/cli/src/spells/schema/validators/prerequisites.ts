/**
 * Declarative prerequisite spec validation.
 *
 * Validates `prerequisites:` blocks at the spell and step level (external
 * deps like env vars, commands on PATH, or files). Added in #460 and kept
 * deliberately small so step validation can delegate here.
 */

import type { ValidationError } from '../../types/step-command.types.js';
import type { PrerequisiteSpec } from '../../types/spell-definition.types.js';

const VALID_DETECT_TYPES = ['env', 'command', 'file'] as const;

export function validatePrerequisites(
  prereqs: readonly PrerequisiteSpec[],
  errors: ValidationError[],
  path: string,
): void {
  if (!Array.isArray(prereqs)) {
    errors.push({ path, message: 'prerequisites must be an array' });
    return;
  }

  const seenNames = new Set<string>();
  prereqs.forEach((p, i) => {
    const pPath = `${path}[${i}]`;
    if (!p || typeof p !== 'object') {
      errors.push({ path: pPath, message: 'prerequisite entry must be an object' });
      return;
    }
    if (typeof p.name !== 'string' || p.name.length === 0) {
      errors.push({ path: `${pPath}.name`, message: 'prerequisite.name is required' });
    } else if (seenNames.has(p.name)) {
      errors.push({
        path: `${pPath}.name`,
        message: `duplicate prerequisite name "${p.name}" in the same block`,
      });
    } else {
      seenNames.add(p.name);
    }
    if (p.description !== undefined && typeof p.description !== 'string') {
      errors.push({ path: `${pPath}.description`, message: 'description must be a string' });
    }
    if (p.docsUrl !== undefined && typeof p.docsUrl !== 'string') {
      errors.push({ path: `${pPath}.docsUrl`, message: 'docsUrl must be a string' });
    }
    if (p.promptOnMissing !== undefined && typeof p.promptOnMissing !== 'boolean') {
      errors.push({ path: `${pPath}.promptOnMissing`, message: 'promptOnMissing must be a boolean' });
    }

    const detect = p.detect as PrerequisiteSpec['detect'] | undefined;
    if (!detect || typeof detect !== 'object') {
      errors.push({ path: `${pPath}.detect`, message: 'detect is required and must be an object' });
      return;
    }
    if (!VALID_DETECT_TYPES.includes(detect.type as typeof VALID_DETECT_TYPES[number])) {
      errors.push({
        path: `${pPath}.detect.type`,
        message: `detect.type must be one of: ${VALID_DETECT_TYPES.join(', ')}`,
      });
      return;
    }
    if (detect.type === 'env') {
      if (typeof detect.key !== 'string' || detect.key.length === 0) {
        errors.push({ path: `${pPath}.detect.key`, message: 'detect.key is required for env detector' });
      }
    } else if (detect.type === 'command') {
      if (typeof detect.command !== 'string' || detect.command.length === 0) {
        errors.push({ path: `${pPath}.detect.command`, message: 'detect.command is required for command detector' });
      }
    } else if (detect.type === 'file') {
      if (typeof detect.path !== 'string' || detect.path.length === 0) {
        errors.push({ path: `${pPath}.detect.path`, message: 'detect.path is required for file detector' });
      }
    }
  });
}
