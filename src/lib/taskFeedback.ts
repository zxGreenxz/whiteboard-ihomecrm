export function dayAttendanceView(status: string | undefined, unavailable: boolean): string {
  if (unavailable) return 'unavailable';
  if (status === 'pending_leave') return 'pending';
  if (status === 'leave_approved') return 'approved';
  return status === 'ticked' ? 'ticked' : 'notYet';
}

export type JobSaveOutcome =
  | { status: 'complete'; jobId: string }
  | { status: 'partial'; jobId: string; error: unknown }
  | { status: 'unknown'; jobId: null; error: unknown };

export async function saveJobAndMaterials(create: () => Promise<{ id: string }>, saveMaterials?: (id: string) => Promise<unknown>): Promise<JobSaveOutcome> {
  let job: { id: string };
  try {
    job = await create();
  } catch (error) {
    return { status: 'unknown', jobId: null, error };
  }
  try {
    if (saveMaterials) await saveMaterials(job.id);
  } catch (error) {
    return { status: 'partial', jobId: job.id, error };
  }
  return { status: 'complete', jobId: job.id };
}
