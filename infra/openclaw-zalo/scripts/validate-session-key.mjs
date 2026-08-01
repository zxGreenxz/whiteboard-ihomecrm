import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { loadRuntimeKeyring } from "../../../services/openclaw-zalo-cell/session-crypto/dist/daemon.js";

const FIXED_KEY_PATH = "/run/secrets/openclaw_session_key";

async function main() {
  const [option, candidate] = process.argv.slice(2);
  if (option !== "--candidate" || !candidate || process.argv.length !== 4 || !isAbsolute(candidate)) {
    throw new Error("candidate argument is invalid");
  }
  const canonical = resolve(candidate);
  if ((await realpath(canonical)) !== canonical) throw new Error("candidate path is not canonical");
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("candidate is not a regular file");
  if ((metadata.mode & 0o777) !== 0o400) throw new Error("candidate mode is invalid");
  if (typeof process.getuid !== "function" || metadata.uid !== process.getuid()) {
    throw new Error("candidate owner is invalid");
  }

  await loadRuntimeKeyring({
    getuid: () => process.getuid(),
    open: async (requestedPath, flags) => {
      if (requestedPath !== FIXED_KEY_PATH || (flags & (constants.O_NOFOLLOW ?? 0x20000)) === 0) {
        throw new Error("session key validator contract changed");
      }
      const handle = await open(canonical, flags);
      return {
        close: () => handle.close(),
        readFile: () => handle.readFile(),
        stat: async () => {
          const value = await handle.stat();
          return {
            kind: value.isFile() ? "file" : "other",
            mode: value.mode,
            size: value.size,
            uid: value.uid,
          };
        },
      };
    },
  });
}

main().catch(() => {
  process.stderr.write("candidate session key is invalid\n");
  process.exitCode = 1;
});
