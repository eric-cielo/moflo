/**
 * Resilience Patterns
 *
 * Production-ready resilience utilities:
 * - Retry with exponential backoff
 * - Circuit breaker pattern
 * - Rate limiting
 *
 * @module v3/shared/resilience
 */

// Retry
export { retry, RetryError, withTimeout } from './retry.js';
export type { RetryOptions, RetryResult, WithTimeoutOptions } from './retry.js';

// Circuit Breaker
export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitBreakerOptions, CircuitBreakerStats } from './circuit-breaker.js';

// Rate Limiter
export { SlidingWindowRateLimiter, TokenBucketRateLimiter } from './rate-limiter.js';
export type { RateLimiter, RateLimiterOptions, RateLimitResult } from './rate-limiter.js';

// Bulkhead
export { Bulkhead } from './bulkhead.js';
export type { BulkheadOptions, BulkheadStats } from './bulkhead.js';

// Signal handlers
export { SHUTDOWN_SIGNALS, attachSignalHandlers } from './signal-handlers.js';
export type { ShutdownSignal } from './signal-handlers.js';
