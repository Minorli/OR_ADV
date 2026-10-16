import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudHandler } from '../../cloudfunctions/oradv/handler';
import { MemoryStore } from '../../shared/memory-store';
import { createAvatarStorage, type AvatarCloudSdk } from '../../cloudfunctions/oradv/avatar-storage';
import { memberIdFor, userIdFor } from '../../shared/models';
import { DEMO_IDENTITIES } from '../../shared/demo';

const config = { envId: 'oradv-test-123', appId: 'wx0123456789abcdef', runtimeEnvId: 'oradv-test-123' };
const context = { OPENID: 'trusted-avatar-user', APPID: config.appId, ENV: config.envId };
const save = { action: 'profile.avatar.save', requestId: 'avatar-request', clubId: 'oradv', payload: { imageBase64: 'A'.repeat(90_000) }, expectedRevision: 1 };

test('cloud avatar allowance is action-specific and ordinary envelopes retain their original byte cap', async () => {
  let calls = 0;
  const handler = createCloudHandler({ config: () => config, context: () => context, store: () => new MemoryStore(),
    invoke: async (_request, _identity, traceId) => { calls++; return { ok: true, data: null, traceId }; } });
  assert.equal((await handler(save)).ok, true);
  assert.equal(calls, 1);
  for (const event of [{ ...save, action: 'profile.update' }, { ...save, action: 'profile.avatar.get' },
    { ...save, payload: { imageBase64: 'A'.repeat(131_072) } }, { ...save, OPENID: 'other-member' }]) {
    const response = await handler(event);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'INVALID_INPUT');
  }
  assert.equal(calls, 1);
});

test('cloud avatar saves have a separate five-per-minute limit without blocking profile reads', async () => {
  const store = new MemoryStore();
  let now = 0;
  const handler = createCloudHandler({ config: () => config, context: () => context, store: () => store, now: () => now,
    invoke: async (_request, _identity, traceId) => ({ ok: true, data: null, traceId }) });
  for (let index = 0; index < 5; index++) assert.equal((await handler(save)).ok, true);
  const limited = await handler(save);
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.error.code, 'RATE_LIMITED');
  assert.equal((await handler({ ...save, action: 'profile.avatar.get', payload: {} })).ok, true);
  now = 60_000;
  assert.equal((await handler(save)).ok, true);
  assert.equal(Object.keys(store.snapshot().rpc_limits).length, 2, 'bounded identity and avatar counters');
});

test('cloud avatar adapter uses unique actor-scoped paths, SDK buffers and short private URLs', async () => {
  const paths: string[] = [];
  const sdk: AvatarCloudSdk = {
    uploadFile: async input => {
      paths.push(input.cloudPath);
      assert(Buffer.isBuffer(input.fileContent));
      return { fileID: 'cloud://test.bucket/' + input.cloudPath, statusCode: 200 };
    },
    getTempFileURL: async input => {
      assert.equal(input.fileList[0].maxAge, 300);
      return { fileList: [{ fileID: input.fileList[0].fileID, status: 0, tempFileURL: 'https://private.example.test/avatar?signed' }] };
    },
    deleteFile: async input => ({ fileList: input.fileList.map(fileID => ({ fileID, status: 0 })) }),
  };
  const storage = createAvatarStorage(sdk);
  const memberId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=';
  const first = await storage.save(memberId, png), second = await storage.save(memberId, png);
  assert.notEqual(first, second);
  assert(paths.every(value => value.startsWith(`member-avatars/${memberId}/`) && value.endsWith('.png')));
  assert((await storage.url(first)).startsWith('https://'));
  await storage.remove(first);
  await assert.rejects(storage.save('../other-member', png));
  await assert.rejects(storage.url('https://attacker.example/image'));
  await assert.rejects(storage.remove('cloud://test.bucket/other-data/file.jpg'));
  sdk.getTempFileURL = async () => ({ fileList: [] });
  await assert.rejects(storage.url(second));
  sdk.deleteFile = async input => ({ fileList: [{ fileID: input.fileList[0], status: -1 }] });
  await assert.rejects(storage.remove(second));
});
