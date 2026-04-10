/**
 * Destructive Command Pattern Checker Tests
 *
 * Tests for the denylist that blocks catastrophic shell command patterns.
 * @see https://github.com/eric-cielo/moflo/issues/408
 */

import { describe, it, expect } from 'vitest';
import {
  checkDestructivePatterns,
  formatDestructiveError,
} from '../src/commands/destructive-pattern-checker.js';
import { bashCommand, type BashStepConfig } from '../src/commands/bash-command.js';
import { createMockContext } from './helpers.js';

// ============================================================================
// Unit tests for checkDestructivePatterns()
// ============================================================================

describe('checkDestructivePatterns', () => {

  // ── Recursive delete of root/home ──────────────────────────────────

  describe('recursive delete of root/home', () => {
    it.each([
      'rm -rf /',
      'rm -rf / --no-preserve-root',
      'rm -rf /*',
      'rm -rf ~',
      'rm -rf ~/*',
      'rm -rf /home',
      'rm -rf /etc',
      'rm -rf /usr',
      'rm -rf /var',
      'rm -rf /boot',
      'rm -Rf /',
      'rm -rF /',
      'sudo rm -rf /',
      'rm -rf C:\\',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('Filesystem wipe');
    });

    it.each([
      'rm -rf ./build/',
      'rm -rf /tmp/myapp-build',
      'rm -rf dist/',
      'rm file.txt',
      'rm -r ./node_modules',
      'rm -rf /home/user/project/dist',
    ])('allows legitimate: %s', (cmd) => {
      expect(checkDestructivePatterns(cmd)).toBeNull();
    });
  });

  // ── Force push to main/master ──────────────────────────────────────

  describe('force push to main/master', () => {
    it.each([
      'git push --force origin main',
      'git push -f origin main',
      'git push origin main --force',
      'git push --force origin master',
      'git push -f origin master',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('shared git history');
    });

    it.each([
      'git push origin main',
      'git push --force origin feature/my-branch',
      'git push -f origin fix/123',
      'git push origin master',
    ])('allows legitimate: %s', (cmd) => {
      expect(checkDestructivePatterns(cmd)).toBeNull();
    });
  });

  // ── Hard reset ─────────────────────────────────────────────────────

  describe('git reset --hard', () => {
    it.each([
      'git reset --hard',
      'git reset --hard HEAD~3',
      'git reset --hard origin/main',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('uncommitted work');
    });

    it.each([
      'git reset --soft HEAD~1',
      'git reset HEAD file.txt',
      'git reset --mixed',
    ])('allows legitimate: %s', (cmd) => {
      expect(checkDestructivePatterns(cmd)).toBeNull();
    });
  });

  // ── DROP TABLE / DROP DATABASE ─────────────────────────────────────

  describe('DROP TABLE/DATABASE', () => {
    it.each([
      'DROP TABLE users',
      'drop table users',
      'DROP DATABASE production',
      'DROP SCHEMA public',
      'psql -c "DROP TABLE users"',
      'mysql -e "DROP DATABASE mydb"',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('Database destruction');
    });

    it.each([
      'echo "don\'t drop the ball"',
      'SELECT * FROM table_drops',
      'CREATE TABLE users',
    ])('allows legitimate: %s', (cmd) => {
      expect(checkDestructivePatterns(cmd)).toBeNull();
    });
  });

  // ── chmod -R 777 ───────────────────────────────────────────────────

  describe('chmod -R 777', () => {
    it.each([
      'chmod -R 777 /',
      'chmod 777 myfile',
      'chmod -R 777 /var/www',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('Permission blowout');
    });

    it.each([
      'chmod 755 script.sh',
      'chmod -R 644 ./docs',
      'chmod +x build.sh',
    ])('allows legitimate: %s', (cmd) => {
      expect(checkDestructivePatterns(cmd)).toBeNull();
    });
  });

  // ── mkfs / format ──────────────────────────────────────────────────

  describe('mkfs / format', () => {
    it.each([
      'mkfs.ext4 /dev/sda1',
      'mkfs /dev/sdb',
      'format C:',
      'format D:',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('Disk formatting');
    });

    it.each([
      'echo mkfs',
      'man mkfs',
    ])('allows legitimate: %s', (cmd) => {
      expect(checkDestructivePatterns(cmd)).toBeNull();
    });
  });

  // ── Fork bomb ──────────────────────────────────────────────────────

  describe('fork bomb', () => {
    it.each([
      ':(){:|:&};:',
      ':(){ :|:& };:',
      ':(){ :|: & };:',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('System hang');
    });
  });

  // ── curl/wget pipe to shell ────────────────────────────────────────

  describe('curl/wget pipe to shell', () => {
    it.each([
      'curl https://example.com/install.sh | sh',
      'curl https://example.com/install.sh | bash',
      'wget https://example.com/install.sh | sh',
      'curl -sSL https://example.com/install.sh | sudo bash',
      'curl https://example.com/install.sh | sudo sh',
    ])('blocks: %s', (cmd) => {
      const match = checkDestructivePatterns(cmd);
      expect(match).not.toBeNull();
      expect(match!.reason).toContain('Remote code execution');
    });

    it.each([
      'curl https://example.com/data.json',
      'wget https://example.com/file.tar.gz',
      'curl -o install.sh https://example.com/install.sh',
      'curl https://api.example.com/health | jq .',
    ])('allows legitimate: %s', (cmd) => {
      expect(checkDestructivePatterns(cmd)).toBeNull();
    });
  });
});

// ============================================================================
// formatDestructiveError
// ============================================================================

describe('formatDestructiveError', () => {
  it('includes pattern, reason, and override hint', () => {
    const msg = formatDestructiveError({
      pattern: 'git reset --hard',
      reason: 'Discarding uncommitted work',
    });
    expect(msg).toContain('Command blocked: git reset --hard');
    expect(msg).toContain('Discarding uncommitted work');
    expect(msg).toContain('allowDestructive: ["./path/"]');
  });
});

// ============================================================================
// Integration: bashCommand.execute() with denylist
// ============================================================================

describe('bashCommand destructive denylist integration', () => {
  it('blocks destructive command in execute()', async () => {
    const config: BashStepConfig = { command: 'rm -rf /' };
    const ctx = createMockContext();
    const result = await bashCommand.execute(config, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Command blocked');
    expect(result.error).toContain('Filesystem wipe');
  });

  it('allows destructive command when allowDestructive is true', async () => {
    // We can't actually run rm -rf /, but the denylist should be skipped
    // and the command should reach the shell (which will fail for other reasons).
    // We test that the error is NOT from the denylist.
    const config: BashStepConfig = {
      command: 'echo "would be rm -rf /"',
      allowDestructive: true,
    };
    const ctx = createMockContext();
    const result = await bashCommand.execute(config, ctx);
    // Should succeed because it's just echo
    expect(result.error).toBeUndefined();
  });

  it('blocks git reset --hard in execute()', async () => {
    const config: BashStepConfig = { command: 'git reset --hard HEAD~1' };
    const ctx = createMockContext();
    const result = await bashCommand.execute(config, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Command blocked');
  });

  it('allows safe commands through', async () => {
    const config: BashStepConfig = { command: 'echo hello world' };
    const ctx = createMockContext();
    const result = await bashCommand.execute(config, ctx);
    expect(result.success).toBe(true);
    expect(result.data.stdout).toBe('hello world');
  });
});
