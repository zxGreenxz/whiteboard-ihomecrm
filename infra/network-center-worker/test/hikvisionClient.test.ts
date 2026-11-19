import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";

import { selectDigestChallenge } from "../src/camera/digestAuth.js";
import {
  classifyHikvisionReply, HIKVISION_ANALOG_CHANNELS_PATH, HIKVISION_PROXY_CHANNELS_PATH, HIKVISION_PROXY_STATUS_PATH,
  HIKVISION_STORAGE_PATH, HikvisionClient, hikvisionLockedOut, mapHikvisionChannels, parseHikvisionAnalogChannels,
  parseHikvisionProxyChannels, parseHikvisionProxyStatus, parseHikvisionStorage,
} from "../src/camera/hikvisionClient.js";
import { childText, childrenNamed, parseXml } from "../src/camera/isapiXml.js";
import { CAMERA_ISSUES } from "../src/camera/types.js";
import { throwawayCertificate } from "./support/throwawayCertificate.js";

// ---------------------------------------------------------------------------
// XML FIXTURES. Every document below is written from the published ISAPI
// schema (element names, nesting and value vocabularies); they are not
// captures. The shapes two real recorders returned are reproduced separately in
// "Hikvision replies as measured on real recorders" at the end of this file.
// ---------------------------------------------------------------------------
const NS = 'version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"';
const analogRow = (id: number, fields: string) => `<VideoInputChannel ${NS}><id>${id}</id><inputPort>${id}</inputPort>${fields}</VideoInputChannel>`;
const ANALOG = `<?xml version="1.0" encoding="UTF-8"?>
<VideoInputChannelList ${NS}>
  ${analogRow(1, "<videoInputEnabled>true</videoInputEnabled><name>Cổng trước</name><videoFormat>PAL</videoFormat><resDesc>1920*1080P25</resDesc>")}
  ${analogRow(2, "<videoInputEnabled>true</videoInputEnabled><name>Sân sau</name><videoFormat>PAL</videoFormat><resDesc>NO VIDEO</resDesc>")}
  ${analogRow(3, "<videoInputEnabled>false</videoInputEnabled><name>Camera 03</name>")}
  ${analogRow(4, "<videoInputEnabled>true</videoInputEnabled><name>Camera 04</name>")}
</VideoInputChannelList>`;
const ANALOG_HEALTHY = `<VideoInputChannelList ${NS}>
  ${analogRow(1, "<videoInputEnabled>true</videoInputEnabled><name>Cổng trước</name><resDesc>1920*1080P25</resDesc>")}
  ${analogRow(2, "<videoInputEnabled>true</videoInputEnabled><name>Sân sau</name><resDesc>NO VIDEO</resDesc>")}
</VideoInputChannelList>`;
const proxyRow = (id: number, name: string) => `<InputProxyChannel ${NS}><id>${id}</id><name>${name}</name>
    <sourceInputPortDescriptor><proxyProtocol>HIKVISION</proxyProtocol><addressingFormatType>ipaddress</addressingFormatType>
      <ipAddress>10.25.0.${100 + id}</ipAddress><managePortNo>8000</managePortNo><srcInputPort>1</srcInputPort>
      <userName>fixture-user</userName><streamType>auto</streamType><name>nested-label</name><id>99</id></sourceInputPortDescriptor>
  </InputProxyChannel>`;
