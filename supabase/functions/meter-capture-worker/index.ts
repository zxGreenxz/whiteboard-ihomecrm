import { sha256 } from '@noble/hashes/sha256';

type Json = Record<string, unknown>;
type Fetcher = typeof fetch;
export interface Dependencies { env?: (key: string) => string | undefined; fetch?: Fetcher }
const BUCKET = 'meter-capture-media';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FRAME = 3 * 1024 * 1024;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const USER_ACTIONS = new Set(['catalog', 'profile', 'resolveQr', 'rotateQr', 'revokeQr', 'startCapture', 'getCapture', 'listCaptures', 'confirmCapture', 'resolveBilling', 'evidence', 'documentReceipt', 'documentEvidence']);
class RequestError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function object(value: unknown): value is Json { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requiredString(value: unknown, regex?: RegExp): string {
  if (typeof value !== 'string' || !value || (regex && !regex.test(value))) throw new RequestError(400, 'invalid_request');
  return value;
}
function response(status: number, value: unknown): Response { return new Response(JSON.stringify(value), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }
function pathFor(key: string): string {
  if (key.includes('..') || key.includes('\\') || key.startsWith('/') || !/^[a-zA-Z0-9/_.-]+$/.test(key)) throw new RequestError(400, 'invalid_object_key');
  return key.split('/').map(encodeURIComponent).join('/');
}
function hex(bytes: Uint8Array): string { return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }
async function boundedJson(request: Request): Promise<Json> {
  if (Number(request.headers.get('content-length') || 0) > 5 * 1024 * 1024) throw new RequestError(413, 'request_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'invalid_json');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 5 * 1024 * 1024) throw new RequestError(413, 'request_too_large'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const joined = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(joined)); } catch { throw new RequestError(400, 'invalid_json'); }
  if (!object(parsed)) throw new RequestError(400, 'invalid_json');
  return parsed;
}
function mimeMatches(prefix: Uint8Array, mime: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...prefix.subarray(start, end));
  if (mime === 'image/jpeg') return prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (mime === 'image/png') return hex(prefix.subarray(0, 8)) === '89504e470d0a1a0a';
  if (mime === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (mime === 'video/webm') return hex(prefix.subarray(0, 4)) === '1a45dfa3';
  if (mime === 'video/mp4' || mime === 'video/quicktime') return ascii(4, 8) === 'ftyp';
  return false;
}
export async function digestStream(source: Response, maximum = MAX_BYTES): Promise<{ sha256: string; sizeBytes: number; prefix: Uint8Array }> {
  if (!source.ok || !source.body) throw new RequestError(502, 'original_unavailable');
  if (Number(source.headers.get('content-length') || 0) > maximum) throw new RequestError(413, 'media_too_large');
  const hash = sha256.create(); const reader = source.body.getReader(); let sizeBytes = 0; let prefix = new Uint8Array();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      sizeBytes += value.length; if (sizeBytes > maximum) throw new RequestError(413, 'media_too_large');
      if (prefix.length < 32) { const next = new Uint8Array(Math.min(32, prefix.length + value.length)); next.set(prefix); next.set(value.subarray(0, next.length - prefix.length), prefix.length); prefix = next; }
      hash.update(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return { sha256: hex(hash.digest()), sizeBytes, prefix };
}
async function secretMatches(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder(); const left = sha256(encoder.encode(a)); const right = sha256(encoder.encode(b));
  let difference = 0; for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return b.length >= 32 && a.length >= 32 && difference === 0;
}

export function createHandler(dependencies: Dependencies = {}) {
  const env = dependencies.env ?? ((key: string) => Deno.env.get(key));
  const fetcher = dependencies.fetch ?? fetch;
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (request.method !== 'POST') throw new RequestError(405, 'method_not_allowed');
      const base = (env('SUPABASE_URL') ?? '').replace(/\/+$/, '');
      const service = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const anon = env('SUPABASE_ANON_KEY') ?? '';
      if (!/^https:\/\//.test(base) || !service || !anon) throw new RequestError(503, 'meter_capture_gateway_unconfigured');
      const auth = request.headers.get('authorization') ?? '';
      if (!/^Bearer \S+$/.test(auth)) throw new RequestError(401, 'unauthorized');
      const body = await boundedJson(request);
      const worker = new URL(request.url).pathname.match(/\/worker\/(claim|media|evidence|complete)$/)?.[1];
      const call = async (url: string, init: RequestInit = {}, token = service, apiKey = service): Promise<Response> => fetcher(url, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(90_000),
        headers: { Authorization: 'Bearer ' + token, apikey: apiKey, ...init.headers },
      });
      const rpc = async (name: string, args: Json, user = false): Promise<unknown> => {
        const result = await call(base + '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) }, user ? auth.slice(7) : service, user ? anon : service);
        if (!result.ok) {
          const error: unknown = await result.json().catch(() => null);
          const code = object(error) && typeof error.code === 'string' ? error.code : '';
          const status = ['42501', 'PGRST301'].includes(code) ? 403 : ['PT409', '23505'].includes(code) ? 409 : ['22023', '55000'].includes(code) ? 422 : 502;
          throw new RequestError(status, code || 'meter_capture_rpc_failed');
        }
        if (result.status === 204) return null;
        return await result.json();
      };
      const original = (key: string) => call(base + '/storage/v1/object/authenticated/' + BUCKET + '/' + pathFor(key));
      const userRpc = (action: string, organizationId: string, payload: Json) => rpc('meter_capture_v1', { p_organization_id: organizationId, p_action: action, p_payload: payload }, true);
      const signed = async (key: unknown): Promise<string | null> => {
        if (key === null || key === undefined) return null;
        const value = requiredString(key);
        const result = await call(base + '/storage/v1/object/sign/' + BUCKET + '/' + pathFor(value), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 300 }) }, auth.slice(7), anon);
        if (!result.ok) throw new RequestError(result.status === 403 ? 403 : 502, 'evidence_sign_failed');
        const json: unknown = await result.json();
        const path = object(json) ? json.signedURL ?? json.signedUrl : null;
        if (typeof path !== 'string' || !path.startsWith('/object/sign/')) throw new RequestError(502, 'invalid_evidence_url');
        return base + '/storage/v1' + path;
      };
      const enrich = async (value: unknown): Promise<unknown> => {
        if (!object(value)) return value;
        const privateReference = (key: unknown) => key == null ? null
          : base + '/storage/v1/object/authenticated/' + BUCKET + '/' + pathFor(requiredString(key));
        const captureReferences = (capture: unknown) => {
          if (!object(capture)) return capture;
          if (!capture.mediaReceived) return { ...capture, evidenceUrl: null, videoUrl: null };
          // Existing StorageImage/useSignedUrl signs these only when expanded. References have
          // no bearer token and remain private; listing 500 captures must not make 1000 sign calls.
          return { ...capture, evidenceUrl: privateReference(capture.imageObjectKey), videoUrl: privateReference(capture.videoObjectKey) };
        };
        if (object(value.evidence)) return { ...value, evidence: { ...value.evidence, imageUrl: await signed(value.evidence.imageObjectKey), videoUrl: await signed(value.evidence.videoObjectKey) } };
        if ('capture' in value) return { ...value, capture: captureReferences(value.capture) };
        if (Array.isArray(value.captures)) {
          return { ...value, captures: value.captures.map(captureReferences) };
        }
        return value;
      };
      if (worker) {
        if (!await secretMatches(auth.slice(7), env('METER_CAPTURE_WORKER_TOKEN') ?? '')) throw new RequestError(403, 'worker_forbidden');
        if (worker === 'claim') {
          const workerId = requiredString(body.workerId); if (workerId.length > 100) throw new RequestError(400, 'invalid_worker_id');
          return response(200, await rpc('meter_capture_claim_v1', { p_worker_id: workerId }));
        }
        const jobId = requiredString(body.jobId, UUID); const leaseToken = requiredString(body.leaseToken, UUID);
        if (worker === 'complete') {
          if (!object(body.result)) throw new RequestError(400, 'invalid_result');
          return response(200, await rpc('meter_capture_complete_v1', { p_job_id: jobId, p_lease_token: leaseToken, p_result: body.result }));
        }
        const context = await rpc('meter_capture_worker_context_v1', { p_job_id: jobId, p_lease_token: leaseToken });
        if (!object(context) || !Array.isArray(context.media)) throw new RequestError(502, 'invalid_job_receipt');
        if (worker === 'media') {
          const mediaId = requiredString(body.mediaId, UUID);
          const media = context.media.find((value: unknown) => object(value) && value.id === mediaId);
          if (!object(media)) throw new RequestError(403, 'media_outside_job');
          const result = await original(requiredString(media.objectKey));
          if (!result.ok) throw new RequestError(502, 'original_unavailable');
          return new Response(result.body, { status: 200, headers: { ...CORS, 'Content-Type': requiredString(media.mimeType), 'Content-Length': String(media.sizeBytes) } });
        }
        const digest = requiredString(body.sha256, HASH);
        if (typeof body.timestampSeconds !== 'number' || !Number.isFinite(body.timestampSeconds) || body.timestampSeconds < 0 || body.timestampSeconds > 60) throw new RequestError(400, 'invalid_timestamp');
        const encoded = requiredString(body.dataBase64);
        if (encoded.length > MAX_FRAME * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new RequestError(413, 'evidence_too_large');
        let bytes: Uint8Array<ArrayBuffer>; try { bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0)); } catch { throw new RequestError(400, 'invalid_evidence'); }
        if (bytes.length > MAX_FRAME || !mimeMatches(bytes, 'image/jpeg') || hex(sha256(bytes)) !== digest) throw new RequestError(400, 'invalid_evidence_digest');
        const key = requiredString(context.organizationId, UUID) + '/meter-captures/' + requiredString(context.captureId, UUID) + '/evidence/' + digest + '.jpg';
        const uploaded = await call(base + '/storage/v1/object/' + BUCKET + '/' + pathFor(key), { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'private, no-store' }, body: bytes });
        if (!uploaded.ok) {
          if (![400, 409].includes(uploaded.status)) throw new RequestError(502, 'evidence_upload_failed');
          const existing = await digestStream(await original(key), MAX_FRAME);
          if (existing.sha256 !== digest || existing.sizeBytes !== bytes.length) throw new RequestError(409, 'evidence_conflict');
        }
        await rpc('meter_capture_evidence_receipt_v1', { p_job_id: jobId, p_lease_token: leaseToken, p_object_key: key, p_sha256: digest, p_timestamp_seconds: body.timestampSeconds });
        return response(200, { objectKey: key });
      }
      // User routes never execute user-selected operations with the service role.
      const organizationId = requiredString(body.organizationId, UUID);
      if (body.action === 'rpc') {
        const action = requiredString(body.rpcAction); if (!USER_ACTIONS.has(action) || !object(body.payload)) throw new RequestError(400, 'unsupported_action');
        return response(200, await enrich(await userRpc(action, organizationId, body.payload)));
      }
      if (body.action === 'invoice' || body.action === 'exit') {
        if (!object(body.arguments) || !Array.isArray(body.sources)) throw new RequestError(400, 'invalid_arguments');
        const args: Json = { p_organization_id: organizationId, p_arguments: body.arguments, p_sources: body.sources };
        if (body.action === 'exit') args.p_rpc_name = requiredString(body.rpcName);
        return response(200, await rpc(body.action === 'invoice' ? 'meter_capture_invoice_v1' : 'meter_capture_exit_v1', args, true));
      }
      if (body.action !== 'finalize') throw new RequestError(400, 'unsupported_action');
      const captureId = requiredString(body.captureId, UUID);
      const snapshot = await userRpc('getCapture', organizationId, { captureId });
      if (!object(snapshot) || !object(snapshot.capture)) throw new RequestError(403, 'capture_not_accessible');
      const capture = snapshot.capture; const key = requiredString(capture.objectKey);
      const mime = requiredString(capture.mimeType);
      const persisted = await original(key);
      if (!persisted.ok && body.allowMissing === true && [400, 404].includes(persisted.status)) {
        const missing: unknown = await persisted.json().catch(() => null);
        if (persisted.status === 404 || (object(missing) && String(missing.statusCode) === '404')) {
          return response(200, { capture: null, needsUpload: true });
        }
        throw new RequestError(502, 'original_unavailable');
      }
      const actual = await digestStream(persisted);
      if (actual.sha256 !== capture.sha256 || actual.sizeBytes !== capture.sizeBytes || !mimeMatches(actual.prefix, mime)) throw new RequestError(422, 'original_receipt_mismatch');
      await rpc('meter_capture_media_receipt_v1', {
        p_capture_id: captureId, p_object_key: key, p_sha256: actual.sha256, p_size_bytes: actual.sizeBytes,
        p_mime_type: mime, p_duration_seconds: null,
      });
      return response(200, await enrich(await userRpc('finalizeCapture', organizationId, { captureId, sha256: actual.sha256, sizeBytes: actual.sizeBytes })));
    } catch (error) {
      if (error instanceof RequestError) return response(error.status, { error: error.code });
      return response(502, { error: 'meter_capture_gateway_failed' });
    }
  };
}
if (import.meta.main) Deno.serve(createHandler());
