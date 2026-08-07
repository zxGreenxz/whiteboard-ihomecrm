import { lookup } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import { createConnection, isIP } from "node:net";
import type { Duplex } from "node:stream";

import {
  evaluateDestination,
  type AllowlistEntry,
} from "./allowlist.js";
import {
  resolveAndPin,
  type LocalTopology,
} from "./dns-policy.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveHost = (host: string) => Promise<readonly ResolvedAddress[]>;

export interface PinnedDestination {
  host: string;
  tlsServername: string;
  port: number;
  pinnedAddress: string;
  family: 4 | 6;
  purpose: string;
}

export type DialPinnedTarget = (destination: PinnedDestination) => Promise<Duplex>;

export interface BrokerLogEvent {
  level: "info" | "warn" | "error";
  event: string;
  host?: string;
  port?: number;
  pinnedAddress?: string;
  reason?: string;
}

export interface ConnectDependencies {
  allowlist: readonly AllowlistEntry[];
  resolveHost?: ResolveHost;
  topology?: LocalTopology;
}

export type ConnectAuthorization =
  | { ok: true; destination: PinnedDestination }
  // `host` is carried so a denial can name what was refused. Allowed connects
  // already log their host, so a denied one discloses nothing new - and without it
  // an operator cannot tell a missing allowlist entry from a broken dependency.
  // Measured cost of the omission: a blocked `jr.zaloapp.com` silently broke every
  // Zalo login for days, presenting as "quét mã không hoạt động" with no trace in
  // any log on any tier.
  | { ok: false; statusCode: 400 | 403 | 502; reason: string; host?: string };

export interface ConnectProxyOptions extends ConnectDependencies {
  dialPinnedTarget?: DialPinnedTarget;
  log?: (event: BrokerLogEvent) => void;
}

const defaultTopology: LocalTopology = {
  hostGatewayAddresses: [],
  containerNetworkCidrs: [],
};

export function parseConnectAuthority(authority: string): { host: string; port: number } | null {
  if (
    authority.length === 0 ||
    authority.length > 260 ||
    authority !== authority.trim() ||
    /[\s/@\\?#%]/.test(authority) ||
    authority.startsWith("[")
  ) {
    return null;
  }
  const separator = authority.lastIndexOf(":");
  if (separator < 1 || separator !== authority.indexOf(":")) return null;
  const host = authority.slice(0, separator).toLowerCase();
  const portText = authority.slice(separator + 1);
  if (!/^[1-9]\d{0,4}$/.test(portText)) return null;
  const port = Number(portText);
  if (port > 65_535) return null;

  const syntaxVerdict = evaluateDestination(host, port, [{ host, port, purpose: "syntax" }]);
  return syntaxVerdict.allowed ? { host, port } : null;
}

export async function authorizeConnect(
  authority: string,
  dependencies: ConnectDependencies,
): Promise<ConnectAuthorization> {
  const target = parseConnectAuthority(authority);
  if (!target) return { ok: false, statusCode: 400, reason: "MALFORMED_TARGET" };

  const destinationVerdict = evaluateDestination(
    target.host,
    target.port,
    dependencies.allowlist,
  );
  if (!destinationVerdict.allowed || !destinationVerdict.entry) {
    return {
      ok: false,
      statusCode: 403,
      reason: destinationVerdict.denial ?? "DESTINATION_FORBIDDEN",
      host: target.host,
    };
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (dependencies.resolveHost ?? systemResolveHost)(target.host);
  } catch {
    return { ok: false, statusCode: 502, reason: "DNS_FAILURE", host: target.host };
  }
  if (addresses.some(({ address, family }) => isIP(address) !== family)) {
    return { ok: false, statusCode: 403, reason: "INVALID", host: target.host };
  }

  const resolution = resolveAndPin(
    target.host,
    addresses.map(({ address }) => address),
    dependencies.topology ?? defaultTopology,
  );
  if (!resolution.ok || !resolution.resolution) {
    return {
      ok: false,
      statusCode: resolution.denial === "NO_ADDRESSES" ? 502 : 403,
      reason: resolution.denial ?? "DNS_POLICY_REJECTED",
    };
  }

  const pinnedAddress = resolution.resolution.pinnedAddress;
  const family = isIP(pinnedAddress);
  if (family !== 4 && family !== 6) {
    return { ok: false, statusCode: 403, reason: "INVALID" };
  }
  return {
    ok: true,
    destination: {
      host: target.host,
      tlsServername: target.host,
      port: target.port,
      pinnedAddress,
      family,
      purpose: destinationVerdict.entry.purpose,
    },
  };
}

export function createConnectProxy(options: ConnectProxyOptions): Server {
  const log = options.log ?? (() => undefined);
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/livez") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("ok\n");
      return;
    }
    response.writeHead(405, {
      connection: "close",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("CONNECT required\n");
  });

  server.on("connect", (request, clientSocket, head) => {
    void (async () => {
      const authorization = await authorizeConnect(request.url ?? "", options);
      if (!authorization.ok) {
        log({
          level: "warn",
          event: "connect_denied",
          reason: authorization.reason,
          ...(authorization.host === undefined ? {} : { host: authorization.host }),
        });
        writeConnectFailure(clientSocket, authorization.statusCode);
        return;
      }

      const destination = authorization.destination;
      let upstream: Duplex;
      try {
        upstream = await (options.dialPinnedTarget ?? systemDialPinnedTarget)(destination);
      } catch (error) {
        log({
          level: "error",
          event: "connect_failed",
          host: destination.host,
          port: destination.port,
          pinnedAddress: destination.pinnedAddress,
          reason: errorCode(error),
        });
        writeConnectFailure(clientSocket, 502);
        return;
      }

      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      log({
        level: "info",
        event: "connect_opened",
        host: destination.host,
        port: destination.port,
        pinnedAddress: destination.pinnedAddress,
      });
      upstream.once("error", () => clientSocket.destroy());
      clientSocket.once("error", () => upstream.destroy());
      upstream.once("close", () => clientSocket.destroy());
      clientSocket.once("close", () => upstream.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    })().catch(() => {
      log({ level: "error", event: "connect_failed", reason: "INTERNAL_ERROR" });
      writeConnectFailure(clientSocket, 502);
    });
  });

  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });
  return server;
}

export const systemResolveHost: ResolveHost = async (host) => {
  const addresses = await lookup(host, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

export const systemDialPinnedTarget: DialPinnedTarget = async (destination) => {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({
      host: destination.pinnedAddress,
      port: destination.port,
      family: destination.family,
    });
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
};

function writeConnectFailure(socket: Duplex, statusCode: 400 | 403 | 502): void {
  if (socket.destroyed) return;
  const statusText = statusCode === 400
    ? "Bad Request"
    : statusCode === 403
      ? "Forbidden"
      : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UPSTREAM_ERROR";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : "UPSTREAM_ERROR";
}
