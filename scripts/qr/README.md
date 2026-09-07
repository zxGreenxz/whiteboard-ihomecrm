# Local browser QR pipeline

`npm run qr:assets` creates self-hosted OpenCV assets from exact npm versions in
the lockfile. `prebuild` and `predev` run it automatically. Generated binaries live
under ignored `public/qr-assets/<transform hash>/`; the small generated
`src/lib/qr/assets.json` is committed so imports exist on a clean checkout. The
generator verifies both upstream artifact SHA-256 hashes and the model license,
extracts WASM to separate files, and emits a source/model/output hash and license
manifest beside the assets. Build transforms enter the URL fingerprint, avoiding
stale module contracts across deployments. There is no CDN fallback.

The two upstream Emscripten builds generate seven binding factories using dynamic
JavaScript. `csp-bindings.mjs` replaces those factories with ordinary closures,
only after exact source-hash verification. The Vitest suite compares original and
replacement behavior, including argument count, name/length, `this`, conversions,
void/method calls, destructor order and errors. The production CSP remains
unchanged; it permits WASM compilation, not arbitrary JavaScript evaluation.

```powershell
npx vitest run scripts/__tests__/qr-csp-bindings.test.mjs
npx vitest run src/lib/qr/__tests__ src/lib/__tests__/qrDecoder.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run gate:strict-islands
npm run build
node scripts/qr/verify-browser.mjs --output <report.json>
node scripts/qr/verify-browser.mjs --edge --output <report.json>
node scripts/qr/ablation.mjs --output <report.json>
```

The browser verifier serves the actual production module worker on loopback with
the exact `vercel.json` CSP and `bypassCSP: false`. It checks corner/seam/large,
rotated/perspective, tight crop, multiple distinct/duplicate QR payloads, real
WeChat bindings, grayscale byte equality, WASM MIME, offline warm operation and
asset-404 recovery. CPU is the sum of browser-owned process CPU time across the
suite; Windows memory snapshots are summed process private bytes/working sets,
not a mobile peak-RAM measurement. No account, database, customer image, payload
or external AI service is used by either committed benchmark.

The filter ablation splits three synthetic source cards into development (A) and
holdout (B/C) before generating any variants. Nearest 2× improved raw 3/5 to 5/5
development and 8/10 to 10/10 synthetic holdout. Smooth, threshold and unsharp did
not rescue anything additional to nearest; white border regressed one holdout
case. Only raw plus bounded nearest are enabled. Other isolated transforms remain
available for measurement; `tryDenoise` stays disabled. These synthetic results
are not customer-image accuracy estimates.

The heavy lane is lazy, used after raw ZXing misses in image/camera-deep mode.
Camera-fast never initializes OpenCV. Three DNN boxes at most receive the six
independent crop/scale transforms established by the development spike; all
successful boxes contribute distinct payload candidates. DNN preprocessing must
remain pixel-exact gray then cubic resize: moving resize before grayscale lost
two of the nine private development images. Row-strip `cvtColor` preserves those
bytes while bounding RGBA scratch memory. Only a single full-size 8-bit gray Mat
is retained for DNN, and transformed rasters are capped at four million pixels.

The caller's watchdog terminates the worker on abort or decode timeout. Lazy model
loading uses its own finite initialization deadline; it cannot reset the decode
clock repeatedly. A scan that runs out of time returns timeout, without claiming
incomplete candidates as a complete scan. Native detection remains available for
bitmap sources. Tile results aggregate before return and all coordinates map to
the original source image.

Android and physical Safari measurements remain required before broad rollout.
Private development learned cases take more than the original 350 ms camera-deep
budget on Windows; camera scheduling must use measured budgets and one active job.

The six-case fictional fixture benchmark is reproducible with:

```powershell
npm run qr:assets
node scripts/qr/benchmark.mjs --fixed
node scripts/qr/benchmark.mjs --baseline-ref 1d6523fb
node scripts/qr/benchmark.mjs --baseline --baseline-ref 1d6523fb
node scripts/qr/verify-benchmark.mjs
```

These commands require the Playwright Chromium browser installed locally
(`npx playwright install chromium`). The explicit verifier is separate from the
portable Vitest tests in `scripts/__tests__/qr-benchmark.test.mjs`.

The fixed lane uses a Vite ES-module build of the current shared scanner, its
emitted worker/chunks/WASM and self-hosted QR models, served on loopback under the
exact production CSP. It reuses one scanner across cases, with the image facade's
3000 ms decode budget and first-candidate interpretation, and disposes it at the
end. It retains structured engine-unavailable/timeout statuses instead of folding
them into a normal miss. A finite outer deadline also covers image/module loading.
Historical baseline refs must contain the old self-contained decoder; a worker-era
facade is rejected rather than resolved against the current source tree. Baseline
and fixed results remain labeled separately. JSONL rows contain no QR payloads.
Infrastructure failures exit 1; ordinary baseline accuracy misses stay in the rows.

Arguments and the baseline are validated before any fixture/browser allocation.
Fixtures, generated browser scratch and benchmark build files belong to one temp
directory, removed on success or setup failure. The explicit verifier covers both
CLI lanes, setup/cleanup failures and blocked worker loading with finite failure
rows. These synthetic checks do not establish private-corpus accuracy or physical
device performance.
