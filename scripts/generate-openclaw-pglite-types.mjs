import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const POSTGRES_META_VERSION = '0.96.6';
const PGLITE_SOCKET_VERSION = '0.2.7';

function resolveNpxRequire() {
  const binDirectory = (process.env.PATH || '')
    .split(delimiter)
    .find((entry) => /node_modules[\\/]\.bin$/i.test(entry));
  if (!binDirectory) {
    throw new Error('Pinned npm exec package directory is unavailable.');
  }
  return createRequire(join(dirname(binDirectory), 'package.json'));
}

async function assertPackageVersion(require, packageName, expectedVersion) {
  const entry = require.resolve(packageName);
  const packageRoot = packageName === '@supabase/postgres-meta'
    ? resolve(dirname(entry), '..', '..')
    : resolve(dirname(entry), '..');
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  if (manifest.version !== expectedVersion) {
    throw new Error(`${packageName} must be exactly ${expectedVersion}.`);
  }
  return { entry, packageRoot };
}

function capture(command, args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

const npxRequire = resolveNpxRequire();
const postgresMeta = await assertPackageVersion(
  npxRequire,
  '@supabase/postgres-meta',
  POSTGRES_META_VERSION,
);
const socket = await assertPackageVersion(
  npxRequire,
  '@electric-sql/pglite-socket',
  PGLITE_SOCKET_VERSION,
);
const [{ PGLiteSocketServer }, { createDisposableOpenClawDatabase }] =
  await Promise.all([
    import(pathToFileURL(socket.entry).href),
    import('./test-openclaw-migrations.mjs'),
  ]);
const database = await createDisposableOpenClawDatabase();
const server = new PGLiteSocketServer({
  db: database,
  host: '127.0.0.1',
  port: 0,
  maxConnections: 4,
});

try {
  await server.start();
  const environment = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NO_COLOR: '1',
    PG_META_GENERATE_TYPES: 'typescript',
    PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS: 'public',
    PG_META_GENERATE_TYPES_DEFAULT_SCHEMA: 'public',
    PG_META_DB_URL:
      `postgresql://postgres:postgres@127.0.0.1:${server.port}/postgres?sslmode=disable`,
  };
  const result = await capture(
    process.execPath,
    [join(postgresMeta.packageRoot, 'dist', 'server', 'server.js')],
    environment,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Pinned postgres-meta exited with code ${result.exitCode}. ${result.stderr.slice(0, 2000)}`,
    );
  }
  process.stdout.write(result.stdout);
} finally {
  await server.stop().catch(() => {});
  await database.close().catch(() => {});
}
