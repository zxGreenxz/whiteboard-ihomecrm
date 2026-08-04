import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareHostBaselines,
  FINDING,
  FORBIDDEN_HOST_MARKERS,
  rootFreeKib,
} from "../../infra/openclaw-zalo/scripts/openclaw-host-baseline-diff.mjs";

/**
 * Proves the recovery-drill comparison actually refuses the deltas it claims to.
 *
 * It runs entirely on a checked-in redacted fixture. No SSH, no Docker socket, no
 * production service - which is the only reason it can run at all here, and also
 * the property Task 28 requires of it: the drill code must be provable without
 * touching the host it is about to inspect.
 *
 * The fixture is deliberately a PASSING pair. Every test below damages a copy of
 * it in one specific way, so a finding that fires is caused by that one change and
 * not by a fixture that never verified in the first place.
 */

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  "../../infra/openclaw-zalo/test/fixtures/host-baseline.redacted.json",
);

const clone = () => JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/** The one call every test makes: an unchanged host must produce no findings. */
function compareWith(mutate) {
  const before = clone();
  const after = clone();
  mutate?.(after, before);
  return compareHostBaselines(before, after);
}

function kinds(result) {
  return result.findings.map(finding => finding.kind);
}

describe("dedicated-host baseline comparison", () => {
  it("passes an unchanged host", () => {
    // If this ever fails the rest of the file proves nothing: every negative test
    // below assumes the baseline verifies before it is damaged.
    const result = compareWith();
    expect(result.findings, JSON.stringify(result.findings, null, 1)).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it("catches a container that was recreated even though its image is identical", () => {
    // The failure this exists for: a restart loop replaces the container, the Id
    // changes, the image does not, and a side-by-side read sees two matching lines.
    const result = compareWith(after => {
      after.containers[0].Id = "9".repeat(64);
    });
    expect(kinds(result)).toContain(FINDING.CONTAINER_ID);
  });

  it("catches image, network, mount and port drift separately", () => {
    // Reported separately because they mean different things: a changed mount is a
    // data-path question, a changed port is an exposure question.
    expect(kinds(compareWith(after => { after.containers[0].Image = "sha256:deadbeef"; })))
      .toContain(FINDING.IMAGE);
    expect(kinds(compareWith(after => {
      after.containers[0].Networks = { other: { IPAddress: "10.0.0.9" } };
    }))).toContain(FINDING.NETWORK);
    expect(kinds(compareWith(after => {
      after.containers[0].Mounts.push({
        Type: "bind", Source: "/etc", Destination: "/host-etc", RW: true,
      });
    }))).toContain(FINDING.MOUNT);
    expect(kinds(compareWith(after => {
      after.containers[0].Ports = { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] };
    }))).toContain(FINDING.PORTS);
  });

  it("catches a restart that happened during the drill", () => {
    expect(kinds(compareWith(after => { after.containers[0].RestartCount = 2; })))
      .toContain(FINDING.RESTART);
  });

  it("does not complain when a restart count goes DOWN", () => {
    // Counters reset when a container is recreated. That recreation is already
    // reported as CONTAINER_ID; reporting it twice under a wrong name would send
    // the reader looking for a restart that did not happen.
    const result = compareWith(after => {
      after.containers[0].Id = "9".repeat(64);
      after.containers[0].RestartCount = 0;
    });
    expect(kinds(result)).toContain(FINDING.CONTAINER_ID);
    expect(kinds(result)).not.toContain(FINDING.RESTART);
  });

  it("catches an unexpected container appearing or disappearing", () => {
    expect(kinds(compareWith(after => { after.containers.pop(); })))
      .toEqual(expect.arrayContaining([FINDING.CONTAINER_SET, FINDING.IMAGE]));
    expect(kinds(compareWith(after => {
      after.containers.push({ ...after.containers[0], Id: "8".repeat(64), Image: "sha256:strange" });
    }))).toEqual(expect.arrayContaining([FINDING.CONTAINER_SET, FINDING.IMAGE]));
  });

  it("catches systemd and cell identity drift", () => {
    expect(kinds(compareWith(after => {
      after.systemd = "ActiveState=failed\nSubState=dead\nNRestarts=3\n";
    }))).toContain(FINDING.SYSTEMD);
    expect(kinds(compareWith(after => { after.cell_id = "cell-0002"; })))
      .toContain(FINDING.CELL);
  });

  it("catches root-disk space that did not come back", () => {
    // A drill that fills the root filesystem and leaves it full is a drill that
    // broke the host, however green the containers look.
    const result = compareWith(after => {
      after.root_filesystem =
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        + "/dev/vda1 41152000 40000000 1152000 98% /\n";
    });
    expect(kinds(result)).toContain(FINDING.ROOT_DISK);
  });

  it("tolerates the small disk movement a drill legitimately causes", () => {
    // Byte equality would make this check useless: logs and temp media move a few
    // hundred MiB every run, and a check that always fires gets ignored.
    const result = compareWith(after => {
      after.root_filesystem =
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        + "/dev/vda1 41152000 12100000 29052000 30% /\n";
    });
    expect(kinds(result)).not.toContain(FINDING.ROOT_DISK);
  });

  it("treats missing model-endpoint evidence as a finding, not as a pass", () => {
    // `error: 1` is what the snapshot writes when the probe never ran. Reading that
    // as "no problem reported" would turn an unmeasured endpoint into a green tick.
    expect(kinds(compareWith(after => { after.model_probe = { status: 0, latency: 0, error: 1 }; })))
      .toContain(FINDING.SLO_EVIDENCE);
    expect(kinds(compareWith(after => { delete after.model_probe; })))
      .toContain(FINDING.SLO_EVIDENCE);
    expect(kinds(compareWith(after => { after.model_probe = { status: 503, latency: 9, error: 0 }; })))
      .toContain(FINDING.SLO_EVIDENCE);
  });

  it("does not accept a 200 that curl itself reported as failed", () => {
    // curl writes both: `%{http_code}` can be 200 while `%{exitcode}` is non-zero,
    // because the response began and then the transfer died. Reading only the
    // status would record a healthy endpoint from a truncated probe - and this is
    // the only case where the exit-code check carries any weight, so without it
    // that branch could be deleted and every other test would still pass.
    const result = compareWith(after => {
      after.model_probe = { status: 200, latency: 10.0, error: 28 };
    });
    expect(kinds(result)).toContain(FINDING.SLO_EVIDENCE);
  });

  it("refuses a baseline carrying any 9Router host or credential", () => {
    // The 9Router VPS is explicitly out of scope for this deployment. A baseline
    // that names it, or carries a key for it, is evidence that something reached
    // somewhere it must not.
    for (const marker of FORBIDDEN_HOST_MARKERS) {
      const result = compareWith(after => {
        after.containers[0].Networks.leak = { Gateway: marker };
      });
      expect(kinds(result), marker).toContain(FINDING.CREDENTIAL);
    }
  });

  it("refuses bearer tokens, API keys and JWTs in the artifact", () => {
    // A baseline is checked in and passed around as evidence. A secret inside it
    // has been published to everyone who reads the evidence.
    for (const secret of [
      "Bearer abcdef0123456789",
      "sbp_0123456789abcdef0123456789abcdef01234567",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    ]) {
      const result = compareWith(after => { after.captured_at = secret; });
      expect(kinds(result), secret.slice(0, 12)).toContain(FINDING.CREDENTIAL);
    }
  });

  it("never echoes the secret it found", () => {
    // Otherwise the finding itself leaks it into every log that prints findings.
    const secret = "sbp_0123456789abcdef0123456789abcdef01234567";
    const result = compareWith(after => { after.captured_at = secret; });
    const text = JSON.stringify(result.findings);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("0123456789abcdef");
  });

  it("reads free space from df output, and says so when it cannot", () => {
    expect(rootFreeKib(
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
      + "/dev/vda1 41152000 12000000 29152000 30% /\n",
    )).toBe(29_152_000);
    expect(rootFreeKib("")).toBeNull();
    expect(rootFreeKib(undefined)).toBeNull();
    // An unreadable filesystem line must not silently pass as "no regression".
    expect(kinds(compareWith(after => { after.root_filesystem = ""; })))
      .toContain(FINDING.ROOT_DISK);
  });

  it("refuses a document that is not the schema it understands", () => {
    // Comparing an unknown shape field by field would produce confident findings
    // about fields that mean something else.
    const result = compareHostBaselines(clone(), { ...clone(), schema: 2 });
    expect(kinds(result)).toContain(FINDING.SCHEMA);
    expect(result.clean).toBe(false);
  });
});

describe("the drill comparison touches nothing", () => {
  it("imports without a Docker socket, an SSH agent, or a network call", () => {
    // The module is pure by construction; this pins it. A future edit that reaches
    // for `node:child_process` or `node:net` would make the whole test unable to
    // run in CI, which is exactly the outcome to catch here rather than there.
    const source = readFileSync(
      resolve(import.meta.dirname, "../../infra/openclaw-zalo/scripts/openclaw-host-baseline-diff.mjs"),
      "utf8",
    );
    for (const forbidden of ["child_process", "node:net", "node:http", "node:https", "fetch("]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
