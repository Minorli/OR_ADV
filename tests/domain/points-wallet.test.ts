import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '../../shared/context';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { key, memberIdFor, userIdFor } from '../../shared/models';
import type { Activity, LedgerEntry, TrustedIdentity } from '../../shared/types';
import { activityWalletReward, awardActivityWallet, dispatchWallet, getWalletPolicy, reverseActivityWallet, walletAccountId, walletSourceId } from '../../shared/points-wallet';
import type { WalletAccount, WalletOverview } from '../../shared/points-wallet-types';

const NOW = '2026-10-16T12:00:00.000Z';
function setup() {
  const store = createDemoStore(NOW); let sequence = 0;
  const ctx = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity = DEMO_IDENTITIES.owner, expectedRevision?: number) => new Context(store,
    { now: () => NOW, id: () => `wallet-test-${++sequence}` }, { action, payload, expectedRevision, clubId: 'oradv', requestId: `wallet-request-${++sequence}` }, identity);
  const call = (action: string, payload: Record<string, unknown> = {}, identity?: TrustedIdentity, revision?: number) => dispatchWallet(ctx(action, payload, identity, revision));
  const memberId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  async function policy(enabled = true) { return call('staff.points.policy.save', { enabled, defaultRewardMode: 'growth', ruleText: '确认领取或服务完成后核销，交付前可取消。', reason: '核定本轮俱乐部兑换规则' }, DEMO_IDENTITIES.owner, 0); }
  async function earn(amount = 100) {
    const id = `wallet-activity-${++sequence}`;
    const original = store.snapshot().activities['intro-ride'] as Activity;
    const activity: Activity = { ...original, id, state: 'ended', startAt: '2026-10-16T08:00:00.000Z', endAt: NOW, actualStartedAt: '2026-10-16T08:00:00.000Z', actualCompletedAt: NOW,
      pointsRule: { growth: 100, annual: 100, redeemable: amount, walletPolicyVersion: 1 } };
    const entry: LedgerEntry = { id: key('oradv', id, memberId, 'completion'), clubId: 'oradv', memberId, activityId: id, awardType: 'completion',
      businessKey: key('oradv', id, memberId, 'completion'), growthDelta: 100, annualDelta: 100, completedCountDelta: 1, year: 2026,
      effectiveAt: NOW, ruleVersion: 1, relatedEntryId: null, actorId: userIdFor(DEMO_IDENTITIES.owner), reason: '完整核验后结算' };
    await store.transaction(async tx => { await tx.set('activities', id, activity); await tx.set('points_ledger', entry.id, entry); await awardActivityWallet(ctx('staff.settlement.run'), tx, activity, entry); });
    return { activity, entry };
  }
  return { store, ctx, call, memberId, policy, earn };
}

test('wallet starts closed and read-only, includes the trusted member, and rejects arbitrary identity or balance fields', async () => {
  const env = setup(), before = env.store.snapshot();
  const result = await env.call('points.wallet', {}, DEMO_IDENTITIES.member) as WalletOverview;
  assert.equal(result.member.id, env.memberId); assert.equal(result.balance, 0); assert.equal(result.held, 0); assert.equal(result.available, 0);
  assert.equal(result.policy.configured, false); assert.equal(result.policy.enabled, false); assert.deepEqual(env.store.snapshot(), before);
  for (const payload of [{ memberId: 'someone-else' }, { balance: 1000 }]) await assert.rejects(env.call('points.wallet', payload, DEMO_IDENTITIES.member), { code: 'INVALID_INPUT' });
  await assert.rejects(env.call('staff.points.policy.save', { enabled: true, balance: 1000 }, DEMO_IDENTITIES.member, 0));
});

test('only owner permissions publish immutable policy versions and stale updates cannot overwrite the previous policy', async () => {
  const env = setup(); await env.policy(false);
  const head = await env.store.transaction(tx => getWalletPolicy(env.ctx('points.policy'), tx));
  assert.equal(head.version, 1); assert.equal(head.enabled, false);
  const version = env.store.snapshot().points_policy_versions[key('wallet-policy-version', 'oradv', 1)];
  await env.call('staff.points.policy.save', { enabled: true, defaultRewardMode: 'zero', ruleText: '新发布活动逐场核定兑换奖励。', reason: '更新规则' }, DEMO_IDENTITIES.owner, 1);
  assert.deepEqual(env.store.snapshot().points_policy_versions[key('wallet-policy-version', 'oradv', 1)], version);
  await assert.rejects(env.call('staff.points.policy.save', { enabled: false, defaultRewardMode: 'growth', ruleText: '旧页面', reason: '旧版本' }, DEMO_IDENTITIES.owner, 0), { code: 'CONFLICT_REFRESH' });
  for (const identity of [DEMO_IDENTITIES.member, DEMO_IDENTITIES.founder, DEMO_IDENTITIES.operator, DEMO_IDENTITIES.leader]) await assert.rejects(env.call('staff.points.policy.get', {}, identity), { code: 'FORBIDDEN' });
});

