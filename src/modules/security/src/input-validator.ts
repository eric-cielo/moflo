/**
 * Input Validator - Comprehensive Input Validation
 *
 * Provides Valibot-based validation schemas for all security-critical inputs.
 *
 * Security Properties:
 * - Type-safe validation
 * - Custom error messages
 * - Sanitization transforms
 * - Reusable schemas
 *
 * @module v3/security/input-validator
 */

import * as v from 'valibot';

/**
 * Common validation patterns as reusable regex
 */
const PATTERNS = {
  // Safe identifier: alphanumeric with underscore/hyphen
  SAFE_IDENTIFIER: /^[a-zA-Z][a-zA-Z0-9_-]*$/,

  // Safe filename: alphanumeric with dot, underscore, hyphen
  SAFE_FILENAME: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,

  // Safe path segment: no traversal
  SAFE_PATH_SEGMENT: /^[^<>:"|?*\x00-\x1f]+$/,

  // No shell metacharacters
  NO_SHELL_CHARS: /^[^;&|`$(){}><\n\r\0]+$/,

  // Semantic version
  SEMVER: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
};

/**
 * Validation limits
 */
const LIMITS = {
  MIN_PASSWORD_LENGTH: 8,
  MAX_PASSWORD_LENGTH: 128,
  MAX_EMAIL_LENGTH: 254,
  MAX_IDENTIFIER_LENGTH: 64,
  MAX_PATH_LENGTH: 4096,
  MAX_CONTENT_LENGTH: 1024 * 1024, // 1MB
  MAX_ARRAY_LENGTH: 1000,
  MAX_OBJECT_KEYS: 100,
};

// ============================================================================
// Base Validation Schemas
// ============================================================================

/**
 * Safe string that cannot contain shell metacharacters
 */
export const SafeStringSchema = v.pipe(
  v.string(),
  v.minLength(1, 'String cannot be empty'),
  v.maxLength(LIMITS.MAX_CONTENT_LENGTH, 'String too long'),
  v.regex(PATTERNS.NO_SHELL_CHARS, 'String contains invalid characters'),
);

/**
 * Safe identifier for IDs, names, etc.
 */
export const IdentifierSchema = v.pipe(
  v.string(),
  v.minLength(1, 'Identifier cannot be empty'),
  v.maxLength(LIMITS.MAX_IDENTIFIER_LENGTH, 'Identifier too long'),
  v.regex(PATTERNS.SAFE_IDENTIFIER, 'Invalid identifier format'),
);

/**
 * Safe filename
 */
export const FilenameSchema = v.pipe(
  v.string(),
  v.minLength(1, 'Filename cannot be empty'),
  v.maxLength(255, 'Filename too long'),
  v.regex(PATTERNS.SAFE_FILENAME, 'Invalid filename format'),
);

/**
 * Email schema with length limit
 */
export const EmailSchema = v.pipe(
  v.string(),
  v.email('Invalid email format'),
  v.maxLength(LIMITS.MAX_EMAIL_LENGTH, 'Email too long'),
  v.toLowerCase(),
);

/**
 * Password schema with complexity requirements
 */
export const PasswordSchema = v.pipe(
  v.string(),
  v.minLength(LIMITS.MIN_PASSWORD_LENGTH, `Password must be at least ${LIMITS.MIN_PASSWORD_LENGTH} characters`),
  v.maxLength(LIMITS.MAX_PASSWORD_LENGTH, `Password must not exceed ${LIMITS.MAX_PASSWORD_LENGTH} characters`),
  v.check((val) => /[A-Z]/.test(val), 'Password must contain uppercase letter'),
  v.check((val) => /[a-z]/.test(val), 'Password must contain lowercase letter'),
  v.check((val) => /\d/.test(val), 'Password must contain digit'),
);

/**
 * UUID schema
 */
export const UUIDSchema = v.pipe(v.string(), v.uuid('Invalid UUID format'));

/**
 * URL schema with HTTPS enforcement
 */
export const HttpsUrlSchema = v.pipe(
  v.string(),
  v.url('Invalid URL format'),
  v.check(
    (val) => val.startsWith('https://'),
    'URL must use HTTPS',
  ),
);

/**
 * URL schema (allows HTTP for development)
 */
export const UrlSchema = v.pipe(v.string(), v.url('Invalid URL format'));

/**
 * Semantic version schema
 */
export const SemverSchema = v.pipe(
  v.string(),
  v.regex(PATTERNS.SEMVER, 'Invalid semantic version format'),
);

/**
 * Port number schema
 */
export const PortSchema = v.pipe(
  v.number('Port must be a number'),
  v.integer('Port must be an integer'),
  v.minValue(1, 'Port must be at least 1'),
  v.maxValue(65535, 'Port must be at most 65535'),
);

/**
 * IP address schema (v4)
 */
export const IPv4Schema = v.pipe(
  v.string(),
  v.ipv4('Invalid IPv4 address'),
);

/**
 * IP address schema (v4 or v6)
 */
export const IPSchema = v.pipe(
  v.string(),
  v.ip('Invalid IP address'),
);

// ============================================================================
// Authentication Schemas
// ============================================================================

/**
 * User role schema
 */
export const UserRoleSchema = v.picklist([
  'admin',
  'operator',
  'developer',
  'viewer',
  'service',
]);

/**
 * Permission schema
 */
export const PermissionSchema = v.picklist([
  'swarm.create',
  'swarm.read',
  'swarm.update',
  'swarm.delete',
  'swarm.scale',
  'agent.spawn',
  'agent.read',
  'agent.terminate',
  'task.create',
  'task.read',
  'task.cancel',
  'metrics.read',
  'system.admin',
  'api.access',
]);

/**
 * Login request schema
 */
export const LoginRequestSchema = v.object({
  email: EmailSchema,
  password: v.pipe(v.string(), v.minLength(1, 'Password is required')),
  mfaCode: v.optional(v.pipe(v.string(), v.length(6, 'MFA code must be 6 digits'))),
});

/**
 * User creation schema
 */
export const CreateUserSchema = v.object({
  email: EmailSchema,
  password: PasswordSchema,
  role: UserRoleSchema,
  permissions: v.optional(v.array(PermissionSchema)),
  isActive: v.optional(v.boolean(), true),
});

/**
 * API key creation schema
 */
export const CreateApiKeySchema = v.object({
  name: IdentifierSchema,
  permissions: v.optional(v.array(PermissionSchema)),
  expiresAt: v.optional(v.date()),
});

// ============================================================================
// Agent & Task Schemas
// ============================================================================

/**
 * Agent type schema
 */
export const AgentTypeSchema = v.picklist([
  'coder',
  'reviewer',
  'tester',
  'planner',
  'researcher',
  'security-architect',
  'security-auditor',
  'memory-specialist',
  'swarm-specialist',
  'integration-architect',
  'performance-engineer',
  'core-architect',
  'test-architect',
  'queen-coordinator',
  'project-coordinator',
]);

/**
 * Agent spawn request schema
 */
export const SpawnAgentSchema = v.object({
  type: AgentTypeSchema,
  id: v.optional(IdentifierSchema),
  config: v.optional(v.record(v.string(), v.unknown())),
  timeout: v.optional(v.pipe(v.number(), v.minValue(0, 'Must be non-negative'))),
});

/**
 * Task input schema
 */
export const TaskInputSchema = v.object({
  taskId: UUIDSchema,
  content: v.pipe(SafeStringSchema, v.maxLength(10000, 'Task content too long')),
  agentType: AgentTypeSchema,
  priority: v.optional(v.picklist(['low', 'medium', 'high', 'critical'])),
  metadata: v.optional(v.record(v.string(), v.unknown())),
});

// ============================================================================
// Command & Path Schemas
// ============================================================================

/**
 * Command argument schema
 */
export const CommandArgumentSchema = v.pipe(
  v.string(),
  v.maxLength(1024, 'Argument too long'),
  v.check(
    (val) => !val.includes('\0'),
    'Argument contains null byte',
  ),
  v.check(
    (val) => !/[;&|`$(){}><]/.test(val),
    'Argument contains shell metacharacters',
  ),
);

