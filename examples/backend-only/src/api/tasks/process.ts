/**
 * Background task processor — runs as a task.
 * POST /api/tasks/process — enqueue a simulated background job.
 *
 * Tasks are fire-and-forget workloads: email sending, image resizing,
 * report generation, etc. They get their own execution context with
 * longer timeouts than serverless functions.
 */
export const route = { kind: 'task' };

export async function POST(req: any, reply: any) {
  const body = req.parsedBody as { type?: string; payload?: any };
  const taskType = body?.type ?? 'default';
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Simulate async processing
  const startTime = Date.now();
  await new Promise(resolve => setTimeout(resolve, 100));
  const duration = Date.now() - startTime;

  return reply.status(202).json({
    taskId,
    type: taskType,
    status: 'accepted',
    message: `Task ${taskId} enqueued for processing`,
    processingTime: `${duration}ms`,
    payload: body?.payload ?? null,
  });
}
