import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateCommandStore, PrivateCommandStoreError } from './private-command-store.mjs';
import { StoreTransportError } from './store-transport.mjs';

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const CLAIM = id('a'), OTHER = id('b'), COMMAND = id('c');
const claim = () => ({ tokenDigest: 'a'.repeat(64), claimId: CLAIM });
const command = () => ({ commandId: COMMAND, connectionId: id('1'), assistantId: id('2'), userId: id('3'),
  organizationId: id('4'), bindingId: id('5'), bindingEpoch: 2, text: 'Có phòng trống nào?', expiresAt: 1_900_000_000_000 });
const claimed = () => ({ status: 'claimed', claimId: CLAIM, command: command() });
const inputFor = operation => operation === 'prunePrivateCommands' ? { limit: 3 } :
  operation === 'finishPrivateCommand' ? { ...claim(), text: 'Có 2 phòng trống.' } :
    operation === 'failPrivateCommand' ? { ...claim(), reason: 'runtime_failed' } : claim();
const outputFor = operation => operation === 'claimPrivateCommand' ? claimed() :
  operation === 'prunePrivateCommands' ? { status: 'pruned', count: 2 } :
    { status: ({ dispatchPrivateCommand: 'dispatched', finishPrivateCommand: 'ready', failPrivateCommand: 'failed' })[operation],
      commandId: COMMAND, claimId: CLAIM };
const OPERATIONS = ['claimPrivateCommand', 'dispatchPrivateCommand', 'finishPrivateCommand', 'failPrivateCommand', 'prunePrivateCommands'];
const code = expected => error => error instanceof PrivateCommandStoreError && error.code === expected && error.message === expected;
const invalid = code('private_command_store_request_invalid');
const unknown = code('store_outcome_unknown');
function setup(reply = operation => outputFor(operation)) {
  const calls = [], controller = new AbortController();
  const transport = { call: async (operation, payload, options) => {
    calls.push({ operation, payload, options });
    return reply(operation, payload, options);
  } };
  return { store: createPrivateCommandStore({ transport }), transport, calls, controller, options: { signal: controller.signal } };
}

test('each fixed operation projects its exact input and freezes the complete acknowledgement', async t => {
  for (const operation of OPERATIONS) await t.test(operation, async () => {
    const f = setup(), input = inputFor(operation);
    const output = await f.store[operation](input, f.options);
    assert.deepEqual(output, outputFor(operation));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].operation, operation);
    assert.deepEqual(f.calls[0].payload, input);
    assert.notEqual(f.calls[0].payload, input);
    assert.ok(Object.isFrozen(f.calls[0].payload));
    assert.equal(f.calls[0].options.signal, f.controller.signal);
    assert.ok(Object.isFrozen(output));
    if (output.command) assert.ok(Object.isFrozen(output.command));
  });
});

test('empty, already-dispatched and already-ready remain distinct states', async () => {
  const empty = setup(() => ({ status: 'empty' }));
  assert.deepEqual(await empty.store.claimPrivateCommand(claim(), empty.options), { status: 'empty' });
  for (const [operation, status] of [['dispatchPrivateCommand', 'already_dispatched'], ['finishPrivateCommand', 'already_ready'],
    ['failPrivateCommand', 'unknown']]) {
    const f = setup(() => ({ ...outputFor(operation), status }));
    assert.equal((await f.store[operation](inputFor(operation), f.options)).status, status);
  }
});

test('requests cannot override identity, pass credentials or select a different operation', async t => {
  for (const operation of OPERATIONS) await t.test(operation, async () => {
    const f = setup();
    for (const value of [null, [], 'request', 0, new Date(), Object.create({ ...inputFor(operation) })]) {
      await assert.rejects(f.store[operation](value, f.options), invalid);
    }
    for (const key of ['userId', 'organizationId', 'connectionId', 'token', 'accessToken', 'function', 'operation', 'toJSON']) {
      await assert.rejects(f.store[operation]({ ...inputFor(operation), [key]: 'private' }, f.options), invalid);
    }
    const symbol = { ...inputFor(operation), [Symbol('extra')]: 'private' };
    await assert.rejects(f.store[operation](symbol, f.options), invalid);
    const hidden = Object.defineProperty(inputFor(operation), 'hidden', { value: 'private' });
    await assert.rejects(f.store[operation](hidden, f.options), invalid);
    assert.equal(f.calls.length, 0);
  });
});

test('inputs are own data properties; accessors and hostile reflection never execute data getters', async () => {
  const f = setup(); let reads = 0;
  for (const operation of OPERATIONS) {
    for (const key of Object.keys(inputFor(operation))) {
      const input = Object.defineProperty(inputFor(operation), key, { enumerable: true, get() { reads++; throw new Error('secret'); } });
      await assert.rejects(f.store[operation](input, f.options), invalid);
    }
    const input = new Proxy(inputFor(operation), { ownKeys() { throw new Error('secret'); } });
    await assert.rejects(f.store[operation](input, f.options), invalid);
  }
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
  const plain = Object.assign(Object.create(null), claim());
  assert.equal((await f.store.claimPrivateCommand(plain, f.options)).status, 'claimed');
});