/**
 * Path schema
 */
export const PathSchema = v.pipe(
  v.string(),
  v.maxLength(LIMITS.MAX_PATH_LENGTH, 'Path too long'),
  v.check(
    (val) => !val.includes('\0'),
    'Path contains null byte',
  ),
  v.check(
    (val) => !val.includes('..'),
    'Path contains traversal pattern',
  ),
);

// ============================================================================
// Configuration Schemas
// ============================================================================

/**
 * Security configuration schema
 */
export const SecurityConfigSchema = v.object({
  bcryptRounds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(20)), 12),
  jwtExpiresIn: v.optional(v.string(), '24h'),
  sessionTimeout: v.optional(v.pipe(v.number(), v.minValue(0, 'Must be non-negative')), 3600000),
  maxLoginAttempts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 5),
  lockoutDuration: v.optional(v.pipe(v.number(), v.minValue(0, 'Must be non-negative')), 900000),
  requireMFA: v.optional(v.boolean(), false),
});

/**
 * Executor configuration schema
 */
export const ExecutorConfigSchema = v.object({
  allowedCommands: v.pipe(v.array(IdentifierSchema), v.minLength(1)),
  blockedPatterns: v.optional(v.array(v.string())),
  timeout: v.optional(v.pipe(v.number(), v.minValue(0, 'Must be non-negative')), 30000),
  maxBuffer: v.optional(v.pipe(v.number(), v.minValue(0, 'Must be non-negative')), 10 * 1024 * 1024),
  cwd: v.optional(PathSchema),
  allowSudo: v.optional(v.boolean(), false),
});

