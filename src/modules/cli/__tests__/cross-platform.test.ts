/**
 * Cross-Platform Compatibility Tests
 *
 * Validates platform-aware process killing, MSYS path normalization,
 * Node.js git hook scripts, and generateHooks() alignment with
 * settings-generator patterns.
 *
 * Epic #334 — Stories #336, #337
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

// ============================================================================
// Story #336: Platform-aware process killing
// ============================================================================

describe('platform-aware process killing', () => {
  describe('daemon killBackgroundDaemon', () => {
    it('should use taskkill on win32 instead of SIGKILL/SIGTERM', async () => {
      // Read the compiled daemon source to verify platform branching
      const daemonSrc = readFileSync(
        join(__dirname, '..', 'src', 'commands', 'daemon.ts'),
        'utf-8'
      );

      // Verify SIGKILL is wrapped in platform check
      expect(daemonSrc).toContain("process.platform === 'win32'");
      expect(daemonSrc).toContain("execFileSync('taskkill'");

      // Verify graceful kill uses taskkill without /F first
      const gracefulMatch = daemonSrc.match(/taskkill.*?\/PID.*?holderPid/s);
      expect(gracefulMatch).toBeTruthy();

      // Verify force kill uses /F flag
      expect(daemonSrc).toContain("'/F', '/PID'");

      // Verify Unix path still uses SIGTERM and SIGKILL
      expect(daemonSrc).toContain("process.kill(holderPid, 'SIGTERM')");
      expect(daemonSrc).toContain("process.kill(holderPid, 'SIGKILL')");
    });

    it('should not use SIGKILL without platform guard', () => {
      const daemonSrc = readFileSync(
        join(__dirname, '..', 'src', 'commands', 'daemon.ts'),
        'utf-8'
      );

      // Find all SIGKILL usages — they should all be inside else blocks (Unix path)
      const lines = daemonSrc.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("'SIGKILL'")) {
          // Look backwards for platform check
          const context = lines.slice(Math.max(0, i - 10), i + 1).join('\n');
          expect(context).toContain('else');
        }
      }
    });
  });

  describe('process-manager.mjs killAll', () => {
    it('should contain platform-aware kill in bin/lib/process-manager.mjs', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'lib', 'process-manager.mjs'),
        'utf-8'
      );

      expect(src).toContain("process.platform === 'win32'");
      expect(src).toContain("execFileSync('taskkill'");
      expect(src).toContain("'/F', '/PID'");
      // Unix fallback preserved
      expect(src).toContain("process.kill(entry.pid, 'SIGTERM')");
    });

    it('should contain platform-aware kill in .claude/scripts/lib/process-manager.mjs', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.claude', 'scripts', 'lib', 'process-manager.mjs'),
        'utf-8'
      );

      expect(src).toContain("process.platform === 'win32'");
      expect(src).toContain("execFileSync('taskkill'");
    });

    it('should import execFileSync from child_process', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'lib', 'process-manager.mjs'),
        'utf-8'
      );

      expect(src).toMatch(/import\s*\{[^}]*execFileSync[^}]*\}\s*from\s*'child_process'/);
    });
  });

  describe('registry-cleanup.cjs killTrackedSync', () => {
    it('should contain platform-aware kill in bin/lib/registry-cleanup.cjs', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'lib', 'registry-cleanup.cjs'),
        'utf-8'
      );

      expect(src).toContain("process.platform === 'win32'");
      expect(src).toContain("childProcess.execFileSync('taskkill'");
      expect(src).toContain("require('child_process')");
      // Unix fallback preserved
      expect(src).toContain("process.kill(entries[i].pid, 'SIGTERM')");
    });

    it('should contain platform-aware kill in .claude/scripts/lib/registry-cleanup.cjs', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.claude', 'scripts', 'lib', 'registry-cleanup.cjs'),
        'utf-8'
      );

      expect(src).toContain("process.platform === 'win32'");
      expect(src).toContain("childProcess.execFileSync('taskkill'");
    });
  });
});

// ============================================================================
// Story #337: Hook scripts cross-platform hardening
// ============================================================================

describe('hook-handler MSYS path normalization', () => {
  it('should normalize MSYS paths in bin/hook-handler.cjs', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'bin', 'hook-handler.cjs'),
      'utf-8'
    );

    // Must have the MSYS normalization regex
    expect(src).toContain(".replace(/^\\/([a-z])\\//i, '$1:/')");
  });

  it('should normalize MSYS paths in .claude/helpers/hook-handler.cjs', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'hook-handler.cjs'),
      'utf-8'
    );

    expect(src).toContain(".replace(/^\\/([a-z])\\//i, '$1:/')");
  });

  it('MSYS regex should correctly transform /c/Users to C:/Users', () => {
    const msysPath = '/c/Users/test/project';
    const result = msysPath.replace(/^\/([a-z])\//i, '$1:/');
    expect(result).toBe('c:/Users/test/project');
  });

  it('MSYS regex should not modify normal Windows paths', () => {
    const normalPath = 'C:\\Users\\test\\project';
    const result = normalPath.replace(/^\/([a-z])\//i, '$1:/');
    expect(result).toBe('C:\\Users\\test\\project');
  });

  it('MSYS regex should handle uppercase drive letters', () => {
    const msysPath = '/D/SomeDir/project';
    const result = msysPath.replace(/^\/([a-z])\//i, '$1:/');
    expect(result).toBe('D:/SomeDir/project');
  });
});

describe('pre-commit Node.js rewrite', () => {
  it('should be a Node.js script, not bash', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'pre-commit'),
      'utf-8'
    );

    expect(src).toMatch(/^#!\/usr\/bin\/env node/);
    expect(src).not.toContain('#!/bin/bash');
    expect(src).not.toContain('[[');
    expect(src).not.toContain('$()');
  });

  it('should use execFileSync instead of shell commands', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'pre-commit'),
      'utf-8'
    );

    expect(src).toContain("execFileSync('git'");
    expect(src).toContain('windowsHide: true');
  });

  it('should have MSYS path normalization', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'pre-commit'),
      'utf-8'
    );

    expect(src).toContain(".replace(/^\\/([a-z])\\//i, '$1:/')");
  });

  it('should filter for JS/TS file extensions', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'pre-commit'),
      'utf-8'
    );

    // Verifies it filters for JS/TS extensions
    expect(src).toContain('ts|js|tsx|jsx');
  });
});

describe('post-commit Node.js rewrite', () => {
  it('should be a Node.js script, not bash', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'post-commit'),
      'utf-8'
    );

    expect(src).toMatch(/^#!\/usr\/bin\/env node/);
    expect(src).not.toContain('#!/bin/bash');
  });

  it('should use execFileSync for git commands', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'post-commit'),
      'utf-8'
    );

    expect(src).toContain("execFileSync('git'");
    expect(src).toContain('windowsHide: true');
    expect(src).toContain('rev-parse');
  });

  it('should have MSYS path normalization', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'post-commit'),
      'utf-8'
    );

    expect(src).toContain(".replace(/^\\/([a-z])\\//i, '$1:/')");
  });
});

describe('generateHooks alignment with settings-generator', () => {
  it('should not use npx flo in generateHooks', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'init', 'moflo-init.ts'),
      'utf-8'
    );

    // Extract just the generateHooks function body
    const funcStart = src.indexOf('function generateHooks(');
    const funcEnd = src.indexOf('\n// =====', funcStart + 1);
    const funcBody = src.slice(funcStart, funcEnd);

    // Should not use npx flo as hook commands (comments mentioning it are OK)
    const commandLines = funcBody.split('\n').filter(l => l.includes('"command"'));
    for (const line of commandLines) {
      expect(line).not.toContain('npx flo');
      expect(line).not.toContain('npx moflo');
    }
  });

  it('should use direct node invocation via helper scripts', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'init', 'moflo-init.ts'),
      'utf-8'
    );

    const funcStart = src.indexOf('function generateHooks(');
    const funcEnd = src.indexOf('\n// =====', funcStart + 1);
    const funcBody = src.slice(funcStart, funcEnd);

    // Should reference helper scripts directly
    expect(funcBody).toContain('gate-hook.mjs');
    expect(funcBody).toContain('gate.cjs');
    expect(funcBody).toContain('hook-handler.cjs');
    expect(funcBody).toContain('prompt-hook.mjs');
  });

  it('should use $CLAUDE_PROJECT_DIR for all helper script paths', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'init', 'moflo-init.ts'),
      'utf-8'
    );

    const funcStart = src.indexOf('function generateHooks(');
    const funcEnd = src.indexOf('\n// =====', funcStart + 1);
    const funcBody = src.slice(funcStart, funcEnd);

    // Every node command should use $CLAUDE_PROJECT_DIR
    const nodeCommands = funcBody.match(/node "\$CLAUDE_PROJECT_DIR/g) || [];
    expect(nodeCommands.length).toBeGreaterThanOrEqual(5);
  });

  it('should have same hook events as settings-generator', () => {
    const initSrc = readFileSync(
      join(__dirname, '..', 'src', 'init', 'moflo-init.ts'),
      'utf-8'
    );
    const settingsSrc = readFileSync(
      join(__dirname, '..', 'src', 'init', 'settings-generator.ts'),
      'utf-8'
    );

    // Both should define the same hook event categories
    const hookEvents = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SubagentStart', 'SessionStart', 'Stop'];
    for (const event of hookEvents) {
      expect(initSrc).toContain(`"${event}"`);
    }
  });
});

// ============================================================================
// Bin/scripts file sync validation
// ============================================================================

describe('bin and .claude/scripts file sync', () => {
  it('process-manager.mjs should be in sync between bin/ and .claude/scripts/', () => {
    const binSrc = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'bin', 'lib', 'process-manager.mjs'),
      'utf-8'
    );
    const scriptsSrc = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'scripts', 'lib', 'process-manager.mjs'),
      'utf-8'
    );

    expect(binSrc).toBe(scriptsSrc);
  });

  it('registry-cleanup.cjs should be in sync between bin/ and .claude/scripts/', () => {
    const binSrc = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'bin', 'lib', 'registry-cleanup.cjs'),
      'utf-8'
    );
    const scriptsSrc = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'scripts', 'lib', 'registry-cleanup.cjs'),
      'utf-8'
    );

    expect(binSrc).toBe(scriptsSrc);
  });

  it('hook-handler.cjs should be in sync between bin/ and .claude/helpers/', () => {
    const binSrc = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'bin', 'hook-handler.cjs'),
      'utf-8'
    );
    const helpersSrc = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'hook-handler.cjs'),
      'utf-8'
    );

    expect(binSrc).toBe(helpersSrc);
  });
});

// ============================================================================
// Story #338: execSync to execFileSync migration
// ============================================================================

describe('execSync to execFileSync migration', () => {
  describe('gate-hook.mjs', () => {
    it('should use execFileSync instead of execSync in bin/', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'gate-hook.mjs'),
        'utf-8'
      );

      expect(src).toContain("execFileSync('node'");
      expect(src).not.toMatch(/execSync\s*\(/);
      expect(src).toContain('windowsHide: true');
    });

    it('should use execFileSync instead of execSync in .claude/helpers/', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'gate-hook.mjs'),
        'utf-8'
      );

      expect(src).toContain("execFileSync('node'");
      expect(src).not.toMatch(/execSync\s*\(/);
    });

    it('should pass script path and command as separate args (no shell string)', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'gate-hook.mjs'),
        'utf-8'
      );

      // Should use array args pattern: execFileSync('node', [gateScript, command], ...)
      expect(src).toContain('[gateScript, command]');
      // Should NOT use string concatenation for command
      expect(src).not.toContain("'node \"' + gateScript");
    });
  });

  describe('prompt-hook.mjs', () => {
    it('should use execFileSync instead of execSync in bin/', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'prompt-hook.mjs'),
        'utf-8'
      );

      expect(src).toContain("execFileSync('node'");
      expect(src).not.toMatch(/execSync\s*\(/);
      expect(src).toContain('windowsHide: true');
    });

    it('should be in sync between bin/ and .claude/helpers/', () => {
      const binSrc = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'prompt-hook.mjs'),
        'utf-8'
      );
      const helpersSrc = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.claude', 'helpers', 'prompt-hook.mjs'),
        'utf-8'
      );

      expect(binSrc).toBe(helpersSrc);
    });
  });

  describe('generate-code-map.mjs', () => {
    it('should use execFileSync for git ls-files in bin/', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'generate-code-map.mjs'),
        'utf-8'
      );

      // git ls-files should use execFileSync with array args
      expect(src).toContain("execFileSync(\n      'git', ['ls-files', '--'");
    });

    it('should use execFileSync for node embed script in bin/', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'generate-code-map.mjs'),
        'utf-8'
      );

      expect(src).toContain("execFileSync('node', [embedScript, '--namespace', 'code-map']");
    });

    it('should be in sync between bin/ and .claude/scripts/', () => {
      const binSrc = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'generate-code-map.mjs'),
        'utf-8'
      );
      const scriptsSrc = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.claude', 'scripts', 'generate-code-map.mjs'),
        'utf-8'
      );

      expect(binSrc).toBe(scriptsSrc);
    });
  });

  describe('index-tests.mjs', () => {
    it('should use execFileSync for git ls-files in bin/', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'index-tests.mjs'),
        'utf-8'
      );

      expect(src).toContain("execFileSync(\n      'git', ['ls-files', '--'");
    });

    it('should use execFileSync for node embed script in bin/', () => {
      const src = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'index-tests.mjs'),
        'utf-8'
      );

      expect(src).toContain("execFileSync('node', [embedScript, '--namespace', 'tests']");
    });

    it('should be in sync between bin/ and .claude/scripts/', () => {
      const binSrc = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'bin', 'index-tests.mjs'),
        'utf-8'
      );
      const scriptsSrc = readFileSync(
        join(__dirname, '..', '..', '..', '..', '.claude', 'scripts', 'index-tests.mjs'),
        'utf-8'
      );

      expect(binSrc).toBe(scriptsSrc);
    });
  });

  describe('executor.ts auto-memory commands', () => {
    it('should not use node -e with inline scripts', () => {
      const src = readFileSync(
        join(__dirname, '..', 'src', 'init', 'executor.ts'),
        'utf-8'
      );

      // Should not have inline node -e with git rev-parse
      expect(src).not.toContain('node -e "');
      expect(src).not.toContain("gitRootResolver");
    });

    it('should use $CLAUDE_PROJECT_DIR for auto-memory hooks', () => {
      const src = readFileSync(
        join(__dirname, '..', 'src', 'init', 'executor.ts'),
        'utf-8'
      );

      expect(src).toContain('$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs');
    });
  });
});

// ============================================================================
// Story #339: Doctor and generator cross-platform fixes
// ============================================================================

describe('doctor cross-platform fixes', () => {
  it('should have platform-aware npx cache fix suggestion', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'commands', 'doctor.ts'),
      'utf-8'
    );

    // Windows should get a Windows-friendly suggestion
    expect(src).toContain("process.platform === 'win32'");
    expect(src).toContain('LocalAppData');
    // Unix should still get rm -rf
    expect(src).toContain('rm -rf ~/.npm/_npx/*');
  });

  it('should detect drive letter from cwd for PowerShell disk check', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'commands', 'doctor.ts'),
      'utf-8'
    );

    // Should extract drive letter from process.cwd()
    expect(src).toMatch(/process\.cwd\(\).*match.*\[A-Z\]/);
    // Should NOT hardcode 'C' as the only drive
    expect(src).not.toContain("Get-PSDrive C |");
  });

  it('should search %APPDATA%\\Claude\\ for MCP config on Windows', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'commands', 'doctor.ts'),
      'utf-8'
    );

    expect(src).toContain("process.env.APPDATA");
    expect(src).toContain("'Claude', 'claude_desktop_config.json'");
  });

  it('should still search ~/.claude/ for MCP config (cross-platform)', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'commands', 'doctor.ts'),
      'utf-8'
    );

    expect(src).toContain('.claude/claude_desktop_config.json');
    expect(src).toContain('.config/claude/mcp.json');
  });
});

describe('envrc generator cross-platform', () => {
  it('should skip .envrc on Windows', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'init', 'envrc-generator.ts'),
      'utf-8'
    );

    expect(src).toContain("process.platform === 'win32'");
    expect(src).toContain('Windows');
    expect(src).toContain('return');
  });
});
