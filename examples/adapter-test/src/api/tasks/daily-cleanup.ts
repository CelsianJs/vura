export const route = { kind: 'task' as const, schedule: '0 2 * * *', retries: 3, timeout: 60000 };
export async function POST(job: any) {
  return { cleaned: true, taskId: job.taskId };
}
