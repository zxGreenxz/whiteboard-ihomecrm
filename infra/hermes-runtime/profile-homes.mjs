import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEYS = ['assistantId', 'userId', 'organizationId'];
const fail = code => { throw new Error(code); };
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('invalid_profile_owner');
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item || !Object.hasOwn(item, 'value')) fail('invalid_profile_owner');
    return [key, item.value];
  })));
}
const missing = async target => { try { await lstat(target); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };

/** Trusted logical homes only; never mounts, reads or deletes runtime memory.
 * Root must already exist under host ownership. New homes get permanent owner
 * markers outside the home. Existing unmarked homes are never adopted. This is
 * not an execution lease: ProfileLeaseStore remains the sole lease owner and
 * crash locks are never recovered here. Factory performs no filesystem I/O.
 */
export function createProfileHomes({ homeRoot } = {}) {
  if (typeof homeRoot !== 'string' || !path.isAbsolute(homeRoot) || /[\0\r\n]/.test(homeRoot)) fail('invalid_profile_root');
  const rootInput = path.resolve(homeRoot), pending = new Map();
  const privatePath = async (target, directory) => {
    const info = await lstat(target);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail('profile_path_refused');
    if (process.platform === 'linux' && (info.uid !== process.getuid() || info.gid !== process.getgid() ||
      (info.mode & 0o777) !== (directory ? 0o700 : 0o600))) fail('profile_path_refused');
    return info;
  };
  return Object.freeze({
    async ensure(raw, options) {
      const owner = exact(raw, KEYS), { signal } = exact(options, ['signal']);
      if (KEYS.some(key => typeof owner[key] !== 'string' || !UUID.test(owner[key])) || !(signal instanceof AbortSignal)) fail('invalid_profile_owner');
      const live = () => { if (signal.aborted) fail('profile_cancelled'); };
      live();
      // Serialize filesystem creation for an assistant within this host adapter;
      // permanent marker validation still fences other processes/owners.
      const previous = pending.get(owner.assistantId);
      const work = (async () => {
        await previous?.catch(() => {}); live();
        await privatePath(rootInput, true); live();
        const root = await realpath(rootInput); live();
        const directory = path.join(root, '.profile-home-owners');
        try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await privatePath(directory, true); live();
        if (await realpath(directory) !== directory) fail('profile_path_refused');
        const home = path.join(root, `assistant-${owner.assistantId}`), marker = path.join(directory, `${owner.assistantId}.json`);
        const expected = JSON.stringify({ version: 1, ...owner, home }) + '\n';
        if (await missing(marker)) {
          live(); if (!await missing(home)) fail('profile_home_unowned'); live();
          let file;
          try { file = await open(marker, 'wx', 0o600); await file.writeFile(expected); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          finally { await file?.close(); }
        }
        live(); await privatePath(marker, false);
        const file = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 4096 || (process.platform === 'linux' &&
            (info.uid !== process.getuid() || info.gid !== process.getgid() || (info.mode & 0o777) !== 0o600))) fail('profile_path_refused');
          if (await file.readFile('utf8') !== expected) fail('profile_owner_mismatch');
        } finally { await file.close(); }
        live();
        try { await mkdir(home, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await privatePath(home, true); live();
        const canonical = await realpath(home); live();
        if (canonical !== home || path.dirname(canonical) !== root) fail('profile_path_refused');
        return canonical;
      })();
      pending.set(owner.assistantId, work);
      try { return await work; }
      catch (error) {
        if (/^(invalid_profile_owner|profile_(cancelled|path_refused|home_unowned|owner_mismatch))$/.test(error?.message ?? '')) throw error;
        fail('profile_home_unavailable');
      } finally { if (pending.get(owner.assistantId) === work) pending.delete(owner.assistantId); }
    },
  });
}