test('digest and claim ID must use their exact canonical scalar forms', async () => {
  const f = setup();
  for (const tokenDigest of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 1, { toString: () => 'a'.repeat(64) }]) {
    await assert.rejects(f.store.claimPrivateCommand({ ...claim(), tokenDigest }, f.options), invalid);
  }
  for (const claimId of [CLAIM.toUpperCase(), id('x'), '0'.repeat(36), `${CLAIM} `, 1, null]) {
    await assert.rejects(f.store.claimPrivateCommand({ ...claim(), claimId }, f.options), invalid);
  }
  assert.equal(f.calls.length, 0);
});

test('all operations require a real live signal supplied without accessors', async () => {
  const f = setup(); let reads = 0;
  const getterOptions = Object.defineProperty({}, 'signal', { enumerable: true, get() { reads++; return f.controller.signal; } });
  for (const options of [undefined, null, {}, { signal: {} }, { signal: f.controller.signal, token: 'private' }, getterOptions]) {
    for (const operation of OPERATIONS) await assert.rejects(f.store[operation](inputFor(operation), options), invalid);
  }
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
  f.controller.abort();
  for (const operation of OPERATIONS) {
    await assert.rejects(f.store[operation](inputFor(operation), f.options), code('private_command_store_cancelled'));
  }
  assert.equal(f.calls.length, 0);
});

test('text bounds are UTF-8 bytes and reject empty, NUL and coercible values', async () => {
  const f = setup();
  for (const text of ['', '\0', 'hello\0world', 'x'.repeat(32769), 'é'.repeat(16385), 1, new String('private')]) {
    await assert.rejects(f.store.finishPrivateCommand({ ...claim(), text }, f.options), invalid);
  }
  assert.equal(f.calls.length, 0);
  await f.store.finishPrivateCommand({ ...claim(), text: 'é'.repeat(16384) }, f.options);
  assert.equal(f.calls.length, 1);
});

test('failure reason and prune limit are bounded closed sets', async () => {
  const f = setup();
  for (const reason of ['runtime_timeout', 'private error message', '', null, 1]) {
    await assert.rejects(f.store.failPrivateCommand({ ...claim(), reason }, f.options), invalid);
  }
  for (const limit of [0, -1, 1.5, 257, Infinity, NaN, '1', null]) {
    await assert.rejects(f.store.prunePrivateCommands({ limit }, f.options), invalid);
  }
  assert.equal(f.calls.length, 0);
  for (const reason of ['runtime_failed', 'runtime_cancelled', 'runtime_unknown']) {
    await f.store.failPrivateCommand({ ...claim(), reason }, f.options);
  }
});

test('request and options are copied before the first await; input mutation cannot alter the claim or ACK scope', async () => {
  let finish;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  const input = { ...claim(), text: 'Original response' }, options = { signal: f.controller.signal };
  const pending = f.store.finishPrivateCommand(input, options);
  input.claimId = OTHER; input.tokenDigest = 'b'.repeat(64); input.text = 'Changed response';
  options.signal = new AbortController().signal;
  assert.deepEqual(f.calls[0].payload, { ...claim(), text: 'Original response' });
  finish(outputFor('finishPrivateCommand'));
  assert.equal((await pending).claimId, CLAIM);
  assert.equal(f.calls.length, 1);
});

test('claim ACK is an isolated snapshot, frozen at every nested level', async () => {
  const raw = claimed(), f = setup(() => raw);
  const result = await f.store.claimPrivateCommand(claim(), f.options);
  raw.command.userId = OTHER; raw.command.text = 'Changed'; raw.claimId = OTHER;
  assert.deepEqual(result, claimed());
  assert.throws(() => { result.command.text = 'Change'; }, TypeError);
  assert.throws(() => { result.claimId = OTHER; }, TypeError);
});

test('malformed ACKs are unknown writes for every operation, never retried', async t => {
  for (const operation of OPERATIONS) await t.test(operation, async () => {
    for (const result of [null, [], '', {}, { ...outputFor(operation), secret: 'private' },
      { ...outputFor(operation), status: 'ok' }, Object.create(outputFor(operation))]) {
      const f = setup(() => result);
      await assert.rejects(f.store[operation](inputFor(operation), f.options), unknown);
      assert.equal(f.calls.length, 1);
    }
  });
});

test('an empty ACK must have no payload and cannot use status getters', async () => {
  let reads = 0;
  for (const result of [{ status: 'empty', command: command() },
    Object.defineProperty({}, 'status', { enumerable: true, get() { reads++; return 'empty'; } }),
    Object.defineProperty({ status: 'empty' }, 'status', { enumerable: false })]) {
    const f = setup(() => result);
    await assert.rejects(f.store.claimPrivateCommand(claim(), f.options), unknown);
  }
  assert.equal(reads, 0);
  let observations = 0;
  const changing = new Proxy({ status: 'empty' }, { getOwnPropertyDescriptor(target, key) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (key === 'status' && observations++ > 0) return { ...descriptor, value: 'claimed' };
    return descriptor;
  } });
  const f = setup(() => changing);
  await assert.rejects(f.store.claimPrivateCommand(claim(), f.options), unknown);
});

