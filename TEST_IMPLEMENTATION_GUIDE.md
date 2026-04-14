# Test Implementation Quick Reference

## Finding Placeholder Tests

All created test skeletons use `// TODO:` comments for easy identification:

```bash
# Find all TODO test placeholders
grep -r "// TODO:" src/**/*.test.ts

# Count total placeholders
grep -r "// TODO:" src/**/*.test.ts | wc -l

# Find placeholders by module
grep -r "// TODO:" src/modules/aidefence/__tests__/*.test.ts
grep -r "// TODO:" src/modules/claims/__tests__/*.test.ts
grep -r "// TODO:" src/core/__tests__/*.test.ts
grep -r "// TODO:" src/__tests__/appliance/*.test.ts
```

## Test Skeleton Structure

Each test skeleton follows this pattern:

```typescript
describe('Feature Name', () => {
  it('should do something specific', async () => {
    // TODO: Implement actual test
    expect(true).toBe(true); // Placeholder
  });
});
```

## Implementation Steps

### 1. Remove Placeholder
```typescript
// Before
it('should validate input', async () => {
  // TODO: Test input validation
  expect(true).toBe(true); // Placeholder
});

// After
it('should validate input', async () => {
  const service = createService();
  
  await expect(
    service.process({ invalid: 'data' })
  ).rejects.toThrow('Invalid input');
});
```

### 2. Add Setup/Teardown
```typescript
describe('Service', () => {
  let service: MyService;
  
  beforeEach(() => {
    service = createMyService();
  });
  
  afterEach(() => {
    service.cleanup();
  });
  
  it('should work', () => {
    // Test uses service from beforeEach
  });
});
```

### 3. Follow Existing Patterns

