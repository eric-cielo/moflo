/**
 * CapabilityGateway Hardening Tests
 *
 * Epic #270: Tests for enforcement gap closures:
 *   #265: GatedConnectorAccessor
 *   #266: Non-optional gateway (DenyAllGateway)
 *   #267: Capability disclosure extraction
 *   #268: checkCredentials()
 */

import { describe, it, expect } from 'vitest';
import {
  CapabilityGateway,
  CapabilityDeniedError,
  DenyAllGateway,
  DENY_ALL_GATEWAY,
  discloseStep,
  discloseSpell,
  formatStepDisclosure,
  formatSpellDisclosure,
  type ICapabilityGateway,
} from '../../spells/core/capability-gateway.js';
import {
  discloseStep as disclosureDiscloseStep,
  discloseSpell as disclosureDiscloseSpell,
} from '../../spells/core/capability-disclosure.js';
import { GatedConnectorAccessor } from '../../spells/core/gated-connector-accessor.js';
import type { ConnectorAccessor, ConnectorOutput } from '../../spells/types/spell-connector.types.js';
import type { StepCapability } from '../../spells/types/step-command.types.js';
import { ALLOW_ALL_GATEWAY } from './helpers.js';

// ============================================================================
// #265 — GatedConnectorAccessor
// ============================================================================

