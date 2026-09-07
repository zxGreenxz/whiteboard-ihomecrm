# Local CCCD OCR

The still-image owner tries QR first and invokes this worker only after QR is
exhausted. It terminates its QR worker before loading OCR: separate workers do
not share the 256 MiB OpenCV heap. Replacing/removing the image, opening another
scan, applying the preview, or unmounting releases OCR. The worker can serve warm
reads while owned, and its HTTP assets are immutable/hash-named for later scans.
Camera integration must pass one explicitly captured original frame through the
same file owner; never schedule OCR on every video frame.

Only the dedicated module worker decodes pixels and runs inference. The client
has a 60 second cold initialization watchdog and a separate 30 second reading
watchdog (configurable). Abort and timeout terminate synchronous WASM work too.
The worker checks deadlines between inference steps, limits 20 MiB input, 24 MP
decoded raster, 128 detected lines, 1000 contours and 96 decoder tokens per line.
White alpha composition is identical for Blob and transferred ImageData inputs.
No network request contains an image, recognized text, identifier or telemetry.
Only same-origin static assets are fetched. Browser model scores are uncalibrated;
the UI shows editable readable/check/missing states, never identity accuracy.

`npm run ocr:assets` verifies every committed model/font and pinned runtime hash
before copying to ignored `public/ocr-assets/<hash>/`. `prebuild`/`predev` run both
QR and OCR preparation. Python is not needed for installs/builds or production.
`vendor/cccd-ocr/manifest.json` records sources, original/derived SHA-256, sizes,
license declarations and exact quantization versions. Model cards and license
texts ship beside the models. Vemines is a community MIT distribution of the
Apache-2.0 VietOCR project; this does not assert official identity authentication.

To reproduce weights, create an isolated Python environment outside this repo:

```text
pip install onnx==1.22.0 onnxruntime==1.29.0 Pillow==12.3.0 numpy==2.5.3
python scripts/ocr/prepare-public.py <external-model-directory>
python scripts/ocr/quantize.py <external-model-directory>
```

Preparation downloads only revision-pinned public model/font sources and checks
their bytes. Quantization verifies source hashes/versions and regenerates twelve
fictional text lines, then verifies both derived output hashes. The 113 MB external
encoder source is deliberately never stored in this repository. Commit only the
verified derived files already listed in the manifest. Changes in model training,
quantization, dictionary or licenses require new evidence and asset hashes.

```text
npx vitest run src/lib/ocr/__tests__ src/components/customers/__tests__/CCCDQrUpload.test.tsx
npx tsc --noEmit -p tsconfig.strict-islands.json
npm run build
node scripts/ocr/verify-browser.mjs
```

The verifier serves the real production module worker using the exact Vercel CSP
with `bypassCSP:false`. It uses a generated fictional accented card, checks all
five fields at four right-angle orientations, warm offline operation, model404
retry, MIME and a processing deadline. Private corpus and authenticated DEMO form
verification are performed by the task controller in RAM, never by committed
fixtures or calibration. Physical mobile memory/performance remains a separate
release measurement; desktop localhost timings exclude public-network download.
