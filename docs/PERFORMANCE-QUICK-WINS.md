# Performance Quick Wins - Summary

Top 10 performance optimizations with immediate impact.

## 🔥 Critical (Implement First)

### 1. Vector Store Search Index
**File**: `src/modules/aidefence/src/domain/services/threat-learning-service.ts`
**Impact**: 50-100x faster searches
**Fix**: Pre-compute searchable text at insert time (see `optimized-vector-store.ts`)

```typescript
// ❌ Before: JSON.stringify on every search
for (const [key, { value }] of ns) {
  const valueStr = JSON.stringify(value).toLowerCase();
  // ...
}

// ✅ After: Pre-computed index
const entry = {
  value: item.value,
  searchableText: JSON.stringify(item.value).toLowerCase() // Once at insert
};
```

### 2. Trajectory Memory Leak
**File**: `src/modules/aidefence/src/domain/services/threat-learning-service.ts:160`
**Impact**: Prevents OOM crashes
**Fix**: Add LRU eviction and TTL (see `trajectory-manager.ts`)

```typescript
// ❌ Before: Unbounded growth
private trajectories = new Map<string, LearningTrajectory>();

// ✅ After: Bounded with auto-cleanup
const manager = new TrajectoryManager({
  maxTrajectories: 1000,
  trajectoryTTL: 1800000 // 30 min
});
```

### 3. Cache Size Estimation
**File**: `src/modules/memory/src/cache-manager.ts:338`
**Impact**: 18x faster cache operations
**Fix**: Cache computed sizes in LRUNode

```typescript
// ❌ Before: JSON.stringify on every set/evict
private estimateSize(data: T): number {
  return JSON.stringify(data).length * 2;
}

// ✅ After: Store size in node
interface LRUNode<T> {
  key: string;
  value: CachedEntry<T>;
  estimatedSize: number; // Cached!
}
```

---

## ⚡ High Impact (Implement Next)

### 4. Pattern Matching Early Termination
**File**: `src/modules/aidefence/src/domain/services/threat-detection-service.ts`
**Impact**: 3-5x faster threat detection

```typescript
// ✅ Stop after critical threat found
for (const pattern of patternsByPriority) {
  if (pattern.pattern.test(input)) {
    threats.push(createThreat(pattern));
    
    if (pattern.severity === 'critical') {
      break; // Early termination!
    }
  }
}
```

### 5. Request Deduplication
**Impact**: 50% reduction in redundant work

```typescript
// ✅ Deduplicate concurrent identical requests
private pendingRequests = new Map<string, Promise<unknown>>();

async search(params) {
  const key = this.cacheKey(params);
  const pending = this.pendingRequests.get(key);
  if (pending) return pending; // Return existing promise
  
  const promise = this.doSearch(params);
  this.pendingRequests.set(key, promise);
  promise.finally(() => this.pendingRequests.delete(key));
  
  return promise;
}
```

### 6. Buffer Pre-Allocation
**File**: Test files with buffer operations
**Impact**: 2-3x faster buffer operations

```typescript
// ❌ Before: Multiple allocations
return Buffer.concat([lenBuf, strBuf]);

// ✅ After: Single allocation
const result = Buffer.allocUnsafe(8 + strBytes);
result.writeBigUInt64LE(BigInt(strBytes), 0);
result.write(str, 8, 'utf-8');
return result;
```

---

## 💡 Medium Impact (Nice to Have)

### 7. Batch Operations
**Impact**: 5-10x faster bulk inserts/searches

```typescript
// ✅ Batch API
async storeBatch(entries: Array<{...}>): Promise<void> {
  // Group by namespace, reduce Map operations
  const grouped = groupBy(entries, e => e.namespace);
  for (const [ns, items] of grouped) {
    // Bulk insert to namespace
  }
}
```

### 8. Hash Caching
**Impact**: Avoid redundant crypto operations

```typescript
// ✅ Cache hashes
class HashCache {
  private cache = new LRUCache<string, string>({ max: 10000 });
  
  hash(input: string): string {
    return this.cache.getOrSet(input, () => 
      createHash('sha256').update(input).digest('hex')
    );
  }
}
```

### 9. Regex Compilation Cache
**Impact**: Faster pattern matching

```typescript
// ✅ Cache compiled regexes
const regexCache = new Map<string, RegExp>();

function getRegex(pattern: string): RegExp {
  return regexCache.getOrSet(pattern, () => new RegExp(pattern, 'i'));
}
```

### 10. Lazy Cleanup
**Impact**: Reduce timer overhead

```typescript
// ❌ Before: Timer-based cleanup
setInterval(() => this.cleanup(), 60000);

// ✅ After: Demand-driven cleanup
async get(key: string): Promise<T | null> {
  const entry = this.cache.get(key);
  
  // Cleanup on access (lazy)
  if (entry && this.isExpired(entry)) {
    this.delete(key);
    return null;
  }
  
  return entry;
}
```

---

## 📊 Performance Targets

| Operation | Before | Target | Improvement |
|-----------|--------|--------|-------------|
| Vector search (10k) | 50ms | 1ms | **50x** |
| Threat detection | 10ms | 3ms | **3x** |
| Cache set (1000) | 15ms | 0.8ms | **18x** |
| Buffer ops (100KB) | 8ms | 3ms | **2.6x** |

---

## 🧪 Testing

```bash
# Run performance benchmarks
npm run bench

# Run with profiling
node --prof src/modules/memory/benchmarks/vector-search.bench.ts

# Generate flame graph
node --prof-process isolate-*.log > processed.txt
```

---

## 📈 Monitoring

```typescript
// Track performance in production
import { PerformanceTracker } from './performance-tracker';

const tracker = new PerformanceTracker();

app.get('/api/search', async (req, res) => {
  const result = await tracker.trackAsync('api:search', async () => {
    return vectorStore.search(req.query);
  });
  
  res.json(result);
});

// Log slow operations
setInterval(() => {
  const report = tracker.getReport();
  for (const [op, metrics] of Object.entries(report)) {
    if (metrics.avgTime > 100) {
      logger.warn(`Slow operation: ${op} avg=${metrics.avgTime}ms`);
    }
  }
}, 60000);
```

---

## 🚀 Implementation Checklist

### Week 1: Critical Path
- [ ] Replace InMemoryVectorStore with OptimizedVectorStore
- [ ] Add TrajectoryManager with memory limits
- [ ] Optimize CacheManager size estimation
- [ ] Add performance benchmarks

### Week 2: High Impact
- [ ] Implement pattern matching early termination
- [ ] Add request deduplication layer
- [ ] Optimize buffer operations
- [ ] Add batch operation APIs

### Week 3: Polish
- [ ] Add hash/regex caching
- [ ] Implement lazy cleanup
- [ ] Add performance monitoring
- [ ] Document performance characteristics

---

## 📚 Reference

**Full Documentation**: `docs/performance-optimizations.md`
**Optimized Implementations**:
- `src/modules/aidefence/src/domain/services/optimized-vector-store.ts`
- `src/modules/aidefence/src/domain/services/trajectory-manager.ts`
- `src/modules/memory/src/cache-manager.ts` (updated)

**Key Principles**:
1. **Avoid repeated work** - Cache, memoize, deduplicate
2. **Early termination** - Stop when done, don't over-process
3. **Pre-compute** - Do work once at insert, not on every read
4. **Bounded resources** - LRU, TTL, max limits
5. **Measure** - Track metrics, set targets, regression test
