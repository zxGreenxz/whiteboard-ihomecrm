import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overlayNames = [
  "authorize-client.ts",
  "behavior-contract.ts",
  "canonical-send.ts",
  "control-traffic.ts",
  "egress-agent.ts",
  "inbound-listener.ts",
  "outbound-rpc.ts",
  "protocol.ts",
  "runtime-bootstrap.ts",
  "send-context.ts",
];
const rootOverlayNames = ["behavior-contract-api.ts"];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

async function loadPrepareScript() {
  return import("../scripts/prepare.mjs");
}

function makeOverlayFixture() {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-overlay-source-"));
  temporaryRoots.push(fixtureRoot);
  const bridgeRoot = resolve(fixtureRoot, "src/bridge");
  mkdirSync(bridgeRoot, { recursive: true });
  for (const name of overlayNames) {
    copyFileSync(resolve(vendorRoot, "src/bridge", name), resolve(bridgeRoot, name));
  }
  for (const name of rootOverlayNames) {
    copyFileSync(resolve(vendorRoot, name), resolve(fixtureRoot, name));
  }
  return fixtureRoot;
}

describe("prepared bridge overlay", () => {
  it("copies every runtime bridge source with deterministic membership", async () => {
    const { copyOverlay } = await loadPrepareScript();
    const firstPreparedRoot = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-overlay-a-"));
    const secondPreparedRoot = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-overlay-b-"));
    temporaryRoots.push(firstPreparedRoot, secondPreparedRoot);

    copyOverlay(vendorRoot, firstPreparedRoot);
    copyOverlay(vendorRoot, secondPreparedRoot);

    expect(readdirSync(resolve(firstPreparedRoot, "src/bridge")).sort()).toEqual(overlayNames);
    expect(readdirSync(resolve(secondPreparedRoot, "src/bridge")).sort()).toEqual(overlayNames);
    for (const name of overlayNames) {
      expect(readFileSync(resolve(firstPreparedRoot, "src/bridge", name))).toEqual(
        readFileSync(resolve(secondPreparedRoot, "src/bridge", name)),
      );
      expect(readFileSync(resolve(firstPreparedRoot, "src/bridge", name))).toEqual(
        readFileSync(resolve(vendorRoot, "src/bridge", name)),
      );
    }
    for (const name of rootOverlayNames) {
      expect(readFileSync(resolve(firstPreparedRoot, name))).toEqual(
        readFileSync(resolve(vendorRoot, name)),
      );
      expect(readFileSync(resolve(secondPreparedRoot, name))).toEqual(
        readFileSync(resolve(vendorRoot, name)),
      );
    }
  });

  it("fails closed when a required bridge overlay source is missing", async () => {
    const { copyOverlay } = await loadPrepareScript();
    const fixtureRoot = makeOverlayFixture();
    rmSync(resolve(fixtureRoot, "src/bridge/canonical-send.ts"));
    const preparedRoot = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-overlay-missing-"));
    temporaryRoots.push(preparedRoot);

    expect(() => copyOverlay(fixtureRoot, preparedRoot)).toThrow(/canonical-send\.ts|ENOENT/);
  });

  it("fails closed when the installed behavior contract entrypoint is missing", async () => {
    const { copyOverlay } = await loadPrepareScript();
    const fixtureRoot = makeOverlayFixture();
    rmSync(resolve(fixtureRoot, "behavior-contract-api.ts"));
    const preparedRoot = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-overlay-missing-contract-"));
    temporaryRoots.push(preparedRoot);

    expect(() => copyOverlay(fixtureRoot, preparedRoot)).toThrow(/behavior-contract-api\.ts|ENOENT/);
  });
});
