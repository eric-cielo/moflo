/**
 * Plugins System - ADR-004 Implementation
 *
 * Plugin architecture for extending MoFlo functionality.
 *
 * @module v3/shared/plugins
 */

/** Stable identity string for the plugins module. */
export const MODULE_ID = '@moflo/plugins';

// Types
export type {
  PluginConfig,
  PluginContext,
  PluginEvent,
  PluginEventHandler,
  ClaudeFlowPlugin,
  PluginMetadata,
  IPluginRegistry,
  IPluginLoader,
} from './types.js';

// Official Plugins
export {
  HiveMindPlugin,
  createHiveMindPlugin,
  type HiveMindConfig,
  type CollectiveDecision,
  type EmergentPattern,
  MaestroPlugin,
  createMaestroPlugin,
  type MaestroConfig,
  type SpellStep,
  type Spell,
  type OrchestrationResult,
} from './official/index.js';
