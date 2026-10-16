import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudHandler, validateEnvelope } from '../../cloudfunctions/oradv/handler';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
const identity = { ...DEMO_IDENTITIES.owner, appId: 'wx0123456789abcdef' };
const config = { appId: identity.appId, envId: 'viewer-mode-offline', runtimeEnvId: 'viewer-mode-offline' };
const event = { action: 'identity.me', payload: {}, clubId: 'oradv', requestId: 'viewer-native', viewerMode: 'guest' };
test('the native envelope forwards only the supported guest restriction while trusted SDK auth and rate limiting remain mandatory', async () => {
  const store = createDemoStore('2026-10-16T12:00:00.000Z'), service = createService(store); let invoked = 0;
  const handler = createCloudHandler({ config: () => config, context: () => ({ APPID: identity.appId, OPENID: identity.openId, ENV: config.envId }), store: () => store,
    invoke: async (request, trusted, trace) => { invoked++; assert.deepEqual(trusted, identity); assert.equal(request.viewerMode, 'guest'); return service.handle(request, trusted, trace); } });
  const result = await handler({ ...event, userInfo: { openId: 'forged' }, tcbContext: { roles: ['owner'] } }); assert(result.ok); assert.equal(result.data, null); assert.equal(invoked, 1);
  assert.equal(Object.keys(store.snapshot().rpc_limits).length, 1, 'the actual SDK identity is still rate limited');
  const noSdk = createCloudHandler({ config: () => config, context: () => ({}), store: () => { throw Error('must not reach storage'); }, invoke: async () => { throw Error('must not invoke'); } });
  assert.equal((await noSdk(event)).ok, false);
});
test('invalid viewer modes, identity fields and oversized envelopes are rejected at the transport boundary', () => {
  assert.equal(validateEnvelope(event).viewerMode, 'guest');
  for (const viewerMode of [null, false, '', 'owner', {}, ['guest']]) assert.throws(() => validateEnvelope({ ...event, viewerMode }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateEnvelope({ ...event, openId: identity.openId }), { code: 'INVALID_INPUT' });
  for (const action of ['staff.activity.save', 'staff.activity.content.save']) {
    assert.equal(validateEnvelope({ ...event, action, payload: { description: '路'.repeat(12000) } }).action, action);
    assert.throws(() => validateEnvelope({ ...event, action, payload: { description: '路'.repeat(33000) } }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => validateEnvelope({ ...event, action: 'profile.update', payload: { description: 'x'.repeat(17000) } }), { code: 'INVALID_INPUT' });
});
