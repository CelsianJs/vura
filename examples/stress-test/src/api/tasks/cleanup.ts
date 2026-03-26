/**
 * POST /api/tasks/cleanup — Task route
 * Background cleanup job with retries and timeout.
 */

export const route = {
  kind: 'task' as const,
  retries: 2,
  timeout: 5000,
};

export async function POST(job: { taskId: string; input: unknown; attempt: number }) {
  const input = job.input as { type?: string } | null;
  const cleanupType = input?.type ?? 'basic';

  // Simulate async processing
  await new Promise(resolve => setTimeout(resolve, 50));

  return {
    success: true,
    taskId: job.taskId,
    attempt: job.attempt,
    cleanupType,
    itemsCleaned: 15,
    processedAt: new Date().toISOString(),
  };
}
