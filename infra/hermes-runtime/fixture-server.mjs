import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modelReply, sseReply } from './fake-model.mjs';

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
};
async function jsonBody(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2_000_000) throw new Error('Fixture body limit exceeded');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
});
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

export async function startRuntimeFixture({ fixture, createMcpHttpServer, outputDir, port = 8080, adminPort = 8081, host = '0.0.0.0' }) {
  const { broker, connections } = fixture;
  if (!connections?.a?.token || !connections?.b?.token) throw new Error('Synthetic fixture requires exactly A/B connection bindings');
  const sentinels = Object.fromEntries(['a', 'b'].map((actor) => [actor, `PRIVATE_${actor.toUpperCase()}_${randomBytes(16).toString('hex')}`]));
  const stats = { modelCalls: [], mcpCalls: [], failures: [], forbiddenNetworkRequests: 0 };
  const mcp = createMcpHttpServer({ broker, allowedHosts: ['fixture', 'localhost', '127.0.0.1'], allowedOrigins: [] });
  await mkdir(outputDir, { recursive: true });
  for (const actor of ['a', 'b']) {
    const { token, connection } = connections[actor];
    await writeFile(path.join(outputDir, `${actor}.json`), JSON.stringify({ actor, token,
      userId: connection.userId, organizationId: connection.organizationId, assistantId: connection.assistantId,
      sentinel: sentinels[actor] }) + '\n', { mode: 0o600 });
  }
  const server = http.createServer(async (request, response) => {
    if (request.url === '/forbidden-network-tool') { stats.forbiddenNetworkRequests++; send(response, 200, { fixture: 'forbidden-tool-reached-network' }); return; }
    if (request.url === '/mcp') {
      const actor = ['a', 'b'].find((key) => request.headers.authorization === `Bearer ${connections[key].token}`) ?? null;
      // Record status only, never bearer material or tool/result content.
      response.once('finish', () => stats.mcpCalls.push({ actor, status: response.statusCode }));
      mcp.emit('request', request, response); return;
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { send(response, 404, { error: 'not_found' }); return; }
    const actor = { 'Bearer fixture-model-a': 'a', 'Bearer fixture-model-b': 'b' }[request.headers.authorization];
    if (!actor) { send(response, 401, { error: 'unauthorized' }); return; }
    try {
      const body = await jsonBody(request);
      const result = modelReply(body, { actor, sentinels, connectionTokens: ['a', 'b'].map((key) => connections[key].token) });
      stats.modelCalls.push(result.audit);
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.end(sseReply(result.response));
      } else send(response, 200, result.response);
    } catch (error) {
      // Errors are from our bounded validators, never persist prompts or bearer material.
      const message = ['Foreign memory reached the model', 'Broker credential reached the model',
        'Unexpected model tool surface', 'Only fixture prompts are accepted'].includes(error.message)
        ? error.message : 'Invalid fixture model request';
      stats.failures.push({ actor, message }); send(response, 400, { error: { message, type: 'fixture_rejection' } });
    }
  });
  const admin = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/control') { send(response, 404, { error: 'not_found' }); return; }
      const body = await jsonBody(request);
      if (body.op === 'health') { send(response, 200, { ready: true }); return; }
      if (body.op === 'stats') { send(response, 200, stats); return; }
      if (body.op === 'revoke' && ['a', 'b'].includes(body.actor)) {
        await broker.revokeConnection(connections[body.actor].connection.id);
        send(response, 200, { revoked: body.actor }); return;
      }
      send(response, 400, { error: 'invalid_control' });
    } catch { send(response, 500, { error: 'fixture_control_failed' }); }
  });
  try {
    await listen(server, port, host);
    // Deliberately unreachable from Hermes containers, despite the shared fixture network.
    await listen(admin, adminPort, '127.0.0.1');
  } catch (error) { await close(server); await close(admin); throw error; }
  return { server, admin, stats, sentinels, close: async () => { await close(server); await close(admin); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--output' || !path.isAbsolute(process.argv[3] ?? '') || process.argv.length !== 4) throw new Error('Expected --output <absolute fixture directory>');
  const brokerDir = process.env.HERMES_FIXTURE_BROKER_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hermes-broker');
  const { createFixtureBroker } = await import(pathToFileURL(path.join(brokerDir, 'fixture.mjs')));
  const { createMcpHttpServer } = await import(pathToFileURL(path.join(brokerDir, 'mcp-http.mjs')));
  const fixture = await createFixtureBroker();
  await startRuntimeFixture({ fixture, createMcpHttpServer, outputDir: process.argv[3] });
  console.log('Hermes P1 fixture listening internally; synthetic data only.');
}
