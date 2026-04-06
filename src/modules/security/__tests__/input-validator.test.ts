/**
 * Input Validator Tests
 *
 * Tests verify:
 * - Valibot schema validation
 * - Input sanitization
 * - Authentication schemas
 * - Command and path schemas
 */

import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  InputValidator,
  sanitizeString,
  sanitizeHtml,
  sanitizePath,
  SafeStringSchema,
  IdentifierSchema,
  EmailSchema,
  PasswordSchema,
  UUIDSchema,
  HttpsUrlSchema,
  PortSchema,
  UserRoleSchema,
  PermissionSchema,
  LoginRequestSchema,
  CreateUserSchema,
  TaskInputSchema,
  CommandArgumentSchema,
  PathSchema,
  PATTERNS,
  LIMITS,
} from '../src/input-validator.js';

describe('InputValidator', () => {
  describe('SafeStringSchema', () => {
    it('should accept safe strings', () => {
      expect(() => v.parse(SafeStringSchema, 'hello world')).not.toThrow();
    });

    it('should reject empty strings', () => {
      expect(() => v.parse(SafeStringSchema, '')).toThrow();
    });

    it('should reject strings with shell metacharacters', () => {
      const dangerous = [';', '&&', '||', '|', '`', '$()', '${}', '>', '<'];
      for (const char of dangerous) {
        expect(() => v.parse(SafeStringSchema, `hello${char}world`)).toThrow();
      }
    });
  });

  describe('IdentifierSchema', () => {
    it('should accept valid identifiers', () => {
      expect(() => v.parse(IdentifierSchema, 'validId')).not.toThrow();
      expect(() => v.parse(IdentifierSchema, 'valid-id')).not.toThrow();
      expect(() => v.parse(IdentifierSchema, 'valid_id')).not.toThrow();
      expect(() => v.parse(IdentifierSchema, 'validId123')).not.toThrow();
    });

    it('should reject identifiers starting with number', () => {
      expect(() => v.parse(IdentifierSchema, '123invalid')).toThrow();
    });

    it('should reject identifiers with special characters', () => {
      expect(() => v.parse(IdentifierSchema, 'invalid@id')).toThrow();
      expect(() => v.parse(IdentifierSchema, 'invalid id')).toThrow();
    });

    it('should reject empty identifiers', () => {
      expect(() => v.parse(IdentifierSchema, '')).toThrow();
    });
  });

  describe('EmailSchema', () => {
    it('should accept valid emails', () => {
      expect(() => v.parse(EmailSchema, 'user@example.com')).not.toThrow();
      expect(() => v.parse(EmailSchema, 'user.name@example.co.uk')).not.toThrow();
    });

    it('should reject invalid emails', () => {
      expect(() => v.parse(EmailSchema, 'notanemail')).toThrow();
      expect(() => v.parse(EmailSchema, '@nodomain.com')).toThrow();
      expect(() => v.parse(EmailSchema, 'no@')).toThrow();
    });

    it('should lowercase emails', () => {
      const result = v.parse(EmailSchema, 'USER@EXAMPLE.COM');
      expect(result).toBe('user@example.com');
    });

    it('should reject too long emails', () => {
      const longEmail = 'a'.repeat(300) + '@example.com';
      expect(() => v.parse(EmailSchema, longEmail)).toThrow();
    });
  });

  describe('PasswordSchema', () => {
    it('should accept valid passwords', () => {
      expect(() => v.parse(PasswordSchema, 'SecurePass123')).not.toThrow();
    });

    it('should reject short passwords', () => {
      expect(() => v.parse(PasswordSchema, 'Short1')).toThrow();
    });

    it('should reject passwords without uppercase', () => {
      expect(() => v.parse(PasswordSchema, 'lowercase123')).toThrow();
    });

    it('should reject passwords without lowercase', () => {
      expect(() => v.parse(PasswordSchema, 'UPPERCASE123')).toThrow();
    });

    it('should reject passwords without digits', () => {
      expect(() => v.parse(PasswordSchema, 'NoDigitsHere')).toThrow();
    });
  });

  describe('UUIDSchema', () => {
    it('should accept valid UUIDs', () => {
      expect(() => v.parse(UUIDSchema, '550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
    });

    it('should reject invalid UUIDs', () => {
      expect(() => v.parse(UUIDSchema, 'not-a-uuid')).toThrow();
      expect(() => v.parse(UUIDSchema, '550e8400-e29b-41d4-a716')).toThrow();
    });
  });

  describe('HttpsUrlSchema', () => {
    it('should accept HTTPS URLs', () => {
      expect(() => v.parse(HttpsUrlSchema, 'https://example.com')).not.toThrow();
      expect(() => v.parse(HttpsUrlSchema, 'https://example.com/path')).not.toThrow();
    });

    it('should reject HTTP URLs', () => {
      expect(() => v.parse(HttpsUrlSchema, 'http://example.com')).toThrow();
    });

    it('should reject invalid URLs', () => {
      expect(() => v.parse(HttpsUrlSchema, 'not-a-url')).toThrow();
    });
  });

  describe('PortSchema', () => {
    it('should accept valid ports', () => {
      expect(() => v.parse(PortSchema, 80)).not.toThrow();
      expect(() => v.parse(PortSchema, 443)).not.toThrow();
      expect(() => v.parse(PortSchema, 3000)).not.toThrow();
      expect(() => v.parse(PortSchema, 65535)).not.toThrow();
    });

    it('should reject invalid ports', () => {
      expect(() => v.parse(PortSchema, 0)).toThrow();
      expect(() => v.parse(PortSchema, -1)).toThrow();
      expect(() => v.parse(PortSchema, 65536)).toThrow();
      expect(() => v.parse(PortSchema, 3.14)).toThrow();
    });
  });

  describe('UserRoleSchema', () => {
    it('should accept valid roles', () => {
      expect(() => v.parse(UserRoleSchema, 'admin')).not.toThrow();
      expect(() => v.parse(UserRoleSchema, 'operator')).not.toThrow();
      expect(() => v.parse(UserRoleSchema, 'developer')).not.toThrow();
      expect(() => v.parse(UserRoleSchema, 'viewer')).not.toThrow();
      expect(() => v.parse(UserRoleSchema, 'service')).not.toThrow();
    });

    it('should reject invalid roles', () => {
      expect(() => v.parse(UserRoleSchema, 'superuser')).toThrow();
      expect(() => v.parse(UserRoleSchema, 'root')).toThrow();
    });
  });

  describe('PermissionSchema', () => {
    it('should accept valid permissions', () => {
      expect(() => v.parse(PermissionSchema, 'swarm.create')).not.toThrow();
      expect(() => v.parse(PermissionSchema, 'agent.spawn')).not.toThrow();
      expect(() => v.parse(PermissionSchema, 'system.admin')).not.toThrow();
    });

    it('should reject invalid permissions', () => {
      expect(() => v.parse(PermissionSchema, 'invalid.permission')).toThrow();
    });
  });

  describe('LoginRequestSchema', () => {
    it('should accept valid login request', () => {
      expect(() => v.parse(LoginRequestSchema, {
        email: 'user@example.com',
        password: 'password123',
      })).not.toThrow();
    });

    it('should accept login with MFA code', () => {
      expect(() => v.parse(LoginRequestSchema, {
        email: 'user@example.com',
        password: 'password123',
        mfaCode: '123456',
      })).not.toThrow();
    });

    it('should reject invalid MFA code length', () => {
      expect(() => v.parse(LoginRequestSchema, {
        email: 'user@example.com',
        password: 'password123',
        mfaCode: '12345', // 5 digits instead of 6
      })).toThrow();
    });
  });

  describe('CreateUserSchema', () => {
    it('should accept valid user creation', () => {
      expect(() => v.parse(CreateUserSchema, {
        email: 'user@example.com',
        password: 'SecurePass123',
        role: 'developer',
      })).not.toThrow();
    });

    it('should require strong password', () => {
      expect(() => v.parse(CreateUserSchema, {
        email: 'user@example.com',
        password: 'weak',
        role: 'developer',
      })).toThrow();
    });
  });

  describe('TaskInputSchema', () => {
    it('should accept valid task input', () => {
      expect(() => v.parse(TaskInputSchema, {
        taskId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'Implement new feature',
        agentType: 'coder',
      })).not.toThrow();
    });

    it('should reject task with shell characters in content', () => {
      expect(() => v.parse(TaskInputSchema, {
        taskId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'Implement feature; rm -rf /',
        agentType: 'coder',
      })).toThrow();
    });
  });

  describe('CommandArgumentSchema', () => {
    it('should accept safe arguments', () => {
      expect(() => v.parse(CommandArgumentSchema, '--flag')).not.toThrow();
      expect(() => v.parse(CommandArgumentSchema, 'value')).not.toThrow();
      expect(() => v.parse(CommandArgumentSchema, 'path/to/file')).not.toThrow();
    });

    it('should reject arguments with null bytes', () => {
      expect(() => v.parse(CommandArgumentSchema, 'arg\x00injected')).toThrow();
    });

    it('should reject arguments with shell metacharacters', () => {
      expect(() => v.parse(CommandArgumentSchema, 'arg;injected')).toThrow();
      expect(() => v.parse(CommandArgumentSchema, 'arg&&injected')).toThrow();
      expect(() => v.parse(CommandArgumentSchema, 'arg|injected')).toThrow();
    });
  });

  describe('PathSchema', () => {
    it('should accept valid paths', () => {
      expect(() => v.parse(PathSchema, '/path/to/file.ts')).not.toThrow();
      expect(() => v.parse(PathSchema, './relative/path')).not.toThrow();
    });

    it('should reject paths with traversal', () => {
      expect(() => v.parse(PathSchema, '/path/../etc/passwd')).toThrow();
    });

    it('should reject paths with null bytes', () => {
      expect(() => v.parse(PathSchema, '/path/file\x00.jpg')).toThrow();
    });
  });

  describe('Sanitization Functions', () => {
    describe('sanitizeString', () => {
      it('should remove null bytes', () => {
        expect(sanitizeString('hello\x00world')).toBe('helloworld');
      });

      it('should remove HTML brackets', () => {
        expect(sanitizeString('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
      });

      it('should remove javascript: protocol', () => {
        expect(sanitizeString('javascript:alert(1)')).toBe('alert(1)');
      });

      it('should trim whitespace', () => {
        expect(sanitizeString('  hello  ')).toBe('hello');
      });
    });

    describe('sanitizeHtml', () => {
      it('should escape HTML entities', () => {
        expect(sanitizeHtml('<script>')).toBe('&lt;script&gt;');
        expect(sanitizeHtml('"quoted"')).toBe('&quot;quoted&quot;');
        expect(sanitizeHtml("'apostrophe'")).toBe('&#x27;apostrophe&#x27;');
        expect(sanitizeHtml('a & b')).toBe('a &amp; b');
      });
    });

    describe('sanitizePath', () => {
      it('should remove null bytes', () => {
        expect(sanitizePath('/path\x00/file')).toBe('path/file');
      });

      it('should remove traversal patterns', () => {
        expect(sanitizePath('../etc/passwd')).toBe('etc/passwd');
      });

      it('should normalize slashes', () => {
        expect(sanitizePath('/path//to///file')).toBe('path/to/file');
      });

      it('should remove leading slash', () => {
        expect(sanitizePath('/absolute/path')).toBe('absolute/path');
      });

      it('should prevent ....// bypass (nested traversal)', () => {
        // After removing ".." pairs and normalizing slashes, leading slash is stripped
        expect(sanitizePath('....//etc/passwd')).toBe('etc/passwd');
        expect(sanitizePath('....//')).toBe('');
        expect(sanitizePath('....//....//etc')).toBe('etc');
      });

      it('should handle deeply nested traversal attempts', () => {
        expect(sanitizePath('......///etc')).toBe('etc');
        expect(sanitizePath('.a]../b')).toBe('.a]/b');
      });
    });
  });

  describe('InputValidator Class', () => {
    it('should validate email', () => {
      expect(InputValidator.validateEmail('user@example.com')).toBe('user@example.com');
    });

    it('should validate password', () => {
      expect(() => InputValidator.validatePassword('SecurePass123')).not.toThrow();
    });

    it('should validate identifier', () => {
      expect(InputValidator.validateIdentifier('myId')).toBe('myId');
    });

    it('should validate path', () => {
      expect(InputValidator.validatePath('/valid/path')).toBe('/valid/path');
    });

    it('should validate command argument', () => {
      expect(InputValidator.validateCommandArg('--flag')).toBe('--flag');
    });

    it('should validate login request', () => {
      const result = InputValidator.validateLoginRequest({
        email: 'USER@example.com',
        password: 'password',
      });
      expect(result.email).toBe('user@example.com');
    });

    it('should safely parse with result', () => {
      const success = InputValidator.safeParse(EmailSchema, 'user@example.com');
      expect(success.success).toBe(true);

      const failure = InputValidator.safeParse(EmailSchema, 'invalid');
      expect(failure.success).toBe(false);
    });
  });

  describe('Constants', () => {
    it('should export PATTERNS', () => {
      expect(PATTERNS.SAFE_IDENTIFIER).toBeDefined();
      expect(PATTERNS.SAFE_FILENAME).toBeDefined();
      expect(PATTERNS.NO_SHELL_CHARS).toBeDefined();
    });

    it('should export LIMITS', () => {
      expect(LIMITS.MIN_PASSWORD_LENGTH).toBe(8);
      expect(LIMITS.MAX_PASSWORD_LENGTH).toBe(128);
      expect(LIMITS.MAX_PATH_LENGTH).toBe(4096);
    });
  });
});
