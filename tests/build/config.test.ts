import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Build script is executable ESM, not a TypeScript module.
import { selectBuild } from '../../scripts/build-config.mjs';

const local = {
  appId: 'wx0123456789abcdef', version: '0.1.0-test.1',
  environments: { test: { envId: 'test-only' }, production: { envId: 'prod-only' } },
};
test('mock builds are explicitly marked and cannot target production', () => {
  assert.equal(selectBuild([], {}).mode, 'mock');
  assert.equal(selectBuild([], {}).appId, '');
  assert.throws(() => selectBuild(['--mode', 'mock', '--env', 'production'], local));
});
test('real cloud build requires actual AppID and EnvId', () => {
  assert.throws(() => selectBuild(['--mode', 'cloud'], {}));
  assert.throws(() => selectBuild(['--mode', 'cloud'], { ...local, environments: {} }));
  assert.deepEqual(selectBuild(['--mode', 'cloud'], local), {
    mode: 'cloud', target: 'test', appId: local.appId, envId: 'test-only', version: local.version,
  });
});
test('test and production environments cannot share a database', () => {
  assert.throws(() => selectBuild(['--mode', 'cloud'], {
    ...local, environments: { test: { envId: 'same' }, production: { envId: 'same' } },
  }));
});
test('invalid build arguments and metadata are rejected', () => {
  assert.throws(() => selectBuild(['--mode', 'unknown'], local));
  assert.throws(() => selectBuild(['--env', 'unknown'], local));
  assert.throws(() => selectBuild(['--secret', 'value'], local));
  assert.throws(() => selectBuild(['--mode'], local));
  assert.throws(() => selectBuild([], { ...local, version: '../escape' }));
  assert.throws(() => selectBuild(['--mode', 'cloud'], { ...local, appId: 'test' }));
});