const proxyList = (...rows: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<InputProxyChannelList ${NS}>${rows.join("")}</InputProxyChannelList>`;
const PROXY = proxyList(proxyRow(1, "Hành lang"), proxyRow(2, "Thang máy"));
const statusRow = (id: number, fields: string) => `<InputProxyChannelStatus ${NS}><id>${id}</id>${fields}</InputProxyChannelStatus>`;
const statusList = (...rows: string[]) => `<InputProxyChannelStatusList ${NS}>${rows.join("")}</InputProxyChannelStatusList>`;
const PROXY_STATUS = statusList(
  statusRow(1, "<online>true</online><chanDetectResult>connect</chanDetectResult>"),
  statusRow(2, "<online>false</online><chanDetectResult>netUnreachable</chanDetectResult>"));
const hddRow = (id: number, fields: string) => `<hdd ${NS}><id>${id}</id><hddName>hdd${id}</hddName><hddType>SATA</hddType>${fields}<property>RW</property></hdd>`;
const storage = (...rows: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<storage ${NS}><hddList ${NS}>${rows.join("")}</hddList><nasList ${NS}/><workMode>quota</workMode></storage>`;
const STORAGE = storage(hddRow(1, "<status>ok</status><capacity>1907729</capacity><freeSpace>7729</freeSpace>"));
const fault = (code: number, text: string, detail: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus ${NS}><requestURL>/ISAPI/fixture</requestURL><statusCode>${code}</statusCode><statusString>${text}</statusString><subStatusCode>${detail}</subStatusCode></ResponseStatus>`;
const NOT_SUPPORTED = fault(4, "Invalid Operation", "notSupport");
const LOW_PRIVILEGE = fault(4, "Invalid Operation", "lowPrivilege");
const MEGABYTE = 1024 * 1024;

describe("ISAPI XML extraction", () => {
  it("ignores prefixes, namespaces, attributes, comments and declarations", () => {
    const root = parseXml('﻿<?xml version="1.0"?><!-- note --><h:list xmlns:h="urn:fixture" note="a > b"><h:Item id=\'1\'>A &amp; B&#x21;<![CDATA[ <raw> ]]></h:Item><h:item/></h:list>');
    expect(root.name).toBe("list");
    expect(childrenNamed(root, "ITEM")).toHaveLength(2);
    expect(childText(root, "item")).toBe("A & B! <raw>");
    expect(childText(root, "absent")).toBeUndefined();
  });

  it.each([
    "", "plain text", "<a>", "<a></b>", "<a/><b/>", "</a>", "<a><b></a></b>", "<a>&amp;</a> trailing",
    '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', "<a><!-- open</a>", `<a>${"<b>".repeat(40)}${"</b>".repeat(40)}</a>`,
  ])("rejects malformed or unsafe input instead of guessing: %j", (text) => {
    expect(() => parseXml(text)).toThrow("INVALID_RESPONSE");
  });
});

describe("Hikvision boundary parsers", () => {
  it("maps analog inputs: disabled is empty, NO VIDEO is disconnected, a resolution is connected, no resDesc is unknown", () => {
    expect(parseHikvisionAnalogChannels(ANALOG)).toEqual([
      { id: 1, state: "CONNECTED", name: "Cổng trước" }, { id: 2, state: "DISCONNECTED", name: "Sân sau" },
      { id: 3, state: "EMPTY", name: "Camera 03" }, { id: 4, state: "UNKNOWN", name: "Camera 04" },
    ]);
    const states = (fields: string) => parseHikvisionAnalogChannels(`<VideoInputChannelList>${analogRow(1, fields)}</VideoInputChannelList>`)[0]?.state;
    expect(states("<resDesc>no  video</resDesc>")).toBe("DISCONNECTED");
    expect(states("<resDesc>NoVideo</resDesc>")).toBe("DISCONNECTED");
    expect(states("<videoInputEnabled>false</videoInputEnabled><resDesc>1280*720P25</resDesc>")).toBe("EMPTY");
    expect(states("<resDesc></resDesc>")).toBe("UNKNOWN");
    expect(states("<resDesc>1280*720P25</resDesc>")).toBe("CONNECTED");
    expect(parseHikvisionAnalogChannels("<VideoInputChannelList/>")).toEqual([]);
  });

  it("bounds labels for ingestion and drops control characters", () => {
    const named = (name: string) => parseHikvisionAnalogChannels(`<VideoInputChannelList>${analogRow(1, `<name>${name}</name>`)}</VideoInputChannelList>`)[0]?.name;
    expect(named("ắ".repeat(140))).toBe("ắ".repeat(128));
    expect(named("A".repeat(127) + "🚪")).toBe("A".repeat(127));
    expect(named(" Sảnh&#0;&#9;tầng 3 ")).toBe("Sảnh&#0; tầng 3");
    expect(named("&#7;")).toBeUndefined();
  });

  it.each([
    "<VideoInputChannelList><VideoInputChannel><name>no id</name></VideoInputChannel></VideoInputChannelList>",
    `<VideoInputChannelList>${analogRow(1, "")}${analogRow(1, "")}</VideoInputChannelList>`,
    `<VideoInputChannelList>${analogRow(0, "")}</VideoInputChannelList>`,
    `<VideoInputChannelList>${analogRow(257, "")}</VideoInputChannelList>`,
    "<html><body>login</body></html>", NOT_SUPPORTED, "not xml",
  ])("rejects an analog list it cannot attribute rather than claiming health: %j", (xml) => {
    expect(() => parseHikvisionAnalogChannels(xml)).toThrow("INVALID_RESPONSE");
  });

  it("reads only the direct id and name of an IP channel, never the nested source descriptor", () => {
    expect(parseHikvisionProxyChannels(PROXY)).toEqual([{ id: 1, name: "Hành lang" }, { id: 2, name: "Thang máy" }]);
    expect(parseHikvisionProxyChannels(`<InputProxyChannelList ${NS}/>`)).toEqual([]);
    expect(() => parseHikvisionProxyChannels(proxyList(proxyRow(1, "A"), proxyRow(1, "B")))).toThrow("INVALID_RESPONSE");
  });

  it("maps the IP online flag and leaves out a row without one", () => {
    expect([...parseHikvisionProxyStatus(statusList(statusRow(1, "<online>true</online>"), statusRow(2, "<online>FALSE</online>"), statusRow(3, "<chanDetectResult>connect</chanDetectResult>"), statusRow(4, "<online>maybe</online>")))])
      .toEqual([[1, true], [2, false]]);
    expect(() => parseHikvisionProxyStatus(statusList(statusRow(1, "<online>true</online>"), statusRow(1, "<online>false</online>")))).toThrow("INVALID_RESPONSE");
  });

  it("maps disk status words and converts megabytes to bytes", () => {
    expect(parseHikvisionStorage(STORAGE)).toEqual([{ slot: 1, state: "NORMAL", totalBytes: 1907729 * MEGABYTE, usedBytes: 1900000 * MEGABYTE }]);
    const state = (status: string) => parseHikvisionStorage(storage(hddRow(1, `<status>${status}</status>`)))[0]?.state;
    for (const word of ["ok", "OK", "idle", "sleeping"]) expect(state(word)).toBe("NORMAL");
    for (const word of ["unformatted", "error", "smartFailed", "mismatch", "abnormal", "bad"]) expect(state(word)).toBe("ERROR");
    for (const word of ["notexist", "offline"]) expect(state(word)).toBe("MISSING");
    for (const word of ["", "formating", "reparing", "constructor"]) expect(state(word)).toBe("UNKNOWN");
  });

  it("clamps used space at zero, omits unreadable capacity and accepts a recorder without disks", () => {
    expect(parseHikvisionStorage(storage(hddRow(2, "<status>ok</status><capacity>100</capacity><freeSpace>250</freeSpace>")))).toEqual([{ slot: 2, state: "NORMAL", totalBytes: 100 * MEGABYTE, usedBytes: 0 }]);
    expect(parseHikvisionStorage(storage(hddRow(1, "<status>ok</status><capacity>100</capacity>")))).toEqual([{ slot: 1, state: "NORMAL", totalBytes: 100 * MEGABYTE }]);
    expect(parseHikvisionStorage(storage(hddRow(1, "<status>ok</status><capacity>1.5</capacity><freeSpace>1</freeSpace>")))).toEqual([{ slot: 1, state: "NORMAL" }]);
    expect(parseHikvisionStorage(storage())).toEqual([]);
    expect(parseHikvisionStorage(`<storage ${NS}/>`)).toEqual([]);
    for (const xml of [storage(hddRow(33, "")), storage(hddRow(1, ""), hddRow(1, "")), ANALOG, "garbage"]) expect(() => parseHikvisionStorage(xml)).toThrow("INVALID_RESPONSE");
  });

  it("classifies a reply: missing channel type, refused privilege, device failure", () => {
    expect(classifyHikvisionReply(200, ANALOG)).toBe("OK");
    expect(classifyHikvisionReply(403, "")).toBe("NOT_SUPPORTED");
    expect(classifyHikvisionReply(404, "<html>Not Found</html>")).toBe("NOT_SUPPORTED");
    expect(classifyHikvisionReply(400, NOT_SUPPORTED)).toBe("NOT_SUPPORTED");
    expect(classifyHikvisionReply(200, fault(4, "Invalid Operation", "invalidOperation"))).toBe("NOT_SUPPORTED");
    expect(classifyHikvisionReply(403, LOW_PRIVILEGE)).toBe("DENIED");
    expect(classifyHikvisionReply(403, fault(4, "Invalid Operation", "badAuthorization"))).toBe("DENIED");
    expect(classifyHikvisionReply(500, fault(3, "Device Error", "deviceError"))).toBe("FAILED");
    expect(classifyHikvisionReply(503, "")).toBe("FAILED");
    expect(classifyHikvisionReply(302, "")).toBe("FAILED");
  });

  it("recognises a stated lock-out and nothing else", () => {
    expect(hikvisionLockedOut("<userCheck><statusValue>401</statusValue><lockStatus>lock</lockStatus><unlockTime>1800</unlockTime></userCheck>")).toBe(true);
    expect(hikvisionLockedOut("<ResponseStatus><statusCode>4</statusCode><lockStatus>locked</lockStatus></ResponseStatus>")).toBe(true);
    for (const body of ["<userCheck><lockStatus>unlock</lockStatus></userCheck>", "<html>401</html>", "", "lock"]) expect(hikvisionLockedOut(body)).toBe(false);
  });
});

describe("Hikvision channel numbering", () => {
  const analog = parseHikvisionAnalogChannels(ANALOG);
  const online = new Map([[1, true], [2, false]]);

  it("adds the analog range when IP ids restart at 1 and fills the remaining slots as empty", () => {
    expect(mapHikvisionChannels({ analog, proxy: parseHikvisionProxyChannels(PROXY), online, channelCount: 8 })).toEqual({ dropped: 0, channels: [
      { channel: 1, state: "CONNECTED", name: "Cổng trước" }, { channel: 2, state: "DISCONNECTED", name: "Sân sau" },
      { channel: 3, state: "EMPTY", name: "Camera 03" }, { channel: 4, state: "UNKNOWN", name: "Camera 04" },
      { channel: 5, state: "CONNECTED", name: "Hành lang" }, { channel: 6, state: "DISCONNECTED", name: "Thang máy" },
      { channel: 7, state: "EMPTY" }, { channel: 8, state: "EMPTY" },
    ] });
  });

  it("keeps IP ids that already sit above the analog range", () => {
    const mapped = mapHikvisionChannels({ analog, proxy: [{ id: 5, name: "D1" }, { id: 7 }], online: new Map([[5, true]]), channelCount: 8 });
    expect(mapped.channels.slice(4)).toEqual([{ channel: 5, state: "CONNECTED", name: "D1" }, { channel: 6, state: "EMPTY" }, { channel: 7, state: "UNKNOWN" }, { channel: 8, state: "EMPTY" }]);
    expect(mapped.dropped).toBe(0);
  });

  it("shifts every IP id as soon as one of them falls inside the analog range", () => {
    const mapped = mapHikvisionChannels({ analog, proxy: [{ id: 4 }, { id: 5 }], online: new Map([[4, true], [5, true]]), channelCount: 16 });
    expect(mapped.channels.filter((channel) => channel.state === "CONNECTED").map((channel) => channel.channel)).toEqual([1, 8, 9]);
  });

  it("uses IP ids as they are on a recorder without analog inputs", () => {
    expect(mapHikvisionChannels({ analog: [], proxy: [{ id: 1 }, { id: 3 }], online: new Map([[1, true], [3, false]]), channelCount: 4 }).channels).toEqual([
      { channel: 1, state: "CONNECTED" }, { channel: 2, state: "EMPTY" }, { channel: 3, state: "DISCONNECTED" }, { channel: 4, state: "EMPTY" },
    ]);
  });

  it("treats a gap in the analog ids as part of the analog range, so the two types never share a number", () => {
    const mapped = mapHikvisionChannels({ analog: [{ id: 1, state: "CONNECTED" }, { id: 6, state: "CONNECTED" }], proxy: [{ id: 5 }], online: new Map([[5, true]]), channelCount: 16 });
    expect(mapped.channels.filter((channel) => channel.state === "CONNECTED").map((channel) => channel.channel)).toEqual([1, 6, 11]);
    expect(mapped.dropped).toBe(0);
  });

  it("never emits a number above the enrolled capacity or 256, and never a duplicate", () => {
    const beyond = mapHikvisionChannels({ analog, proxy: parseHikvisionProxyChannels(PROXY), online, channelCount: 5 });
    expect(beyond.channels.map((channel) => channel.channel)).toEqual([1, 2, 3, 4, 5]);
    expect(beyond.dropped).toBe(1);
    const huge = mapHikvisionChannels({ analog: [], proxy: [{ id: 256 }, { id: 257 }, { id: 4000 }], online: new Map(), channelCount: 256 });
    expect(huge.channels).toHaveLength(256);
    expect(Math.max(...huge.channels.map((channel) => channel.channel))).toBe(256);
    expect(huge.dropped).toBe(2);
    expect(new Set(huge.channels.map((channel) => channel.channel)).size).toBe(256);
  });
});

describe("Digest challenge selection", () => {
  const digest = 'Digest realm="fixture-realm", domain="/", qop="auth", nonce="n1", opaque="", algorithm="MD5", stale="FALSE"';
  it("selects Digest whether Basic arrives on its own line or on the same one, and never Basic", () => {
    expect(selectDigestChallenge([digest, 'Basic realm="fixture-realm"'])).toBe(digest);
    expect(selectDigestChallenge([`Basic realm="a, Digest b=c", ${digest}`])).toBe(digest);
    expect(selectDigestChallenge([`${digest}, Basic realm="fixture-realm"`])).toBe(digest);
    expect(selectDigestChallenge(['Basic realm="fixture-realm"'])).toBeNull();
    expect(selectDigestChallenge([])).toBeNull();
  });
  it("prefers SHA-256 and skips an algorithm it cannot compute", () => {
    const sha = 'Digest realm="r", qop="auth", nonce="n2", algorithm=SHA-256';
    expect(selectDigestChallenge([digest, sha])).toBe(sha);
    expect(selectDigestChallenge(['Digest realm="r", nonce="n3", algorithm=MD5-sess', digest])).toBe(digest);
    expect(selectDigestChallenge(['Digest realm="r", nonce="n3", algorithm=MD5-sess'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A local stand-in for a recorder. It verifies the Digest response itself, so a
// client that computed the wrong hash, reused a nonce or sent Basic is refused.
// ---------------------------------------------------------------------------
const USER = "fixture-user";
const PASSWORD = ["fixture", "secret"].join("-");
const REALM = "fixture-realm";
const OPAQUE = "fixture-opaque";

interface Route { status?: number; body: string }
interface FakeRecorderOptions {
  routes: Record<string, Route>;
  algorithm?: "MD5" | "SHA-256";
  /** WWW-Authenticate lines sent before the Digest line, the way a recorder also offers Basic. */
  alsoOffer?: string[];
  /** Replace every challenge, e.g. a device that only offers Basic. */
  challenges?: string[];
  challengeBody?: string;
  tls?: HttpsServerOptions;
  /** Kill a connection when a second request arrives on it, without answering. */
  dropReusedConnections?: boolean;
}
interface SeenRequest { path: string; authorization: string | undefined; headers: string; connection: number }

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fakeRecorder(options: FakeRecorderOptions) {
  const algorithm = options.algorithm ?? "MD5";
  const seen: SeenRequest[] = [];
  const nonces = new Set<string>();
  const connections = new Map<Socket, { id: number; requests: number }>();
  const ciphers = new Set<string>();
  const state = { dropped: 0 };
  const hash = (value: string) => createHash(algorithm === "MD5" ? "md5" : "sha256").update(value).digest("hex");
  const authorized = (request: IncomingMessage, header: string) => {
    if (!header.startsWith("Digest ")) return false;
    const field = new Map([...header.slice(7).matchAll(/([a-z]+)=(?:"([^"]*)"|([^,\s]+))/giu)].map((match) => [match[1]!.toLowerCase(), match[2] ?? match[3] ?? ""]));
    const expected = hash(`${hash(`${USER}:${REALM}:${PASSWORD}`)}:${field.get("nonce")}:${field.get("nc")}:${field.get("cnonce")}:auth:${hash(`${request.method}:${field.get("uri")}`)}`);
    return field.get("username") === USER && field.get("realm") === REALM && nonces.delete(field.get("nonce") ?? "") && field.get("uri") === request.url
      && field.get("qop") === "auth" && field.get("nc") === "00000001" && field.get("opaque") === OPAQUE && field.get("algorithm") === algorithm
      && field.get("response") === expected;
  };
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    let connection = connections.get(request.socket);
    if (!connection) {
      connection = { id: connections.size + 1, requests: 0 };
      connections.set(request.socket, connection);
      if (options.tls) ciphers.add((request.socket as TLSSocket).getCipher().name);
    }
    connection.requests += 1;
    seen.push({ path: request.url ?? "", authorization: request.headers.authorization, headers: request.rawHeaders.join("\n"), connection: connection.id });
    if (options.dropReusedConnections && connection.requests > 1) { state.dropped += 1; request.socket.destroy(); return; }
    const authorization = request.headers.authorization;
    if (!authorization || !authorized(request, authorization)) {
      const nonce = randomBytes(8).toString("hex");
      nonces.add(nonce);
      response.statusCode = 401;
      response.setHeader("WWW-Authenticate", options.challenges ?? [...(options.alsoOffer ?? []),
        `Digest realm="${REALM}", domain="/", qop="auth", nonce="${nonce}", opaque="${OPAQUE}", algorithm="${algorithm}", stale="FALSE"`]);
      response.end(options.challengeBody ?? "<html><body>Unauthorized</body></html>");
      return;
    }
    const route = options.routes[request.url ?? ""];
    response.statusCode = route ? route.status ?? 200 : 404;
    response.setHeader("Content-Type", "application/xml");
    response.end(route?.body ?? "");
  };
  const server = options.tls ? createHttpsServer(options.tls, handle) : createHttpServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`, seen, state, connectionCount: () => connections.size, ciphers };
}

