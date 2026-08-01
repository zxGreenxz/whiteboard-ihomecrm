import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const EXPECTED_PROJECT_REF = "tryymsxyyckgbrmmvozx";
export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";

const SECRET_REPLACEMENTS = Object.freeze([
  {
    pattern: /\bsbp_[A-Za-z0-9_-]+\b/gi,
    replacement: "[REDACTED_TOKEN]",
  },
  {
    pattern: /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@[^\s]+/gi,
    replacement: "[REDACTED_DATABASE_URL]",
  },
  {
    pattern: /\b(authorization\s*:\s*(?:bearer|basic))\s+[^\s,;]+/gi,
    replacement: "$1 [REDACTED_TOKEN]",
  },
  {
    pattern:
      /["']?(claimToken|markerNonce|credentialHash|credentialProofSha256|SUPABASE_ACCESS_TOKEN|SUPABASE_PAT|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENCLAW_MODEL_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|API_KEY|access_token|refresh_token|service_role_key|password|set-cookie|cookie|imei|qrPayload|qrData|qrCode|qrToken)["']?\s*([:=])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/gi,
    replacement: "$1$2[REDACTED_SECRET]",
  },
  {
    pattern:
      /([?&](?:token|ticket|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&#\s]+/gi,
    replacement: "$1[REDACTED_SECRET]",
  },
  {
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{5,})?\b/g,
    replacement: "[REDACTED_JWT]",
  },
]);

export function redactSensitiveText(output, knownSecrets = []) {
  const exactRedacted = knownSecrets.reduce(
    (text, secret) =>
      secret ? text.replaceAll(String(secret), "[REDACTED_EXACT_SECRET]") : text,
    String(output ?? ""),
  );
  return SECRET_REPLACEMENTS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    exactRedacted,
  );
}

export function parseSqlHarnessArgs(args) {
  const modes = [
    args.includes("--local") && "local",
    args.includes("--live-demo") && "live-demo",
  ].filter(Boolean);
  if (modes.length === 0) {
    throw new Error("An explicit --local or --live-demo mode is required.");
  }
  if (modes.length !== 1) {
    throw new Error("Exactly one SQL harness mode may be selected.");
  }
  const allowed = new Set(["--local", "--live-demo"]);
  const unknown = args.filter((value) => !allowed.has(value));
  if (unknown.length > 0) throw new Error(`Unknown SQL harness argument: ${unknown[0]}`);
  return { mode: modes[0] };
}

export function assertLiveDemoTarget({ projectRef, organizationId, authorized }) {
  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new Error("Live DEMO project ref does not match the reviewed project.");
  }
  if (organizationId === PROD_ORG_ID) {
    throw new Error("PROD organization fixtures are forbidden.");
  }
  if (organizationId !== DEMO_ORG_ID) {
    throw new Error("Only the canonical DEMO organization is allowed.");
  }
  if (!authorized) {
    throw new Error("The authorized live-DEMO environment marker is required.");
  }
}

export function assertSafeHarnessOutput(output) {
  const text = String(output ?? "");
  if (redactSensitiveText(text) !== text) {
    throw new Error("Harness output may contain a secret and was suppressed.");
  }
  return text;
}

async function defaultTransport(request) {
  if (request.mode === "live-demo") {
    throw new Error(
      "Live DEMO transport is disabled until Task 29 supplies reviewed read/write credentials.",
    );
  }
  const { runDisposableSqlAuthorizationMatrix } = await import(
    "./test-openclaw-migrations.mjs"
  );
  return runDisposableSqlAuthorizationMatrix();
}

export async function runSqlHarness({
  args = process.argv.slice(2),
  environment = process.env,
  transport = defaultTransport,
} = {}) {
  const { mode } = parseSqlHarnessArgs(args);
  const organizationId =
    mode === "local"
      ? DEMO_ORG_ID
      : environment.OPENCLAW_DEMO_ORG_ID;
  if (organizationId === PROD_ORG_ID) {
    throw new Error("PROD organization fixtures are forbidden.");
  }
  if (mode === "live-demo") {
    assertLiveDemoTarget({
      projectRef: environment.OPENCLAW_PROJECT_REF,
      organizationId,
      authorized: environment.OPENCLAW_AUTHORIZED_LIVE_DEMO === "1",
    });
  }
  const result = await transport({
    mode,
    projectRef: mode === "live-demo" ? EXPECTED_PROJECT_REF : "local-disposable",
    organizationId,
    rollbackOnly: true,
  });
  const summary = assertSafeHarnessOutput(
    result?.summary ??
      `PASS OpenClaw SQL ${mode} rollback-only authorization matrix`,
  );
  return { mode, organizationId, rollbackOnly: true, summary };
}

async function main() {
  const result = await runSqlHarness();
  process.stdout.write(`${result.summary}\n`);
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    const message = redactSensitiveText(error?.message ?? error);
    console.error(message);
    process.exitCode = 1;
  });
}
