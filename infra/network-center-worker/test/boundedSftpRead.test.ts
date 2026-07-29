import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSftpFileBounded,
  readSftpRemoteFileBounded,
  stageSftpFileBounded,
  stageSftpRemoteFileBounded,
} from "../src/routeros/boundedSftpRead.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

function source(chunks: Array<Buffer | string>): Readable {
  return Readable.from(chunks);
}

describe("bounded SFTP reads", () => {
  it("accepts an export exactly at the byte limit and destroys the source", async () => {
    const stream = source([Buffer.from("1234"), Buffer.from("5678")]);

    await expect(readSftpFileBounded(stream, {
      kind: "export",
      maxBytes: 8,
      timeoutMs: 100,
    })).resolves.toEqual(Buffer.from("12345678"));
    expect(stream.destroyed).toBe(true);
  });

  it("rejects limit plus one before concatenation and destroys the source", async () => {
    const stream = source([Buffer.alloc(8, 1), Buffer.alloc(1, 2)]);

    await expect(readSftpFileBounded(stream, {
      kind: "export",
      maxBytes: 8,
      timeoutMs: 100,
    })).rejects.toMatchObject({
      code: "SFTP_READ_LIMIT_EXCEEDED",
      retryable: false,
      mayHaveExecuted: false,
    });
    expect(stream.destroyed).toBe(true);
  });

  it("aborts a zero-progress stream at the deadline", async () => {
    const stream = new Readable({ read() {} });

    await expect(readSftpFileBounded(stream, {
      kind: "export",
      maxBytes: 8,
      timeoutMs: 20,
    })).rejects.toMatchObject({
      code: "SFTP_READ_TIMEOUT",
      retryable: true,
      mayHaveExecuted: false,
    });
    expect(stream.destroyed).toBe(true);
  });

  it("maps source errors to a typed read failure and performs one cleanup", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("remote read failed"));
      },
    });

    await expect(readSftpFileBounded(stream, {
      kind: "export",
      maxBytes: 8,
      timeoutMs: 100,
    })).rejects.toMatchObject({
      code: "SFTP_READ_FAILED",
      retryable: true,
      mayHaveExecuted: false,
    });
    expect(stream.destroyed).toBe(true);
  });

  it("streams backup bytes into one owner-only staging file with hash readback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "network-center-sftp-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "candidate.backup.part");
    const payload = Buffer.concat([
      Buffer.alloc(64 * 1024, 1),
      Buffer.alloc(64 * 1024, 2),
    ]);
    const stream = source([payload.subarray(0, 64 * 1024), payload.subarray(64 * 1024)]);

    const staged = await stageSftpFileBounded(stream, {
      kind: "backup",
      destinationPath,
      maxBytes: payload.byteLength,
      timeoutMs: 100,
    });

    expect(staged).toMatchObject({
      path: destinationPath,
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    expect(await readFile(destinationPath)).toEqual(payload);
    if (process.platform !== "win32") {
      expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
    }
    expect(stream.destroyed).toBe(true);

    await staged.dispose();
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await staged.dispose();
  });

  it("deletes every incomplete staging file on limit, deadline, and source failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "network-center-sftp-cleanup-"));
    temporaryDirectories.push(directory);
    const cases = [
      {
        name: "limit",
        stream: source([Buffer.alloc(9)]),
        timeoutMs: 100,
        expectedCode: "SFTP_READ_LIMIT_EXCEEDED",
      },
      {
        name: "timeout",
        stream: new Readable({ read() {} }),
        timeoutMs: 20,
        expectedCode: "SFTP_READ_TIMEOUT",
      },
      {
        name: "source",
        stream: new Readable({
          read() {
            this.destroy(new Error("remote read failed"));
          },
        }),
        timeoutMs: 100,
        expectedCode: "SFTP_READ_FAILED",
      },
    ];

    for (const item of cases) {
      const destinationPath = join(directory, `${item.name}.backup.part`);
      await expect(stageSftpFileBounded(item.stream, {
        kind: "backup",
        destinationPath,
        maxBytes: 8,
        timeoutMs: item.timeoutMs,
      })).rejects.toMatchObject({ code: item.expectedCode });
      await expect(stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(item.stream.destroyed).toBe(true);
    }
  });

  it("closes the SFTP session exactly once after successful and failed remote reads", async () => {
    const closed: string[] = [];
    const successful = {
      createReadStream: () => source([Buffer.from("safe")]),
      end: () => { closed.push("success"); },
    };
    await expect(readSftpRemoteFileBounded(successful, "safe.rsc", {
      kind: "export",
      maxBytes: 4,
      timeoutMs: 100,
    })).resolves.toEqual(Buffer.from("safe"));

    const failed = {
      createReadStream: () => source([Buffer.alloc(5)]),
      end: () => { closed.push("failure"); },
    };
    await expect(readSftpRemoteFileBounded(failed, "large.rsc", {
      kind: "export",
      maxBytes: 4,
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: "SFTP_READ_LIMIT_EXCEEDED" });

    expect(closed).toEqual(["success", "failure"]);
  });

  it("closes SFTP when stream creation fails and while staging a remote backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "network-center-sftp-session-"));
    temporaryDirectories.push(directory);
    const closed: string[] = [];
    const broken = {
      createReadStream: () => { throw new Error("cannot open remote file"); },
      end: () => { closed.push("broken"); },
    };
    await expect(readSftpRemoteFileBounded(broken, "missing.rsc", {
      kind: "export",
      maxBytes: 4,
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: "SFTP_READ_FAILED" });

    const remoteBackup = {
      createReadStream: () => source([Buffer.from("backup")]),
      end: () => { closed.push("backup"); },
    };
    const staged = await stageSftpRemoteFileBounded(
      remoteBackup,
      "safe.backup",
      {
        kind: "backup",
        destinationPath: join(directory, "safe.backup.part"),
        maxBytes: 6,
        timeoutMs: 100,
      },
    );
    expect(staged.bytes).toBe(6);
    expect(closed).toEqual(["broken", "backup"]);
  });
});
