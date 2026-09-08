export interface G3WriterIdentity { runId: string; runAttempt: string; sourceSha: string; buildSha: string; workflow: string; repository: string; }
export function validateG3AdmissionFile(value: unknown, current: G3WriterIdentity): Record<string, unknown>;
