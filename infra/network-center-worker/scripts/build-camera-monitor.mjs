import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// esbuild is pinned by the repository's root lockfile. The artifact has no external packages.
const output = new URL("../camera-dist/", import.meta.url);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/cameraMain.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("cameraMain.mjs", output)),
  bundle: true, platform: "node", target: "node22.23", format: "esm", sourcemap: false,
});
const digest = createHash("sha256").update(await readFile(new URL("cameraMain.mjs", output))).digest("hex");
await writeFile(new URL("SHA256SUMS", output), `${digest}  cameraMain.mjs\n`);
console.log(`Camera monitor artifact SHA256 ${digest}`);
