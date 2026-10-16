import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudHandler } from '../../cloudfunctions/oradv/handler';
import { createService } from '../../shared/service';
import { MemoryStore } from '../../shared/memory-store';

test('trusted native cloud context allocates positive numbers without accepting client zero or owner authority', async () => {
  const config = { envId: 'oradv-test-123', appId: 'wx0123456789abcdef', runtimeEnvId: 'oradv-test-123' };
  const store = new MemoryStore();
  const service = createService(store);
  const handler = createCloudHandler({ config: () => config, context: () => ({ APPID: config.appId, ENV: config.envId, OPENID: 'fictional-first-member' }), store: () => store,
    invoke: (request, identity, traceId) => service.handle(request, identity, traceId) });
  const request = { action: 'identity.ensure', requestId: 'native-number', clubId: 'oradv', payload: { consentVersions: { privacy: 1, terms: 1 }, memberNumber: 0, role: 'owner' } };
  const created = await handler(request);
  assert.equal(created.ok, true);
  if (created.ok) { assert.equal((created.data as any).memberNumber, 1); assert.deepEqual((created.data as any).roles, []); }
  const repeated = await handler(request);
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal((repeated.data as any).memberNumber, 1);
  const spoof = await handler({ ...request, OPENID: 'owner' });
  assert.equal(spoof.ok, false);
  assert.equal(Object.keys(store.snapshot().memberships).length, 1);
  assert.equal(Object.keys(store.snapshot().staff_roles ?? {}).length, 0);
});
