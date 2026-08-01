import { HEARTBEAT_INTERVAL_MS } from "./snapshot.js";

export interface HeartbeatSnapshot {
  running: boolean;
  inFlight: boolean;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  consecutiveFailures: number;
}

export interface HeartbeatLoopOptions {
  send: () => Promise<void>;
  now?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Content-free wrapper used so heartbeat transport errors never retain secrets. */
export class HeartbeatSendError extends Error {
  readonly code = "HEARTBEAT_SEND_FAILED";

  constructor() {
    super("runtime heartbeat send failed");
    this.name = "HeartbeatSendError";
  }
}

/**
 * Sends a content-free bridge heartbeat on a fixed cadence. A slow request is
 * shared by concurrent pulses instead of allowing overlapping heartbeats.
 */
export class HeartbeatLoop {
  readonly #send: () => Promise<void>;
  readonly #now: () => number;
  readonly #setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;

  #intervalHandle: unknown | null = null;
  #inFlight: Promise<void> | null = null;
  #lastAttemptAtMs: number | null = null;
  #lastSuccessAtMs: number | null = null;
  #consecutiveFailures = 0;

  constructor(options: HeartbeatLoopOptions) {
    this.#send = options.send;
    this.#now = options.now ?? Date.now;
    this.#setInterval = options.setInterval ?? ((callback, milliseconds) =>
      globalThis.setInterval(callback, milliseconds));
    this.#clearInterval = options.clearInterval ?? ((handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
  }

  start(): void {
    if (this.#intervalHandle !== null) return;

    this.#intervalHandle = this.#setInterval(() => {
      // Scheduled failures are reflected by snapshot() and deliberately do not
      // become unhandled rejections. Direct pulse() callers still receive them.
      void this.pulse().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.#intervalHandle === null) return;
    this.#clearInterval(this.#intervalHandle);
    this.#intervalHandle = null;
  }

  async settle(timeoutMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new RangeError("heartbeat drain timeout is invalid");
    }
    const active = this.#inFlight;
    if (active === null) return;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    await Promise.race([
      active.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = globalThis.setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }

  pulse(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;

    this.#lastAttemptAtMs = this.#now();
    const operation = (async () => {
      try {
        await this.#send();
        this.#lastSuccessAtMs = this.#now();
        this.#consecutiveFailures = 0;
      } catch {
        this.#consecutiveFailures += 1;
        throw new HeartbeatSendError();
      } finally {
        this.#inFlight = null;
      }
    })();
    this.#inFlight = operation;
    return operation;
  }

  snapshot(): HeartbeatSnapshot {
    return {
      running: this.#intervalHandle !== null,
      inFlight: this.#inFlight !== null,
      lastAttemptAtMs: this.#lastAttemptAtMs,
      lastSuccessAtMs: this.#lastSuccessAtMs,
      consecutiveFailures: this.#consecutiveFailures,
    };
  }
}
