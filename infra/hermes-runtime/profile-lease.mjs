import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertInside } from './runtime-contract.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code) => { throw new Error(code); };
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function createOnce(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); }
  finally { await handle.close(); }
}
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Synthetic, single-host supervisor primitive. Metadata stays OUTSIDE every
// container home. A crashed holder leaves a lock: no timeout/PID-based takeover.
// It is not a distributed lease, credential store, or CRM-memory purge service.
export class ProfileLeaseStore {
  constructor({ directory, homeRoot }) {
    if (!path.isAbsolute(directory) || !path.isAbsolute(homeRoot)) fail('profile_invalid_root');
    this.directory = assertInside(homeRoot, directory);
    this.homeRoot = path.resolve(homeRoot);
  }

  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await realpath(this.homeRoot);
    const directory = await realpath(this.directory);
    assertInside(root, directory);
    for (const name of ['owners', 'homes', 'locks', 'revoked']) {
      await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
      // Supervisor metadata directories may not be redirected by symlinks.
      if (await realpath(path.join(directory, name)) !== path.join(directory, name)) fail('profile_metadata_redirected');
    }
    return { root, directory };
  }

  async acquire(input) {
    if (!input || Object.keys(input).sort().join(',') !== 'assistantId,home,organizationId,userId' ||
        ![input.userId, input.organizationId, input.assistantId].every((id) => typeof id === 'string' && uuid.test(id)) ||
        typeof input.home !== 'string' || !path.isAbsolute(input.home)) fail('profile_invalid_binding');
    const { root, directory } = await this.prepare();
    // Resolve both sides before containment: Windows TEMP may use an 8.3 alias
    // while realpath(root) has the long name. A symlink outside still fails.
    const home = await realpath(input.home);
    assertInside(root, home);
    // Fixed sibling layout prevents nested profiles exposing B's home inside A.
    if (path.dirname(home) !== root) fail('profile_home_not_direct_child');
    const metaRelative = path.relative(home, directory);
    if (!metaRelative || (!metaRelative.startsWith('..') && !path.isAbsolute(metaRelative))) fail('profile_metadata_inside_home');
    const binding = { assistantId: input.assistantId.toLowerCase(), userId: input.userId.toLowerCase(),
      organizationId: input.organizationId.toLowerCase(), home };
    const revoked = path.join(directory, 'revoked', binding.assistantId + '.json');
    if (await exists(revoked)) fail('profile_revoked');
    const file = path.join(directory, 'locks', binding.assistantId + '.json');
    const lease = { leaseId: randomUUID(), binding };
    try { await createOnce(file, lease); }
    catch (error) { if (error.code === 'EEXIST') fail('profile_in_use'); throw error; }
    let released = false;
    const release = async () => {
      if (released) return false;
      if (!isDeepStrictEqual(await readJson(file), lease)) fail('profile_lease_tampered');
      await unlink(file); released = true; return true;
    };
    try {
      const homeKey = createHash('sha256').update(home).digest('hex');
      for (const ownerFile of [path.join(directory, 'homes', homeKey + '.json'),
        path.join(directory, 'owners', binding.assistantId + '.json')]) {
        try { await createOnce(ownerFile, binding); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!isDeepStrictEqual(await readJson(ownerFile), binding)) fail('profile_owner_mismatch');
        }
      }
      if (await exists(revoked)) fail('profile_revoked');
      return { binding: structuredClone(binding), release };
    } catch (error) { await release(); throw error; }
  }

  async revoke(assistantId) {
    if (typeof assistantId !== 'string' || !uuid.test(assistantId)) fail('profile_invalid_binding');
    const { directory } = await this.prepare();
    const id = assistantId.toLowerCase();
    if (!await readJson(path.join(directory, 'owners', id + '.json'))) fail('profile_unknown_owner');
    try { await createOnce(path.join(directory, 'revoked', id + '.json'), { revoked: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
