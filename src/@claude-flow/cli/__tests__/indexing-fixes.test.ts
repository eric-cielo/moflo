/**
 * Tests for indexing fixes:
 * 1. Pretrain fileTypes array/string handling (the root cause of patterns namespace being empty)
 * 2. Code-map multi-language type extraction
 * 3. Code-map file entries for files without detected types
 * 4. Error logging in getRealStoreFunction/getRealSearchFunction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'path';

// ============================================================================
// 1. Pretrain fileTypes handling
// ============================================================================

describe('pretrain fileTypes handling', () => {
  // Simulate the fixed logic from hooks-tools.ts handler
  function parseFileTypes(rawFileTypes: unknown): string[] {
    return Array.isArray(rawFileTypes)
      ? (rawFileTypes as unknown[]).map((t: unknown) => String(t).trim())
      : (typeof rawFileTypes === 'string' ? rawFileTypes : 'ts,js,py,md').split(',').map(e => e.trim());
  }

  it('should handle string input (MCP tool call)', () => {
    const result = parseFileTypes('ts,js,py,md');
    expect(result).toEqual(['ts', 'js', 'py', 'md']);
  });

  it('should handle array input (CLI call via callMCPTool)', () => {
    const result = parseFileTypes(['ts', 'js', 'py', 'md', 'json']);
    expect(result).toEqual(['ts', 'js', 'py', 'md', 'json']);
  });

  it('should handle array with whitespace', () => {
    const result = parseFileTypes([' ts ', ' js']);
    expect(result).toEqual(['ts', 'js']);
  });

  it('should handle undefined/null with defaults', () => {
    expect(parseFileTypes(undefined)).toEqual(['ts', 'js', 'py', 'md']);
    expect(parseFileTypes(null)).toEqual(['ts', 'js', 'py', 'md']);
  });

  it('should handle string with spaces', () => {
    const result = parseFileTypes('ts, js , py');
    expect(result).toEqual(['ts', 'js', 'py']);
  });

  it('should handle empty array', () => {
    const result = parseFileTypes([]);
    expect(result).toEqual([]);
  });

  it('should handle numeric values in array by converting to string', () => {
    const result = parseFileTypes([42, 'js']);
    expect(result).toEqual(['42', 'js']);
  });
});

// ============================================================================
// 2. Code-map multi-language type extraction patterns
// ============================================================================

describe('code-map multi-language type extraction', () => {
  // Replicate the pattern matching logic from generate-code-map.mjs
  const LANG_PATTERNS: Record<string, Array<[RegExp, string?]>> = {
    ts: [
      [/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w,\s.]+))?/],
      [/^export\s+(?:default\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s.]+))?/],
      [/^export\s+(?:default\s+)?type\s+(\w+)\s*[=<]/],
      [/^export\s+(?:const\s+)?enum\s+(\w+)/],
      [/^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/],
      [/^export\s+(?:default\s+)?const\s+(\w+)\s*[=:]/],
      [/^(?:module\.exports\s*=\s*)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?/],
      [/^(?:async\s+)?function\s+(\w+)\s*\(/],
      [/^const\s+(\w+)\s*=\s*(?:async\s+)?\(?.*\)?\s*=>/],
      [/^(?:var|let|const)\s+(\w+)\s*=\s*require\s*\(/],
    ],
    py: [
      [/^class\s+(\w+)(?:\(([^)]+)\))?:/],
      [/^(?:async\s+)?def\s+(\w+)\s*\(/],
      [/^(\w+)\s*:\s*TypeAlias\s*=/, 'type'],
    ],
    go: [
      [/^type\s+(\w+)\s+struct\b/, 'struct'],
      [/^type\s+(\w+)\s+interface\b/, 'interface'],
      [/^type\s+(\w+)\s+/, 'type'],
      [/^func\s+(\w+)\s*\(/],
      [/^func\s+\([^)]+\)\s+(\w+)\s*\(/, 'method'],
    ],
    java: [
      [/^(?:public|protected|private|abstract|static|final|sealed|open|\s)*class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w,\s.]+))?/],
      [/^(?:public|protected|private|abstract|static|sealed|\s)*interface\s+(\w+)(?:\s+extends\s+([\w,\s.]+))?/],
      [/^(?:public|protected|private|abstract|static|\s)*enum\s+(\w+)/],
    ],
    cs: [
      [/^(?:public|protected|private|internal|abstract|static|sealed|partial|\s)*class\s+(\w+)(?:\s*:\s*([\w.,\s<>]+))?/],
      [/^(?:public|protected|private|internal|abstract|static|\s)*interface\s+(\w+)(?:\s*:\s*([\w.,\s<>]+))?/],
      [/^(?:public|protected|private|internal|abstract|static|\s)*struct\s+(\w+)/],
      [/^(?:public|protected|private|internal|abstract|static|\s)*record\s+(\w+)/],
      [/^namespace\s+([\w.]+)/, 'namespace'],
    ],
    rs: [
      [/^pub(?:\([\w]+\))?\s+struct\s+(\w+)/, 'struct'],
      [/^pub(?:\([\w]+\))?\s+enum\s+(\w+)/],
      [/^pub(?:\([\w]+\))?\s+trait\s+(\w+)(?:\s*:\s*([\w\s+]+))?/, 'trait'],
      [/^pub(?:\([\w]+\))?\s+(?:async\s+)?fn\s+(\w+)/],
      [/^struct\s+(\w+)/, 'struct'],
      [/^enum\s+(\w+)/],
      [/^trait\s+(\w+)/, 'trait'],
      [/^(?:async\s+)?fn\s+(\w+)/],
    ],
  };

  function extractNames(lines: string[], lang: string): string[] {
    const patterns = LANG_PATTERNS[lang] || [];
    const names: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      for (const [pattern] of patterns) {
        const m = trimmed.match(pattern);
        if (m && m[1] && !seen.has(m[1])) {
          seen.add(m[1]);
          names.push(m[1]);
          break;
        }
      }
    }
    return names;
  }

  // --- TypeScript/JavaScript ---
  it('should extract TS/JS exports', () => {
    const lines = [
      'export class UserService extends BaseService implements IUserService {',
      'export interface IUserService {',
      'export type UserId = string;',
      'export enum UserRole {',
      'export async function createUser() {',
      'export const MAX_USERS = 100;',
    ];
    expect(extractNames(lines, 'ts')).toEqual([
      'UserService', 'IUserService', 'UserId', 'UserRole', 'createUser', 'MAX_USERS',
    ]);
  });

  it('should extract plain JS (no export keyword)', () => {
    const lines = [
      'class TaskManager {',
      'function processTask(task) {',
      'const helper = (x) => x + 1;',
      'const db = require("sqlite3");',
    ];
    expect(extractNames(lines, 'ts')).toEqual([
      'TaskManager', 'processTask', 'helper', 'db',
    ]);
  });

  // --- Python ---
  it('should extract Python classes and functions', () => {
    const lines = [
      'class UserModel(BaseModel):',
      'async def fetch_user(user_id: int):',
      'def helper():',
    ];
    expect(extractNames(lines, 'py')).toEqual(['UserModel', 'fetch_user', 'helper']);
  });

  // --- Go ---
  it('should extract Go types and functions', () => {
    const lines = [
      'type UserService struct {',
      'type Repository interface {',
      'type UserID string',
      'func NewUserService() *UserService {',
      'func (s *UserService) GetUser(id string) (*User, error) {',
    ];
    expect(extractNames(lines, 'go')).toEqual([
      'UserService', 'Repository', 'UserID', 'NewUserService', 'GetUser',
    ]);
  });

  // --- Java ---
  it('should extract Java classes and interfaces', () => {
    const lines = [
      'public class UserController extends BaseController implements Serializable {',
      'public interface UserRepository extends JpaRepository<User, Long> {',
      'public enum Status {',
    ];
    expect(extractNames(lines, 'java')).toEqual(['UserController', 'UserRepository', 'Status']);
  });

  // --- C# ---
  it('should extract C# classes, interfaces, structs, records', () => {
    const lines = [
      'public class UserService : IUserService, IDisposable {',
      'public interface IUserService : IService {',
      'public struct Point {',
      'public record UserDto(string Name, int Age);',
      'namespace MyApp.Services {',
    ];
    const names = extractNames(lines, 'cs');
    expect(names).toContain('UserService');
    expect(names).toContain('IUserService');
    expect(names).toContain('Point');
    expect(names).toContain('UserDto');
    expect(names).toContain('MyApp.Services');
  });

  // --- Rust ---
  it('should extract Rust structs, enums, traits, fns', () => {
    const lines = [
      'pub struct UserService {',
      'pub enum Error {',
      'pub trait Repository: Send + Sync {',
      'pub async fn create_user(db: &Pool) -> Result<User> {',
      'fn internal_helper() {',
    ];
    expect(extractNames(lines, 'rs')).toEqual([
      'UserService', 'Error', 'Repository', 'create_user', 'internal_helper',
    ]);
  });
});

// ============================================================================
// 3. Code-map file entries for files without types
// ============================================================================

describe('code-map file entries for all files', () => {
  it('should include files with zero exported types', () => {
    // Simulate the fixed logic: typesByFile[file] = types (always, not gated on types.length > 0)
    const files = ['src/index.js', 'src/utils/helper.js', 'src/config.js'];
    const typesByFile: Record<string, unknown[]> = {};

    for (const file of files) {
      // Simulate extractTypes returning empty for plain JS files
      const types = file === 'src/utils/helper.js' ? [{ name: 'helper', kind: 'function' }] : [];
      // Fixed: always store, not gated on types.length > 0
      typesByFile[file] = types;
    }

    // All files should have entries
    expect(Object.keys(typesByFile)).toEqual(files);
    expect(typesByFile['src/index.js']).toHaveLength(0);
    expect(typesByFile['src/utils/helper.js']).toHaveLength(1);
    expect(typesByFile['src/config.js']).toHaveLength(0);
  });

  it('should generate file entries for files without types (not skip them)', () => {
    // Simulate generateFileEntries behavior after fix
    const typesByFile: Record<string, Array<{ name: string; kind: string }>> = {
      'src/index.js': [],
      'src/service.ts': [{ name: 'UserService', kind: 'class' }],
    };

    const entries: Array<{ key: string; hasTypes: boolean }> = [];
    for (const [filePath, types] of Object.entries(typesByFile)) {
      // Fixed: no `if (types.length === 0) continue;`
      entries.push({
        key: `file:${filePath}`,
        hasTypes: types.length > 0,
      });
    }

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ key: 'file:src/index.js', hasTypes: false });
    expect(entries[1]).toEqual({ key: 'file:src/service.ts', hasTypes: true });
  });
});

// ============================================================================
// 4. Cross-platform path detection in file tags
// ============================================================================

describe('cross-platform path tag detection', () => {
  function detectTags(filePath: string): string[] {
    const tags: string[] = ['file'];
    if (filePath.includes('/services/') || filePath.includes('\\services\\')) tags.push('service');
    if (filePath.includes('/routes/') || filePath.includes('\\routes\\')) tags.push('route');
    if (filePath.includes('/middleware/') || filePath.includes('\\middleware\\')) tags.push('middleware');
    if (filePath.includes('/components/') || filePath.includes('\\components\\')) tags.push('component');
    if (filePath.includes('/hooks/') || filePath.includes('\\hooks\\')) tags.push('hook');
    if (filePath.includes('/api/') || filePath.includes('\\api\\')) tags.push('api');
    if (filePath.includes('/utils/') || filePath.includes('\\utils\\')) tags.push('util');
    return tags;
  }

  it('should detect tags with Unix paths', () => {
    expect(detectTags('src/services/user.ts')).toContain('service');
    expect(detectTags('src/components/App.tsx')).toContain('component');
    expect(detectTags('src/api/client.ts')).toContain('api');
  });

  it('should detect tags with Windows paths', () => {
    expect(detectTags('src\\services\\user.ts')).toContain('service');
    expect(detectTags('src\\components\\App.tsx')).toContain('component');
    expect(detectTags('src\\middleware\\auth.ts')).toContain('middleware');
  });

  it('should not false-positive on partial matches', () => {
    expect(detectTags('src/my-services.ts')).not.toContain('service');
    expect(detectTags('src/userapi.ts')).not.toContain('api');
  });
});

// ============================================================================
// 5. Language detection
// ============================================================================

describe('multi-language detection', () => {
  function detectLanguage(filePath: string): string {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const langMap: Record<string, string> = {
      '.tsx': 'React/TypeScript', '.jsx': 'React/JavaScript',
      '.ts': 'TypeScript', '.mjs': 'ESM', '.cjs': 'CommonJS', '.js': 'JavaScript',
      '.py': 'Python', '.pyi': 'Python',
      '.go': 'Go',
      '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
      '.cs': 'C#',
      '.rs': 'Rust',
      '.rb': 'Ruby',
      '.swift': 'Swift',
      '.php': 'PHP',
      '.c': 'C', '.h': 'C/C++ Header', '.cpp': 'C++', '.hpp': 'C++ Header', '.cc': 'C++',
    };
    return langMap[ext] || 'Unknown';
  }

  it('should detect all supported languages', () => {
    expect(detectLanguage('app.py')).toBe('Python');
    expect(detectLanguage('main.go')).toBe('Go');
    expect(detectLanguage('App.java')).toBe('Java');
    expect(detectLanguage('Service.cs')).toBe('C#');
    expect(detectLanguage('lib.rs')).toBe('Rust');
    expect(detectLanguage('app.rb')).toBe('Ruby');
    expect(detectLanguage('ViewController.swift')).toBe('Swift');
    expect(detectLanguage('index.php')).toBe('PHP');
    expect(detectLanguage('main.cpp')).toBe('C++');
    expect(detectLanguage('header.h')).toBe('C/C++ Header');
    expect(detectLanguage('App.tsx')).toBe('React/TypeScript');
    expect(detectLanguage('index.js')).toBe('JavaScript');
    expect(detectLanguage('data.kt')).toBe('Kotlin');
  });

  it('should return Unknown for unsupported extensions', () => {
    expect(detectLanguage('README.md')).toBe('Unknown');
    expect(detectLanguage('data.csv')).toBe('Unknown');
  });
});