const HEALTHY_ROUTES: Record<string, Route> = {
  [HIKVISION_ANALOG_CHANNELS_PATH]: { body: ANALOG_HEALTHY },
  [HIKVISION_PROXY_CHANNELS_PATH]: { body: PROXY },
  [HIKVISION_PROXY_STATUS_PATH]: { body: PROXY_STATUS },
  [HIKVISION_STORAGE_PATH]: { body: STORAGE },
};
const HEALTHY_CHANNELS = [
  { channel: 1, state: "CONNECTED", name: "Cổng trước" }, { channel: 2, state: "DISCONNECTED", name: "Sân sau" },
  { channel: 3, state: "CONNECTED", name: "Hành lang" }, { channel: 4, state: "DISCONNECTED", name: "Thang máy" },
];
const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");
const clientFor = (url: string, overrides: Partial<ConstructorParameters<typeof HikvisionClient>[0]> = {}) =>
  new HikvisionClient({ baseUrl: url, username: USER, password: PASSWORD, channelCount: 4, timeoutMs: 5000, now: fixedNow, ...overrides });

describe("Hikvision read-only polling over HTTP Digest", () => {
  it("answers each challenge once, reuses one connection and reports a complete snapshot", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES, alsoOffer: [`Basic realm="${REALM}"`] });
    const client = clientFor(recorder.url);
    const snapshot = await client.poll();
    expect(snapshot).toEqual({
      observedAt: "2026-01-01T00:00:00.000Z", status: "ONLINE", eventCoverage: "STATE_POLLING_ONLY", issues: [], channels: HEALTHY_CHANNELS,
      storage: [{ slot: 1, state: "NORMAL", totalBytes: 1907729 * MEGABYTE, usedBytes: 1900000 * MEGABYTE }],
    });
    expect(client.lastFailure).toBeNull();
    expect(recorder.seen.map((request) => [request.path, request.authorization === undefined])).toEqual([
      [HIKVISION_ANALOG_CHANNELS_PATH, true], [HIKVISION_ANALOG_CHANNELS_PATH, false],
      [HIKVISION_PROXY_CHANNELS_PATH, true], [HIKVISION_PROXY_CHANNELS_PATH, false],
      [HIKVISION_PROXY_STATUS_PATH, true], [HIKVISION_PROXY_STATUS_PATH, false],
      [HIKVISION_STORAGE_PATH, true], [HIKVISION_STORAGE_PATH, false],
    ]);
    expect(recorder.connectionCount()).toBe(1);
    expect(recorder.seen.every((request) => request.authorization === undefined || request.authorization.startsWith("Digest "))).toBe(true);
    expect(recorder.seen.some((request) => request.headers.includes(PASSWORD) || /basic/iu.test(request.authorization ?? ""))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(PASSWORD);
  });

  it("computes SHA-256 responses when the recorder asks for them", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES, algorithm: "SHA-256" });
    expect(await clientFor(recorder.url).poll()).toMatchObject({ status: "ONLINE", issues: [], channels: HEALTHY_CHANNELS });
    expect(recorder.seen.at(-1)?.authorization).toContain("algorithm=SHA-256");
  });

  it("stops after one refused login: exactly two requests in the whole poll, then AUTH_DENIED", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES });
    const client = clientFor(recorder.url, { password: "wrong" });
    expect(await client.poll()).toEqual({ observedAt: "2026-01-01T00:00:00.000Z", status: "AUTH_DENIED", eventCoverage: "STATE_POLLING_ONLY", issues: ["AUTHENTICATION_FAILED"], channels: [], storage: [] });
    expect(recorder.seen).toHaveLength(2);
    expect(recorder.seen.filter((request) => request.authorization !== undefined)).toHaveLength(1);
    expect(client.lastFailure).toBe("AUTH_DENIED");
  });

  it("never falls back to Basic when no Digest challenge is offered", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES, challenges: [`Basic realm="${REALM}"`] });
    expect(await clientFor(recorder.url).poll()).toMatchObject({ status: "AUTH_DENIED", issues: ["AUTHENTICATION_FAILED"] });
    expect(recorder.seen).toHaveLength(1);
    expect(recorder.seen[0]?.authorization).toBeUndefined();
  });

  it("sends no login at all while the recorder states a lock-out", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES, challengeBody: "<userCheck><statusValue>401</statusValue><lockStatus>lock</lockStatus><unlockTime>1800</unlockTime></userCheck>" });
    expect(await clientFor(recorder.url).poll()).toMatchObject({ status: "AUTH_DENIED", issues: ["AUTHENTICATION_FAILED"] });
    expect(recorder.seen).toHaveLength(1);
    expect(recorder.seen[0]?.authorization).toBeUndefined();
  });

  it("reads a model without analog inputs: the 403 notSupport list is empty and IP ids are used as they are", async () => {
    const recorder = await fakeRecorder({ routes: { ...HEALTHY_ROUTES, [HIKVISION_ANALOG_CHANNELS_PATH]: { status: 403, body: NOT_SUPPORTED } } });
    expect(await clientFor(recorder.url).poll()).toMatchObject({ status: "ONLINE", issues: [], channels: [
      { channel: 1, state: "CONNECTED", name: "Hành lang" }, { channel: 2, state: "DISCONNECTED", name: "Thang máy" },
      { channel: 3, state: "EMPTY" }, { channel: 4, state: "EMPTY" },
    ] });
  });

  it("reads a model without IP channels: a 404 list is empty and the status endpoint is not requested", async () => {
    const { [HIKVISION_PROXY_CHANNELS_PATH]: _absent, ...routes } = HEALTHY_ROUTES;
    const recorder = await fakeRecorder({ routes });
    expect(await clientFor(recorder.url).poll()).toMatchObject({ status: "ONLINE", issues: [], channels: [
      { channel: 1, state: "CONNECTED" }, { channel: 2, state: "DISCONNECTED" }, { channel: 3, state: "EMPTY" }, { channel: 4, state: "EMPTY" },
    ] });
    expect(recorder.seen.some((request) => request.path === HIKVISION_PROXY_STATUS_PATH)).toBe(false);
  });

  it("does not call a recorder empty when neither channel list exists", async () => {
    const recorder = await fakeRecorder({ routes: { [HIKVISION_STORAGE_PATH]: { body: STORAGE } } });
    const client = clientFor(recorder.url);
    expect(await client.poll()).toMatchObject({ status: "UNKNOWN", issues: ["CHANNEL_STATUS_UNAVAILABLE"], channels: [] });
    expect(client.lastFailure).toBe("UNSUPPORTED");
  });

  it("treats a stated privilege refusal as denied access, not as a missing channel type", async () => {
    const recorder = await fakeRecorder({ routes: { ...HEALTHY_ROUTES, [HIKVISION_PROXY_CHANNELS_PATH]: { status: 403, body: LOW_PRIVILEGE } } });
    expect(await clientFor(recorder.url).poll()).toMatchObject({ status: "AUTH_DENIED", issues: ["AUTHENTICATION_FAILED"], channels: [], storage: [] });
    expect(recorder.seen.map((request) => request.path)).not.toContain(HIKVISION_STORAGE_PATH);
  });

  it.each([
    { name: "a failing status endpoint", route: { status: 500, body: "" }, issues: ["CHANNEL_STATUS_UNAVAILABLE"] },
    { name: "an unparseable status list", route: { body: "<html>busy</html>" }, issues: ["DEVICE_RESPONSE_INVALID", "CHANNEL_STATUS_UNAVAILABLE"] },
    { name: "a model without the status endpoint", route: { status: 404, body: "" }, issues: ["CHANNEL_STATUS_UNAVAILABLE"] },
    { name: "a status list missing a row", route: { body: statusList(statusRow(1, "<online>true</online>")) }, issues: ["CHANNEL_STATUS_UNAVAILABLE"], third: "CONNECTED" },
  ])("keeps measured analog states and marks IP channels unknown for $name", async ({ route, issues, third }) => {
    const recorder = await fakeRecorder({ routes: { ...HEALTHY_ROUTES, [HIKVISION_PROXY_STATUS_PATH]: route } });
    const snapshot = await clientFor(recorder.url).poll();
    expect(snapshot).toMatchObject({ status: "ONLINE", issues, storage: [{ slot: 1, state: "NORMAL" }] });
    expect(snapshot.channels.map((channel) => channel.state)).toEqual(["CONNECTED", "DISCONNECTED", third ?? "UNKNOWN", "UNKNOWN"]);
  });

  it.each([
    { name: "a failing storage endpoint", route: { status: 500, body: fault(3, "Device Error", "deviceError") }, issue: "STORAGE_STATUS_UNAVAILABLE" },
    { name: "a model without the storage endpoint", route: { status: 404, body: "" }, issue: "STORAGE_STATUS_UNAVAILABLE" },
    { name: "an unparseable storage reply", route: { body: "<html>busy</html>" }, issue: "DEVICE_RESPONSE_INVALID" },
    { name: "an oversized storage reply", route: { body: storage(hddRow(1, `<status>ok</status><!--${"x".repeat(4096)}-->`)) }, issue: "DEVICE_RESPONSE_INVALID" },
    { name: "a disk in a state this build does not know", route: { body: storage(hddRow(1, "<status>reparing</status>")) }, issue: "STORAGE_STATUS_UNAVAILABLE", disks: [{ slot: 1, state: "UNKNOWN" }] },
  ])("keeps measured channels when storage is unreadable: $name", async ({ route, issue, disks }) => {
    const recorder = await fakeRecorder({ routes: { ...HEALTHY_ROUTES, [HIKVISION_STORAGE_PATH]: route } });
    const snapshot = await clientFor(recorder.url, { maxResponseBytes: 4096 }).poll();
    expect(snapshot).toMatchObject({ status: "ONLINE", issues: [issue], channels: HEALTHY_CHANNELS, storage: disks ?? [] });
    expect(snapshot.issues.every((code) => (CAMERA_ISSUES as readonly string[]).includes(code))).toBe(true);
  });

  it.each([
    { name: "an unparseable channel list", route: { body: "<html>busy</html>" }, issue: "DEVICE_RESPONSE_INVALID" },
    { name: "a failing channel list", route: { status: 500, body: "" }, issue: "CHANNEL_STATUS_UNAVAILABLE" },
    { name: "a redirect", route: { status: 302, body: "" }, issue: "CHANNEL_STATUS_UNAVAILABLE" },
  ])("does not certify channels after $name, and still reads the disks", async ({ route, issue }) => {
    const recorder = await fakeRecorder({ routes: { ...HEALTHY_ROUTES, [HIKVISION_ANALOG_CHANNELS_PATH]: route } });
    expect(await clientFor(recorder.url).poll()).toMatchObject({ status: "UNKNOWN", issues: [issue], channels: [], storage: [{ slot: 1, state: "NORMAL" }] });
    expect(recorder.seen.map((request) => request.path)).not.toContain(HIKVISION_PROXY_CHANNELS_PATH);
  });

  it("flags channels the enrolment has no room for instead of sending numbers ingestion rejects", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES });
    const snapshot = await clientFor(recorder.url, { channelCount: 3 }).poll();
    expect(snapshot).toMatchObject({ status: "ONLINE", issues: ["CHANNEL_STATUS_UNAVAILABLE"] });
    expect(snapshot.channels.map((channel) => channel.channel)).toEqual([1, 2, 3]);
  });

  it("reports a recorder that does not answer as offline, without device text", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES });
    const [server] = servers.splice(0);
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const client = clientFor(recorder.url);
    expect(await client.poll()).toEqual({ observedAt: "2026-01-01T00:00:00.000Z", status: "OFFLINE", eventCoverage: "STATE_POLLING_ONLY", issues: ["NETWORK_UNREACHABLE"], channels: [], storage: [] });
    expect(client.lastFailure).toBe("UNREACHABLE");
  });

  it("recovers when the recorder silently closes kept-alive connections, then stops reusing them", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES, dropReusedConnections: true });
    const client = clientFor(recorder.url);
    expect(await client.poll()).toMatchObject({ status: "ONLINE", issues: [], channels: HEALTHY_CHANNELS });
    expect(recorder.state.dropped).toBe(1);
    const before = recorder.seen.length;
    expect(await client.poll()).toMatchObject({ status: "ONLINE", issues: [] });
    expect(recorder.state.dropped).toBe(1);
    const second = recorder.seen.slice(before);
    expect(second).toHaveLength(8);
    expect(new Set(second.map((request) => request.connection)).size).toBe(8);
  });

  it("rejects embedded credentials, paths and an unusable capacity before any request", () => {
    expect(() => clientFor("http://user:secret@192.0.2.10")).toThrow("INVALID_CAMERA_BASE_URL");
    expect(() => clientFor("http://192.0.2.10/untrusted")).toThrow("INVALID_CAMERA_BASE_URL");
    expect(() => clientFor("http://192.0.2.10", { channelCount: 0 })).toThrow("INVALID_CAMERA_CHANNEL_COUNT");
    expect(() => clientFor("http://192.0.2.10", { username: "a\r\nb" })).toThrow("INVALID_CAMERA_CREDENTIAL");
  });
});

