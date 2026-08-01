/**
 * Deterministic fake Zalo adapter used by tests and by the DEMO end-to-end
 * fleet. It never touches a real provider and never opens a socket: every
 * outcome is chosen explicitly by the test.
 */

export type FakeSendOutcome = "SUCCESS" | "PROVIDER_REJECT" | "AMBIGUOUS_TIMEOUT";

export interface FakeInboundEvent {
  providerEventId: string | null;
  providerMessageId: string | null;
  eventKind: string;
  providerTimestamp: number;
  payload: Record<string, unknown>;
}

export interface FakeSendResult {
  outcome: FakeSendOutcome;
  providerMessageId: string | null;
}

export interface FakeAdapterState {
  qrPayload: string;
  directory: Array<{ providerId: string; displayName: string }>;
  inbound: FakeInboundEvent[];
  sendOutcomes: FakeSendOutcome[];
}

export class FakeZaloAdapter {
  private sendIndex = 0;
  private readonly sent: Array<Record<string, unknown>> = [];
  /** Counters the ordering tests assert stay at zero. */
  readonly counters = {
    builtInReplies: 0,
    pairingNotifications: 0,
    directProviderFrames: 0,
    dispatches: 0,
  };

  constructor(private readonly state: FakeAdapterState) {}

  async requestQr(): Promise<{ qrPayload: string; expiresInSeconds: number }> {
    return { qrPayload: this.state.qrPayload, expiresInSeconds: 120 };
  }

  async listDirectory(): Promise<FakeAdapterState["directory"]> {
    return [...this.state.directory];
  }

  /**
   * Delivers inbound events to the listener. The callback is intentionally
   * awaited here so a test can prove the bridge commits durably before the
   * adapter would have dispatched anything.
   */
  async deliverInbound(
    listener: (event: FakeInboundEvent) => Promise<void> | void,
  ): Promise<void> {
    for (const event of this.state.inbound) {
      await listener(event);
    }
  }

  async send(payload: Record<string, unknown>): Promise<FakeSendResult> {
    const outcome = this.state.sendOutcomes[this.sendIndex] ?? "SUCCESS";
    this.sendIndex += 1;
    this.sent.push(payload);
    if (outcome === "SUCCESS") {
      return { outcome, providerMessageId: `fake-message-${this.sendIndex}` };
    }
    // A rejected or ambiguous send never yields a provider message id: the
    // caller must resolve it through the UNKNOWN path.
    return { outcome, providerMessageId: null };
  }

  sentPayloads(): ReadonlyArray<Record<string, unknown>> {
    return this.sent;
  }
}