describe('#265 — GatedConnectorAccessor', () => {
  function makeMockConnectorAccessor(): ConnectorAccessor & { executeCalls: Array<[string, string]> } {
    const executeCalls: Array<[string, string]> = [];
    return {
      executeCalls,
      get: () => undefined,
      has: (name) => name === 'test-conn',
      list: () => [],
      execute: async (name, action) => {
        executeCalls.push([name, action]);
        return { success: true, data: {} };
      },
    };
  }

  it('should delegate execute to inner when gateway allows', async () => {
    const inner = makeMockConnectorAccessor();
    const gated = new GatedConnectorAccessor(inner, ALLOW_ALL_GATEWAY);

    const result = await gated.execute('test-conn', 'fetch', {});
    expect(result.success).toBe(true);
    expect(inner.executeCalls).toEqual([['test-conn', 'fetch']]);
  });

  it('should block execute when gateway denies net capability', async () => {
    const inner = makeMockConnectorAccessor();
    const caps: StepCapability[] = [{ type: 'shell' }]; // no 'net'
    const gateway = new CapabilityGateway(caps, 'test-step', 'test');
    const gated = new GatedConnectorAccessor(inner, gateway);

    const result = await gated.execute('test-conn', 'fetch', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('test-conn');
    expect(result.error).toContain('blocked by capability gateway');
    expect(inner.executeCalls).toHaveLength(0);
  });

  it('should allow execute when gateway grants net capability', async () => {
    const inner = makeMockConnectorAccessor();
    const caps: StepCapability[] = [{ type: 'net' }];
    const gateway = new CapabilityGateway(caps, 'test-step', 'test');
    const gated = new GatedConnectorAccessor(inner, gateway);

    const result = await gated.execute('test-conn', 'fetch', {});
    expect(result.success).toBe(true);
    expect(inner.executeCalls).toHaveLength(1);
  });

  it('should pass through get, has, list without gateway checks', () => {
    const inner = makeMockConnectorAccessor();
    const gated = new GatedConnectorAccessor(inner, DENY_ALL_GATEWAY);

    // Read-only operations should not trigger gateway
    expect(gated.has('test-conn')).toBe(true);
    expect(gated.get('test-conn')).toBeUndefined();
    expect(gated.list()).toEqual([]);
  });
});

// ============================================================================
// #266 — DenyAllGateway
// ============================================================================

describe('#266 — DenyAllGateway', () => {
  it('should be a singleton', () => {
    expect(DENY_ALL_GATEWAY).toBeInstanceOf(DenyAllGateway);
  });

  it('should deny all capability checks', () => {
    const gw = DENY_ALL_GATEWAY;
    expect(() => gw.checkNet('http://example.com')).toThrow(CapabilityDeniedError);
    expect(() => gw.checkShell('echo')).toThrow(CapabilityDeniedError);
    expect(() => gw.checkFsRead('/etc')).toThrow(CapabilityDeniedError);
    expect(() => gw.checkFsWrite('/tmp')).toThrow(CapabilityDeniedError);
    expect(() => gw.checkAgent('general')).toThrow(CapabilityDeniedError);
    expect(() => gw.checkMemory('ns')).toThrow(CapabilityDeniedError);
    expect(() => gw.checkBrowser()).toThrow(CapabilityDeniedError);
    expect(() => gw.checkBrowserEvaluate()).toThrow(CapabilityDeniedError);
    expect(() => gw.checkCredentials('key')).toThrow(CapabilityDeniedError);
  });

  it('should include "no scoped gateway" in denial reason', () => {
    try {
      DENY_ALL_GATEWAY.checkNet('http://example.com');
    } catch (err) {
      expect((err as CapabilityDeniedError).violation.reason).toContain('no scoped gateway');
    }
  });
});

// ============================================================================
// #268 — checkCredentials()
// ============================================================================

describe('#268 — checkCredentials', () => {
  it('should allow when credentials capability is granted', () => {
    const gw = new CapabilityGateway([{ type: 'credentials' }], 'step-1', 'test');
    expect(() => gw.checkCredentials('API_KEY')).not.toThrow();
  });

  it('should deny when credentials capability is not granted', () => {
    const gw = new CapabilityGateway([{ type: 'shell' }], 'step-1', 'test');
    expect(() => gw.checkCredentials('API_KEY')).toThrow(CapabilityDeniedError);
  });

  it('should enforce scope on credential names', () => {
    const gw = new CapabilityGateway(
      [{ type: 'credentials', scope: ['API_'] }],
      'step-1', 'test',
    );
    expect(() => gw.checkCredentials('API_KEY')).not.toThrow();
    expect(() => gw.checkCredentials('DB_PASSWORD')).toThrow(CapabilityDeniedError);
  });
});

// ============================================================================
// #267 — Disclosure extraction
// ============================================================================

describe('#267 — Disclosure extraction', () => {
  it('should re-export disclosure functions from capability-gateway', () => {
    // Verify re-exports work and match the dedicated module
    expect(discloseStep).toBe(disclosureDiscloseStep);
    expect(discloseSpell).toBe(disclosureDiscloseSpell);
  });

  it('discloseStep returns granted and denied capabilities', () => {
    const caps: StepCapability[] = [{ type: 'shell' }, { type: 'net', scope: ['https://api.com'] }];
    const summary = discloseStep('my-step', caps);
    expect(summary.stepName).toBe('my-step');
    expect(summary.granted).toHaveLength(2);
    expect(summary.denied).toContain('fs:read');
    expect(summary.denied).not.toContain('shell');
  });

  it('discloseSpell aggregates across steps', () => {
    const steps = [
      { name: 'step-1', caps: [{ type: 'shell' as const }] },
      { name: 'step-2', caps: [{ type: 'net' as const }, { type: 'shell' as const }] },
    ];
    const summary = discloseSpell('test-wf', steps);
    expect(summary.stepCount).toBe(2);
    expect(summary.aggregate.get('shell')).toEqual(['step-1', 'step-2']);
    expect(summary.aggregate.get('net')).toEqual(['step-2']);
    expect(summary.unused).toContain('fs:read');
  });

  it('formatStepDisclosure produces readable output', () => {
    const summary = discloseStep('s1', [{ type: 'shell' }]);
    const text = formatStepDisclosure(summary);
    expect(text).toContain('shell');
    expect(text).toContain('Execute shell commands');
  });

  it('formatSpellDisclosure produces readable output', () => {
    const summary = discloseSpell('wf', [
      { name: 's1', caps: [{ type: 'shell' }] },
    ]);
    const text = formatSpellDisclosure(summary);
    expect(text).toContain('shell');
    expect(text).toContain('s1');
  });
});
