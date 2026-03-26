export const route = { kind: 'task' as const, schedule: '0 9 * * 1', retries: 1, timeout: 120000 };
export async function POST(job: any) {
  return { report: 'generated', taskId: job.taskId };
}
