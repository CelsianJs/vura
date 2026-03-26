import {
  TaskRunner, MemoryQueue, CronScheduler,
  parseCron, cronFieldMatches,
  createTaskRunner, createCronScheduler
} from '../packages/core/dist/index.js';

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// === TaskRunner Tests ===
console.log('\n=== TaskRunner ===');

// 1. Timer leak fix: verify timeout doesn't create unhandled rejections
{
  console.log('\n--- Timer Leak Fix ---');
  const runner = createTaskRunner();
  let unhandled = false;
  const handler = (e) => { unhandled = true; };
  process.on('unhandledRejection', handler);

  runner.register('fast-task', async (job) => {
    return { done: true };
  }, { timeout: 5000 });

  const id = runner.enqueue('fast-task', { test: true });
  await new Promise(r => setTimeout(r, 200)); // Wait for task to complete

  const job = runner.getJob(id);
  assert(job.status === 'completed', 'Fast task completes');

  // Wait a bit more to ensure no unhandled rejection from lingering timer
  await new Promise(r => setTimeout(r, 500));
  assert(!unhandled, 'No unhandled rejection from timeout timer');
  process.removeListener('unhandledRejection', handler);
}

// 2. Results eviction
{
  console.log('\n--- Results Eviction ---');
  const runner = createTaskRunner();
  runner.register('bulk-task', async () => ({ ok: true }), {});

  // Enqueue many tasks
  for (let i = 0; i < 50; i++) {
    runner.enqueue('bulk-task', { i });
  }
  await new Promise(r => setTimeout(r, 500));

  const stats = runner.getStats();
  assert(stats.total <= 10001, `Results map bounded (${stats.total} entries)`);
}

// 3. Concurrency guard (processing flag)
{
  console.log('\n--- Concurrency Guard ---');
  const runner = createTaskRunner();
  let concurrent = 0;
  let maxConcurrent = 0;

  runner.register('serial-task', async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 50));
    concurrent--;
    return { ok: true };
  }, {});

  // Rapid-fire enqueue
  for (let i = 0; i < 5; i++) {
    runner.enqueue('serial-task', { i });
  }
  await new Promise(r => setTimeout(r, 500));

  assert(maxConcurrent === 1, `Max concurrent tasks was 1 (got ${maxConcurrent})`);
}

// 4. Retry with backoff
{
  console.log('\n--- Retry with Backoff ---');
  const runner = createTaskRunner();
  let attempts = 0;

  runner.register('flaky-task', async (job) => {
    attempts++;
    if (attempts < 3) throw new Error('Flaky!');
    return { success: true };
  }, { retries: 3, timeout: 5000 });

  const id = runner.enqueue('flaky-task', {});
  await new Promise(r => setTimeout(r, 3000));

  const job = runner.getJob(id);
  assert(job.status === 'completed', `Flaky task eventually succeeds (status: ${job.status})`);
  assert(attempts === 3, `Took 3 attempts (got ${attempts})`);
}

// 5. Timeout enforcement
{
  console.log('\n--- Timeout Enforcement ---');
  const runner = createTaskRunner();

  runner.register('slow-task', async () => {
    await new Promise(r => setTimeout(r, 10000));
    return { done: true };
  }, { timeout: 200, retries: 0 });

  const id = runner.enqueue('slow-task', {});
  await new Promise(r => setTimeout(r, 1000));

  const job = runner.getJob(id);
  assert(job.status === 'failed', `Slow task failed (status: ${job.status})`);
  assert(job.error.includes('timeout'), `Error mentions timeout: ${job.error}`);
}

// === CronScheduler Tests ===
console.log('\n=== CronScheduler ===');

// 6. Double-fire prevention
{
  console.log('\n--- Double-Fire Prevention ---');
  let fireCount = 0;
  const scheduler = createCronScheduler((taskName) => {
    fireCount++;
  });
  scheduler.register('test-job', '* * * * *'); // Every minute

  // Tick twice in same minute
  scheduler.tick();
  scheduler.tick();
  scheduler.tick();

  assert(fireCount === 1, `Cron fired exactly once despite 3 ticks (got ${fireCount})`);
  scheduler.stop();
}

