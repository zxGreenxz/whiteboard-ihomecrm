import { createHandler, digestStream } from './index.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const CAPTURE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const WORKER = 'fixture-worker-bearer-' + 'x'.repeat(40);
const ORIGINAL = `${ORG}/meter-captures/${CAPTURE}/original.jpg`;
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
const values: Record<string, string> = { SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role', SUPABASE_ANON_KEY: 'fixture-anon', METER_CAPTURE_WORKER_TOKEN: WORKER };
function assert(value: unknown, message = 'assertion failed'): asserts value { if (!value) throw new Error(message); }
function equal(actual: unknown, expected: unknown) { assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function request(body: unknown, route = '', bearer = 'user-jwt'): Request { return new Request('https://edge.test/meter-capture-worker' + route, { method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
type Call = { url: string; auth: string | null; profile: string | null; body: unknown };
function harness(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const handler = createHandler({ env: key => values[key], fetch: async (input, init) => {
    const raw = init?.body; let body: unknown = raw;
    if (typeof raw === 'string') body = JSON.parse(raw);
    const headers = new Headers(init?.headers);
    const call = { url: String(input), auth: headers.get('Authorization'), profile: headers.get('Content-Profile'), body };
    calls.push(call); return await reply(call);
  } });
  return { handler, calls };
}
async function capture() { return { id: CAPTURE, objectKey: ORIGINAL, mimeType: 'image/jpeg', sizeBytes: JPEG.length, sha256: (await digestStream(new Response(JPEG))).sha256, mediaReceived: false }; }
function context() { return { jobId: JOB, captureId: CAPTURE, organizationId: ORG, leaseToken: LEASE, media: [{ id: CAPTURE, objectKey: ORIGINAL, mimeType: 'image/jpeg', sizeBytes: JPEG.length }] }; }

Deno.test('worker bearer is separate from user JWT and bad bearer never touches DB', async () => {
  const { handler, calls } = harness(() => { throw new Error('must not call'); });
  equal((await handler(request({ workerId: 'cpu1' }, '/worker/claim'))).status, 403);
  equal(calls.length, 0);
});
Deno.test('staged rollout blocks new registration and collection before any RPC when decoder is unconfigured', async () => {
  for (const token of ['', 'too-short']) {
    let calls = 0;
    const handler = createHandler({ env: key => key === 'METER_CAPTURE_WORKER_TOKEN' ? token : values[key], fetch: () => { calls++; throw new Error('must not call'); } });
    for (const rpcAction of ['catalog', 'profile', 'rotateQr', 'startCapture']) {
      const result = await handler(request({ action: 'rpc', organizationId: ORG, rpcAction, payload: {} }));
      equal(result.status, 503); equal(await result.json(), { error: 'meter_capture_reader_not_enabled' });
    }
    equal(calls, 0);
  }
});
Deno.test('staged rollout still authorizes existing evidence reads with the user JWT', async () => {
  const handler = createHandler({ env: key => key === 'METER_CAPTURE_WORKER_TOKEN' ? undefined : values[key], fetch: (_input, init) => {
    equal(new Headers(init?.headers).get('authorization'), 'Bearer user-jwt');
    return Promise.resolve(json({ code: '42501' }, 403));
  } });
  equal((await handler(request({ action: 'rpc', organizationId: ORG, rpcAction: 'getCapture', payload: { captureId: CAPTURE } }))).status, 403);
});
Deno.test('worker claim reaches only scoped RPC; empty queue stays null', async () => {
  const { handler, calls } = harness(call => { assert(call.url.endsWith('/rpc/meter_capture_claim_v1')); equal(call.auth, 'Bearer fixture-service-role'); return json(null); });
  const result = await handler(request({ workerId: 'cpu1' }, '/worker/claim', WORKER));
  equal(result.status, 200); equal(await result.json(), null); equal(calls[0].body, { p_worker_id: 'cpu1' });
});
Deno.test('user, worker and financial RPCs explicitly target public when REST defaults to api', async () => {
  const { handler, calls } = harness(call => {
    // TEST and production expose api first. A missing profile reaches a different
    // schema and returns PGRST202 before any business function can execute.
    if (call.profile !== 'public') return json({ code: 'PGRST202' }, 404);
    return json(null);
  });
  const requests = [
    request({ action: 'rpc', organizationId: ORG, rpcAction: 'catalog', payload: {} }),
    request({ action: 'rpc', organizationId: ORG, rpcAction: 'profile', payload: { meterId: CAPTURE } }),
    request({ action: 'invoice', organizationId: ORG, arguments: {}, sources: [] }),
    request({ action: 'exit', organizationId: ORG, rpcName: 'confirm_contract_return_v1', arguments: {}, sources: [] }),
    request({ workerId: 'cpu1' }, '/worker/claim', WORKER),
    request({ jobId: JOB, leaseToken: LEASE, result: {} }, '/worker/complete', WORKER),
  ];
  for (const input of requests) equal((await handler(input)).status, 200);
  equal(calls.map(call => call.url.split('/').pop()), [
    'meter_capture_v1', 'meter_capture_v1', 'meter_capture_invoice_v1',
    'meter_capture_exit_v1', 'meter_capture_claim_v1', 'meter_capture_complete_v1',
  ]);
  equal(calls.map(call => call.auth), [
    ...Array(4).fill('Bearer user-jwt'), ...Array(2).fill('Bearer fixture-service-role'),
  ]);
});
Deno.test('user operation never receives service role and arbitrary RPC/action rejected', async () => {
  const { handler, calls } = harness(call => { equal(call.auth, 'Bearer user-jwt'); assert(call.url.endsWith('/rpc/meter_capture_v1')); return json({ meters: [] }); });
  equal((await handler(request({ action: 'rpc', organizationId: ORG, rpcAction: 'catalog', payload: {} }))).status, 200);
  equal((await handler(request({ action: 'rpc', organizationId: ORG, rpcAction: 'meter_capture_claim_v1', payload: {} }))).status, 400);
  equal((await handler(request({ action: 'rpc', organizationId: ORG, rpcAction: 'finalizeCapture', payload: {} }))).status, 400);
  equal(calls.length, 1);
});
Deno.test('canonical startCapture and internal document evidence/receipt actions are forwarded', async () => {
  const { handler, calls } = harness(call => { equal(call.auth, 'Bearer user-jwt'); return json({}); });
  for (const rpcAction of ['startCapture', 'documentReceipt', 'documentEvidence']) {
    equal((await handler(request({ action: 'rpc', organizationId: ORG, rpcAction, payload: {} }))).status, 200);
  }
  equal(calls.map(call => (call.body as Record<string, unknown>).p_action), ['startCapture', 'documentReceipt', 'documentEvidence']);
});
Deno.test('unauthorized cross-org capture fails before service storage access', async () => {
  const { handler, calls } = harness(call => { equal(call.auth, 'Bearer user-jwt'); return json({ code: '42501' }, 403); });
  const result = await handler(request({ action: 'finalize', organizationId: ORG, captureId: CAPTURE }));
  equal(result.status, 403); equal(calls.length, 1);
});
Deno.test('finalized settlement correction is a business conflict, not an upstream outage', async () => {
  const { handler, calls } = harness(call => { equal(call.auth, 'Bearer user-jwt'); return json({ code: 'PT422' }, 422); });
  const result = await handler(request({ action: 'rpc', organizationId: ORG, rpcAction: 'confirmCapture', payload: { captureId: CAPTURE } }));
  equal(result.status, 422); equal(calls.length, 1);
  const body = await result.json(); equal(body.error, 'PT422');
});
Deno.test('finalize hashes persisted original then records service receipt and queues under user JWT', async () => {
  const data = await capture();
  const { handler, calls } = harness(call => {
    if (call.url.includes('/rpc/meter_capture_v1')) {
      equal(call.auth, 'Bearer user-jwt');
      const args = call.body as Record<string, unknown>;
      return args.p_action === 'getCapture' ? json({ capture: data }) : json({ capture: { ...data, status: 'QUEUED' } });
    }
    equal(call.auth, 'Bearer fixture-service-role');
    if (call.url.includes('/storage/')) return new Response(JPEG);
    assert(call.url.endsWith('/rpc/meter_capture_media_receipt_v1'));
    equal((call.body as Record<string, unknown>).p_duration_seconds, null);
    return json({ mediaReceived: true });
  });
  equal((await handler(request({ action: 'finalize', organizationId: ORG, captureId: CAPTURE }))).status, 200);
  equal(calls.length, 4);
  equal((calls[3].body as Record<string, unknown>).p_action, 'finalizeCapture');
});
Deno.test('tampered original digest or magic never records a receipt', async () => {
  for (const wrongMagic of [false, true]) {
    const data = await capture();
    if (wrongMagic) data.mimeType = 'image/png'; else data.sha256 = 'a'.repeat(64);
    const { handler, calls } = harness(call => call.url.includes('/rpc/') ? json({ capture: data }) : new Response(JPEG));
    equal((await handler(request({ action: 'finalize', organizationId: ORG, captureId: CAPTURE }))).status, 422);
    equal(calls.length, 2);
  }
});
Deno.test('pre-upload reconciliation reports only proven missing objects and never masks forbidden or outages', async () => {
  const data = await capture();
  for (const [status, code, expected] of [[404, '404', 200], [400, '404', 200], [403, '403', 502], [500, '500', 502], [400, '400', 502]]) {
    const { handler, calls } = harness(call => call.url.includes('/rpc/') ? json({ capture: data }) : json({ statusCode: code }, Number(status)));
    const result = await handler(request({ action: 'finalize', organizationId: ORG, captureId: CAPTURE, allowMissing: true }));
    equal(result.status, expected); equal(calls.length, 2);
    if (expected === 200) equal(await result.json(), { capture: null, needsUpload: true });
  }
});
Deno.test('stream byte ceiling enforced without content-length', async () => {
  let rejected = false;
  try { await digestStream(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close(); } })), 10); }
  catch { rejected = true; }
  assert(rejected);
});
Deno.test('worker cannot download different capture or supply external URL', async () => {
  const { handler, calls } = harness(() => json(context()));
  equal((await handler(request({ jobId: JOB, leaseToken: LEASE, mediaId: ORG, url: 'https://attacker.test' }, '/worker/media', WORKER))).status, 403);
  equal(calls.length, 1);
});
Deno.test('expired worker lease returns concurrency conflict before storage access', async () => {
  const { handler, calls } = harness(() => json({ code: 'PT409' }, 409));
  equal((await handler(request({ jobId: JOB, leaseToken: LEASE, mediaId: CAPTURE }, '/worker/media', WORKER))).status, 409);
  equal(calls.length, 1);
});
Deno.test('worker media streams authorized original only', async () => {
  const { handler, calls } = harness(call => call.url.includes('/rpc/') ? json(context()) : new Response(JPEG));
  const result = await handler(request({ jobId: JOB, leaseToken: LEASE, mediaId: CAPTURE }, '/worker/media', WORKER));
  equal([...new Uint8Array(await result.arrayBuffer())], [...JPEG]); equal(calls.length, 2);
  assert(calls[1].url.endsWith(ORIGINAL));
});
Deno.test('evidence uses content-derived immutable key and scoped receipt', async () => {
  const digest = (await digestStream(new Response(JPEG))).sha256;
  const { handler, calls } = harness(call => {
    if (call.url.endsWith('/rpc/meter_capture_worker_context_v1')) return json(context());
    return json({});
  });
  const result = await handler(request({ jobId: JOB, leaseToken: LEASE, timestampSeconds: 0, sha256: digest, dataBase64: btoa(String.fromCharCode(...JPEG)) }, '/worker/evidence', WORKER));
  equal(result.status, 200); equal(await result.json(), { objectKey: `${ORG}/meter-captures/${CAPTURE}/evidence/${digest}.jpg` });
  equal(calls.length, 3); assert(calls[2].url.endsWith('/rpc/meter_capture_evidence_receipt_v1'));
});
Deno.test('evidence signing uses user JWT after capture authorization', async () => {
  const { handler, calls } = harness(call => {
    equal(call.auth, 'Bearer user-jwt');
    return call.url.includes('/rpc/') ? json({ evidence: { captureId: CAPTURE, imageObjectKey: ORIGINAL, videoObjectKey: null, timestampSeconds: 0 } }) : json({ signedURL: '/object/sign/meter-capture-media/fixture?token=fixture' });
  });
  const result = await handler(request({ action: 'rpc', rpcAction: 'evidence', organizationId: ORG, payload: { captureId: CAPTURE } }));
  equal(result.status, 200); const data = await result.json(); assert(data.evidence.imageUrl.startsWith('https://database.test/storage/v1/object/sign/')); equal(data.evidence.videoUrl, null); equal(calls.length, 2);
});
Deno.test('listing 500 captures returns private references without fan-out signing requests', async () => {
  const captures = Array.from({ length: 500 }, (_, index) => ({ id: CAPTURE, mediaReceived: true, imageObjectKey: `${ORG}/meter-captures/${CAPTURE}/evidence/${index}.jpg`, videoObjectKey: ORIGINAL }));
  const { handler, calls } = harness(call => { equal(call.auth, 'Bearer user-jwt'); return json({ captures }); });
  const result = await handler(request({ action: 'rpc', rpcAction: 'listCaptures', organizationId: ORG, payload: {} }));
  equal(result.status, 200); equal(calls.length, 1);
  const data = await result.json(); equal(data.captures.length, 500);
  assert(data.captures[0].evidenceUrl.includes('/storage/v1/object/authenticated/meter-capture-media/'));
  assert(!data.captures[0].evidenceUrl.includes('token='));
  assert(!data.captures[0].videoUrl.includes('/public/'));
});
Deno.test('signing failure is visible instead of unsafe/public URL fallback', async () => {
  const { handler } = harness(call => call.url.includes('/rpc/') ? json({ evidence: { imageObjectKey: ORIGINAL } }) : json({ error: 'denied' }, 403));
  const result = await handler(request({ action: 'rpc', rpcAction: 'evidence', organizationId: ORG, payload: { captureId: CAPTURE } }));
  equal(result.status, 403); equal(await result.json(), { error: 'evidence_sign_failed' });
});

Deno.test('clip review and invoice evidence expose every timestamp as private references without eager signing', async () => {
  const frames = [0, 1, 2, 6, 7, 8].map(timestampSeconds => ({ timestampSeconds, objectKey: ORIGINAL }));
  const { handler, calls } = harness(call => {
    equal(call.auth, 'Bearer user-jwt');
    const args = call.body as Record<string, unknown>;
    return args.p_action === 'evidence'
      ? json({ evidence: { captureId: CAPTURE, imageObjectKey: null, videoObjectKey: null, evidenceFrames: frames } })
      : json({ capture: { id: CAPTURE, mediaReceived: true, imageObjectKey: null, videoObjectKey: null, evidenceFrames: frames } });
  });
  for (const rpcAction of ['getCapture', 'evidence']) {
    const result = await handler(request({ action: 'rpc', rpcAction, organizationId: ORG, payload: { captureId: CAPTURE } }));
    equal(result.status, 200); const data = await result.json();
    const actual = (data.capture ?? data.evidence).evidenceFrames;
    equal(actual.map((frame: { timestampSeconds: number }) => frame.timestampSeconds), [0, 1, 2, 6, 7, 8]);
    assert(actual.every((frame: { imageUrl: string }) => frame.imageUrl.includes('/object/authenticated/') && !frame.imageUrl.includes('token=')));
  }
  equal(calls.length, 2);
});

Deno.test('malformed frame metadata is rejected and pending uploads expose no frame references', async () => {
  for (const frames of [[{ timestampSeconds: -1, objectKey: ORIGINAL }], [{ timestampSeconds: 1, objectKey: '../other' }], Array(7).fill({ timestampSeconds: 1, objectKey: ORIGINAL })]) {
    const { handler } = harness(() => json({ capture: { mediaReceived: true, evidenceFrames: frames } }));
    const result = await handler(request({ action: 'rpc', rpcAction: 'getCapture', organizationId: ORG, payload: { captureId: CAPTURE } }));
    assert(result.status >= 400);
  }
  const { handler } = harness(() => json({ capture: { mediaReceived: false, evidenceFrames: [{ timestampSeconds: 1, objectKey: ORIGINAL }] } }));
  const result = await handler(request({ action: 'rpc', rpcAction: 'getCapture', organizationId: ORG, payload: { captureId: CAPTURE } }));
  equal((await result.json()).capture.evidenceFrames, []);
});
