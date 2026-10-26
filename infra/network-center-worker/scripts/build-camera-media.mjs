import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const upstream = "https://github.com/bluenviron/mediamtx.git";
const revision = "914e39535ece709919ac325aaeed98d394ed9093";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const patchPath = fileURLToPath(new URL("../media/playback-control.patch", import.meta.url));
const patch = await readFile(patchPath);
const patchSha256 = createHash("sha256").update(patch).digest("hex");
const cache = join(root, ".cache", "camera-media"); await mkdir(cache, { recursive: true });
const checkout = await mkdtemp(join(cache, "source-"));
const run = (binary, args, env = {}) => execFileSync(binary, args, { cwd: checkout, env: { ...process.env, GOTOOLCHAIN: "go1.27.0", ...env }, stdio: "inherit", timeout: 300_000 });
run("git", ["-c", "core.autocrlf=false", "clone", "--depth", "1", "--branch", "v1.21.2", upstream, "."]);
run("git", ["config", "core.autocrlf", "false"]);
const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
if (actual !== revision) throw new Error("CAMERA_MEDIA_UPSTREAM_CHANGED");
run("git", ["apply", "--check", patchPath]); run("git", ["apply", patchPath]);
// The upstream HLS generator verifies its own pinned archive hash; its asset is embedded even with HLS disabled.
run("go", ["generate", "./internal/core", "./internal/servers/hls"]);
if (process.argv.includes("--test")) {
  run("go", ["test", "-p", "2", ...(process.platform === "linux" ? ["-race"] : []), "./internal/staticsources/rtsp", "./internal/core", "./internal/stream", "./internal/protocols/rtsp", "-run", "^TestIHome", "-count=1"]);
} else {
  const output = fileURLToPath(new URL("../camera-dist/", import.meta.url)); await mkdir(output, { recursive: true });
  await writeFile(join(checkout, "internal/core/VERSION"), "v1.21.2-ihome-playback2\n");
  run("go", ["build", "-p", "2", "-trimpath", "-buildvcs=false", "-o", join(output, "mediamtx"), "."], { GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" });
  const binarySha256 = createHash("sha256").update(await readFile(join(output, "mediamtx"))).digest("hex");
  await writeFile(join(output, "mediamtx-LICENSE"), await readFile(join(checkout, "LICENSE")));
  await writeFile(join(output, "MEDIA-PROVENANCE.json"), JSON.stringify({ upstream, revision, patchSha256, toolchain: "go1.27.0", target: "linux/amd64", binarySha256 }, null, 2) + "\n");
  console.log(`Camera media artifact SHA256 ${binarySha256}`);
}