test('all ACK fields reject accessors, symbols and hidden keys without executing getters', async () => {
  let reads = 0;
  for (const operation of OPERATIONS) {
    for (const key of Object.keys(outputFor(operation))) {
      const result = Object.defineProperty(outputFor(operation), key, { enumerable: true, get() { reads++; throw new Error('secret'); } });
      const f = setup(() => result);
      await assert.rejects(f.store[operation](inputFor(operation), f.options), unknown);
    }
    for (const result of [{ ...outputFor(operation), [Symbol('private')]: 'secret' },
      Object.defineProperty(outputFor(operation), 'private', { value: 'secret' })]) {
      const f = setup(() => result);
      await assert.rejects(f.store[operation](inputFor(operation), f.options), unknown);
    }
  }
  const result = claimed();
  Object.defineProperty(result.command, 'text', { enumerable: true, get() { reads++; return 'secret'; } });
  const f = setup(() => result);
  await assert.rejects(f.store.claimPrivateCommand(claim(), f.options), unknown);
  assert.equal(reads, 0);
});

test('claim ACK must bind the exact claim, canonical owner IDs and bounded command data', async () => {
  const mutations = [value => { value.claimId = OTHER; }, value => { delete value.command.bindingId; },
    value => { value.command.token = 'private'; }, value => { value.command.bindingEpoch = 0; },
    value => { value.command.bindingEpoch = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.command.expiresAt = '1900000000000'; }, value => { value.command.expiresAt = 0; },
    value => { value.command.text = ''; }, value => { value.command.text = 'x\0'; },
    value => { value.command.text = 'é'.repeat(4097); },
    ...['commandId', 'connectionId', 'assistantId', 'userId', 'organizationId', 'bindingId']
      .map(key => value => { value.command[key] = 'invalid'; })];
  for (const mutate of mutations) {
    const raw = claimed(); mutate(raw);
    const f = setup(() => raw);
    await assert.rejects(f.store.claimPrivateCommand(claim(), f.options), unknown);
    assert.equal(f.calls.length, 1);
  }
  const f = setup(() => ({ ...claimed(), command: { ...command(), text: 'é'.repeat(4096) } }));
  assert.equal(Buffer.byteLength((await f.store.claimPrivateCommand(claim(), f.options)).command.text), 8192);
});

test('receipt states, UUIDs and claim echoes do not accept another claim or cross-operation ACK', async () => {
  for (const operation of ['dispatchPrivateCommand', 'finishPrivateCommand', 'failPrivateCommand']) {
    for (const delta of [{ claimId: OTHER }, { commandId: 'invalid' }, { status: 'claimed' }, { status: 'empty' }]) {
      const f = setup(() => ({ ...outputFor(operation), ...delta }));
      await assert.rejects(f.store[operation](inputFor(operation), f.options), unknown);
    }
  }
  for (const count of [-1, 1.5, 4, '2', Infinity, NaN]) {
    const f = setup(() => ({ status: 'pruned', count }));
    await assert.rejects(f.store.prunePrivateCommands({ limit: 3 }, f.options), unknown);
  }
  const f = setup(() => ({ status: 'pruned', count: 0 }));
  assert.deepEqual(await f.store.prunePrivateCommands({ limit: 1 }, f.options), { status: 'pruned', count: 0 });
});

test('post-dispatch cancellation cannot return a successful ACK or authorize replay', async () => {
  let finish;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.store.dispatchPrivateCommand(claim(), f.options);
  f.controller.abort();
  finish(outputFor('dispatchPrivateCommand'));
  await assert.rejects(pending, unknown);
  assert.equal(f.calls.length, 1);
});

test('typed transport outcomes are sanitized and unexpected failures remain unknown; no operation retries', async () => {
  for (const operation of OPERATIONS) {
    for (const expected of ['store_denied', 'store_conflict', 'store_rejected', 'store_outcome_unknown', 'store_unavailable', 'store_principal_refused']) {
      const f = setup(() => { const error = new StoreTransportError(expected); error.message = 'private database details'; throw error; });
      await assert.rejects(f.store[operation](inputFor(operation), f.options), code(expected));
      assert.equal(f.calls.length, 1);
    }
    for (const error of [new Error('private secret'), { code: 'store_denied', message: 'private' },
      new StoreTransportError('unexpected_private_code')]) {
      const f = setup(() => { throw error; });
      await assert.rejects(f.store[operation](inputFor(operation), f.options), unknown);
      assert.equal(f.calls.length, 1);
    }
  }
});

test('configuration rejects missing transport and the exposed method set is immutable', () => {
  for (const transport of [undefined, {}, { call: 'rpc' }]) assert.throws(() => createPrivateCommandStore({ transport }), TypeError);
  const f = setup();
  assert.ok(Object.isFrozen(f.store));
  assert.deepEqual(Object.keys(f.store), OPERATIONS);
});