describe("Hikvision HTTPS with a pinned certificate", () => {
  const identity = throwawayCertificate();
  const nearMiss = (identity.fingerprint256[0] === "0" ? "1" : "0") + identity.fingerprint256.slice(1);

  it("requires a pin for https and refuses one for http", () => {
    expect(() => clientFor("https://192.0.2.10")).toThrow("CAMERA_TLS_PIN_REQUIRED");
    expect(() => clientFor("https://192.0.2.10", { tlsFingerprint256: "AB".repeat(32) })).toThrow("CAMERA_TLS_PIN_REQUIRED");
    expect(() => clientFor("http://192.0.2.10", { tlsFingerprint256: identity.fingerprint256 })).toThrow("CAMERA_TLS_PIN_REQUIRES_HTTPS");
  });

  it("polls through a self-signed, expired certificate when its fingerprint matches the pin", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES, tls: identity, alsoOffer: [`Basic realm="${REALM}"`] });
    const client = clientFor(recorder.url, { tlsFingerprint256: identity.fingerprint256 });
    expect(await client.poll()).toMatchObject({ status: "ONLINE", issues: [], channels: HEALTHY_CHANNELS, storage: [{ slot: 1, state: "NORMAL" }] });
    expect(recorder.seen).toHaveLength(8);
    expect(recorder.connectionCount()).toBe(1);
  });

  it("negotiates the TLS 1.2 DHE-RSA suite an old recorder firmware is limited to", async () => {
    // The suite and protocol version measured on one target; the DH group here is this runtime's own
    // 2048-bit default, so a firmware with a smaller group is NOT covered by this test.
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES, tls: { ...identity, maxVersion: "TLSv1.2", ciphers: "DHE-RSA-AES256-GCM-SHA384", dhparam: "auto" } });
    expect(await clientFor(recorder.url, { tlsFingerprint256: identity.fingerprint256 }).poll()).toMatchObject({ status: "ONLINE", issues: [] });
    expect([...recorder.ciphers]).toEqual(["DHE-RSA-AES256-GCM-SHA384"]);
  });

  it("writes no request line and no Authorization header when the certificate does not match the pin", async () => {
    const received: Buffer[] = [];
    const accepted: Array<Promise<void>> = [];
    const server = createTlsServer({ key: identity.key, cert: identity.cert }, (socket) => {
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("error", () => undefined);
    });
    server.on("connection", (socket: Socket) => { accepted.push(new Promise((resolve) => socket.once("close", () => resolve()))); });
    server.on("tlsClientError", () => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      // Control: this server does record what a client writes after the handshake.
      await new Promise<void>((resolve, reject) => {
        const probe = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => probe.end("control-bytes"));
        probe.once("close", () => resolve());
        probe.once("error", reject);
      });
      await Promise.all(accepted.splice(0));
      expect(Buffer.concat(received.splice(0)).toString()).toBe("control-bytes");

      // A short deadline keeps a client that did write a request from hanging on this silent server.
      const client = clientFor(`https://127.0.0.1:${port}`, { tlsFingerprint256: nearMiss, timeoutMs: 500 });
      const snapshot = await client.poll();
      await Promise.all(accepted);
      expect(Buffer.concat(received).toString()).toBe("");
      expect(accepted).toHaveLength(1);
      expect(client.lastFailure).toBe("TLS_PIN_MISMATCH");
      expect(snapshot).toEqual({ observedAt: "2026-01-01T00:00:00.000Z", status: "UNKNOWN", eventCoverage: "STATE_POLLING_ONLY", issues: ["DEVICE_RESPONSE_INVALID"], channels: [], storage: [] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a peer that is not speaking TLS as a failed handshake, not as an offline recorder", async () => {
    const recorder = await fakeRecorder({ routes: HEALTHY_ROUTES });
    const client = clientFor(recorder.url.replace("http://", "https://"), { tlsFingerprint256: identity.fingerprint256 });
    expect(await client.poll()).toMatchObject({ status: "UNKNOWN", issues: ["DEVICE_RESPONSE_INVALID"] });
    expect(client.lastFailure).toBe("TLS_HANDSHAKE_FAILED");
    expect(recorder.seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MEASURED SHAPES. These documents reproduce what two real recorders returned
// on 2026-11-10: a hybrid DVR with 8 analog inputs on firmware V4.70 and a
// 16-input DVR on firmware V3.4. Layout, element order and value vocabulary are
// kept; names, addresses and device ids are fixture values.
// ---------------------------------------------------------------------------
describe("Hikvision replies as measured on real recorders", () => {
  const PROLOG = '<?xml version="1.0" encoding="UTF-8" ?>';
  const measuredInput = (id: number, enabled: boolean, name: string, resDesc: string) => `<VideoInputChannel ${NS}>
<id>${id}</id>
<inputPort>${id}</inputPort>
<videoInputEnabled>${enabled}</videoInputEnabled>
<name>${name}</name>
<videoFormat>PAL</videoFormat>
<resDesc>${resDesc}</resDesc>
</VideoInputChannel>`;
  const measuredSource = (protocol: string, address: string, port: number) => `<sourceInputPortDescriptor>
<proxyProtocol>${protocol}</proxyProtocol>
<addressingFormatType>ipaddress</addressingFormatType>
<ipAddress>${address}</ipAddress>
<managePortNo>${port}</managePortNo>
<srcInputPort>1</srcInputPort>
<userName>fixture-user</userName>
<streamType>auto</streamType>
<deviceID>fixture-device-${port}</deviceID>
</sourceInputPortDescriptor>`;
  const measuredStatus = (id: number, source: string, online: boolean, streams: string, detect: string) => `<InputProxyChannelStatus ${NS}>
<id>${id}</id>
${source}
<online>${online}</online>
<streamingProxyChannelIdList>
${streams}</streamingProxyChannelIdList>
<relatedIOProxy>
<inputProxyPortIdList>
</inputProxyPortIdList>
<outputProxyPortIdList>
</outputProxyPortIdList>
</relatedIOProxy>
<chanDetectResult>${detect}</chanDetectResult>
<SecurityStatus>
<PasswordStatus>weak</PasswordStatus>
</SecurityStatus>
</InputProxyChannelStatus>`;
  const measuredStorage = (id: number, name: string, capacity: number, workMode: string) => `${PROLOG}
<storage ${NS}>
<hddList>
<hdd ${NS}>
<id>${id}</id>
<hddName>${name}</hddName>
<hddPath></hddPath>
<hddType>SATA</hddType>
<status>ok</status>
<capacity>${capacity}</capacity>
<freeSpace>0</freeSpace>
<property>RW</property>
</hdd>
</hddList>
<nasList>
</nasList>
<workMode>${workMode}</workMode>
</storage>`;

  it("reads a hybrid DVR: padded resolutions, switched-off inputs and IP channels numbered after the analog range", () => {
    const inputs = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => id <= 5
      ? measuredInput(id, true, `Camera 0${id}`, `${id % 2 === 1 ? "  " : ""}960*1080(1080PLite)P25`)
      : measuredInput(id, false, `Camera 0${id}`, "NO VIDEO"));
    const analog = parseHikvisionAnalogChannels(`${PROLOG}
<VideoInputChannelList ${NS}>
${inputs.join("\n")}
</VideoInputChannelList>`);
    const onvif = measuredSource("ONVIF", "10.25.0.122", 80);
    const native = measuredSource("HIKVISION", "10.25.0.140", 8000);
    const proxy = parseHikvisionProxyChannels(`${PROLOG}
<InputProxyChannelList ${NS} size="3">
<InputProxyChannel ${NS}>
<id>9</id>
<name>IPC</name>
${onvif}
<enableTiming>true</enableTiming>
</InputProxyChannel>
<InputProxyChannel ${NS}>
<id>10</id>
<name>Camera 01</name>
${native}
</InputProxyChannel>
</InputProxyChannelList>`);
    const streams = ["<streamingProxyChannelId>901</streamingProxyChannelId>", "<streamingProxyChannelId>902</streamingProxyChannelId>", ""].join("\n");
    const online = parseHikvisionProxyStatus(`${PROLOG}
<InputProxyChannelStatusList ${NS}>
${measuredStatus(9, onvif, true, streams, "connect")}
${measuredStatus(10, native, false, "", "netUnreachable")}
</InputProxyChannelStatusList>`);

    expect(online).toEqual(new Map([[9, true], [10, false]]));
    expect(mapHikvisionChannels({ analog, proxy, online, channelCount: 10 })).toEqual({ dropped: 0, channels: [
      { channel: 1, state: "CONNECTED", name: "Camera 01" }, { channel: 2, state: "CONNECTED", name: "Camera 02" },
      { channel: 3, state: "CONNECTED", name: "Camera 03" }, { channel: 4, state: "CONNECTED", name: "Camera 04" },
      { channel: 5, state: "CONNECTED", name: "Camera 05" }, { channel: 6, state: "EMPTY", name: "Camera 06" },
      { channel: 7, state: "EMPTY", name: "Camera 07" }, { channel: 8, state: "EMPTY", name: "Camera 08" },
      { channel: 9, state: "CONNECTED", name: "IPC" }, { channel: 10, state: "DISCONNECTED", name: "Camera 01" },
    ] });
    expect(parseHikvisionStorage(measuredStorage(1, "hdd1", 1907729, "quota"))).toEqual([
      { slot: 1, state: "NORMAL", totalBytes: 1907729 * 1048576, usedBytes: 1907729 * 1048576 },
    ]);
  });

  it("reads an older analog-only DVR: short resolution words, enabled inputs without video, no IP channels, disk in slot 2", () => {
    const analog = parseHikvisionAnalogChannels(`${PROLOG}
<VideoInputChannelList ${NS}>
${measuredInput(1, true, "Loi vao - cong", "1080P25")}
${measuredInput(2, true, "H.Lang T3", "HD720P25")}
${measuredInput(3, true, "San sau", "NO VIDEO")}
${measuredInput(4, true, "chua gan", "NO VIDEO")}
</VideoInputChannelList>`);
    const proxy = parseHikvisionProxyChannels(`${PROLOG}
<InputProxyChannelList ${NS}>
</InputProxyChannelList>`);
    const online = parseHikvisionProxyStatus(`${PROLOG}
<InputProxyChannelStatusList ${NS}>
</InputProxyChannelStatusList>`);

    expect(proxy).toEqual([]);
    expect(online.size).toBe(0);
    expect(mapHikvisionChannels({ analog, proxy, online, channelCount: 4 })).toEqual({ dropped: 0, channels: [
      { channel: 1, state: "CONNECTED", name: "Loi vao - cong" }, { channel: 2, state: "CONNECTED", name: "H.Lang T3" },
      { channel: 3, state: "DISCONNECTED", name: "San sau" }, { channel: 4, state: "DISCONNECTED", name: "chua gan" },
    ] });
    expect(parseHikvisionStorage(measuredStorage(2, "hddb", 3815447, "group"))).toEqual([
      { slot: 2, state: "NORMAL", totalBytes: 3815447 * 1048576, usedBytes: 3815447 * 1048576 },
    ]);
  });
});
