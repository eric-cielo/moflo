/**
 * V3 Claude-Flow Test Helpers Index
 *
 * Central export for all test helpers
 */

// Mock factory utilities
export {
  createMock,
  createDeepMock,
  createSpyMock,
  createMockWithBehavior,
  createRetryMock,
  createSequenceMock,
  InteractionRecorder,
  type MockedInterface,
} from './create-mock.js';

// Test application builder
export {
  createTestApplication,
  type TestApplication,
  type IEventBus,
  type ITaskManager,
  type IAgentLifecycle,
  type IMemoryService,
  type ISecurityService,
  type ISwarmCoordinator,
} from './test-application.js';

// Swarm test instance
export {
  createSwarmTestInstance,
  SwarmTestInstance,
  type V3AgentType,
  type SwarmTopology,
  type SwarmAgent,
  type SwarmMessage,
  type SwarmTask,
  type SwarmTaskResult,
} from './swarm-instance';

// Custom assertions
export {
  assertCallSequence,
  assertNotCalledWith,
  assertInteractionCount,
  assertAllCalled,
  assertNoneCalled,
  assertContractCompliance,
  assertTimingWithin,
  assertTimingRange,
  assertThrowsWithMessage,
  assertEventPublished,
  assertMockSequence,
  assertNoSensitiveDataLogged,
  assertPerformanceTarget,
  type ContractDefinition,
} from './assertions';
