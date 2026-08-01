import { parseOpenClawSendWorkClaimV1, type OpenClawSendWorkClaimV1 } from "../runtime-api/schemas.js";

const SEND_WORK_KINDS = ["INBOUND_AUTOMATION", "SCHEDULE_OCCURRENCE", "CRM_EVENT"] as const;
export type SendWorkKind = typeof SEND_WORK_KINDS[number];

export interface PeriodicWorkerOptions {
  run(signal: AbortSignal): Promise<void>;
  intervalMs: number;
  drainTimeoutMs?: number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Non-overlapping periodic task whose stop waits for the current pulse. */
export class PeriodicWorker {
  readonly #run: (signal: AbortSignal) => Promise<void>;
  readonly #intervalMs: number;
  readonly #setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  readonly #drainTimeoutMs: number;
  #handle: unknown | null = null;
  #inFlight: Promise<void> | null = null;
  #activeController: AbortController | null = null;
  #stopping = false;

  constructor(options: PeriodicWorkerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100) {
      throw new RangeError("periodic worker interval is invalid");
    }
    this.#run = options.run;
    this.#intervalMs = options.intervalMs;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.#drainTimeoutMs) || this.#drainTimeoutMs < 100 ||
      this.#drainTimeoutMs > 30_000) {
      throw new RangeError("periodic worker drain timeout is invalid");
    }
    this.#setInterval = options.setInterval ?? ((callback, milliseconds) =>
      globalThis.setInterval(callback, milliseconds));
    this.#clearInterval = options.clearInterval ?? ((handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
  }

  start(): void {
    if (this.#handle !== null || this.#stopping) return;
    this.#handle = this.#setInterval(() => {
      void this.pulse().catch(() => undefined);
    }, this.#intervalMs);
  }

  pulse(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (this.#inFlight !== null) return this.#inFlight;
    const controller = new AbortController();
    this.#activeController = controller;
    const operation = Promise.resolve().then(async () => await this.#run(controller.signal)).finally(() => {
      if (this.#inFlight === operation) this.#inFlight = null;
      if (this.#activeController === controller) this.#activeController = null;
    });
    this.#inFlight = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#handle !== null) {
      this.#clearInterval(this.#handle);
      this.#handle = null;
    }
    this.#activeController?.abort();
    const active = this.#inFlight;
    if (active === null) return;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    await Promise.race([
      active.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = globalThis.setTimeout(resolve, this.#drainTimeoutMs);
      }),
    ]);
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }

  isSettled(): boolean {
    return this.#inFlight === null;
  }

  async settle(): Promise<void> {
    await this.#inFlight?.catch(() => undefined);
  }
}

export async function runSendWorkBatch({
  claimWork,
  claimToken,
  runInbound,
  runSchedule,
  runCrm,
  concurrency,
  requestedKinds = SEND_WORK_KINDS,
}: {
  claimWork(request: { version: 1; claimToken: string; limit: number; leaseSeconds: number; requestedKinds: readonly string[] }): Promise<unknown[]>;
  claimToken(): string;
  runInbound(claim: OpenClawSendWorkClaimV1): Promise<unknown>;
  runSchedule(claim: OpenClawSendWorkClaimV1): Promise<unknown>;
  runCrm(claim: OpenClawSendWorkClaimV1): Promise<unknown>;
  concurrency: number;
  requestedKinds?: readonly SendWorkKind[];
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 30) {
    throw new RangeError("concurrency must be 1-30");
  }
  if (
    requestedKinds.length < 1 || requestedKinds.length > SEND_WORK_KINDS.length ||
    new Set(requestedKinds).size !== requestedKinds.length ||
    requestedKinds.some((kind) => !SEND_WORK_KINDS.includes(kind))
  ) {
    throw new TypeError("requested work kinds are invalid");
  }
  const values = await claimWork({
    version: 1,
    claimToken: claimToken(),
    limit: Math.min(25, concurrency * 2),
    leaseSeconds: 30,
    requestedKinds: [...requestedKinds],
  });
  if (!Array.isArray(values)) throw new TypeError("work claim response is invalid");
  const unique = new Map<string, OpenClawSendWorkClaimV1>();
  for (const value of values) {
    const claim = parseOpenClawSendWorkClaimV1(value);
    const key = `${claim.workItemId}:${claim.claimGeneration}`;
    if (!unique.has(key)) unique.set(key, claim);
  }
  const queue = [...unique.values()];
  const results: unknown[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const claim = queue[index];
      if (!claim) return;
      if (claim.payload.kind === "INBOUND_AUTOMATION") results[index] = await runInbound(claim);
      else if (claim.payload.kind === "SCHEDULE_OCCURRENCE") results[index] = await runSchedule(claim);
      else results[index] = await runCrm(claim);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}
