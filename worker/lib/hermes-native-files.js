import fs from 'node:fs';
import path from 'node:path';

const fail = () => { throw new Error('native_private_file_invalid'); };
export function nativeAbsolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) fail();
  return path.resolve(value);
}
function check(info, directory) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail();
  // Production runs as the worker's Linux principal. Windows tests do not prove ACLs.
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || info.gid !== process.getgid() ||
      (info.mode & 0o777) !== (directory ? 0o700 : 0o600))) fail();
}
export function nativeDirectory(value, { create = false, io = fs } = {}) {
  const directory = nativeAbsolute(value);
  if (create && !io.existsSync(directory)) {
    // Do not create through an unresolved parent/link or change existing permissions.
    const parent = path.dirname(directory);
    if (io.realpathSync(parent) !== parent) fail();
    io.mkdirSync(directory, { mode: 0o700 });
  }
  check(io.lstatSync(directory), true);
  if (io.realpathSync(directory) !== directory) fail();
  return directory;
}
export function nativePrivateRead(value, maxBytes, { io = fs } = {}) {
  const file = nativeAbsolute(value);
  nativeDirectory(path.dirname(file), { io });
  const before = io.lstatSync(file); check(before, false);
  if (before.size > maxBytes || io.realpathSync(file) !== file) fail();
  let fd;
  const buffer = Buffer.alloc(maxBytes + 1);
  try {
    fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0));
    const held = io.fstatSync(fd); check(held, false);
    if (held.dev !== before.dev || held.ino !== before.ino || held.size > maxBytes) fail();
    let length = 0;
    while (length < buffer.length) {
      const count = io.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = io.lstatSync(file); check(after, false);
    if (length > maxBytes || after.dev !== held.dev || after.ino !== held.ino ||
        after.size !== length || io.realpathSync(file) !== file) fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { buffer.fill(0); if (fd !== undefined) io.closeSync(fd); }
}
