#!/usr/bin/env node
// Deploy CHỈ các Edge function của OpenClaw.
//
// Tách khỏi scripts/deploy-edge-fn.mjs khi gộp origin/main: hai file cùng tên
// hàm deployEdgeFunction nhưng là HAI CÔNG CỤ khác nhau — bản kia deploy đúng một
// slug network-center-worker theo manifest có SHA và ghi biên nhận. Nhét chung một
// file thì phải đổi tên hàm, có hai hàm main(), và người đọc sau phải đoán lệnh nào
// thuộc công cụ nào.
//
// Chính sách JWT của hai bên KHÔNG mâu thuẫn, chỉ trùng tên: bản kia cho phép
// --no-verify-jwt riêng slug network-center-worker; bản này ghim verifyJwt từng slug
// ngay trong OPENCLAW_EDGE_FUNCTIONS bên dưới và TỪ CHỐI cờ CLI nào mâu thuẫn với
// giá trị đã ghim. Giữ nguyên cả hai, mỗi cái gác phần của mình.
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OPENCLAW_EDGE_FUNCTIONS = Object.freeze({
  "openclaw-control": Object.freeze({ verifyJwt: true }),
  "openclaw-qr": Object.freeze({ verifyJwt: true }),
  "openclaw-object-tickets": Object.freeze({ verifyJwt: true }),
  "openclaw-runtime-token": Object.freeze({ verifyJwt: false }),
  "openclaw-runtime": Object.freeze({ verifyJwt: false }),
});

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACCESS_TOKEN_PATTERN = /^sbp_[A-Za-z0-9_-]{8,}$/;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function redactSensitiveText(value, knownSecrets = []) {
  let result = String(value ?? "");
  for (const secret of knownSecrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED_SECRET]");
  }
  return result
    .replace(/\bsbp_[A-Za-z0-9_-]+\b/gi, "[REDACTED_PAT]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, "[REDACTED_JWT]");
}

export function parseDeployArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || !SLUG_PATTERN.test(args[0])) {
    throw new Error(
      "Usage: deploy-edge-fn.mjs <slug> [--no-verify-jwt] [--include-shared openclaw]",
    );
  }
  const slug = args[0];
  let includeShared;
  let noVerifyJwt = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-verify-jwt") {
      if (noVerifyJwt) throw new Error("Duplicate --no-verify-jwt flag.");
      noVerifyJwt = true;
      continue;
    }
    if (argument === "--include-shared") {
      if (includeShared !== undefined || index + 1 >= args.length) {
        throw new Error("Invalid --include-shared argument.");
      }
      includeShared = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown deploy argument: ${argument}`);
  }

  if (includeShared !== undefined) {
    if (includeShared !== "openclaw") {
      throw new Error("Only --include-shared openclaw is supported.");
    }
    const settings = OPENCLAW_EDGE_FUNCTIONS[slug];
    if (!settings) throw new Error("Slug is not an OpenClaw entrypoint.");
    if (noVerifyJwt && settings.verifyJwt) {
      throw new Error("CLI JWT mode conflicts with the version-controlled OpenClaw JWT mode.");
    }
    return { slug, includeShared };
  }

  return { slug, verifyJwt: !noVerifyJwt };
}

async function collectFiles(directory) {
  const result = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
      const path = join(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Symbolic links are forbidden in Edge bundles: ${path}`);
      }
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) result.push(path);
      else throw new Error(`Unsupported Edge bundle entry: ${path}`);
    }
  }
  await walk(directory);
  return result;
}

function prepareOpenClawBundleFiles(root, sourcePaths) {
  return sourcePaths.flatMap((sourcePath) => {
    const bundlePath = relative(root, sourcePath).replace(/\\/g, "/");
    const segments = bundlePath.split("/");
    if (segments.some((segment) => segment.startsWith("."))) {
      throw new Error(`Sensitive dotfiles are forbidden in OpenClaw Edge bundles: ${bundlePath}`);
    }
    if (
      segments.includes("__tests__") ||
      bundlePath.endsWith(".test.ts") ||
      bundlePath.endsWith(".spec.ts")
    ) {
      return [];
    }
    if (!bundlePath.endsWith(".ts")) {
      throw new Error(`Unsupported OpenClaw Edge bundle source: ${bundlePath}`);
    }
    return [{ path: bundlePath, sourcePath }];
  });
}

