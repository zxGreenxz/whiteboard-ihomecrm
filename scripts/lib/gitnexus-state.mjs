import fs from 'node:fs';
import {readFile, realpath, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join, relative, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

export const fail = (reason, code = 2) => Object.assign(new Error(reason), {code});
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function optionalRead(path) {
  try { return await readFile(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function checkDeadline(deadline = Infinity) {
  if (performance.now() >= deadline) throw fail('timeout');
}
export function normalizedEnvironment(env = process.env) {
  // Reject upstream ambient switches, including credentials, without logging values.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GITNEXUS_') && key !== 'GITNEXUS_HOME' && env[key]) throw fail(`unsupported environment: ${key}`,64);
  }
  const result = {...env};
  delete result.NODE_OPTIONS;
  return result;
}
export async function validateInstallation(packageRoot, version) {
  packageRoot = await realpath(packageRoot);
  const pkg = await json(join(packageRoot,'package.json'));
  if (pkg.name !== 'gitnexus' || pkg.version !== version) throw fail('tool pin mismatch');
  const cliPath = join(packageRoot,'dist/cli/index.js');
  if (!(await stat(cliPath)).isFile()) throw fail('tool CLI missing');
  return {packageRoot, cliPath, version:pkg.version};
}

export async function captureSnapshot(repoRoot, toolInstallation) {
  const deadline = toolInstallation.deadline ?? Infinity;
  if (!Number.isFinite(deadline)) return measureSnapshot(repoRoot, toolInstallation);
  checkDeadline(deadline);
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      measureSnapshot(repoRoot, {...toolInstallation, signal:controller.signal}),
      new Promise((_, reject) => {timer=setTimeout(() => {controller.abort();reject(fail('timeout'));}, Math.max(1,deadline-performance.now()));}),
    ]);
  } finally {clearTimeout(timer);}
}

async function measureSnapshot(repoRoot, toolInstallation) {
  const {packageRoot, deadline = Infinity} = toolInstallation;
  checkDeadline(deadline);
  repoRoot = await realpath(repoRoot);
  const env = normalizedEnvironment(toolInstallation.env);
  const configFiles = ['scripts/run-pinned-gitnexus.mjs','scripts/lib/gitnexus-state.mjs','tooling/agent-tools.json','.gitignore','.gitnexusignore'];
  const configHash = createHash('sha256');
  for (const file of configFiles) {
    const bytes = await optionalRead(join(repoRoot,file));
    configHash.update(JSON.stringify([file,bytes === null ? null : digest(bytes)]));
  }
  // Pre-read strictly: upstream intentionally tolerates unreadable ignore files.
  const rcBytes = await optionalRead(join(repoRoot,'.gitnexusrc'));
  const load = file => import(pathToFileURL(join(packageRoot,file)).href);
  const [{createIgnoreFilter},{loadAnalyzeConfig},size] = await Promise.all([
    load('dist/config/ignore-service.js'),load('dist/cli/analyze-config.js'),load('dist/core/ingestion/utils/max-file-size.js'),
  ]);
  if (typeof createIgnoreFilter !== 'function' || typeof loadAnalyzeConfig !== 'function' || typeof size.getMaxFileSizeBytes !== 'function') throw fail('unsupported pin adapter');
  let config;
  try {config = loadAnalyzeConfig(repoRoot) ?? {};} catch {throw fail('invalid .gitnexusrc',64);}
  const allowed = {indexOnly:true,skipAgentsMd:true,skipSkills:true,embeddings:false,pdg:false,workerTimeout:'60',maxFileSize:'512'};
  for (const [key,value] of Object.entries(config)) {
    if (!(key in allowed) || String(value) !== String(allowed[key])) throw fail(`unsupported .gitnexusrc option: ${key}`,64);
  }
  const maxBytes = size.getMaxFileSizeBytes();
  if (maxBytes !== size.DEFAULT_MAX_FILE_SIZE_BYTES || maxBytes !== 524288) throw fail('unsupported scanner size');
  // Digest only approved effective options: never raw config containing credentials.
  configHash.update(JSON.stringify({schema:2,version:toolInstallation.version,config,maxBytes,registryHome:env.GITNEXUS_HOME ?? null,rcPresent:rcBytes !== null}));
  const ignore = await createIgnoreFilter(repoRoot,{noGitignore:false});
  checkDeadline(deadline);
  const require = createRequire(join(packageRoot,'package.json'));
  const {glob} = require('glob');
  // path-scurry can suppress filesystem errors. Capture them at its I/O boundary.
  let traversalError;
  const strictPromises = Object.fromEntries(
    ['lstat', 'readdir', 'readlink', 'realpath'].map(method => [method, async (...args) => {
      try {
        return await fs.promises[method](...args);
      } catch (error) {
        traversalError = error;
        throw error;
      }
    }]),
  );
  const strictFs = {
    ...fs,
    promises: {...fs.promises, ...strictPromises},
    readdir(path, options, callback) {
      return fs.readdir(path, options, (error, result) => {
        if (error) traversalError = error;
        callback(error, result);
      });
    },
    lstat(path, callback) {
      return fs.lstat(path, (error, result) => {
        if (error) traversalError = error;
        callback(error, result);
      });
    },
  };
  const paths = await glob('**/*',{cwd:repoRoot,nodir:true,dot:false,ignore,fs:strictFs,signal:toolInstallation.signal});
  if (traversalError) throw fail('snapshot traversal failed');
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    checkDeadline(deadline);
    const full = join(repoRoot,path);
    const actual = await realpath(full);
    const rel = relative(repoRoot,actual);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw fail('snapshot path escapes repository');
    const info = await stat(full);
    if (!info.isFile()) throw fail('snapshot path is not a regular file');
    // Large paths stay in the snapshot so shrinking below the cap is observable.
    const content = info.size > maxBytes ? 'oversize' : digest(await readFile(full,{signal:toolInstallation.signal}));
    hash.update(JSON.stringify([path.replaceAll('\\','/'),content]));
  }
  checkDeadline(deadline);
  return {sourceDigest:hash.digest('hex'),configDigest:configHash.digest('hex')};
}

