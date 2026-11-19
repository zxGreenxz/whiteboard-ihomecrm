import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CameraIngest } from "./cameraApiTypes.js";

const ENTRY = /^\d{16}-[a-f0-9-]{36}\.json$/u;

/** Atomic, durable batches; the exact event keys survive ambiguous HTTP acknowledgements. */
export class CameraOutbox {
  private operation: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  constructor(private readonly directory: string, private readonly maxBytes = 64 * 1024 * 1024) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operation.then(fn);
    this.operation = next.catch(() => undefined);
    return next;
  }

  async enqueue(payload: CameraIngest): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const files = (await readdir(this.directory)).filter((name) => ENTRY.test(name));
      let bytes = 0;
      for (const name of files) {
        this.sequence = Math.max(this.sequence, Number(name.slice(0, 16)));
        try { bytes += (await stat(join(this.directory, name))).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const body = JSON.stringify(payload);
      if (bytes + Buffer.byteLength(body) > this.maxBytes) throw new Error("CAMERA_OUTBOX_FULL");
      this.sequence = Math.max(Date.now(), this.sequence + 1);
      const name = `${String(this.sequence).padStart(16, "0")}-${randomUUID()}.json`;
      const temporary = join(this.directory, `${name}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(body, "utf8"); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.directory, name));
      await this.syncDirectory();
    });
  }

  private async syncDirectory(path = this.directory): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async drain(send: (payload: CameraIngest) => Promise<unknown>, maximum = 20, quarantine?: {
    reason(payload: CameraIngest): "EXPIRED" | "BINDING_CHANGED" | null;
    recorded(reason: "EXPIRED" | "BINDING_CHANGED"): void;
  }): Promise<number> {
    // One drain loop per recorder; enqueues can continue during a slow request.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter((name) => ENTRY.test(name)).sort().slice(0, maximum);
    let delivered = 0;
    for (const name of names) {
      const path = join(this.directory, name);
      const payload: unknown = JSON.parse(await readFile(path, "utf8"));
      // Files are private worker-owned artifacts. The server revalidates every field and binding.
      if (!payload || typeof payload !== "object" || !("recorderId" in payload) || !("events" in payload)) {
        throw new Error("CAMERA_OUTBOX_CORRUPT");
      }
      const reason = quarantine?.reason(payload as CameraIngest);
      if (reason && quarantine) {
        const archive = join(this.directory, "quarantine", reason);
        await mkdir(archive, { recursive: true, mode: 0o700 });
        await rename(path, join(archive, name));
        await this.syncDirectory(archive);
        await this.syncDirectory(join(this.directory, "quarantine"));
        await this.syncDirectory();
        quarantine.recorded(reason);
        continue;
      }
      await send(payload as CameraIngest);
      await unlink(path);
      await this.syncDirectory();
      delivered += 1;
    }
    return delivered;
  }
}
