import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CloudStore, type CloudDatabase } from '../../cloudfunctions/oradv/store';

const fromFunction = createRequire(resolve('cloudfunctions/oradv/package.json'));
function wrappedDatabase(raw: Record<string, unknown>) {
  const cloud = fromFunction('wx-server-sdk');
  assert.equal(fromFunction('wx-server-sdk/package.json').version, '4.0.2');
  cloud.init({ env: 'offline-sdk-code-capture' });
  const database = cloud.database({ env: 'offline-sdk-code-capture', throwOnNotFound: false });
  // Replace the installed SDK's raw transaction boundary before any operation.
  database._db.runTransaction = async (work: (tx: unknown) => unknown) => work({ collection: () => ({ doc: () => raw }) });
  let observedError: unknown;
  const run = database.runTransaction;
  database.runTransaction = function (work: (tx: unknown) => unknown) {
    return run.call(this, (tx: any) => work({ collection: (name: string) => ({ doc: (id: string) => {
      const reference = tx.collection(name).doc(id);
      for (const method of ['get', 'set']) {
        const original = reference[method];
        reference[method] = async function (...args: unknown[]) {
          try { return await original.apply(this, args); }
          catch (error) { observedError = error; throw error; }
        };
      }
      return reference;
    } }) }));
  };
  return { database: database as CloudDatabase, observedError: () => observedError };
}

test('pinned SDK remaps unknown raw response codes to -501001, while CloudStore preserves the original get code on the same error', async () => {
  const response = Object.freeze({ code: 'NATIVE_GET_DIAGNOSTIC', message: 'private backend message is not diagnostic metadata' });
  const prototype = { async get(this: unknown) { assert.equal(this, raw); return response; }, async set() { return {}; } };
  const raw = Object.create(prototype), original = raw.get;
  const sdk = wrappedDatabase(raw);
  await assert.rejects(sdk.database.runTransaction((tx: any) => tx.collection('rpc_limits').doc('id').get()), (error: any) => error.errCode === -501001 && error.backendCode === undefined);
  const store = new CloudStore(sdk.database);
  await assert.rejects(store.transaction(tx => tx.get('rpc_limits', 'id')), (error: any) => {
    assert.ok(error === sdk.observedError()); assert.equal(error.errCode, -501001);
    assert.equal(error.backendCode, response.code);
    assert(!Object.keys(error).includes('backendCode'), 'diagnostic metadata is not added to serializable SDK error fields');
    assert.equal(error.backendCode.includes('private'), false);
    return true;
  });
  assert.equal(raw.get, original); assert.equal(Object.prototype.hasOwnProperty.call(raw, 'get'), false);
  assert.deepEqual(response, { code: 'NATIVE_GET_DIAGNOSTIC', message: 'private backend message is not diagnostic metadata' });
});

test('raw set throw codes survive the wx wrapper with argument/this binding and original methods restored', async () => {
  const backendError = Object.assign(new Error('private failure details'), { code: 'NATIVE_SET_DIAGNOSTIC', response: { private: true } });
  let writes = 0;
  const raw = { async get(this: unknown) { assert.equal(this, raw); return { data: null }; },
    async set(this: unknown, data: unknown) { assert.equal(this, raw); assert.deepEqual(data, { count: 1 }); writes++; throw backendError; } };
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'set'), sdk = wrappedDatabase(raw), store = new CloudStore(sdk.database);
  await assert.rejects(store.transaction(tx => tx.set('rpc_limits', 'id', { count: 1, _id: 'removed', _openid: 'removed' })), (error: any) => {
    assert.ok(error === sdk.observedError()); assert.equal(error.errCode, -501001); assert.equal(error.backendCode, backendError.code);
    return true;
  });
  assert.equal(writes, 1); assert.deepEqual(Object.getOwnPropertyDescriptor(raw, 'set'), descriptor);
  assert.deepEqual(backendError.response, { private: true }); assert.equal(backendError.code, 'NATIVE_SET_DIAGNOSTIC');
});

test('successful SDK operations, malformed raw codes and plain adapters keep their existing behavior', async () => {
  let stored: unknown;
  const raw = { async get() { return { data: { id: 'one' } }; }, async set(data: unknown) { stored = data; return { updated: 1 }; } };
  const originalGet = raw.get, originalSet = raw.set, sdk = wrappedDatabase(raw), store = new CloudStore(sdk.database);
  await store.transaction(async tx => { assert.deepEqual(await tx.get('rpc_limits', 'id'), { id: 'one' }); await tx.set('rpc_limits', 'id', { count: 2 }); });
  assert.deepEqual(stored, { count: 2 }); assert.equal(raw.get, originalGet); assert.equal(raw.set, originalSet);
  raw.get = async () => { throw { code: 'private code with spaces / credentials', message: 'redacted' }; };
  await assert.rejects(store.transaction(tx => tx.get('rpc_limits', 'id')), (error: any) => error.errCode === -501001 && error.backendCode === undefined);
  const original = Object.assign(new Error('plain adapter failure'), { code: 'PLAIN_ADAPTER', response: { retained: true } });
  const plain = { runTransaction: async (work: any) => work({ collection: () => ({ doc: () => ({ get: async () => { throw original; }, set: async () => ({}) }) }) }) } as unknown as CloudDatabase;
  await assert.rejects(new CloudStore(plain).transaction(tx => tx.get('rpc_limits', 'id')), error => error === original);
  assert.deepEqual(original.response, { retained: true }); assert.equal((original as any).backendCode, undefined);
});