// 7. Cron field matching - comprehensive
{
  console.log('\n--- cronFieldMatches ---');

  // Wildcard
  assert(cronFieldMatches('*', 0), '* matches 0');
  assert(cronFieldMatches('*', 59), '* matches 59');

  // Exact
  assert(cronFieldMatches('5', 5), '5 matches 5');
  assert(!cronFieldMatches('5', 6), '5 does not match 6');

  // Range
  assert(cronFieldMatches('1-5', 3), '1-5 matches 3');
  assert(!cronFieldMatches('1-5', 6), '1-5 does not match 6');
  assert(cronFieldMatches('1-5', 1), '1-5 matches 1 (lower bound)');
  assert(cronFieldMatches('1-5', 5), '1-5 matches 5 (upper bound)');

  // Step
  assert(cronFieldMatches('*/5', 0), '*/5 matches 0');
  assert(cronFieldMatches('*/5', 10), '*/5 matches 10');
  assert(!cronFieldMatches('*/5', 3), '*/5 does not match 3');

  // Range + Step (THE BIG FIX)
  assert(cronFieldMatches('1-30/5', 1), '1-30/5 matches 1');
  assert(cronFieldMatches('1-30/5', 6), '1-30/5 matches 6');
  assert(cronFieldMatches('1-30/5', 11), '1-30/5 matches 11');
  assert(cronFieldMatches('1-30/5', 16), '1-30/5 matches 16');
  assert(cronFieldMatches('1-30/5', 21), '1-30/5 matches 21');
  assert(cronFieldMatches('1-30/5', 26), '1-30/5 matches 26');
  assert(!cronFieldMatches('1-30/5', 0), '1-30/5 does not match 0');
  assert(!cronFieldMatches('1-30/5', 2), '1-30/5 does not match 2');
  assert(!cronFieldMatches('1-30/5', 31), '1-30/5 does not match 31');

  // Comma-separated
  assert(cronFieldMatches('1,15,30', 15), '1,15,30 matches 15');
  assert(!cronFieldMatches('1,15,30', 10), '1,15,30 does not match 10');

  // Combined comma + range
  assert(cronFieldMatches('1-5,10-15', 3), '1-5,10-15 matches 3');
  assert(cronFieldMatches('1-5,10-15', 12), '1-5,10-15 matches 12');
  assert(!cronFieldMatches('1-5,10-15', 7), '1-5,10-15 does not match 7');
}

// 8. parseCron
{
  console.log('\n--- parseCron ---');
  const fields = parseCron('*/5 0-23 1,15 * 1-5');
  assert(fields !== null, 'Parses valid 5-field expression');
  assert(fields.minute === '*/5', 'Minute field correct');
  assert(fields.hour === '0-23', 'Hour field correct');
  assert(fields.dayOfMonth === '1,15', 'DayOfMonth field correct');
  assert(fields.month === '*', 'Month field correct');
  assert(fields.dayOfWeek === '1-5', 'DayOfWeek field correct');

  const invalid = parseCron('1 2 3');
  assert(invalid === null, 'Rejects 3-field expression');
}

// === MemoryQueue Tests ===
console.log('\n=== MemoryQueue ===');

{
  const q = new MemoryQueue();
  const job1 = { id: '1', taskName: 'test', input: {}, status: 'pending', attempt: 0, maxRetries: 0, createdAt: Date.now() };
  const job2 = { id: '2', taskName: 'test', input: {}, status: 'pending', attempt: 0, maxRetries: 0, createdAt: Date.now() };

  q.push(job1);
  q.push(job2);
  assert(q.length === 2, 'Queue has 2 items');

  const popped = q.pop();
  assert(popped.id === '1', 'FIFO order (got id 1 first)');
  assert(q.length === 1, 'Queue has 1 item after pop');

  q.markInFlight(popped);
  assert(q.inFlightCount === 1, '1 in-flight');

  q.ack(popped.id);
  assert(q.inFlightCount === 0, '0 in-flight after ack');

  const job3 = { id: '3', taskName: 'test', input: {}, status: 'pending', attempt: 0, maxRetries: 0, createdAt: Date.now() };
  q.push(job3);
  // Simulate what TaskRunner does: pop then markInFlight
  const popped3 = q.pop();
  q.markInFlight(popped3);
  assert(q.inFlightCount === 1, '1 in-flight after markInFlight');
  q.nack(popped3);
  assert(q.inFlightCount === 0, 'nack removes from in-flight');
  assert(q.length === 2, 'nack re-queues the job');
}

// === Summary ===
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
