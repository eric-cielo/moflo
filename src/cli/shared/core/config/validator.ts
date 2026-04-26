/**
 * V3 Configuration Validator
 * Validation logic using Valibot schemas
 */

import * as v from 'valibot';
import {
  AgentConfigSchema,
  TaskConfigSchema,
  SwarmConfigSchema,
  MemoryConfigSchema,
  MCPServerConfigSchema,
  OrchestratorConfigSchema,
  SystemConfigSchema,
  type AgentConfig,
  type TaskConfig,
  type SwarmConfig,
  type MemoryConfig,
  type MCPServerConfig,
  type OrchestratorConfig,
  type SystemConfig,
} from './schema.js';

/**
 * Validation result
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
}

/**
 * Validation error
 */
export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

/**
 * Convert Valibot issues to validation errors
 */
function valibotIssuesToValidationErrors(issues: v.BaseIssue<unknown>[]): ValidationError[] {
  return issues.map((issue) => ({
    path: issue.path?.map((p) => 'key' in p ? String(p.key) : String(p)).join('.') ?? '',
    message: issue.message,
    code: issue.type,
  }));
}

/**
 * Generic validation function
 * Uses parse + try/catch to get output types with defaults applied
 */
function validate<TSchema extends v.GenericSchema>(
  schema: TSchema,
  data: unknown
): ValidationResult<v.InferOutput<TSchema>> {
  const result = v.safeParse(schema, data);
  if (result.success) {
    return {
      success: true,
      data: result.output,
    };
  }
  return {
    success: false,
    errors: valibotIssuesToValidationErrors(result.issues),
  };
}

/**
 * Validate agent configuration
 */
export function validateAgentConfig(data: unknown): ValidationResult<AgentConfig> {
  return validate(AgentConfigSchema, data);
}

/**
 * Validate task configuration
 */
export function validateTaskConfig(data: unknown): ValidationResult<TaskConfig> {
  return validate(TaskConfigSchema, data);
}

/**
 * Validate swarm configuration
 */
export function validateSwarmConfig(data: unknown): ValidationResult<SwarmConfig> {
  return validate(SwarmConfigSchema, data);
}

/**
 * Validate memory configuration
 */
export function validateMemoryConfig(data: unknown): ValidationResult<MemoryConfig> {
  return validate(MemoryConfigSchema, data);
}

/**
 * Validate MCP server configuration
 */
export function validateMCPServerConfig(data: unknown): ValidationResult<MCPServerConfig> {
  return validate(MCPServerConfigSchema, data);
}

/**
 * Validate orchestrator configuration
 */
export function validateOrchestratorConfig(data: unknown): ValidationResult<OrchestratorConfig> {
  return validate(OrchestratorConfigSchema, data);
}

/**
 * Validate full system configuration
 */
export function validateSystemConfig(data: unknown): ValidationResult<SystemConfig> {
  return validate(SystemConfigSchema, data);
}

/**
 * Configuration validator class
 */
export class ConfigValidator {
  /**
   * Validate and throw on error
   */
  static validateOrThrow<TSchema extends v.GenericSchema>(
    schema: TSchema,
    data: unknown,
    configName: string
  ): v.InferOutput<TSchema> {
    const result = validate(schema, data);

    if (!result.success) {
      const errorMessages = result.errors
        ?.map((e) => `  - ${e.path}: ${e.message}`)
        .join('\n');
      throw new Error(`Invalid ${configName} configuration:\n${errorMessages}`);
    }

    return result.data!;
  }

  /**
   * Validate agent config or throw
   */
  static validateAgentOrThrow(data: unknown): AgentConfig {
    return this.validateOrThrow(AgentConfigSchema, data, 'agent');
  }

  /**
   * Validate task config or throw
   */
  static validateTaskOrThrow(data: unknown): TaskConfig {
    return this.validateOrThrow(TaskConfigSchema, data, 'task');
  }

  /**
   * Validate swarm config or throw
   */
  static validateSwarmOrThrow(data: unknown): SwarmConfig {
    return this.validateOrThrow(SwarmConfigSchema, data, 'swarm');
  }

  /**
   * Validate memory config or throw
   */
  static validateMemoryOrThrow(data: unknown): MemoryConfig {
    return this.validateOrThrow(MemoryConfigSchema, data, 'memory');
  }

  /**
   * Validate MCP server config or throw
   */
  static validateMCPServerOrThrow(data: unknown): MCPServerConfig {
    return this.validateOrThrow(MCPServerConfigSchema, data, 'MCP server');
  }

  /**
   * Validate orchestrator config or throw
   */
  static validateOrchestratorOrThrow(data: unknown): OrchestratorConfig {
    return this.validateOrThrow(OrchestratorConfigSchema, data, 'orchestrator');
  }

  /**
   * Validate system config or throw
   */
  static validateSystemOrThrow(data: unknown): SystemConfig {
    return this.validateOrThrow(SystemConfigSchema, data, 'system');
  }

  /**
   * Check if data matches schema
   */
  static isValid<TSchema extends v.GenericSchema>(
    schema: TSchema,
    data: unknown
  ): boolean {
    return validate(schema, data).success;
  }
}
