export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface AiCircuitBreakerOptions {
  failureThreshold: number;
  resetAfterMs: number;
}

export interface AiCircuitSnapshot {
  state: CircuitState;
  failureCount: number;
  openedAtMs: number | null;
  nextProbeAtMs: number | null;
  aiAutomaticSendAllowed: boolean;
  manualNonAiSendAllowed: true;
}

export class CircuitOpenError extends Error {
  constructor() {
    super("AI provider circuit is open");
    this.name = "CircuitOpenError";
  }
}

/**
 * AI-only circuit breaker. Manual non-AI delivery is intentionally independent
 * and remains available in every state.
 */
export class AiCircuitBreaker {
  readonly #failureThreshold: number;
  readonly #resetAfterMs: number;

  #state: CircuitState = "CLOSED";
  #failureCount = 0;
  #openedAtMs: number | null = null;

  constructor(options: AiCircuitBreakerOptions) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new TypeError("failureThreshold must be a positive integer");
    }
    if (!Number.isFinite(options.resetAfterMs) || options.resetAfterMs <= 0) {
      throw new TypeError("resetAfterMs must be positive");
    }
    this.#failureThreshold = options.failureThreshold;
    this.#resetAfterMs = options.resetAfterMs;
  }

  canAttempt(nowMs: number): boolean {
    if (this.#state === "CLOSED") return true;
    if (this.#state === "HALF_OPEN") return false;

    const nextProbeAtMs = this.#nextProbeAtMs();
    if (nextProbeAtMs === null || nowMs < nextProbeAtMs) return false;

    this.#state = "HALF_OPEN";
    return true;
  }

  assertCanAttempt(nowMs: number): void {
    if (!this.canAttempt(nowMs)) throw new CircuitOpenError();
  }

  recordSuccess(): void {
    this.#state = "CLOSED";
    this.#failureCount = 0;
    this.#openedAtMs = null;
  }

  recordFailure(nowMs: number): void {
    if (this.#state === "HALF_OPEN") {
      this.#open(nowMs);
      return;
    }

    if (this.#state === "OPEN") return;

    this.#failureCount += 1;
    if (this.#failureCount >= this.#failureThreshold) this.#open(nowMs);
  }

  snapshot(_nowMs: number): AiCircuitSnapshot {
    return {
      state: this.#state,
      failureCount: this.#failureCount,
      openedAtMs: this.#openedAtMs,
      nextProbeAtMs: this.#nextProbeAtMs(),
      aiAutomaticSendAllowed: this.#state === "CLOSED",
      manualNonAiSendAllowed: true,
    };
  }

  #open(nowMs: number): void {
    this.#state = "OPEN";
    this.#failureCount = Math.max(this.#failureCount, this.#failureThreshold);
    this.#openedAtMs = nowMs;
  }

  #nextProbeAtMs(): number | null {
    if (this.#state === "CLOSED" || this.#openedAtMs === null) return null;
    return this.#openedAtMs + this.#resetAfterMs;
  }
}
