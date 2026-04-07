/**
 * MCP Tool Name Constants
 *
 * Story #380: Centralize stringly-typed MCP tool names used by CLI commands.
 * These match the tool names registered in the MCP server (mcp-tools/*.ts).
 */

// Workflow / Spell tools
export const TOOL_WORKFLOW_RUN = 'workflow_run' as const;
export const TOOL_WORKFLOW_LIST = 'workflow_list' as const;
export const TOOL_WORKFLOW_STATUS = 'workflow_status' as const;
export const TOOL_WORKFLOW_CANCEL = 'workflow_cancel' as const;
export const TOOL_WORKFLOW_TEMPLATE = 'workflow_template' as const;

// Memory tools
export const TOOL_MEMORY_STORE = 'memory_store' as const;
export const TOOL_MEMORY_RETRIEVE = 'memory_retrieve' as const;
export const TOOL_MEMORY_LIST = 'memory_list' as const;
export const TOOL_MEMORY_STATS = 'memory_stats' as const;

// Session tools
export const TOOL_SESSION_CURRENT = 'session_current' as const;

// Progress tools
export const TOOL_PROGRESS_CHECK = 'progress_check' as const;
export const TOOL_PROGRESS_SUMMARY = 'progress_summary' as const;

// Hive-mind tools
export const TOOL_HIVE_MIND_JOIN = 'hive-mind_join' as const;
export const TOOL_HIVE_MIND_LEAVE = 'hive-mind_leave' as const;
export const TOOL_HIVE_MIND_CONSENSUS = 'hive-mind_consensus' as const;
export const TOOL_HIVE_MIND_BROADCAST = 'hive-mind_broadcast' as const;
export const TOOL_HIVE_MIND_MEMORY = 'hive-mind_memory' as const;

// Hooks tools
export const TOOL_HOOKS_INTELLIGENCE_RESET = 'hooks_intelligence-reset' as const;
export const TOOL_HOOKS_MODEL_OUTCOME = 'hooks_model-outcome' as const;

// Infrastructure tools
export const TOOL_MCP_STOP = 'mcp_stop' as const;
export const TOOL_SWARM_STOP = 'swarm_stop' as const;
