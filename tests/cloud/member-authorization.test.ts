import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudHandler } from '../../cloudfunctions/oradv/handler';
import { createDemoStore } from '../../shared/demo';
import { createService } from '../../shared/service';
import type { MemberSummary, Registration } from '../../shared/types';

// Exercise the deployed entry boundary and actual domain service together.
// No SDK networking, account credentials or production identities are used.
test('trusted WeChat context cannot be replaced by requested founder identity or staff authority', async () => {
  const now = '2026-10-15T12:00:00.000Z';
  const store = createDemoStore(now);
  const service = createService(store, { now: () => now });
  const appId = 'wx0123456789abcdef';
  const envId = 'oradv-test-offline';
  let sequence = 0;
  const handler = createCloudHandler({
    config: () => ({ appId, envId, runtimeEnvId: envId }),
    context: () => ({ APPID: appId, ENV: envId, OPENID: 'ordinary-trusted-caller' }),
    store: () => store,
    invoke: (request, identity, traceId) => service.handle(request, identity, traceId),
    now: () => Date.parse(now),
  });
  const call = (action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) => handler({
    action, payload, expectedRevision, clubId: 'oradv', requestId: `boundary-${++sequence}`,
  });
  const created = await call('identity.ensure', {
    nickname: '边界测试成员', consentVersions: { privacy: 1, terms: 1 },
    memberKind: 'founder', role: 'owner', openId: 'fictional-owner',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const member = created.data as MemberSummary & { memberKind: string };
  assert.equal(member.memberKind, 'regular');
  assert.deepEqual(member.roles, []);

  const selfAssign = await call('staff.member.assign', {
    memberId: member.id, memberKind: 'founder', reason: '伪造自升身份',
  }, member.revision);
  assert.equal(selfAssign.ok, false);
  if (!selfAssign.ok) assert.equal(selfAssign.error.code, 'FORBIDDEN');

  const spoofed = await call('registration.apply', {
    activityId: 'intro-ride', acceptedRuleVersion: 1,
    memberKind: 'founder', confirmationMode: 'direct', role: 'owner',
  });
  if (spoofed.ok) assert.notEqual((spoofed.data as Registration).state, 'confirmed');
  else assert.equal(spoofed.error.code, 'INVALID_INPUT');
  const registration = await call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 });
  assert.equal(registration.ok, true);
  if (registration.ok) assert.equal((registration.data as Registration).state, 'pending_confirmation');

  const privateBriefing = await call('activity.briefing.get', { activityId: 'intro-ride' });
  assert.equal(privateBriefing.ok, false, 'pending applicants cannot read participant-only arrangements');
  if (!privateBriefing.ok) assert.equal(privateBriefing.error.code, 'FORBIDDEN');
  const unchanged = await call('identity.me');
  assert.equal(unchanged.ok, true);
  if (unchanged.ok) assert.equal((unchanged.data as MemberSummary & { memberKind: string }).memberKind, 'regular');
});
