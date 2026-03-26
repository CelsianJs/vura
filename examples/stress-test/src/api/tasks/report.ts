/**
 * POST /api/tasks/report — Scheduled task route
 * Runs every 5 minutes via cron schedule.
 */

export const route = {
  kind: 'task' as const,
  schedule: '*/5 * * * *',
};

export async function POST(job: { taskId: string; input: unknown; attempt: number }) {
  const input = job.input as { _cron?: boolean; _schedule?: string } | null;

  return {
    success: true,
    taskId: job.taskId,
    isCron: input?._cron ?? false,
    schedule: input?._schedule ?? null,
    reportGenerated: true,
    generatedAt: new Date().toISOString(),
  };
}
