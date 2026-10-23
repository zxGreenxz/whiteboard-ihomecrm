import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import QRCode from 'qrcode';
import { z } from 'zod';
import { loadMeterLiveFixture, METER_TEST_REF, METER_TEST_URL, type MeterLiveFixture } from '../support/meter-capture-live-fixture';
import { meterBillingSourceSchema } from '../../src/lib/meter-capture/types';
import { assertMonthlyInvoice, assertZeroMoveOut, financialSource, monthlyInvoiceRequest, zeroMoveOutRequest } from '../support/meter-capture-financial';
import { installMeterLiveBrowser } from '../support/meter-capture-live-browser';

/**
 * Live TEST smoke, not the synthetic gateway/component harness.
 * Prerequisites: reviewed TEST build/schema + meter-capture Edge gateway, private
 * storage, running TEST worker (FFmpeg/Paddle/Sol) and real TEST actor permissions.
 * FLEET_METER_LIVE=1, FLEET_METER_FIXTURE_MANIFEST (see support module),
 * TEST_SUPABASE_PUBLISHABLE_KEY, FLEET_METER_FFMPEG (pinned executable),
 * FLEET_PASS_TEST_CHU and a reviewed TEST loopback/preview build are required.
 * The fixture provisioner must supply a reviewed, hash-pinned verify/retire module;
 * no production/cloned real contract may be chosen ad hoc. Audit remains in TEST.
 * The dedicated fixture creates an unpaid monthly invoice, then finalizes a
 * zero-kWh MOVE_OUT through canonical writers. It never collects/refunds cash.
 */
test.use({ serviceWorkers: 'block' });
test.skip(process.env.FLEET_METER_LIVE !== '1', 'CHƯA KIỂM: opt in with a disposable TEST fixture and live meter worker.');

const exec = promisify(execFile);
const captureSchema = z.object({ id: z.string().uuid(), clientId: z.string().uuid(), orgId: z.string().uuid(), meterId: z.string().uuid(),
  status: z.string(), version: z.number(), mediaReceived: z.boolean(), mediaValidated: z.boolean(), sha256: z.string(),
  proposedValue: z.string().nullable(), confirmedReadingId: z.string().uuid().nullable(), previousValue: z.string().nullable(),
  aiResult: z.object({ value: z.string().nullable(), status: z.string() }).passthrough().nullable(),
  serverResult: z.object({ value: z.string().nullable(), status: z.string() }).passthrough().nullable(),
  evidenceFrames: z.array(z.object({ timestampSeconds: z.number(), imageUrl: z.string() })),
});
type Capture = z.infer<typeof captureSchema>;
const sourcesSchema = z.object({ meters: z.array(meterBillingSourceSchema) });

async function userHeaders(page: Page): Promise<Record<string, string>> {
  const key = process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
  if (!key) throw new Error('Missing TEST_SUPABASE_PUBLISHABLE_KEY.');
  const token = await page.evaluate((ref) => {
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    if (!raw) return null;
    const session: unknown = JSON.parse(raw);
    return session && typeof session === 'object' && 'access_token' in session && typeof session.access_token === 'string' ? session.access_token : null;
  }, METER_TEST_REF);
  if (!token) throw new Error('Missing real TEST user session after UI login.');
  return { authorization: `Bearer ${token}`, apikey: key };
}

