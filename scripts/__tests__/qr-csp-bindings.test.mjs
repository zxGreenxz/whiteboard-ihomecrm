import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchBindings, bindingPatches } from '../qr/csp-bindings.mjs';

const sources = {
  wechat: readFileSync('node_modules/qr-scanner-wechat/dist/wasm.mjs', 'utf8'),
  opencv: readFileSync('node_modules/@techstark/opencv-js/dist/opencv.js', 'utf8'),
};
test('pinned artifacts reject unexpected bytes before transforming', () => {
  assert.throws(() => patchBindings('wechat', sources.wechat + ' '), /hash mismatch/);
});
for (const kind of ['wechat', 'opencv']) {
  test(`${kind} generated bindings preserve calls, conversions, metadata and errors`, () => {
    const patched = patchBindings(kind, sources[kind]);
    assert.doesNotMatch(patched, /new Function|new_\(Function|HI\(Function/);
    for (const entry of bindingPatches(kind)) {
      const original = sources[kind].slice(sources[kind].indexOf(entry.start), sources[kind].indexOf(entry.end, sources[kind].indexOf(entry.start)));
      function exercise(code) {
        const events = [];
        const legal = name => name.replace(/[^\w]/g, '_');
        const fail = message => { throw Error(message); };
        const register = f => f;
        const destructors = list => { events.push(['stack', ...list]); };
        const ret = { name: 'int', fromWireType: v => v + 1, toWireType: (_, v) => v + 2 };
        const param = { name: 'int', destructorFunction: v => events.push(['delete', v]), toWireType: (_, v) => { events.push(['wire', v]); return v + 10; }, readValueFromPointer: v => v + 1, argPackAdvance: 4, deleteObject: v => events.push(['deleteObject', v]) };
        const sandbox = { JA: legal, makeLegalFunctionName: legal, h: fail, throwBindingError: fail, aA: destructors, runDestructors: destructors, HI: (ctor, args) => Reflect.construct(ctor, args), new_: (ctor, args) => Reflect.construct(ctor, args), aC: () => [ret, param, param], __emval_lookupTypes: () => [ret, param, param], YC: register, __emval_addMethodCaller: register, dI: {}, signature: 'iii', rawFunction: 42 };
        const make = vm.runInNewContext(`(${code})`, sandbox);
        const outputs = [];
        if (entry.kind === 'named') {
          const fn = make('hello.world', function (value) { return [this, value]; });
          outputs.push(fn.name, fn.length, fn.call(null, 3), fn.call(7, 9));
        } else if (entry.kind === 'dynamic') {
          const fn = make((...args) => args);
          outputs.push(fn.name, fn.length, fn(1, 2, 3));
        } else if (entry.kind === 'method') {
          const fn = make(3, 0);
          outputs.push(fn.name, fn.length, fn({ base: 4, add(a,b) { return this.base+a+b; } }, 'add', [], 20));
          assert.throws(() => fn({ add() { throw Error('method failure'); } }, 'add', [], 20), /method failure/);
          ret.isVoid = true;
          outputs.push(make(3, 0)({ add: () => 20 }, 'add', [], 0));
        } else {
          for (const method of [false, true]) for (const stack of [false, true]) for (const isVoid of [false, true]) {
            const parameter = { ...param, destructorFunction: stack ? undefined : param.destructorFunction, toWireType: (dtors,v) => { if (dtors) dtors.push(v); return v + 10; } };
            const types = [{ ...ret, name: isVoid ? 'void' : 'int' }, method ? parameter : null, parameter];
            const fn = make('target.call', types, method ? {} : null, (...args) => { events.push(['invoke', ...args]); return 100; }, 42);
            outputs.push(fn.name, fn.length, fn.call(4, 3));
            assert.throws(() => fn(), /expected 1 args/);
            const throwing = make('failure', types, method ? {} : null, () => { throw Error('call failure'); }, 42);
            assert.throws(() => throwing.call(4, 3), /call failure/);
          }
          assert.throws(() => make('bad', [], null, () => {}, 0), /argTypes array size mismatch/);
        }
        return JSON.stringify({ outputs, events });
      }
      assert.equal(exercise(entry.replacement), exercise(original), entry.kind);
    }
  });
}
