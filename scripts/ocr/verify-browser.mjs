import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, sep } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const root = process.cwd(),
  dist = resolve(root, "dist");
const config = JSON.parse(await readFile("vercel.json", "utf8"));
const csp = config.headers
  .flatMap((item) => item.headers)
  .find((item) => item.key === "Content-Security-Policy").value;
const worker = (await readdir(resolve(dist, "assets"))).find((name) =>
  /^ocr\.worker-.*\.js$/.test(name),
);
assert.ok(worker, "Build first");
const assets = JSON.parse(await readFile("src/lib/ocr/assets.json", "utf8"));
let failModel = false;
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", csp);
  const pathname = new URL(req.url, "http://localhost").pathname;
  requests.push(pathname);
  for (const rule of config.headers)
    if (new RegExp(`^${rule.source}$`).test(pathname))
      for (const header of rule.headers)
        res.setHeader(header.key, header.value);
  if (pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Fictional OCR validation</title>");
    return;
  }
  if (failModel && pathname.endsWith(".onnx")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const file = resolve(dist, "." + pathname);
  if (!file.startsWith(dist + sep)) {
    res.statusCode = 403;
    res.end();
    return;
  }
  try {
    res.setHeader(
      "Content-Type",
      extname(file) === ".wasm"
        ? "application/wasm"
        : extname(file) === ".json"
          ? "application/json"
          : extname(file) === ".ttf"
            ? "font/ttf"
            : [".js", ".mjs"].includes(extname(file))
              ? "text/javascript"
              : "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({ bypassCSP: false }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  const bootstrap = async ({ worker, assets }) => {
    const font = new FontFace(
      "Synthetic",
      `url(${assets.directory}/NotoSans.ttf)`,
    );
    await font.load();
    document.fonts.add(font);
    window.serial = 0;
    window.worker = new Worker("/assets/" + worker, { type: "module" });
    window.read = async (angle = 0, budgetMs = 30000) => {
      const source = new OffscreenCanvas(1400, 850),
        ctx = source.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1400, 850);
      ctx.fillStyle = "#111";
      const text = (str, y, size = 30) => {
        ctx.font = `${size}px Synthetic`;
        ctx.fillText(str, 400, y);
      };
      text("CĂN CƯỚC CÔNG DÂN", 100, 38);
      text("Số / No.: 001099999993", 190, 38);
      text("Họ và tên / Full name:", 255);
      text("ĐỖ THỊ THỬ", 305, 40);
      text("Ngày sinh / Date of birth: 29/02/2000", 375);
      text("Giới tính / Sex: Nữ", 440);
      text("Quê quán / Place of origin: Hà Nội", 505);
      text("Nơi thường trú / Place of residence:", 565);
      text("Số 27, Đường Thử Nghiệm,", 620);
      text("Phường Hòa Bình, Thành phố Hà Nội", 670);
      const rotated = new OffscreenCanvas(
          angle % 180 ? 850 : 1400,
          angle % 180 ? 1400 : 850,
        ),
        rc = rotated.getContext("2d");
      rc.translate(rotated.width / 2, rotated.height / 2);
      rc.rotate((angle * Math.PI) / 180);
      rc.drawImage(source, -700, -425);
      const image = rc.getImageData(0, 0, rotated.width, rotated.height),
        requestId = ++window.serial,
        start = performance.now();
      let loaded = 0;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.worker.terminate();
          reject(Error("OCR verification timeout"));
        }, 65000);
        window.worker.onerror = () => {
          clearTimeout(timeout);
          reject(Error("OCR worker crash"));
        };
        window.worker.onmessage = ({ data }) => {
          if (data.requestId !== requestId) return;
          if (data.type === "progress" && data.stage === "reading")
            loaded = performance.now() - start;
          if (data.type === "result") {
            clearTimeout(timeout);
            resolve({
              ...data.result,
              wallMs: performance.now() - start,
              initMs: loaded,
            });
          }
        };
        window.worker.postMessage(
          { type: "read", requestId, source: image, budgetMs },
          [image.data.buffer],
        );
      });
    };
  };
  await page.evaluate(bootstrap, { worker, assets });
  const rows = [];
  for (const angle of (process.argv.includes("--recovery-only") || process.argv.includes("--cancel-only"))
    ? []
    : [0, 90, 180, 270]) {
    const result = await page.evaluate((angle) => window.read(angle), angle);
    assert.equal(result.status, "review", `orientation ${angle} status`);
    const expected = {
      idNumber: "001099999993",
      fullName: "ĐỖ THỊ THỬ",
      dateOfBirth: "2000-02-29",
      gender: "Nữ",
      permanentAddress:
        "Số 27, Đường Thử Nghiệm, Phường Hòa Bình, Thành phố Hà Nội",
    };
    const matches = Object.fromEntries(
      Object.entries(expected).map(([key, value]) => [
        key,
        result.data[key] === value,
      ]),
    );
    rows.push({
      angle,
      wallMs: Math.round(result.wallMs),
      initMs: Math.round(result.initMs),
      matches,
    });
    assert.ok(
      Object.values(matches).every(Boolean),
      JSON.stringify({ angle, matches }),
    );
  }
  let offline = { status: "not-run" },
    timeout = { status: "not-run" };
  if (!process.argv.includes("--recovery-only") && !process.argv.includes("--cancel-only")) {
    await page.context().setOffline(true);
    offline = await page.evaluate(() => window.read());
    assert.equal(offline.data.idNumber, "001099999993");
    await page.context().setOffline(false);
    timeout = await page.evaluate(() => window.read(0, 1));
    assert.equal(timeout.status, "timeout");
  }
  let cancelHeavy=null;
  if(!process.argv.includes('--recovery-only')){
    cancelHeavy=await page.evaluate(()=>new Promise((resolve,reject)=>{
      const requestId=++window.serial,source=new ImageData(new Uint8ClampedArray(2000*2000*4).fill(255),2000,2000);
      const watchdog=setTimeout(()=>{window.worker.terminate();reject(Error('Cancel probe did not reach reading'));},30000);
      window.worker.onmessage=({data})=>{
        if(data.requestId!==requestId)return;
        if(data.type==='result'){clearTimeout(watchdog);reject(Error('Heavy request completed before cancel'));}
        if(data.type==='progress'&&data.stage==='reading'){
          const started=performance.now();setTimeout(()=>{clearTimeout(watchdog);window.worker.terminate();resolve({reachedReading:true,cancelMs:Math.round(performance.now()-started)});},40);
        }
      };
      window.worker.postMessage({type:'read',requestId,source,budgetMs:30000},[source.data.buffer]);
    }));
    assert.equal(cancelHeavy.reachedReading,true);assert.ok(cancelHeavy.cancelMs<1000);
  }
  await page.evaluate(() => window.worker.terminate());
  const recovery = await browser.newPage({ bypassCSP: false });
  await recovery.goto(origin);
  await recovery.evaluate(bootstrap, { worker, assets });
  failModel = true;
  const failure = await recovery.evaluate(() => window.read());
  assert.equal(failure.status, "engine-unavailable");
  failModel = false;
  const retry = await recovery.evaluate(() => window.read());
  assert.equal(
    retry.status,
    "review",
    JSON.stringify({
      status: retry.status,
      wallMs: retry.wallMs,
      initMs: retry.initMs,
      modelRequests: requests.filter((p) => p.endsWith(".onnx")).length,
    }),
  );
  assert.equal(retry.data.idNumber, "001099999993");
  await recovery.close();
  for (const pathname of [
    ...new Set(requests.filter((p) => p.endsWith(".wasm"))),
  ])
    assert.equal(
      (await page.request.get(origin + pathname)).headers()["content-type"],
      "application/wasm",
    );
  assert.deepEqual(errors, []);
  const existing = await page.request.get(
    origin + assets.directory + "/vocab.json",
  );
  assert.equal(
    existing.headers()["cache-control"],
    "public, max-age=31536000, immutable",
  );
  const missing = await page.request.get(
    origin + assets.directory + "/missing.onnx",
  );
  assert.equal(missing.status(), 404);
  assert.ok(
    !config.rewrites.some((rule) =>
      new RegExp(`^${rule.source}$`).test(assets.directory + "/missing.onnx"),
    ),
    "Missing model must bypass SPA rewrite",
  );
  console.log(
    JSON.stringify({
      bypassCSP: false,
      worker,
      rows,
      offlineWarm: offline.status,
      timeout: timeout.status,
      model404: failure.status,
      retry: retry.status,
      uniqueAssetRequests: new Set(requests).size,
      errors,
      cancelHeavy,
    }),
  );
} finally {
  await browser.close();
  server.close();
}