// ============================================================================
// Sanitization Functions
// ============================================================================

/**
 * Sanitizes a string by removing dangerous characters
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/\0/g, '')           // Remove null bytes
    .replace(/[<>]/g, '')          // Remove HTML brackets
    .replace(/javascript:/gi, '')  // Remove javascript: protocol
    .replace(/data:/gi, '')        // Remove data: protocol
    .trim();
}

/**
 * Sanitizes HTML entities
 */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Sanitizes a path by removing traversal patterns
 */
export function sanitizePath(input: string): string {
  let result = input
    .replace(/\0/g, '');          // Remove null bytes

  // Loop until no traversal patterns remain (prevents ....// → ../ bypass)
  let prev = '';
  while (result !== prev) {
    prev = result;
    result = result.replace(/\.\./g, '');
  }

  return result
    .replace(/\/+/g, '/')         // Normalize slashes
    .replace(/^\//, '')           // Remove leading slash
    .trim();
}

// ============================================================================
// Validation Helper Class
// ============================================================================

export class InputValidator {
  /**
   * Validates input against a schema
   */
  static validate<T>(schema: v.GenericSchema<unknown, T>, input: unknown): T {
    return v.parse(schema, input);
  }

  /**
   * Safely validates input, returning result
   */
  static safeParse<T>(schema: v.GenericSchema<unknown, T>, input: unknown): { success: boolean; output?: T; issues?: v.BaseIssue<unknown>[] } {
    const result = v.safeParse(schema, input);
    if (result.success) {
      return { success: true, output: result.output };
    }
    return { success: false, issues: result.issues };
  }

  /**
   * Validates email
   */
  static validateEmail(email: string): string {
    return v.parse(EmailSchema, email);
  }

  /**
   * Validates password
   */
  static validatePassword(password: string): string {
    return v.parse(PasswordSchema, password);
  }

  /**
   * Validates identifier
   */
  static validateIdentifier(id: string): string {
    return v.parse(IdentifierSchema, id);
  }

  /**
   * Validates path
   */
  static validatePath(path: string): string {
    return v.parse(PathSchema, path);
  }

  /**
   * Validates command argument
   */
  static validateCommandArg(arg: string): string {
    return v.parse(CommandArgumentSchema, arg);
  }

  /**
   * Validates login request
   */
  static validateLoginRequest(data: unknown): v.InferOutput<typeof LoginRequestSchema> {
    return v.parse(LoginRequestSchema, data);
  }

  /**
   * Validates user creation request
   */
  static validateCreateUser(data: unknown): v.InferOutput<typeof CreateUserSchema> {
    return v.parse(CreateUserSchema, data);
  }

  /**
   * Validates task input
   */
  static validateTaskInput(data: unknown): v.InferOutput<typeof TaskInputSchema> {
    return v.parse(TaskInputSchema, data);
  }
}

// ============================================================================
// Export all schemas for direct use
// ============================================================================

export {
  PATTERNS,
  LIMITS,
};
