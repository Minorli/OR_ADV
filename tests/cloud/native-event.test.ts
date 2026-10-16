import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudHandler, validateEnvelope } from '../../cloudfunctions/oradv/handler';
import { createDemoStore } from '../../shared/demo';
import { createService } from '../../shared/service';
import { MemoryStore } from '../../shared/memory-store';
import type { MemberSummary } from '../../shared/types';

const config = { envId: 'oradv-native-offline', appId: 'wx0123456789abcdef', runtimeEnvId: 'oradv-native-offline' };
const context = { OPENID: 'trusted-native-rider', APPID: config.appId, ENV: config.envId };
const request = { action: 'activity.list', requestId: 'native-event-1', clubId: 'oradv', payload: {} };
const metadata = { appId: config.appId, openId: 'different-untrusted-event-identity', unionId: 'private-platform-metadata' };

test('native callFunction metadata is removed before the strict business envelope reaches the service', async () => {
  const event = { ...request, userInfo: metadata };
  assert.deepEqual(validateEnvelope(event), request);
  assert.deepEqual(event.userInfo, metadata, 'normalization does not mutate the platform event');
  let invoked = false;
  const handler = createCloudHandler({ config: () => config, context: () => context, store: () => new MemoryStore(),
    invoke: async (rpc, identity, traceId) => {
      invoked = true;
      assert.deepEqual(rpc, request);
      assert.deepEqual(identity, { appId: config.appId, openId: context.OPENID });
      return { ok: true, data: { items: [] }, traceId };
    },
  });
  assert.equal((await handler(event)).ok, true);
  assert.equal(invoked, true);
});