test('new activity rewards require an approved policy; old missing rewards never copy historical growth into a wallet', async () => {
  const env = setup();
  await assert.rejects(env.store.transaction(tx => activityWalletReward(env.ctx('staff.activity.save'), tx, 100)), { code: 'POLICY_NOT_CONFIGURED' });
  assert.deepEqual(await env.store.transaction(tx => activityWalletReward(env.ctx('staff.activity.save'), tx, undefined)), { redeemable: 0, walletPolicyVersion: 0 });
  await env.policy(false);
  assert.deepEqual(await env.store.transaction(tx => activityWalletReward(env.ctx('staff.activity.save'), tx, 80)), { redeemable: 80, walletPolicyVersion: 1 });
  const activity = env.store.snapshot().activities['intro-ride'] as Activity, before = env.store.snapshot();
  await env.store.transaction(tx => awardActivityWallet(env.ctx('staff.settlement.run'), tx, activity, {} as LedgerEntry));
  assert.deepEqual(env.store.snapshot(), before, 'old frozen activities have zero wallet reward even when the policy later exists');
});

test('explicit earned credits are source-idempotent, private and separate from growth, yearly totals and public rankings', async () => {
  const env = setup(); await env.policy(); const before = env.store.snapshot(); const { activity, entry } = await env.earn(80);
  const original = env.store.snapshot(); await env.store.transaction(tx => awardActivityWallet(env.ctx('staff.settlement.run'), tx, activity, entry));
  assert.deepEqual(env.store.snapshot(), original);
  const result = await env.call('points.wallet', {}, DEMO_IDENTITIES.member) as WalletOverview;
  assert.equal(result.balance, 80); assert.equal(result.available, 80); assert.equal(result.items.length, 1); assert.equal(result.member.id, env.memberId);
  assert.equal(JSON.stringify(result).includes('wxOpenId'), false); assert.equal(JSON.stringify(result).includes('actorId'), false);
  assert.deepEqual(env.store.snapshot().member_stats, before.member_stats); assert.deepEqual(env.store.snapshot().public_rankings, before.public_rankings);
  assert.equal((env.store.snapshot().points_ledger[entry.id] as LedgerEntry).growthDelta, 100);
});

test('forged or altered source records and ordinary-member award calls cannot create redeemable credits', async () => {
  const env = setup(); await env.policy(); const { activity, entry } = await env.earn();
  for (const altered of [{ ...entry, id: 'missing-source' }, { ...entry, memberId: 'forged-member' }, { ...entry, growthDelta: 9999 }]) {
    const before = env.store.snapshot();
    await assert.rejects(env.store.transaction(tx => awardActivityWallet(env.ctx('staff.settlement.run'), tx, activity, altered)));
    assert.deepEqual(env.store.snapshot(), before);
  }
  await assert.rejects(env.store.transaction(tx => awardActivityWallet(env.ctx('staff.settlement.run', {}, DEMO_IDENTITIES.member), tx, activity, entry)), { code: 'FORBIDDEN' });
});

test('an earning reversal deducts exactly the original wallet credit once, without using a changed reward or changing the annual source', async () => {
  const env = setup(); await env.policy(); const { activity, entry } = await env.earn(80);
  const reversal: LedgerEntry = { ...entry, id: key('reversal', entry.id), businessKey: key('reversal', entry.id), awardType: 'reversal', growthDelta: -100, annualDelta: -100, completedCountDelta: -1, relatedEntryId: entry.id, reason: '核验记录更正' };
  await env.store.transaction(async tx => {
    await tx.set('activities', activity.id, { ...activity, pointsRule: { ...activity.pointsRule, redeemable: 9999 } });
    await tx.set('points_ledger', reversal.id, reversal); await reverseActivityWallet(env.ctx('staff.points.reverse'), tx, entry, reversal);
  });
  const after = env.store.snapshot(); await env.store.transaction(tx => reverseActivityWallet(env.ctx('staff.points.reverse'), tx, entry, reversal)); assert.deepEqual(env.store.snapshot(), after);
  const wallet = after.points_accounts[walletAccountId('oradv', env.memberId)] as WalletAccount;
  assert.equal(wallet.balance, 0); assert.equal(wallet.held, 0); assert.equal(Object.keys(after.points_wallet_ledger).length, 2);
  assert.equal((after.points_wallet_ledger[walletSourceId('oradv', reversal.id)] as any).balanceDelta, -80);
  assert.equal((after.points_ledger[reversal.id] as LedgerEntry).year, 2026);
});

test('wallet credit and its source transaction roll back together when a ledger, account or audit write fails', async () => {
  for (const collection of ['points_wallet_ledger', 'points_accounts', 'audit_logs']) {
    const env = setup(); await env.policy(); const original = env.store.transaction.bind(env.store), before = env.store.snapshot();
    env.store.transaction = work => original(tx => work({ ...tx, set: async (name, id, value) => { if (name === collection) throw Error('injected write failure'); await tx.set(name, id, value); } }));
    await assert.rejects(env.earn()); assert.deepEqual(env.store.snapshot(), before);
  }
});
