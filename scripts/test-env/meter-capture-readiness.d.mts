export function safeMeterErrorCode(payload: unknown): string | null;
export class MeterTestHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(label: string, status: number, payload: unknown);
}
export function withMeterReadRetry<T>(action: string, request: (timeoutMs: number) => Promise<T>, hooks?: {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (event: { action: string; attempt: number; delayMs: number; code: 'PGRST002' }) => void;
}): Promise<T>;