test('ignored userInfo never replaces missing or mismatched trusted WeChat context', async () => {
  for (const trusted of [{}, { ...context, OPENID: undefined }, { ...context, APPID: 'wx1111111111111111' }]) {
    let touched = false;
    const handler = createCloudHandler({ config: () => config, context: () => trusted,
      store: () => { touched = true; return new MemoryStore(); }, invoke: async () => { throw Error('must not invoke'); },
    });
    const result = await handler({ ...request, userInfo: { openId: 'forged-owner', appId: config.appId, ENV: config.envId, role: 'owner' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(['UNAUTHENTICATED', 'TEMPORARY_FAILURE'].includes(result.error.code));
    assert.equal(touched, false);
  }
});

test('native metadata compatibility preserves unknown-field, invalid-revision and total-size rejection', () => {
  for (const value of [
    { ...request, userInfo: metadata, role: 'owner' },
    { ...request, userInfo: metadata, OPENID: 'forged' },
    { ...request, userInfo: metadata, __unexpected: true },
    { ...request, userInfo: metadata, expectedRevision: -1 },
    { ...request, userInfo: { openId: 'x'.repeat(17_000) } },
    { ...request, payload: { value: 'x'.repeat(17_000) }, userInfo: metadata },
  ]) assert.throws(() => validateEnvelope(value), { code: 'INVALID_INPUT' });
});

test('platform-enriched requests reach public pages, consented login and private flows without trusting metadata identity', async () => {
  const store = createDemoStore('2026-10-16T12:00:00.000Z');
  const service = createService(store, { now: () => '2026-10-16T12:00:00.000Z' });
  const handler = createCloudHandler({ config: () => config, context: () => context, store: () => store,
    invoke: (rpc, identity, traceId) => service.handle(rpc, identity, traceId),
  });
  let seq = 0;
  const call = (action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) => handler({
    action, payload, clubId: 'oradv', requestId: `native-flow-${++seq}`, ...(expectedRevision === undefined ? {} : { expectedRevision }),
    userInfo: metadata,
  });
  for (const [action, payload] of [
    ['activity.list', {}], ['club.public', {}], ['ranking.list', { metric: 'growth' }],
    ['club.content.get', { section: 'handbook' }], ['learning.catalog', {}],
  ] as const) {
    const result = await call(action, payload);
    assert.equal(result.ok, true, `${action}: ${JSON.stringify(result)}`);
  }
  const loggedIn = await call('identity.ensure', { nickname: '原生调用测试车友', consentVersions: { privacy: 1, terms: 1 } });
  assert.equal(loggedIn.ok, true, JSON.stringify(loggedIn));
  if (!loggedIn.ok) return;
  const member = loggedIn.data as MemberSummary;
  assert.deepEqual(member.roles, []);
  const me = await call('identity.me');
  assert.equal(me.ok, true);
  if (me.ok) assert.equal((me.data as MemberSummary).id, member.id);
  for (const action of ['dossier.mine', 'skills.mine', 'learning.mine', 'registration.mine', 'points.mine']) {
    const result = await call(action);
    assert.equal(result.ok, true, `${action}: ${JSON.stringify(result)}`);
  }
  const staff = await call('staff.skills.queue');
  assert.equal(staff.ok, false);
  if (!staff.ok) assert.equal(staff.error.code, 'FORBIDDEN');
});

test('rejected native fields log bounded names and a build marker without logging values or arbitrary key text', async () => {
  const logs: Record<string, unknown>[] = [];
  const handler = createCloudHandler({ config: () => config, context: () => context,
    store: () => { throw Error('invalid envelope must not access storage'); },
    invoke: async () => { throw Error('invalid envelope must not invoke'); },
    log: entry => logs.push(entry),
  });
  const result = await handler({ ...request, userInfo: metadata, transportExtension: 'private-secret-value',
    ['private/姓名/credential']: 'private-contact-value' });
  assert.equal(result.ok, false);
  const entry = logs[0] as any;
  assert.equal(entry.action, 'activity.list');
  assert.equal(entry.code, 'INVALID_INPUT');
  assert.match(entry.serverBuild, /^native-envelope-/);
  assert.deepEqual(entry.rejectedFields, ['transportExtension', '[nonstandard-field]']);
  assert.equal(entry.rejectedFieldCount, 2);
  assert(!JSON.stringify(logs).includes('private-secret-value'));
  assert(!JSON.stringify(logs).includes('private-contact-value'));
  assert(!JSON.stringify(logs).includes('姓名'));
  assert(!JSON.stringify(result).includes('transportExtension'));
});

test('observed native tcbContext metadata is removed and cannot override trusted identity, environment or roles', async () => {
  const tcbContext = { uid: 'forged-owner', envId: 'another-environment', openId: 'forged-owner', roles: ['owner'] };
  const event = { ...request, userInfo: metadata, tcbContext };
  assert.deepEqual(validateEnvelope(event), request);
  assert.deepEqual(event.tcbContext, tcbContext, 'transport event is not mutated');
  const store = new MemoryStore();
  let called = 0;
  const handler = createCloudHandler({ config: () => config, context: () => context, store: () => store,
    invoke: async (rpc, identity, traceId) => {
      called++;
      assert.deepEqual(rpc, request);
      assert.deepEqual(identity, { appId: config.appId, openId: context.OPENID });
      return { ok: true, data: null, traceId };
    },
  });
  assert.equal((await handler(event)).ok, true);
  assert.equal(called, 1);
  const forbidden = createCloudHandler({ config: () => config, context: () => ({}),
    store: () => { throw Error('untrusted platform metadata must not allow store access'); },
    invoke: async () => { throw Error('untrusted platform metadata must not allow invocation'); },
  });
  const noTrustedIdentity = await forbidden(event);
  assert.equal(noTrustedIdentity.ok, false);
  if (!noTrustedIdentity.ok) assert.equal(noTrustedIdentity.error.code, 'TEMPORARY_FAILURE');
  assert.throws(() => validateEnvelope({ ...request, tcbContext: 'x'.repeat(17_000) }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateEnvelope({ ...event, role: 'owner' }), { code: 'INVALID_INPUT' });
});

test('pre-dispatch SDK failures log only a bounded backend code and stage, never secret error text', async () => {
  for (const [code, expected] of [['INVALID_PARAM', 'INVALID_PARAM'], [-501001, '-501001'], ['private|token=/secret', undefined]] as const) {
    const logs: any[] = [];
    const handler = createCloudHandler({ config: () => config, context: () => context,
      store: () => { throw Object.assign(new Error('private-secret=credential; user-content=hidden'), { code }); },
      invoke: async () => { throw Error('must not invoke'); }, log: entry => logs.push(entry),
    });
    const result = await handler({ ...request, tcbContext: { uid: 'ignored' } });
    assert.equal(result.ok, false);
    assert.equal(logs[0].stage, 'store_init');
    assert.equal(logs[0].backendCode, expected);
    assert(!JSON.stringify(logs).includes('private-secret'));
    assert(!JSON.stringify(logs).includes('user-content'));
    assert(!JSON.stringify(result).includes('credential'));
  }
});

test('wrapped SDK errors produce fixed technical hints without retaining source message or credentials', async () => {
  const logs: any[] = [];
  const failure = Object.assign(new Error('document.get:fail token signature permission denied in transaction; secret=private-value'), { errCode: -501001 });
  const handler = createCloudHandler({ config: () => config, context: () => context,
    store: () => ({ ...new MemoryStore(), transaction: async () => { throw failure; } }) as any,
    invoke: async () => { throw Error('must not invoke'); }, log: entry => logs.push(entry),
    runtimeDiagnostics: () => ({ credentials: 'present', sessionToken: true }),
  });
  await handler(request);
  assert.equal(logs[0].stage, 'rate_limit');
  assert.deepEqual(logs[0].backendHints, ['document_get', 'transaction', 'permission', 'signature', 'token']);
  assert.deepEqual(logs[0].runtimeAuth, { credentials: 'present', sessionToken: true });
  assert(!JSON.stringify(logs).includes('private-value'));
  assert(!JSON.stringify(logs).includes('permission denied in'));
});

test('captured raw database code takes precedence over a generic SDK wrapper code only in server logs', async () => {
  const logs: any[] = [];
  const failure = Object.assign(new Error('private-wrapper-details'), { errCode: -501001 });
  Object.defineProperty(failure, 'backendCode', { value: 'SIGN_PARAM_INVALID' });
  const handler = createCloudHandler({ config: () => config, context: () => context,
    store: () => new MemoryStore(),
    invoke: async () => { throw failure; }, log: entry => logs.push(entry),
  });
  const result = await handler(request);
  assert.equal(logs[0].backendCode, 'SIGN_PARAM_INVALID');
  assert.equal(result.ok, false);
  assert(!JSON.stringify(result).includes('SIGN_PARAM_INVALID'));
  assert(!JSON.stringify(logs).includes('private-wrapper-details'));
});
