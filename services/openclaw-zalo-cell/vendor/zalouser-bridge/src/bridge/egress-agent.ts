// Zalo's realtime socket is the only path customer messages ever travel, and it
// was the one path that never opened.
//
// `ws` sets its own `createConnection` on the request options, so a wss:// dial
// never goes through Node's default agent - and therefore never through the
// egress broker. In a cell whose application network is `internal: true` there
// is no resolver and no route, so the socket died at
// `getaddrinfo EAI_AGAIN ws4-msg.chat.zalo.me` before the broker saw anything.
// Measured on the running cell: an `https.request` on the default agent returns
// 404 through the broker, the same request with `new https.Agent()` fails
// EAI_AGAIN. The broker's retained log has never recorded a single
// `ws*-msg.chat.zalo.me` connect.
//
// zca-js already accepts `options.agent` and hands it to both its HTTP calls and
// the WebSocket, so one agent closes the gap without touching Node internals.
// This agent is deliberately dependency-free: the vendored fork must declare no
// dependencies (install-vendored-zalouser.sh rejects the package otherwise), so
// the CONNECT tunnel is written against node: built-ins only.
import { request as httpRequest, type ClientRequestArgs } from "node:http";
import { Agent as HttpsAgent, type AgentOptions } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

type EgressEnvironment = Readonly<Record<string, string | undefined>>;

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the proxy for outbound Zalo traffic, matching the precedence undici's
 * EnvHttpProxyAgent uses so the socket and `fetch` agree on one egress path:
 * lowercase wins over uppercase, https_proxy wins over http_proxy.
 */
export function resolveEgressProxyUrl(env: EgressEnvironment = process.env): URL | undefined {
  const candidate =
    normalizeProxyValue(env.https_proxy) ??
    normalizeProxyValue(env.HTTPS_PROXY) ??
    normalizeProxyValue(env.http_proxy) ??
    normalizeProxyValue(env.HTTP_PROXY) ??
    normalizeProxyValue(env.all_proxy) ??
    normalizeProxyValue(env.ALL_PROXY);
  if (!candidate) return undefined;
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}

/** Return whether NO_PROXY exempts a host, so in-cell peers stay on the direct path. */
export function shouldBypassEgressProxy(
  host: string,
  env: EgressEnvironment = process.env,
): boolean {
  const raw = normalizeProxyValue(env.no_proxy) ?? normalizeProxyValue(env.NO_PROXY);
  if (!raw) return false;
  const target = host.trim().toLowerCase().replace(/\.$/u, "");
  if (!target) return false;
  for (const entry of raw.split(",")) {
    const rule = entry.trim().toLowerCase().replace(/\.$/u, "");
    if (!rule) continue;
    if (rule === "*") return true;
    const bare = rule.startsWith(".") ? rule.slice(1) : rule;
    if (target === bare || target.endsWith(`.${bare}`)) return true;
  }
  return false;
}

type TunnelTarget = {
  readonly host?: string;
  readonly hostname?: string;
  readonly port?: number | string;
  readonly servername?: string;
  readonly rejectUnauthorized?: boolean;
};

/**
 * An https.Agent whose sockets are HTTP CONNECT tunnels through the egress
 * broker. The origin hostname is sent to the broker verbatim and is never
 * resolved in this process, which is the whole point: the cell has no resolver,
 * and the broker is what pins the address and enforces the allowlist.
 */
export class EgressProxyTunnelAgent extends HttpsAgent {
  readonly proxy: URL;

  private readonly env: EgressEnvironment;

  constructor(proxy: URL, env: EgressEnvironment = process.env, options: AgentOptions = {}) {
    super(options);
    this.proxy = proxy;
    this.env = env;
  }

  /**
   * Node's Agent accepts a socket created asynchronously through the callback;
   * its typings only describe the synchronous return, so the declared Duplex is
   * never produced and every caller is served through `callback`.
   */
  createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex {
    const target = options as TunnelTarget;
    const settleTo = (error: Error | null, stream?: Duplex): void => {
      callback?.(error, stream as Duplex);
    };
    const host = (target.host ?? target.hostname ?? "").replace(/^\[|\]$/gu, "");
    const port = Number(target.port ?? 443);
    if (!host) {
      settleTo(new Error("egress tunnel requires a destination host"));
      return undefined as unknown as Duplex;
    }
    const authority = `${host}:${port}`;
    const request = httpRequest({
      agent: false,
      headers: { host: authority },
      host: this.proxy.hostname,
      method: "CONNECT",
      path: authority,
      port: Number(this.proxy.port || (this.proxy.protocol === "https:" ? 443 : 80)),
      // The broker answers CONNECT and nothing else; a silent stall here would
      // look exactly like the DNS failure this replaces, so bound it.
      timeout: 20_000,
    });
    let settled = false;
    const settle = (error: Error | null, socket?: Socket): void => {
      if (settled) return;
      settled = true;
      settleTo(error, socket);
    };
    request.once("connect", (response, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        settle(
          new Error(
            `egress proxy refused CONNECT ${authority} with status ${String(response.statusCode)}`,
          ),
        );
        return;
      }
      const secure = tlsConnect({
        host,
        rejectUnauthorized: target.rejectUnauthorized !== false,
        // The allowlisted FQDN stays the TLS authority end to end; the broker
        // never substitutes the pinned IP as the certificate name.
        servername: target.servername ?? host,
        socket,
      });
      secure.once("secureConnect", () => settle(null, secure));
      secure.once("error", (error: Error) => settle(error));
    });
    request.once("timeout", () => {
      request.destroy(new Error(`egress proxy CONNECT ${authority} timed out`));
    });
    request.once("error", (error: Error) => settle(error));
    request.end();
    return undefined as unknown as Duplex;
  }
}

/**
 * Build the agent zca-js should use for Zalo traffic, or undefined when no proxy
 * is configured so a direct deployment keeps its current behaviour untouched.
 */
export function resolveZaloEgressAgent(
  env: EgressEnvironment = process.env,
): EgressProxyTunnelAgent | undefined {
  const proxy = resolveEgressProxyUrl(env);
  if (!proxy) return undefined;
  return new EgressProxyTunnelAgent(proxy, env);
}