#### For Vitest Tests (AIDefence, Claims, Core)
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('MyFeature', () => {
  it('should work', () => {
    expect(actualValue).toBe(expectedValue);
    expect(actualValue).toEqual(expectedObject);
    expect(fn).toHaveBeenCalledWith(arg);
  });
});
```

#### For Node:test Tests (Appliance/RVFA/GGUF)
```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('MyFeature', () => {
  it('should work', () => {
    assert.equal(actualValue, expectedValue);
    assert.deepEqual(actualObj, expectedObj);
    assert.ok(truthyValue);
    assert.throws(() => fn(), /error message/);
  });
});
```

## Common Test Patterns

### Testing Async Functions
```typescript
it('should handle async operation', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Testing Errors
```typescript
// Vitest
it('should throw on error', async () => {
  await expect(fn()).rejects.toThrow('Error message');
});

// node:test
it('should throw on error', async () => {
  await assert.rejects(
    async () => await fn(),
    { message: 'Error message' }
  );
});
```

### Testing Events
```typescript
it('should emit event', async () => {
  const handler = vi.fn();
  eventBus.on('event-name', handler);
  
  await triggerEvent();
  
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'event-name' })
  );
});
```

### Testing Mocks
```typescript
it('should call dependency', async () => {
  const mockDep = vi.fn().mockResolvedValue('result');
  const service = createService({ dependency: mockDep });
  
  await service.doSomething();
  
  expect(mockDep).toHaveBeenCalledTimes(1);
  expect(mockDep).toHaveBeenCalledWith('expected-arg');
});
```

### Testing Timeouts
```typescript
it('should complete within time limit', async () => {
  const start = performance.now();
  await operation();
  const duration = performance.now() - start;
  
  expect(duration).toBeLessThan(100); // 100ms
});
```

### Testing Retries
```typescript
it('should retry on failure', async () => {
  const fn = vi.fn()
    .mockRejectedValueOnce(new Error('Fail 1'))
    .mockRejectedValueOnce(new Error('Fail 2'))
    .mockResolvedValue('Success');
  
  const result = await retryOperation(fn, { maxRetries: 3 });
  
  expect(fn).toHaveBeenCalledTimes(3);
  expect(result).toBe('Success');
});
```

### Testing Concurrency
```typescript
it('should handle concurrent operations', async () => {
  const promises = Array.from({ length: 100 }, (_, i) => 
    operation(i)
  );
  
  const results = await Promise.all(promises);
  
  expect(results).toHaveLength(100);
  results.forEach(r => expect(r).toBeDefined());
});
```

## Running Tests

### Run All Tests
```bash
npm test
```

### Run Specific Test File
```bash
# Vitest
npm test -- aidefence-integration.test.ts

# node:test
npx tsx --test src/__tests__/appliance/edge-cases.test.ts
```

### Run Tests in Watch Mode
```bash
npm test -- --watch
```

### Run Tests with Coverage
```bash
npm test -- --coverage
```

### Run Only TODO Placeholders (to verify structure)
```bash
# This will run all tests, but placeholders will pass
npm test
```

## Coverage Targets

After implementing tests, verify coverage:

```bash
# Generate coverage report
npm test -- --coverage

# View coverage in browser
open coverage/index.html
```

### Target Coverage by Module
- **Core Orchestrator:** 90%+
- **Claims MCP Tools:** 90%+
- **AIDefence Learning:** 90%+
- **AIDefence Integration:** 85%+
- **RVFA/GGUF Edge Cases:** 80%+

## Checklist for Each Test

- [ ] Remove `// TODO:` comment
- [ ] Remove placeholder `expect(true).toBe(true)`
- [ ] Add actual test implementation
- [ ] Add descriptive assertion messages
- [ ] Test both success and error cases
- [ ] Add edge case tests
- [ ] Verify test passes
- [ ] Verify test fails when it should (break code temporarily)
- [ ] Check coverage report

## Priority Implementation Order

Based on `TEST_COVERAGE_ANALYSIS.md`:

### Week 1-2: Critical Infrastructure
1. `src/core/__tests__/orchestrator.test.ts`
   - TaskManager (30 tests)
   - SessionManager (20 tests)
   
2. `src/modules/claims/__tests__/mcp-tools.test.ts`
   - Core claiming tools (20 tests)
   - Work stealing tools (15 tests)

3. `src/modules/aidefence/__tests__/threat-learning.test.ts`
   - InMemoryVectorStore (10 tests)
   - Pattern learning (15 tests)

### Week 3-4: Integration & Advanced
1. `src/core/__tests__/orchestrator.test.ts`
   - AgentPool (20 tests)
   - HealthMonitor (15 tests)
   - EventCoordinator (15 tests)
   - Integration (17 tests)

2. `src/modules/claims/__tests__/mcp-tools.test.ts`
   - Load balancing tools (15 tests)
   - Additional tools (10 tests)

3. `src/modules/aidefence/__tests__/threat-learning.test.ts`
   - Vector search (10 tests)
   - Mitigation strategies (15 tests)
   - Trajectories (10 tests)

### Week 5-6: End-to-End & Edge Cases
1. `src/modules/aidefence/__tests__/aidefence-integration.test.ts`
   - All integration scenarios (50+ tests)

2. `src/__tests__/appliance/edge-cases.test.ts`
   - GGUF edge cases (40 tests)
   - RVFA edge cases (40 tests)

## Tips for Efficient Implementation

### 1. Implement Similar Tests in Batch
Group similar test types together:
- All validation tests
- All error handling tests
- All performance tests

### 2. Copy Existing Patterns
Look at existing tests in the same module:
```bash
# Find similar tests to copy from
ls -la src/modules/aidefence/__tests__/
cat src/modules/aidefence/__tests__/threat-detection.test.ts
```

### 3. Use Test Factories
Create helper functions for common setups:
```typescript
function createTestService(overrides = {}) {
  return new MyService({
    defaultOption: 'value',
    ...overrides,
  });
}
```

### 4. Leverage TypeScript
Let TypeScript guide you:
- Autocomplete shows available methods
- Type errors reveal missing mocks
- Interface definitions show required properties

### 5. Follow Broken Window Theory
- Fix failing tests before adding new ones
- Don't skip tests with `.skip()`
- Don't mark tests as TODO in code - implement or delete

## Common Pitfalls to Avoid

❌ **Don't:** Leave placeholder tests in production
```typescript
it('should work', () => {
  expect(true).toBe(true); // This passes but tests nothing!
});
```

✅ **Do:** Either implement or remove
```typescript
it('should validate input', () => {
  const result = validate({ data: 'test' });
  expect(result.valid).toBe(true);
});
```

❌ **Don't:** Test implementation details
```typescript
it('should call internal method', () => {
  expect(service._internalMethod).toHaveBeenCalled(); // Fragile!
});
```

✅ **Do:** Test public behavior
```typescript
it('should return correct result', () => {
  const result = service.process(input);
  expect(result).toEqual(expectedOutput);
});
```

❌ **Don't:** Write flaky tests
```typescript
it('should complete quickly', async () => {
  await sleep(100); // Arbitrary wait - flaky!
  expect(result).toBeDefined();
});
```

✅ **Do:** Use proper async patterns
```typescript
it('should complete quickly', async () => {
  const result = await operation(); // Wait for actual completion
  expect(result).toBeDefined();
});
```

## Questions?

Refer to:
- Existing test files in the same module
- `TEST_COVERAGE_ANALYSIS.md` for context
- Vitest docs: https://vitest.dev/
- Node.js test docs: https://nodejs.org/api/test.html
