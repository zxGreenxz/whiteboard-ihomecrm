import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("../camera-dist/", import.meta.url);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/cameraLiveMain.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("cameraLiveMain.mjs", output)),
  bundle: true, platform: "node", target: "node22.23", format: "esm", sourcemap: false,
});
const digest = createHash("sha256").update(await readFile(new URL("cameraLiveMain.mjs", output))).digest("hex");
await writeFile(new URL("LIVE-SHA256SUMS", output), `${digest}  cameraLiveMain.mjs\n`);
console.log(`Camera live artifact SHA256 ${digest}`);
