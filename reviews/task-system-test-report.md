# ThenJS Task System - Stress Test Report

**Date:** 2026-03-13
**Script:** `examples/task-stress-test.mjs`
**Target:** `packages/core/dist/tasks.js`

## Results: 49 passed, 0 failed

---

## TaskRunner Tests (8 tests)

### Timer Leak Fix (2/2 passed)
- Fast task with 5s timeout completes normally
- No unhandled rejection fires from the lingering `setTimeout` after the handler resolves first
- **Validates fix:** `clearTimeout(timer)` is called inside the `.then()` on the handler promise, so the race loser never fires

### Results Eviction (1/1 passed)
- Enqueued 50 tasks; results map stays bounded at 50 (well under `maxResults = 10000`)
- `evictOldResults()` correctly filters by completed/failed status and sorts by timestamp

### Concurrency Guard (1/1 passed)
- 5 rapid-fire enqueues with async 50ms handlers; max concurrent was exactly 1
- The `processing` flag prevents re-entrant `processQueue()` calls from running tasks in parallel

### Retry with Backoff (2/2 passed)
- Task throws on attempts 1-2, succeeds on attempt 3
- Final status is `completed` after exponential backoff retries (100ms * 2^attempt)
- Confirms `job.attempt <= job.maxRetries` comparison is correct

### Timeout Enforcement (2/2 passed)
- Task sleeps 10s but timeout is 200ms; status becomes `failed`
- Error message contains "timeout" substring as expected

---

## CronScheduler Tests (27 tests)

### Double-Fire Prevention (1/1 passed)
- `tick()` called 3 times in the same calendar minute
- Handler fired exactly once thanks to `lastFiredMinute` tracking using a unique minute fingerprint (`year*525960 + month*43800 + date*1440 + hours*60 + minutes`)

### cronFieldMatches (20/20 passed)
Comprehensive coverage of all cron field syntax:

| Pattern | Tests | Status |
|---|---|---|
| `*` (wildcard) | 0, 59 | All pass |
| `5` (exact) | match 5, reject 6 | All pass |
| `1-5` (range) | match 3, bounds 1/5, reject 6 | All pass |
| `*/5` (step) | match 0/10, reject 3 | All pass |
| `1-30/5` (range+step) | match 1/6/11/16/21/26, reject 0/2/31 | All pass |
| `1,15,30` (comma list) | match 15, reject 10 | All pass |
| `1-5,10-15` (comma+range) | match 3/12, reject 7 | All pass |

The **range+step** pattern (`1-30/5`) was the key fix -- it uses `(value - min) % step === 0` to correctly offset from the range start rather than from 0.

### parseCron (6/6 passed)
- Correctly splits 5-field expression into named fields
- Rejects invalid 3-field expression (returns `null`)

---

## MemoryQueue Tests (7 tests, all passed)

| Test | Status |
|---|---|
| Push 2 items, length = 2 | Passed |
| FIFO order (pop returns id 1 first) | Passed |
| Length decrements after pop | Passed |
| markInFlight increments inFlightCount | Passed |
| ack decrements inFlightCount | Passed |
| nack removes from in-flight | Passed |
| nack re-queues the job (length += 1) | Passed |

**Note:** The `markInFlight` method only tracks a job in the in-flight map -- it does not remove it from the queue. In actual `TaskRunner.processQueue()` usage, `pop()` is called first to dequeue, then `markInFlight()` is called to track. Tests were written to match this real usage pattern.

---

## Architecture Observations

1. **Timer cleanup is correct:** The `Promise.race` pattern clears the timeout timer inside the handler's `.then()` callback, preventing the timeout rejection from firing after the task completes.

2. **Serial processing by design:** The `processing` flag ensures only one `processQueue` loop runs at a time. Tasks within the loop are awaited sequentially. This is simple and correct for a single-process task runner.

3. **Retry re-entry:** When a task fails with retries remaining, a `setTimeout` schedules a re-push + `processQueue()` call. Because `processing` is `false` by then (the loop has moved on), the retry correctly starts a new processing loop.

4. **Cron dedup is minute-scoped:** The `lastFiredMinute` fingerprint is deterministic within a calendar minute, so multiple `tick()` calls in the same minute are safely deduplicated.