export async function nativeStamp(repoRoot) {
  const meta = await json(join(repoRoot,'.gitnexus/gitnexus.json'));
  const db = await stat(join(repoRoot,'.gitnexus/lbug'));
  if (!db.isFile() || db.size === 0) throw fail('database missing or empty');
  if (meta.repoPath !== repoRoot || meta.incrementalInProgress || meta.schemaVersion !== 5 || !meta.indexedAt || !meta.fileHashes || typeof meta.fileHashes !== 'object') throw fail('invalid native metadata');
  if (meta.capabilities?.graph?.status !== 'available' || meta.pdg || meta.stats?.embeddings > 0) throw fail('unsupported index capabilities');
  return {repoPath:meta.repoPath,indexedAt:meta.indexedAt,schemaVersion:meta.schemaVersion,
    fileHashesDigest:digest(JSON.stringify(Object.entries(meta.fileHashes).sort())),capabilities:meta.capabilities,
    // Detect replacement even if a writer reuses the source snapshot and metadata.
    dbStamp:[db.size,db.mtimeMs,db.ctimeMs],metadataDigest:digest(JSON.stringify(meta))};
}

export async function inspectIndex(repoRoot, snapshot) {
  try {
    const m = await json(join(repoRoot,'.gitnexus/manifest.json'));
    const version = (await json(join(repoRoot,'tooling/agent-tools.json'))).gitnexus.version;
    if (m.schemaVersion !== 2 || m.repoPath !== repoRoot || m.toolVersion !== version || !m.baseCommit) return {status:'invalid',reason:'manifest provenance mismatch'};
    if (m.configDigest !== snapshot.configDigest || m.sourceDigest !== snapshot.sourceDigest) return {status:'stale',reason:'source/config changed',baseCommit:m.baseCommit};
    const stamp = await nativeStamp(repoRoot);
    if (JSON.stringify(stamp) !== JSON.stringify(m.nativeStamp)) return {status:'invalid',reason:'native index changed'};
    return {status:'ready',reason:'snapshot matches local index',baseCommit:m.baseCommit,manifest:m};
  } catch(e) { return {status:e.code === 'ENOENT'?'missing':'invalid',reason:'index unavailable'}; }
}
