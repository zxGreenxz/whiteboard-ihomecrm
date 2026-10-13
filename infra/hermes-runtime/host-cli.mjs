#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadHostConfiguration } from './host-config.mjs';

const create = async configuration => {
  const { createHermesHost } = await import('./host-service.mjs');
  return createHermesHost(configuration);
};
const invoke = fn => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };

/** Executable boundary; injected ports are tests only, never command/config data.
 * Signal listeners precede config loading and startup. Repeated signals cannot
 * force exit or release a retained lock. Await close and the original startup;
 * a timeout/aborted observer is not evidence that the host has actually drained.
 */
export async function runHermesCli(args, { load = loadHostConfiguration, createHost = create,
  signals = process, emit = event => console.info(JSON.stringify({ event })),
  setExitCode = code => { process.exitCode = code; } } = {}) {
  let configuration, host, starting, closing, finishedWork, stopped = false, startupFailed = false, retained = false;
  let wake;
  const shutdown = new Promise(resolve => { wake = resolve; });
  const report = event => { try { emit(event); } catch { /* Fixed lifecycle output must not bypass cleanup. */ } };
  const close = () => {
    if (!host) return;
    closing ??= invoke(() => host.close());
    void closing.catch(() => { retained = true; });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; report('host_stopping'); close(); wake();
  };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  try {
    if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--config' || typeof args[1] !== 'string' ||
        !path.isAbsolute(args[1]) || /[\0\r\n]/.test(args[1])) throw new Error('invalid_arguments');
    report('host_starting');
    configuration = await load(args[1]);
    if (!stopped) {
      host = await createHost(configuration);
      const finished = Object.getOwnPropertyDescriptor(host, 'finished');
      if (!finished || !Object.hasOwn(finished, 'value') || !(finished.value instanceof Promise)) throw new Error('invalid_host_lifecycle');
      // Observe the host's terminal lifecycle before startup. A server failure
      // can occur while start is pending or without any operating-system signal.
      finishedWork = finished.value.then(() => { stopped = true; close(); wake(); }, () => {
        if (!startupFailed) report('host_failed');
        startupFailed = true; stopped = true; close(); wake();
      });
    }
    if (!stopped) {
      starting = invoke(() => host.start());
      await starting;
      if (!stopped) report('host_ready');
    }
    if (stopped) close();
    else await Promise.race([shutdown, finishedWork]);
  } catch {
    if (!stopped) { startupFailed = true; report('host_failed'); }
    stopped = true; close(); wake();
  } finally {
    // A signal can arrive during async import/factory creation. Close the late
    // host too, and never call start after cancellation of config loading.
    close();
    const results = await Promise.allSettled([starting, closing, finishedWork]);
    if (results[1]?.status === 'rejected') retained = true;
    try { configuration?.dispose(); } catch { retained = true; }
    signals.off('SIGINT', stop); signals.off('SIGTERM', stop);
  }
  const code = retained ? 2 : startupFailed ? 1 : 0;
  report(retained ? 'host_retained' : 'host_stopped'); setExitCode(code); return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runHermesCli(process.argv.slice(2));
}
