/**
 * @claude-flow/shared - Shared Module
 * Common types, events, utilities, and core interfaces for V3 Claude-Flow
 *
 * Based on ADR-002 (DDD) and ADR-006 (Unified Memory Service)
 */

// Types - Shared type definitions
export * from './types.js';

// Events - Event bus and event sourcing (existing)
export * from './events.js';

// Event Sourcing - ADR-007 (Event Sourcing for State Changes)
export * from './events/index.js';

// Plugin System - ADR-004 (Plugin-Based Architecture)
export * from './plugin-interface.js';
export * from './plugin-loader.js';
export * from './plugin-registry.js';
export * from './plugins/index.js';

// Re-export from submodules for convenience
export * from './types/index.js';
export * from './core/index.js';

// Hooks System - Extensible hook points for tool execution and lifecycle events
export * from './hooks/index.js';
