/// <reference lib="webworker" />
import { initializeZxing } from './engines';
import { runPipeline } from './pipeline';
import type { QrWorkerRequest, QrWorkerResponse } from './types';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const startedAt = () => performance.now();
const cancelled = new Set<number>();

function send(message: QrWorkerResponse) { workerScope.postMessage(message); }

initializeZxing().then(
  () => send({ type: 'ready' }),
  (error: unknown) => send({ type: 'init-error', message: error instanceof Error ? error.message : String(error) }),
);

workerScope.onmessage = async (event: MessageEvent<QrWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') { cancelled.add(message.requestId); return; }
  const began = startedAt();
  const bitmap = typeof ImageBitmap !== 'undefined' && message.source instanceof ImageBitmap
    ? message.source : null;
  try {
    const result = await runPipeline(message.source, {
      mode: message.mode, budgetMs: message.budgetMs,
      onInitialization: initializing => send({ type: 'initializing', requestId: message.requestId, initializing }),
    });
    if (!cancelled.has(message.requestId)) send({
      type: 'result', requestId: message.requestId,
      result,
    });
  } catch (error) {
    if (!cancelled.has(message.requestId)) send({
      type: 'result', requestId: message.requestId,
      result: { status: 'engine-unavailable', elapsedMs: startedAt() - began },
    });
  } finally {
    bitmap?.close();
    cancelled.delete(message.requestId);
  }
};

export {};
