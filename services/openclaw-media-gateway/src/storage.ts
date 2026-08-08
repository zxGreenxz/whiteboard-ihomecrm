// Where the bytes live. The design calls for a private R2 bucket; this
// interface is the whole surface that decision touches, so moving there later is
// an adapter and not a rewrite of the signing path above it.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface StoredObject {
  /** Opaque version identifier echoed into the signed receipt. */
  objectVersionOrEtag: string;
  /** True when an identical object was already stored under this key. */
  reused: boolean;
}

export interface DeletedObject {
  /** NOT_FOUND is a success: a retention delete that finds nothing is complete. */
  status: "DELETED" | "NOT_FOUND";
  objectVersionOrEtag: string | null;
}

export interface ObjectStore {
  put(objectKey: string, bytes: Uint8Array, sha256: string): Promise<StoredObject>;
  delete(objectKey: string): Promise<DeletedObject>;
}

export class FilesystemObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #pathFor(objectKey: string): string {
    const path = resolve(join(this.#root, objectKey));
    // Defence in depth: the key was already validated as relative and
    // traversal-free, but a storage root must never be escapable by a key.
    if (path !== this.#root && !path.startsWith(this.#root + sep)) {
      throw new Error("object key escapes the storage root");
    }
    return path;
  }

  async put(objectKey: string, bytes: Uint8Array, sha256: string): Promise<StoredObject> {
    const path = this.#pathFor(objectKey);
    const existing = await stat(path).catch(() => null);
    if (existing?.isFile()) {
      // The bridge retries an upload whose receipt it never saw. Re-storing is
      // harmless, but claiming a fresh write when the same bytes are already
      // there would hide a genuine key collision, so the two are distinguished.
      const current = await readFile(path);
      const digest = createHash("sha256").update(current).digest("hex");
      if (digest === sha256) return { objectVersionOrEtag: digest, reused: true };
      throw new Error("object key already holds different bytes");
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { objectVersionOrEtag: sha256, reused: false };
  }

  async delete(objectKey: string): Promise<DeletedObject> {
    const path = this.#pathFor(objectKey);
    const existing = await stat(path).catch(() => null);
    if (existing === null) return { status: "NOT_FOUND", objectVersionOrEtag: null };
    if (!existing.isFile()) throw new Error("object key does not name a regular object");
    // The version is read before the unlink so the receipt names what was
    // destroyed; afterwards there is nothing left to identify.
    const current = await readFile(path);
    const digest = createHash("sha256").update(current).digest("hex");
    await rm(path, { force: true });
    return { status: "DELETED", objectVersionOrEtag: digest };
  }
}
