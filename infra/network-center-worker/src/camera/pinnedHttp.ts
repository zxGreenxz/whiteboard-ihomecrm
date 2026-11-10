import { timingSafeEqual } from "node:crypto";
import { Agent, request, type ClientRequestArgs } from "node:http";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import { CameraClientError } from "./errors.js";

export interface PinnedHttpReply {
  status: number;
  /** One entry per WWW-Authenticate header line, in the order the device sent them. */
  challenges: string[];
  body: string;
}

export interface PinnedHttpOptions {
  /** `http:` or `https:` origin of one recorder. */
  origin: URL;
  /** Lower-case hex SHA-256 of the DER certificate. The only trust anchor for https; no CA is consulted. */
  tlsFingerprint256?: string | undefined;
  /** Bound on TCP connect plus TLS handshake for a new connection. */
  connectTimeoutMs: number;
  maxResponseBytes: number;
  /** Offer the connection for the next request. Off means one connection per request. */
  keepAlive: boolean;
}

/** A kept-alive socket the device had already closed took the request: nothing was answered. */
export class ReusedSocketClosedError extends CameraClientError {
  constructor() {
    super("UNREACHABLE");
    this.name = "ReusedSocketClosedError";
  }
}

const fingerprintBytes = (value: string | undefined): Buffer => Buffer.from((value ?? "").replace(/:/gu, ""), "hex");

/**
 * Connection source for one recorder. For https the TLS socket is opened here
 * and released to the HTTP layer only after its certificate equals the pin, so
 * no request line or header is written to an unverified peer.
 */
class PinnedAgent extends Agent {
  private readonly handshakes = new Set<TLSSocket>();
  private closed = false;

  constructor(private readonly target: { host: string; port: number; pin: Buffer | null; connectTimeoutMs: number }, keepAlive: boolean) {
    super({ keepAlive, maxSockets: 1, maxFreeSockets: 1 });
  }

  override createConnection(options: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const { pin } = this.target;
    if (pin === null) return super.createConnection(options, callback);
    if (!callback) throw new CameraClientError("UNREACHABLE");
    const done = callback as (error: Error | null, stream?: Duplex) => void;
    // The certificate is self-signed and may be expired, so chain validation
    // is off and the pin below is the whole identity check.
    const socket = tlsConnect({ host: this.target.host, port: this.target.port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    this.handshakes.add(socket);
    let tcpConnected = false;
    let settled = false;
    const fail = (code: "UNREACHABLE" | "TLS_HANDSHAKE_FAILED" | "TLS_PIN_MISMATCH") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.handshakes.delete(socket);
      socket.destroy();
      done(new CameraClientError(code));
    };
    const onError = () => fail(tcpConnected ? "TLS_HANDSHAKE_FAILED" : "UNREACHABLE");
    const timer = setTimeout(() => fail("UNREACHABLE"), this.target.connectTimeoutMs);
    socket.once("connect", () => { tcpConnected = true; });
    // Stays attached on a refused socket, so a late error on it is never unhandled.
    socket.on("error", onError);
    socket.once("close", onError);
    socket.once("secureConnect", () => {
      if (settled) return;
      const presented = fingerprintBytes(socket.getPeerCertificate().fingerprint256);
      if (this.closed || presented.byteLength !== pin.byteLength || !timingSafeEqual(presented, pin)) {
        fail(this.closed ? "UNREACHABLE" : "TLS_PIN_MISMATCH");
        return;
      }
      settled = true;
      clearTimeout(timer);
      this.handshakes.delete(socket);
      socket.off("error", onError);
      socket.off("close", onError);
      done(null, socket);
    });
    return undefined;
  }

  override destroy(): void {
    this.closed = true;
    for (const socket of this.handshakes) socket.destroy();
    this.handshakes.clear();
    super.destroy();
  }
}

/** Bounded GETs against a single recorder origin. Errors carry fixed codes only. */
export class PinnedHttpClient {
  /** True once the device has answered any request, whatever the status. */
  answered = false;
  private agent: PinnedAgent;
  private readonly target: { host: string; port: number; pin: Buffer | null; connectTimeoutMs: number };
  private readonly hostHeader: string;

  constructor(private readonly options: PinnedHttpOptions) {
    const { origin } = options;
    const secure = origin.protocol === "https:";
    if (!secure && origin.protocol !== "http:") throw new Error("INVALID_CAMERA_BASE_URL");
    const pin = options.tlsFingerprint256;
    if (secure && (pin === undefined || !/^[0-9a-f]{64}$/u.test(pin))) throw new Error("CAMERA_TLS_PIN_REQUIRED");
    if (!secure && pin !== undefined) throw new Error("CAMERA_TLS_PIN_REQUIRES_HTTPS");
    this.target = {
      host: origin.hostname, port: origin.port ? Number(origin.port) : secure ? 443 : 80,
      pin: secure ? fingerprintBytes(pin) : null, connectTimeoutMs: options.connectTimeoutMs,
    };
    this.hostHeader = origin.host;
    this.agent = new PinnedAgent(this.target, options.keepAlive);
  }

  /** From now on open one connection per request; idle sockets are dropped. */
  disableReuse(): void {
    this.agent.destroy();
    this.agent = new PinnedAgent(this.target, false);
  }

  close(): void {
    this.agent.destroy();
  }

  get(path: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<PinnedHttpReply> {
    return new Promise<PinnedHttpReply>((resolve, reject) => {
      let settled = false;
      let responded = false;
      const fail = (error: CameraClientError) => { if (!settled) { settled = true; reject(error); } };
      let outgoing: ReturnType<typeof request>;
      try {
        outgoing = request({
          agent: this.agent, host: this.target.host, port: this.target.port, method: "GET", path, signal,
          headers: { Host: this.hostHeader, Accept: "application/xml", ...headers },
        });
      } catch {
        // A header value the HTTP layer refuses to send; nothing left this process.
        fail(new CameraClientError("UNSUPPORTED"));
        return;
      }
      outgoing.once("response", (response) => {
        responded = true;
        this.answered = true;
        const challenges: string[] = [];
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
          if (response.rawHeaders[index]!.toLowerCase() === "www-authenticate") challenges.push(response.rawHeaders[index + 1]!);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > this.options.maxResponseBytes) {
            fail(new CameraClientError("RESPONSE_TOO_LARGE"));
            outgoing.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode ?? 0, challenges, body: new TextDecoder().decode(Buffer.concat(chunks)) });
        });
        response.on("error", () => fail(new CameraClientError("UNREACHABLE")));
        response.once("close", () => fail(new CameraClientError("UNREACHABLE")));
      });
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        if (error instanceof CameraClientError) fail(error);
        else if (signal.aborted) fail(new CameraClientError("UNREACHABLE"));
        else if (typeof error.code === "string" && error.code.startsWith("HPE_")) fail(new CameraClientError("INVALID_RESPONSE"));
        else fail(outgoing.reusedSocket && !responded ? new ReusedSocketClosedError() : new CameraClientError("UNREACHABLE"));
      });
      outgoing.end();
    });
  }
}
