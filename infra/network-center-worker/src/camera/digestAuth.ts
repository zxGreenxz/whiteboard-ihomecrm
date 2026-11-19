import { createHash, randomBytes } from "node:crypto";

import { CameraClientError } from "./errors.js";

export interface DigestRequest {
  /** One challenge, starting with the `Digest` scheme. */
  challenge: string;
  method: string;
  /** Request target exactly as sent on the request line. */
  uri: string;
  username: string;
  password: string;
}

/** RFC 7616 response for one request: MD5 or SHA-256, qop=auth or the legacy form without qop. */
export function digestAuthorization(request: DigestRequest): string {
  const { challenge, method, uri, username, password } = request;
  if (!/^Digest\s/iu.test(challenge)) throw new CameraClientError("UNSUPPORTED");
  const values = new Map<string, string>();
  for (const match of challenge.slice(7).matchAll(/([a-zA-Z]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/gu)) {
    values.set(match[1]!.toLowerCase(), (match[2] ?? match[3] ?? "").replace(/\\(.)/gu, "$1"));
  }
  const realm = values.get("realm");
  const nonce = values.get("nonce");
  const algorithm = (values.get("algorithm") ?? "MD5").toUpperCase();
  const qop = values.get("qop");
  if (realm === undefined || !nonce || (algorithm !== "MD5" && algorithm !== "SHA-256") || (qop !== undefined && !qop.split(",").map((value) => value.trim()).includes("auth"))) {
    throw new CameraClientError("UNSUPPORTED");
  }
  const hash = (value: string) => createHash(algorithm === "MD5" ? "md5" : "sha256").update(value, "utf8").digest("hex");
  const cnonce = randomBytes(16).toString("hex");
  const ha1 = hash(`${username}:${realm}:${password}`);
  const ha2 = hash(`${method}:${uri}`);
  const digest = qop ? hash(`${ha1}:${nonce}:00000001:${cnonce}:auth:${ha2}`) : hash(`${ha1}:${nonce}:${ha2}`);
  const quote = (value: string) => `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
  const parts = [`username=${quote(username)}`, `realm=${quote(realm)}`, `nonce=${quote(nonce)}`, `uri=${quote(uri)}`, `response=${quote(digest)}`, `algorithm=${algorithm}`];
  if (qop) parts.push("qop=auth", "nc=00000001", `cnonce=${quote(cnonce)}`);
  if (values.has("opaque")) parts.push(`opaque=${quote(values.get("opaque")!)}`);
  return `Digest ${parts.join(", ")}`;
}

/** Split one WWW-Authenticate value into its challenges; a comma inside a quoted string does not separate. */
function splitChallenges(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index]!;
    if (quoted && char === "\\" && index + 1 < header.length) {
      current += char + header[index + 1]!;
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  const challenges: string[] = [];
  for (const part of parts.map((value) => value.trim()).filter(Boolean)) {
    // `name=value` continues the open challenge; anything else names a new scheme.
    if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\s*=/u.test(part) && challenges.length > 0) challenges[challenges.length - 1] += `, ${part}`;
    else challenges.push(part);
  }
  return challenges;
}

/**
 * Pick the Digest challenge out of every WWW-Authenticate line a device sent.
 * A recorder may offer Basic beside Digest; Basic is never selected because it
 * would put the password itself on the wire. SHA-256 is preferred over MD5.
 */
export function selectDigestChallenge(headers: readonly string[]): string | null {
  let chosen: string | null = null;
  for (const challenge of headers.flatMap(splitChallenges)) {
    if (!/^Digest\s/iu.test(challenge)) continue;
    const algorithm = /(?:^|[\s,])algorithm\s*=\s*"?([A-Za-z0-9-]+)"?/iu.exec(challenge)?.[1]?.toUpperCase() ?? "MD5";
    if (algorithm === "SHA-256") return challenge;
    if (algorithm === "MD5" && chosen === null) chosen = challenge;
  }
  return chosen;
}