async function syntheticClip(directory: string, fixture: MeterLiveFixture, tag: string): Promise<Buffer> {
  const binary = process.env.FLEET_METER_FFMPEG;
  if (!binary) throw new Error('Missing pinned FLEET_METER_FFMPEG executable.');
  await mkdir(directory,{recursive:true});
  const qr = join(directory, `${tag}-qr.png`), file = join(directory, `${tag}-synthetic.mp4`);
  await writeFile(qr, await QRCode.toBuffer(fixture.qrText, { width: 220, margin: 2 }));
  // All interpolated drawtext values are constrained by the manifest schema.
  const filter = `[0:v]drawbox=x=300:y=100:w=840:h=500:color=white:t=fill,drawbox=x=350:y=200:w=740:h=150:color=0xc6dfb7:t=fill,drawtext=text='${fixture.currentValue}':x=400:y=220:fontsize=100:fontcolor=black,drawtext=text='1.8.0  kWh':x=400:y=400:fontsize=48:fontcolor=black,drawtext=text='${fixture.serial}':x=350:y=500:fontsize=24:fontcolor=black,drawtext=text='SYNTHETIC ${tag}':x=350:y=550:fontsize=20:fontcolor=black[m];[m][1:v]overlay=40:220`;
  await exec(binary, ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=gray:s=1280x720:r=10:d=4','-i',qr,
    '-filter_complex',filter,'-an','-c:v','libx264','-pix_fmt','yuv420p','-t','4','-movflags','+faststart',file], { timeout: 30_000 });
  return readFile(file);
}

