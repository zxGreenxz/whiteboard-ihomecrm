import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import QRCode from 'qrcode';

const root = process.cwd();
const dist = resolve(root, 'dist');
const scratch = await mkdtemp(resolve(tmpdir(), 'ihomecrm-fictional-camera-'));
const videoPath = resolve(scratch, 'fictional-cccd.y4m');
const width = 640;
const height = 480;
const payload = '001099999991||NGUYỄN THỬ MỘT|01011990|Nam|Địa chỉ giả A|01012024';

function fakeVideo() {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules;
  const scale = 6;
  const quiet = 4;
  const rendered = (qr.size + quiet * 2) * scale;
  const left = Math.floor((width - rendered) / 2);
  const top = Math.floor((height - rendered) / 2);
  const y = Buffer.alloc(width * height, 235);
  for (let row = 0; row < qr.size; row += 1) {
    for (let column = 0; column < qr.size; column += 1) {
      if (!qr.data[row * qr.size + column]) continue;
      for (let py = 0; py < scale; py += 1) for (let px = 0; px < scale; px += 1) {
        y[(top + (row + quiet) * scale + py) * width + left + (column + quiet) * scale + px] = 16;
      }
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma, chroma]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`), ...Array.from({ length: 45 }, () => frame)]);
}

await writeFile(videoPath, fakeVideo());
const workerName = (await readdir(resolve(dist, 'assets'))).find((name) => /^qr\.worker-.*\.js$/.test(name));
assert.ok(workerName, 'Run npm run build before the camera verifier');
const config = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'));
const csp = config.headers.flatMap((item) => item.headers).find((item) => item.key === 'Content-Security-Policy').value;
const server = createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', csp);
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Fictional camera frame verification</title>');
    return;
  }
  const file = resolve(dist, `.${pathname}`);
  if (!file.startsWith(`${dist}${sep}`)) { response.statusCode = 403; response.end(); return; }
  try {
    response.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript');
    response.end(await readFile(file));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${videoPath}`,
  ],
});

try {
  const context = await browser.newContext({ permissions: ['camera'], baseURL: origin, bypassCSP: false });
  const page = await context.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async ({ workerUrl, expected }) => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => {
      if (video.readyState >= 2 && video.currentTime > 0) { resolve(undefined); return; }
      video.addEventListener('timeupdate', () => resolve(undefined), { once: true });
    });
    const bitmap = await createImageBitmap(video);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const drawing = canvas.getContext('2d');
    drawing.drawImage(bitmap, 0, 0);
    const pixels = drawing.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let minimum = 255;
    let maximum = 0;
    for (let index = 0; index < pixels.length; index += 64) {
      minimum = Math.min(minimum, pixels[index]);
      maximum = Math.max(maximum, pixels[index]);
    }
    const worker = new Worker(workerUrl, { type: 'module' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('QR worker ready timeout')), 8000);
      worker.onmessage = (event) => { if (event.data.type === 'ready') { clearTimeout(timeout); resolve(undefined); } };
      worker.onerror = () => reject(new Error('QR worker failed'));
    });
    const started = performance.now();
    const scan = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('camera-deep scan timeout')), 4000);
      worker.onmessage = (event) => {
        if (event.data.type === 'result' && event.data.requestId === 1) { clearTimeout(timeout); resolve(event.data.result); }
      };
      worker.postMessage({ type: 'scan', requestId: 1, source: bitmap, mode: 'camera-deep', budgetMs: 1500 }, [bitmap]);
    });
    const wallMs = performance.now() - started;
    worker.terminate();
    stream.getTracks().forEach((track) => track.stop());
    return { width: video.videoWidth, height: video.videoHeight, contrast: maximum - minimum, wallMs, scan, matched: scan.candidates?.some((candidate) => candidate.text === expected) ?? false };
  }, { workerUrl: `/assets/${workerName}`, expected: payload });
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.ok(result.contrast > 150, 'fake camera must deliver the fictional QR raster, not a blank frame');
  assert.equal(result.scan.status, 'decoded');
  assert.equal(result.matched, true);
  assert.ok(result.scan.elapsedMs <= 1500, `camera-deep elapsed ${result.scan.elapsedMs}ms exceeded its budget`);
  console.log(JSON.stringify({ browser: 'chrome', source: 'fictional-y4m', mode: 'camera-deep', budgetMs: 1500, ...result }));
  await context.close();
} finally {
  await browser.close();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
