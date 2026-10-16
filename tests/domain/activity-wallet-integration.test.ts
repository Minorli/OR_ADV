import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import type { Activity, Registration, RpcResponse, TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-16T12:00:00.000Z';
function data(response: RpcResponse): any { assert(response.ok, JSON.stringify(response)); return response.data; }
function setup() {
  const store = createDemoStore(NOW); let seq = 0;
  const service = createService(store, { now: () => NOW, id: () => `wallet-integration-${++seq}` });
  const call = async (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity = DEMO_IDENTITIES.owner, expectedRevision?: number) => data(await service.handle({ action, payload, expectedRevision, clubId: 'oradv', requestId: `integration-${++seq}` }, identity));
  const policy = () => call('staff.points.policy.save', { enabled: false, defaultRewardMode: 'growth', ruleText: '本场有效完成后记入兑换积分，交付前可取消。', reason: '主理人核定新活动规则' }, DEMO_IDENTITIES.owner, 0);
  async function complete(id = 'intro-ride') {
    let registration: Registration = await call('registration.apply', { activityId: id, acceptedRuleVersion: 1 }, DEMO_IDENTITIES.member);
    registration = await call('staff.registration.review', { registrationId: registration.id, decision: 'approved' }, DEMO_IDENTITIES.owner, registration.revision);
    registration = await call('staff.registration.confirm', { registrationId: registration.id }, DEMO_IDENTITIES.owner, registration.revision);
    let activity: Activity = await call('activity.get', { activityId: id });
    activity = await call('staff.activity.start', { activityId: id }, DEMO_IDENTITIES.owner, activity.revision);
    await call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' });
    await call('staff.checkin.record', { registrationId: registration.id, phase: 'return', result: 'present' });
    await call('staff.activity.end', { activityId: id, actualCompletedAt: NOW }, DEMO_IDENTITIES.owner, activity.revision);
    return registration;
  }
  return { store, service, call, policy, complete };
}

test('draft reward uses the current policy, publication freezes it and a legacy published activity is unchanged', async () => {
  const env = setup();
  const old = await env.call('activity.get', { activityId: 'intro-ride' });
  let draft: Activity = await env.call('staff.activity.save', { id: 'draft-ride', pointsRule: { growth: 125, annual: 70 } }, DEMO_IDENTITIES.owner, 1);
  assert.equal(draft.pointsRule.redeemable, 0); assert.equal(draft.pointsRule.walletPolicyVersion, 0);
  await env.policy();
  draft = await env.call('staff.activity.save', { id: draft.id, pointsRule: { growth: 125, annual: 70 } }, DEMO_IDENTITIES.owner, draft.revision);
  assert.deepEqual(draft.pointsRule, { growth: 125, annual: 70, redeemable: 125, walletPolicyVersion: 1 });
  const published = await env.call('staff.activity.publish', { activityId: draft.id }, DEMO_IDENTITIES.owner, draft.revision);
  assert.deepEqual(published.pointsRule, draft.pointsRule);
  assert.deepEqual((await env.call('activity.get', { activityId: old.id })).pointsRule, old.pointsRule);
});

test('real registration/checkin/settlement RPCs atomically credit one wallet reward and reversal removes exactly that reward', async () => {
  const env = setup(); await env.policy();
  await env.store.transaction(async tx => { const activity = (await tx.get<Activity>('activities', 'intro-ride'))!; await tx.set('activities', activity.id, { ...activity, pointsRule: { growth: 100, annual: 100, redeemable: 75, walletPolicyVersion: 1 } }); });
  await env.complete();
  const results = await Promise.all(Array.from({ length: 3 }, () => env.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 })));
  assert(results.every(row => row.status === 'completed'));
  const points = await env.call('points.mine', {}, DEMO_IDENTITIES.member), wallet = await env.call('points.wallet', {}, DEMO_IDENTITIES.member);
  assert.equal(points.memberId, wallet.member.id);
  assert.equal(points.growthPoints, 100); assert.equal(points.annualPoints, 100); assert.equal(points.completedCount, 1); assert.equal(wallet.balance, 75); assert.equal(wallet.items.length, 1);
  await env.call('staff.points.reverse', { ledgerId: points.items[0].id, reason: '核实现场记录后更正' });
  await env.call('staff.points.reverse', { ledgerId: points.items[0].id, reason: '重试同一更正' });
  assert.equal((await env.call('points.wallet', {}, DEMO_IDENTITIES.member)).balance, 0);
  assert.equal((await env.call('points.mine', {}, DEMO_IDENTITIES.member)).growthPoints, 0);
  assert.equal((await env.call('points.wallet', {}, DEMO_IDENTITIES.member)).items.length, 2);
});

test('a failed wallet write rolls back completion, growth totals and registration and is safe to settle again', async () => {
  const env = setup(); await env.policy();
  await env.store.transaction(async tx => { const activity = (await tx.get<Activity>('activities', 'intro-ride'))!; await tx.set('activities', activity.id, { ...activity, pointsRule: { growth: 100, annual: 100, redeemable: 80, walletPolicyVersion: 1 } }); });
  const registration = await env.complete(), transact = env.store.transaction.bind(env.store);
  env.store.transaction = work => transact(tx => work({ ...tx, set: async (collection, id, value) => { if (collection === 'points_wallet_ledger') throw Error('injected wallet failure'); await tx.set(collection, id, value); } }));
  const failed = await env.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 });
  assert.equal(failed.status, 'partial_failure'); assert.equal(failed.failureCount, 1);
  assert.equal((env.store.snapshot().registrations[registration.id] as Registration).state, 'pending_settlement');
  assert.equal(Object.keys(env.store.snapshot().points_ledger || {}).length, 0); assert.equal((await env.call('points.mine', {}, DEMO_IDENTITIES.member)).growthPoints, 0);
  env.store.transaction = transact;
  assert.equal((await env.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 })).status, 'completed');
  assert.equal((await env.call('points.wallet', {}, DEMO_IDENTITIES.member)).balance, 80);
});