test('TEST: QR clip through real UI, worker evidence, invoice and zero-kWh settlement', async ({ page, request }, testInfo) => {
  test.setTimeout(35 * 60_000);
  const appOrigin=process.env.FLEET_BASE_URL??'';
  expect(appOrigin,'Only TEST loopback or the dedicated TEST preview is allowed').toMatch(/^http:\/\/127\.0\.0\.1:\d+$|^https:\/\/ihomecrm-git-test-env-[a-z0-9-]+\.vercel\.app$/);
  expect(process.env.FLEET_TARGET_ENV).toBe('TEST');
  const { fixture, lifecycle } = await loadMeterLiveFixture();
  expect(fixture.expectedBuildSha).toBe(process.env.EXPECTED_SOURCE_SHA);
  const created = { clientIds: [] as string[], captureIds: [] as string[] };
  const ui=await installMeterLiveBrowser(page,fixture,created,appOrigin);
  try {
    if (!process.env.FLEET_METER_FFMPEG || !process.env.TEST_SUPABASE_PUBLISHABLE_KEY) throw new Error('Missing TEST publishable key or pinned FFmpeg; no capture has been created.');
    const password=process.env.FLEET_PASS_TEST_CHU;if(!password)throw new Error('Missing private TEST actor password');
    const auth=await request.post(`${METER_TEST_URL}/auth/v1/token?grant_type=password`,{headers:{apikey:process.env.TEST_SUPABASE_PUBLISHABLE_KEY},data:{email:fixture.actorEmail,password},maxRedirects:0});
    expect(auth.status(),'Actual TEST Auth password login').toBe(200);
    const session=z.object({access_token:z.string(),expires_in:z.number(),refresh_token:z.string(),user:z.object({id:z.string(),email:z.string()}).passthrough()}).passthrough().parse(await auth.json());
    expect(session.user.id).toBe(fixture.actorId);expect(session.user.email).toBe(fixture.actorEmail);
    expect(JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString('utf8'))).toMatchObject({sub:fixture.actorId,role:'authenticated'});
    await page.addInitScript(({session,organization,ref})=>{
      localStorage.setItem(`sb-${ref}-auth-token`,JSON.stringify({...session,expires_at:Math.floor(Date.now()/1000)+session.expires_in}));
      localStorage.setItem('ihomecrm.selectedOrganizationId',organization);
    },{session,organization:fixture.organizationId,ref:METER_TEST_REF});
    await page.goto(`${appOrigin}/meter-readings`);
    await expect(page.getByRole('status', { name: 'Môi trường TEST' })).toBeVisible();
    await expect(page.locator('meta[name="build-sha"]')).toHaveAttribute('content', fixture.expectedBuildSha);
    const headers = await userHeaders(page);
    const financial=async(data:Record<string,unknown>)=>{
      const response=await request.post(`${METER_TEST_URL}/functions/v1/meter-capture-worker`,{headers,data,maxRedirects:0});
      if(!response.ok()){
        const code=z.object({code:z.string().optional(),error:z.string().optional()}).safeParse(await response.json().catch(()=>null));
        throw new Error(`TEST financial gateway returned HTTP ${response.status()} (${code.success?code.data.code??code.data.error??'unknown':'unknown'}).`);
      }return response.json() as Promise<unknown>;
    };
    const read=async(table:string,params:Record<string,string>)=>{
      const response=await request.get(`${METER_TEST_URL}/rest/v1/${table}`,{headers:{...headers,'Accept-Profile':'public'},params:{...params,organization_id:`eq.${fixture.organizationId}`},maxRedirects:0});
      expect(response.status(),`Actual TEST ${table} read`).toBe(200);return response.json() as Promise<unknown>;
    };
    const call = async (rpcAction: string, payload: Record<string, unknown>, organizationId = fixture.organizationId) => {
      const response = await request.post(`${METER_TEST_URL}/functions/v1/meter-capture-worker`, { headers, data: { action:'rpc',organizationId,rpcAction,payload } });
      if (!response.ok()) throw new Error(`Meter gateway ${rpcAction} returned HTTP ${response.status()}.`);
      return response.json() as Promise<unknown>;
    };
    const catalog = z.object({ meters: z.array(z.object({ id:z.string(),orgId:z.string(),buildingId:z.string(),roomId:z.string().nullable(),code:z.string(),qrText:z.string().nullable(),profile:z.object({serial:z.string(),registerCode:z.string(),decimalPlaces:z.number()}).nullable() })) }).parse(await call('catalog',{}));
    expect(catalog.meters.find(meter => meter.id === fixture.meterId)).toMatchObject({orgId:fixture.organizationId,buildingId:fixture.buildingId,roomId:fixture.roomId,code:fixture.meterCode,qrText:fixture.qrText,profile:{serial:fixture.serial,registerCode:fixture.registerCode,decimalPlaces:2}});
    const month = fixture.readingDate.slice(0,7);
    const resolve = async (purpose:'MONTHLY'|'MOVE_OUT') => sourcesSchema.parse(await call('resolveBilling',{contractId:fixture.contractId,month,readingDate:fixture.readingDate,purpose})).meters;
    const initial = await resolve('MONTHLY');
    expect(initial).toHaveLength(1);expect(initial[0].meterId).toBe(fixture.meterId);expect(Number(initial[0].start?.value)).toBe(Number(fixture.previousValue));expect(initial[0].end).toBeNull();
    const collect = async (purpose:'MONTHLY'|'MOVE_OUT',tag:string): Promise<Capture> => {
      const clip = await syntheticClip(testInfo.outputDir,fixture,tag), sha256=createHash('sha256').update(clip).digest('hex');
      let started:{capture:Capture;uploadPath:string};
      if(purpose==='MONTHLY'){
        const browserStarted=await ui.upload(clip,sha256);
        let uploaded:Capture|null=null;
        await expect.poll(async()=>{uploaded=z.object({capture:captureSchema}).parse(await call('getCapture',{captureId:browserStarted.capture.id})).capture;return uploaded.mediaReceived;},{timeout:90_000}).toBe(true);
        started={capture:z.object({capture:captureSchema}).parse(await call('getCapture',{captureId:browserStarted.capture.id})).capture,uploadPath:browserStarted.uploadPath};
      }else{
        const clientId=randomUUID();created.clientIds.push(clientId);
        started=z.object({capture:captureSchema,uploadPath:z.string()}).parse(await call('startCapture',{clientId,meterId:fixture.meterId,contractId:fixture.contractId,qrText:fixture.qrText,purpose,readingDate:fixture.readingDate,month,capturedAt:new Date().toISOString(),sha256,durationSeconds:4,mimeType:'video/mp4',sizeBytes:clip.length}));
        created.captureIds.push(started.capture.id);
        const upload=await request.post(`${METER_TEST_URL}/storage/v1/object/meter-capture-media/${started.uploadPath}`,{headers:{...headers,'content-type':'video/mp4','x-upsert':'false'},data:clip});expect(upload.ok()).toBe(true);
        const finalized=await request.post(`${METER_TEST_URL}/functions/v1/meter-capture-worker`,{headers,data:{action:'finalize',organizationId:fixture.organizationId,captureId:started.capture.id}});expect(finalized.ok()).toBe(true);
      }
      expect(started.uploadPath.startsWith(`${fixture.organizationId}/meter-captures/${started.capture.id}/`)).toBe(true);
      expect(await lifecycle.processCapture(fixture,started.capture.id)).toEqual({captureId:started.capture.id,completed:true});
      let capture=started.capture;
      await expect.poll(async()=>{capture=z.object({capture:captureSchema}).parse(await call('getCapture',{captureId:started.capture.id})).capture;return capture.status;},{timeout:6*60_000,intervals:[3000,5000,10000]}).toBe('REVIEW');
      expect(capture.mediaReceived).toBe(true);expect(capture.mediaValidated).toBe(true);expect(capture.sha256).toBe(sha256);
      expect(capture.aiResult?.status).toBe('ok');expect(Number(capture.aiResult?.value)).toBe(Number(fixture.currentValue));expect(capture.serverResult).not.toBeNull();
      expect(new Set(capture.evidenceFrames.map(frame=>frame.timestampSeconds)).size).toBeGreaterThanOrEqual(2);
      const denied=await request.post(`${METER_TEST_URL}/functions/v1/meter-capture-worker`,{headers,data:{action:'rpc',organizationId:randomUUID(),rpcAction:'evidence',payload:{captureId:capture.id}}});expect(denied.status()).toBe(403);
      const evidence=z.object({evidence:z.object({imageUrl:z.string(),videoUrl:z.string(),evidenceFrames:z.array(z.object({imageUrl:z.string(),timestampSeconds:z.number()}))})}).parse(await call('evidence',{captureId:capture.id})).evidence;
      for (const url of [evidence.imageUrl,evidence.videoUrl]) {expect(new URL(url).origin).toBe(METER_TEST_URL);expect((await request.get(url)).ok()).toBe(true);}
      const privateUrl=`${METER_TEST_URL}/storage/v1/object/authenticated/meter-capture-media/${started.uploadPath}`;
      expect((await request.get(privateUrl)).ok()).toBe(false);
      const payload=purpose==='MONTHLY'?await ui.confirm(capture,testInfo):{captureId:capture.id,expectedVersion:capture.version,expectedPreviousValue:capture.previousValue,value:fixture.currentValue,reason:`E2E synthetic ${tag}: exact rendered digits verified`};
      const confirmed=z.object({capture:captureSchema}).parse(await call(purpose==='MONTHLY'?'getCapture':'confirmCapture',purpose==='MONTHLY'?{captureId:capture.id}:payload)).capture;
      expect(confirmed.status).toBe('CONFIRMED');expect(confirmed.confirmedReadingId).not.toBeNull();
      const repeated=z.object({capture:captureSchema}).parse(await call('confirmCapture',payload)).capture;
      expect(repeated.confirmedReadingId).toBe(confirmed.confirmedReadingId);
      return confirmed;
    };
    const monthly=await collect('MONTHLY','monthly');
    const billed=(await resolve('MONTHLY'))[0];expect(Number(billed.start?.value)).toBe(Number(fixture.previousValue));expect(billed.end?.readingId).toBe(monthly.confirmedReadingId);expect(billed.end?.captureId).toBe(monthly.id);expect(billed.issues).toEqual([]);
    const invoiceRequest=monthlyInvoiceRequest(fixture,financialSource(fixture,billed,'MONTHLY'));
    const invoiceReceipt=z.object({invoice_id:z.string().uuid()}).parse(await financial(invoiceRequest));
    expect(z.object({invoice_id:z.string().uuid()}).parse(await financial(invoiceRequest)).invoice_id).toBe(invoiceReceipt.invoice_id);
    const invoices=z.array(z.unknown()).parse(await read('invoices',{select:'id,organization_id,contract_id,building_id,room_id,billing_month,kind,status,subtotal,total_amount,paid_amount',id:`eq.${invoiceReceipt.invoice_id}`}));expect(invoices).toHaveLength(1);
    const invoice=assertMonthlyInvoice(fixture,invoices[0]);
    const invoiceEvidence=z.object({sources:z.array(z.object({meterId:z.string(),endCaptureId:z.string().nullable(),previousReading:z.string(),currentReading:z.string()}))}).parse(await call('documentEvidence',{kind:'INVOICE',documentId:invoice.id}));
    expect(invoiceEvidence.sources).toHaveLength(1);expect(invoiceEvidence.sources[0]).toMatchObject({meterId:fixture.meterId,endCaptureId:monthly.id});expect(Number(invoiceEvidence.sources[0].previousReading)).toBe(100);expect(Number(invoiceEvidence.sources[0].currentReading)).toBe(120.25);
    const moveOut=await collect('MOVE_OUT','move-out');
    const exit=(await resolve('MOVE_OUT'))[0];expect(exit.end?.readingId).toBe(moveOut.confirmedReadingId);expect(exit.end?.captureId).toBe(moveOut.id);
    expect(exit.start?.readingId).toBe(monthly.confirmedReadingId);expect(Number(exit.start?.value)).toBe(120.25);expect(exit.issues).toEqual([]);
    expect(Number(moveOut.previousValue)).toBe(Number(fixture.currentValue));
    expect(Number(moveOut.proposedValue)-Number(moveOut.previousValue)).toBe(0);
    const contracts=z.array(z.object({id:z.string(),updated_at:z.string()})).parse(await read('contracts',{select:'id,updated_at',id:`eq.${fixture.contractId}`}));expect(contracts).toHaveLength(1);
    const exitRequest=zeroMoveOutRequest(fixture,financialSource(fixture,exit,'MOVE_OUT'),contracts[0].updated_at,invoice.total_amount);
    const finalizedExit=assertZeroMoveOut(fixture,await financial(exitRequest),invoice.total_amount);
    expect(assertZeroMoveOut(fixture,await financial(exitRequest),invoice.total_amount).id).toBe(finalizedExit.id);
    const exitEvidence=z.object({sources:z.array(z.object({meterId:z.string(),startCaptureId:z.string().nullable(),endCaptureId:z.string().nullable(),previousReading:z.string(),currentReading:z.string()}))}).parse(await call('documentEvidence',{kind:'EXIT',documentId:finalizedExit.id}));
    expect(exitEvidence.sources).toHaveLength(1);expect(exitEvidence.sources[0]).toMatchObject({meterId:fixture.meterId,startCaptureId:monthly.id,endCaptureId:moveOut.id});expect(Number(exitEvidence.sources[0].previousReading)).toBe(120.25);expect(Number(exitEvidence.sources[0].currentReading)).toBe(120.25);
    expect(z.array(z.unknown()).parse(await read('payments',{select:'id',invoice_id:`eq.${invoice.id}`}))).toEqual([]);
    expect(z.array(z.unknown()).parse(await read('income_expenses',{select:'id',contract_id:`eq.${fixture.contractId}`}))).toEqual([]);
    expect(z.array(z.unknown()).parse(await read('invoices',{select:'id',contract_id:`eq.${fixture.contractId}`}))).toHaveLength(1);
    await ui.showZeroMoveOut(moveOut,testInfo);
    expect(ui.writes).toEqual(expect.arrayContaining(['startCapture','storageUpload','finalize','confirmCapture']));
    await testInfo.attach('meter-live-observations',{body:JSON.stringify({fixtureId:fixture.fixtureId,projectRef:METER_TEST_REF,monthlyCaptureId:monthly.id,moveOutCaptureId:moveOut.id,monthlyThroughUi:true,uiWrites:ui.writes,zeroUsageCapture:true,invoiceId:invoice.id,exitId:finalizedExit.id,invoiceCreated:true,exitFinalized:true,noPayment:true}),contentType:'application/json'});
    expect(ui.blocked).toEqual([]);expect(ui.errors).toEqual([]);
  } finally {
    const retired=await lifecycle.retireFixture(fixture,created);
    expect(retired).toEqual({fixtureId:fixture.fixtureId,state:'RETIRED',retainedImmutableAudit:true});
  }
});
