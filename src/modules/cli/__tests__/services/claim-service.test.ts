/**
 * Claim Service Tests
 *
 * Happy-path smoke tests for ClaimService: claim, release,
 * handoff request/accept, and basic status checks.
 *
 * Filesystem is mocked — no real directory creation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs so ClaimService doesn't touch the real filesystem
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('{"claims":[]}'),
  };
});

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import {
  ClaimService,
  type Claimant,
  type ClaimResult,
} from '../../src/services/claim-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const humanClaimant: Claimant = { type: 'human', userId: 'user-1', name: 'Alice' };
const agentClaimant: Claimant = { type: 'agent', agentId: 'agent-1', agentType: 'coder' };
const anotherAgent: Claimant = { type: 'agent', agentId: 'agent-2', agentType: 'tester' };

describe('ClaimService', () => {
  let service: ClaimService;

  beforeEach(async () => {
    service = new ClaimService('/tmp/test-project');
    await service.initialize();
  });

  // ===========================================================================
  // Construction & Initialization
  // ===========================================================================
  describe('construction', () => {
    it('should create a service instance', () => {
      expect(service).toBeInstanceOf(ClaimService);
    });

    it('should be an EventEmitter', () => {
      expect(typeof service.on).toBe('function');
      expect(typeof service.emit).toBe('function');
    });
  });

  // ===========================================================================
  // Claim
  // ===========================================================================
  describe('claim', () => {
    it('should claim an unclaimed issue', async () => {
      const result = await service.claim('ISSUE-1', humanClaimant);
      expect(result.success).toBe(true);
      expect(result.claim).toBeDefined();
      expect(result.claim!.issueId).toBe('ISSUE-1');
      expect(result.claim!.status).toBe('active');
      expect(result.claim!.progress).toBe(0);
    });

    it('should return error when issue is already claimed', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      const result = await service.claim('ISSUE-1', agentClaimant);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already claimed');
    });

    it('should emit issue:claimed event', async () => {
      const handler = vi.fn();
      service.on('issue:claimed', handler);
      await service.claim('ISSUE-2', agentClaimant);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: 'ISSUE-2' })
      );
    });
  });

  // ===========================================================================
  // Release
  // ===========================================================================
  describe('release', () => {
    it('should release a claimed issue', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      await service.release('ISSUE-1', humanClaimant);

      // After release, a new claim should succeed
      const result = await service.claim('ISSUE-1', agentClaimant);
      expect(result.success).toBe(true);
    });

    it('should throw when releasing an unclaimed issue', async () => {
      await expect(
        service.release('NO-SUCH-ISSUE', humanClaimant)
      ).rejects.toThrow('not claimed');
    });

    it('should throw when a different claimant tries to release', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      await expect(
        service.release('ISSUE-1', agentClaimant)
      ).rejects.toThrow('not claimed by');
    });

    it('should emit issue:released event', async () => {
      const handler = vi.fn();
      service.on('issue:released', handler);
      await service.claim('ISSUE-1', humanClaimant);
      await service.release('ISSUE-1', humanClaimant);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ===========================================================================
  // Handoff
  // ===========================================================================
  describe('handoff', () => {
    it('should request a handoff from one claimant to another', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      await service.requestHandoff('ISSUE-1', humanClaimant, agentClaimant, 'need AI help');

      // The claim should now be in handoff-pending status
      // (No public getter for individual claims, but acceptHandoff validates status)
    });

    it('should accept a pending handoff', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      await service.requestHandoff('ISSUE-1', humanClaimant, agentClaimant, 'need AI help');
      await service.acceptHandoff('ISSUE-1', agentClaimant);

      // Agent now owns the claim — releasing with agent should work
      await service.release('ISSUE-1', agentClaimant);
    });

    it('should throw when accepting handoff for wrong recipient', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      await service.requestHandoff('ISSUE-1', humanClaimant, agentClaimant, 'reason');

      await expect(
        service.acceptHandoff('ISSUE-1', anotherAgent)
      ).rejects.toThrow('not addressed to');
    });

    it('should throw when no pending handoff exists', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      await expect(
        service.acceptHandoff('ISSUE-1', agentClaimant)
      ).rejects.toThrow('No pending handoff');
    });

    it('should emit handoff events', async () => {
      const requested = vi.fn();
      const accepted = vi.fn();
      service.on('issue:handoff:requested', requested);
      service.on('issue:handoff:accepted', accepted);

      await service.claim('ISSUE-1', humanClaimant);
      await service.requestHandoff('ISSUE-1', humanClaimant, agentClaimant, 'reason');
      expect(requested).toHaveBeenCalledOnce();

      await service.acceptHandoff('ISSUE-1', agentClaimant);
      expect(accepted).toHaveBeenCalledOnce();
    });
  });

  // ===========================================================================
  // Event Log
  // ===========================================================================
  describe('getEventLog', () => {
    it('should return events from service operations', async () => {
      await service.claim('ISSUE-1', humanClaimant);
      await service.release('ISSUE-1', humanClaimant);

      const log = service.getEventLog();
      expect(log.length).toBeGreaterThanOrEqual(2);
      expect(log[0].type).toBe('issue:claimed');
      expect(log[1].type).toBe('issue:released');
    });
  });
});
