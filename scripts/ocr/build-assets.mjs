import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifest = JSON.parse(
  await readFile(resolve(root, "vendor/cccd-ocr/manifest.json"), "utf8"),
);
const files = { ...manifest.files };
for (const [name, entry] of Object.entries(manifest.licenses)) {
  const bytes = await readFile(resolve(root, "scripts/ocr/licenses", name));
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
    throw Error(`OCR license verification failed: ${name}`);
}
for (const [name, entry] of Object.entries(files)) {
  const bytes = await readFile(resolve(root, "vendor/cccd-ocr", name));
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
    throw Error(`OCR source verification failed: ${name}`);
}
const runtime = resolve(root, "node_modules/onnxruntime-web");
if (
  JSON.parse(await readFile(resolve(runtime, "package.json"), "utf8"))
    .version !== "1.24.3"
)
  throw Error("Unexpected ONNX runtime version");
for (const name of [
  "ort.wasm.min.mjs",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]) {
  const data = await readFile(resolve(runtime, "dist", name));
  const expected = manifest.runtime.files[name];
  if (hash(data) !== expected.sha256 || data.length !== expected.bytes)
    throw Error(`OCR runtime verification failed: ${name}`);
  files[name] = expected;
}
const fingerprint = hash(
  JSON.stringify({
    files,
    licenses: manifest.licenses,
    script: hash(await readFile(fileURLToPath(import.meta.url))),
  }),
).slice(0, 16);
const directory = `/ocr-assets/${fingerprint}`,
  out = resolve(root, `public${directory}`);
await mkdir(out, { recursive: true });
for (const name of Object.keys(files))
  await copyFile(
    resolve(
      name.startsWith("ort") ? `${runtime}/dist` : `${root}/vendor/cccd-ocr`,
      name,
    ),
    resolve(out, name),
  );
for (const name of await readdir(resolve(root, "scripts/ocr/licenses")))
  await copyFile(
    resolve(root, "scripts/ocr/licenses", name),
    resolve(out, name),
  );
await writeFile(
  resolve(out, "manifest.json"),
  JSON.stringify({ ...manifest, files }, null, 2) + "\n",
);
await mkdir(resolve(root, "src/lib/ocr"), { recursive: true });
await writeFile(
  resolve(root, "src/lib/ocr/assets.json"),
  JSON.stringify({ directory, files }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    directory,
    verifiedFiles: Object.keys(files).length,
    bytes: Object.values(files).reduce((a, f) => a + f.bytes, 0),
  }),
);
// Only recognized generator outputs, within the resolved OCR asset root.
const assetRoot = resolve(root, "public/ocr-assets");
for (const entry of await readdir(assetRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
  const target = resolve(assetRoot, entry.name);
  if (target === out || !target.startsWith(assetRoot + sep)) continue;
  let previous;
  try {
    previous = JSON.parse(
      await readFile(resolve(target, "manifest.json"), "utf8"),
    );
  } catch {
    continue;
  }
  if (
    previous.schema === 1 &&
    previous.runtime?.package === "onnxruntime-web" &&
    previous.quantization?.calibration ===
      "12 fictional generated text lines; no customer images"
  )
    await rm(target, { recursive: true });
}