export async function buildEdgeFunctionBundle({
  functionsRoot,
  slug,
  includeShared,
  verifyJwt,
}) {
  if (!SLUG_PATTERN.test(slug)) throw new Error("Unsafe Edge function slug.");
  const root = resolve(functionsRoot);
  const functionRoot = join(root, slug);
  const sharedMode = includeShared !== undefined;
  let resolvedVerifyJwt = verifyJwt;
  let entrypointPath = "index.ts";
  let files;

  if (sharedMode) {
    if (includeShared !== "openclaw") {
      throw new Error("Only the OpenClaw shared bundle is supported.");
    }
    const settings = OPENCLAW_EDGE_FUNCTIONS[slug];
    if (!settings) throw new Error("Slug is not an OpenClaw entrypoint.");
    resolvedVerifyJwt = settings.verifyJwt;
    entrypointPath = `${slug}/index.ts`;
    files = prepareOpenClawBundleFiles(root, [
      ...await collectFiles(join(root, "_shared", "openclaw")),
      ...await collectFiles(functionRoot),
    ]);
  } else {
    if (typeof resolvedVerifyJwt !== "boolean") {
      throw new Error("Legacy Edge deployment requires an explicit JWT mode.");
    }
    files = (await collectFiles(functionRoot)).map((path) => ({
      path: relative(functionRoot, path).replace(/\\/g, "/"),
      sourcePath: path,
    }));
  }

  files.sort((left, right) => compareUtf8(left.path, right.path));
  if (!files.some((file) => file.path === entrypointPath)) {
    throw new Error(`Edge entrypoint is missing: ${entrypointPath}`);
  }
  return {
    metadata: {
      name: slug,
      entrypoint_path: entrypointPath,
      verify_jwt: resolvedVerifyJwt,
    },
    files: await Promise.all(files.map(async (file) => ({
      path: file.path,
      bytes: new Uint8Array(await readFile(file.sourcePath)),
    }))),
  };
}

export async function deployEdgeFunction({
  bundle,
  projectRef,
  accessToken,
  fetchImpl = fetch,
}) {
  if (!PROJECT_REF_PATTERN.test(projectRef)) throw new Error("Invalid Supabase project ref.");
  if (!ACCESS_TOKEN_PATTERN.test(accessToken)) throw new Error("Invalid Supabase access token.");

  const form = new FormData();
  form.append("metadata", JSON.stringify(bundle.metadata));
  for (const file of bundle.files) {
    form.append(
      "file",
      new Blob([file.bytes], { type: "application/typescript" }),
      file.path,
    );
  }
  const response = await fetchImpl(
    `https://api.supabase.com/v1/projects/${projectRef}/functions/deploy?slug=${encodeURIComponent(bundle.metadata.name)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    },
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Deploy failed (${response.status}): ${redactSensitiveText(responseText, [accessToken])}`,
    );
  }
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error("Supabase deployment response was not JSON.");
  }
  return result;
}

async function loadDeploymentInputs(repositoryRoot) {
  const localInstructions = await readFile(join(repositoryRoot, "CLAUDE.local.md"), "utf8");
  const accessToken = localInstructions.match(/\bsbp_[A-Za-z0-9_-]+\b/)?.[0];
  if (!accessToken) throw new Error("Supabase access token is unavailable.");
  const configToml = await readFile(join(repositoryRoot, "supabase", "config.toml"), "utf8");
  const projectRef = configToml.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!projectRef) throw new Error("Supabase project ref is unavailable.");
  return { accessToken, projectRef };
}

async function main() {
  const options = parseDeployArgs(process.argv.slice(2));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const functionsRoot = join(repositoryRoot, "supabase", "functions");
  const inputs = await loadDeploymentInputs(repositoryRoot);
  const bundle = await buildEdgeFunctionBundle({
    functionsRoot,
    slug: options.slug,
    includeShared: options.includeShared,
    verifyJwt: options.verifyJwt,
  });
  const info = await deployEdgeFunction({ bundle, ...inputs });
  process.stdout.write(
    `Deployed "${String(info.name ?? basename(bundle.metadata.name))}" ` +
      `(slug=${String(info.slug ?? bundle.metadata.name)}) ` +
      `version=${String(info.version ?? "unknown")} ` +
      `verify_jwt=${String(info.verify_jwt ?? bundle.metadata.verify_jwt)}\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(redactSensitiveText(error?.message ?? error));
    process.exitCode = 1;
  });
}
