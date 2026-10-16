import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '../../shared/context';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { key, memberIdFor, userIdFor } from '../../shared/models';
import type { Activity, LedgerEntry, TrustedIdentity } from '../../shared/types';
import { awardActivityWallet, dispatchWallet, reverseActivityWallet, walletAccountId } from '../../shared/points-wallet';
import { dispatchRedemptions } from '../../shared/redemptions';
import type { RedemptionItem, RedemptionRequest, RedemptionView, WalletAccount, WalletLedgerEntry, WalletOverview } from '../../shared/points-wallet-types';

const NOW = '2026-10-16T12:00:00.000Z';
async function setup() {
  const store = createDemoStore(NOW); let sequence = 0;
  const ctx = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity = DEMO_IDENTITIES.owner, expectedRevision?: number) => new Context(store,
    { now: () => NOW, id: () => `redemption-test-${++sequence}` }, { action, payload, expectedRevision, clubId: 'oradv', requestId: `redemption-rpc-${++sequence}` }, identity);
  const call = (action: string, payload: Record<string, unknown> = {}, identity?: TrustedIdentity, revision?: number): Promise<any> => action.startsWith('points.') || action.startsWith('staff.points.')
    ? dispatchWallet(ctx(action, payload, identity, revision)) : dispatchRedemptions(ctx(action, payload, identity, revision));
  await call('staff.points.policy.save', { enabled: true, defaultRewardMode: 'growth', ruleText: '核对领取或服务完成后核销。交付前可以取消。', reason: '核定内测兑换规则' }, DEMO_IDENTITIES.owner, 0);
  async function fund(amount = 100, identity = DEMO_IDENTITIES.member) {
    const memberId = memberIdFor('oradv', userIdFor(identity)), id = `funded-activity-${++sequence}`;
    const activity: Activity = { ...(store.snapshot().activities['intro-ride'] as Activity), id, state: 'ended', startAt: '2026-10-16T08:00:00.000Z', endAt: NOW,
      actualStartedAt: '2026-10-16T08:00:00.000Z', actualCompletedAt: NOW, pointsRule: { growth: 100, annual: 100, redeemable: amount, walletPolicyVersion: 1 } };
    const source: LedgerEntry = { id: key('oradv', id, memberId, 'completion'), businessKey: key('oradv', id, memberId, 'completion'), clubId: 'oradv', memberId, activityId: id,
      awardType: 'completion', growthDelta: 100, annualDelta: 100, completedCountDelta: 1, year: 2026, effectiveAt: NOW, ruleVersion: 1,
      relatedEntryId: null, actorId: userIdFor(DEMO_IDENTITIES.owner), reason: '完整核验后结算' };
    await store.transaction(async tx => { await tx.set('activities', id, activity); await tx.set('points_ledger', source.id, source); await awardActivityWallet(ctx('staff.settlement.run'), tx, activity, source); });
    return { activity, source };
  }
  function itemPayload(overrides: Record<string, unknown> = {}) { return { submissionId: `catalog-new-${++sequence}`, kind: 'goods', name: '俱乐部骑行手套', description: '单件物品，按已确认项目领取。',
    fulfillmentInstructions: '通过俱乐部既有渠道核对领取安排。', pointsCost: 40, totalStock: 2, sortOrder: 0, reason: '核对物品和库存', ...overrides }; }
  async function item(overrides: Record<string, unknown> = {}) {
    const draft = await call('staff.redemption.catalog.save', itemPayload(overrides), DEMO_IDENTITIES.owner, 0) as RedemptionItem;
    return call('staff.redemption.catalog.publish', { itemId: draft.id, reason: '核定项目内容与实际库存' }, DEMO_IDENTITIES.owner, draft.revision) as Promise<RedemptionItem>;
  }
  const intent = (item: RedemptionItem, overrides: Record<string, unknown> = {}) => ({ submissionId: `redemption-intent-${++sequence}`, itemId: item.id, offerVersion: item.offerVersion, policyVersion: 1, quantity: 1, ...overrides });
  const request = (item: RedemptionItem, identity = DEMO_IDENTITIES.member, overrides: Record<string, unknown> = {}) => call('redemption.request', intent(item, overrides), identity) as Promise<RedemptionView>;
  const change = (action: string, row: RedemptionView, extra: Record<string, unknown> = {}, identity = DEMO_IDENTITIES.owner) => call(`staff.redemption.${action}`, { redemptionId: row.id, reason: `核实后${action}`, ...extra }, identity, row.revision) as Promise<RedemptionView>;
  const wallet = (identity = DEMO_IDENTITIES.member) => call('points.wallet', {}, identity) as Promise<WalletOverview>;
  return { store, ctx, call, fund, item, itemPayload, intent, request, change, wallet };
}

test('unpriced drafts stay private, policy pause blocks new requests, and creating a draft is nonce-idempotent', async () => {
  const env = await setup(), payload = env.itemPayload({ pointsCost: 0, totalStock: 0 });
  const draft = await env.call('staff.redemption.catalog.save', payload, DEMO_IDENTITIES.owner, 0), before = env.store.snapshot();
  assert.equal(draft.status, 'draft'); assert.deepEqual((await env.call('redemption.catalog')).items, []);
  assert.equal((await env.call('staff.redemption.catalog.save', payload, DEMO_IDENTITIES.owner, 0)).id, draft.id); assert.deepEqual(env.store.snapshot(), before);
  await assert.rejects(env.call('staff.redemption.catalog.save', { ...payload, totalStock: 1 }, DEMO_IDENTITIES.owner, 0), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(env.call('staff.redemption.catalog.publish', { itemId: draft.id, reason: '尚无积分价格' }, DEMO_IDENTITIES.owner, draft.revision));
  const live = await env.item(); await env.fund();
  await env.call('staff.points.policy.save', { enabled: false, defaultRewardMode: 'growth', ruleText: '暂停新兑换，既有记录继续处理。', reason: '暂停新申请' }, DEMO_IDENTITIES.owner, 1);
  await assert.rejects(env.request(live), { code: 'REDEMPTION_PAUSED' });
});

test('an exact public item lookup proves current offer terms without exposing drafts or archived projects', async () => {
  const env = await setup(), draft = await env.call('staff.redemption.catalog.save', env.itemPayload(), DEMO_IDENTITIES.owner, 0);
  const before = env.store.snapshot();
  const hidden = await env.call('redemption.catalog', { itemId: draft.id }, DEMO_IDENTITIES.member);
  assert.deepEqual(hidden.items, []); assert.equal(hidden.nextCursor, null); assert.deepEqual(env.store.snapshot(), before);
  const published = await env.call('staff.redemption.catalog.publish', { itemId: draft.id, reason: '核定公开项目' }, DEMO_IDENTITIES.owner, draft.revision);
  await env.item({ name: '其他公开项目' });
  const selected = await env.call('redemption.catalog', { itemId: draft.id }, DEMO_IDENTITIES.member);
  assert.equal(selected.items.length, 1); assert.equal(selected.items[0].id, draft.id); assert.equal(selected.items[0].pointsCost, published.pointsCost);
  assert.equal(selected.items[0].name, published.name); assert.equal(selected.items[0].offerVersion, published.offerVersion); assert.equal(selected.nextCursor, null);
  assert(!('creationDigest' in selected.items[0])); assert(!('createdBy' in selected.items[0])); assert(!('reason' in selected.items[0]));
  await env.call('staff.redemption.catalog.archive', { itemId: draft.id, reason: '停止新申请' }, DEMO_IDENTITIES.owner, published.revision);
  assert.deepEqual((await env.call('redemption.catalog', { itemId: draft.id }, DEMO_IDENTITIES.member)).items, []);
  await assert.rejects(env.call('redemption.catalog', { itemId: 'not-present' }, DEMO_IDENTITIES.member), { code: 'NOT_FOUND' });
});

test('a request atomically reserves points and stock exactly once and never changes growth or annual scores', async () => {
  const env = await setup(); await env.fund(); const item = await env.item(), payload = env.intent(item), before = env.store.snapshot();
  const results = await Promise.all(Array.from({ length: 12 }, () => env.call('redemption.request', payload, DEMO_IDENTITIES.member)));
  assert(results.every(result => result.id === results[0].id));
  const wallet = await env.wallet(); assert.equal(wallet.balance, 100); assert.equal(wallet.held, 40); assert.equal(wallet.available, 60);
  const saved = env.store.snapshot().redemption_catalog[item.id] as RedemptionItem; assert.equal(saved.heldStock, 1); assert.equal(saved.fulfilledStock, 0); assert.equal(saved.offerVersion, item.offerVersion);
  assert.equal(Object.keys(env.store.snapshot().redemption_requests).length, 1); assert.equal(Object.keys(env.store.snapshot().points_wallet_ledger).length, 2);
  assert.deepEqual(env.store.snapshot().member_stats, before.member_stats); assert.deepEqual(env.store.snapshot().public_rankings, before.public_rankings);
  await assert.rejects(env.call('redemption.request', { ...payload, quantity: 2 }, DEMO_IDENTITIES.member));
  await assert.rejects(env.call('redemption.request', { ...payload, offerVersion: item.offerVersion + 1 }, DEMO_IDENTITIES.member), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('approval retains the hold, actual fulfillment consumes, and full refund cannot add points or stock twice', async () => {
  for (const restock of [false, true]) {
    const env = await setup(); await env.fund(); const item = await env.item(), request = await env.request(item);
    const approved = await env.change('approve', request); assert.equal((await env.wallet()).held, 40); assert.equal((await env.wallet()).balance, 100);
    const fulfilled = await env.change('fulfill', approved); assert.equal(fulfilled.state, 'fulfilled'); assert.equal((await env.wallet()).balance, 60); assert.equal((await env.wallet()).held, 0);
    assert.equal((await env.change('fulfill', approved)).id, fulfilled.id);
    const refunded = await env.change('refund', fulfilled, { restock }); assert.equal(refunded.state, 'refunded'); assert.equal((await env.wallet()).balance, 100);
    const before = env.store.snapshot(); await env.change('refund', fulfilled, { restock }); assert.deepEqual(env.store.snapshot(), before);
    const product = env.store.snapshot().redemption_catalog[item.id] as RedemptionItem;
    assert.equal(product.heldStock, 0); assert.equal(product.fulfilledStock, restock ? 0 : 1);
    assert.equal(Object.keys(env.store.snapshot().points_wallet_ledger).length, 4);
    await assert.rejects(env.call('redemption.cancel', { redemptionId: request.id, reason: '已交付不能普通取消' }, DEMO_IDENTITIES.member, refunded.revision));
  }
});

test('cancel and reject release one hold while another member and non-owner employees cannot operate it', async () => {
  for (const finish of ['cancel', 'reject']) {
    const env = await setup(); await env.fund(); const item = await env.item(), request = await env.request(item);
    await assert.rejects(env.call('redemption.get', { redemptionId: request.id }, DEMO_IDENTITIES.founder), { code: 'FORBIDDEN' });
    await assert.rejects(env.call('redemption.cancel', { redemptionId: request.id, reason: '不是本人' }, DEMO_IDENTITIES.founder, request.revision), { code: 'FORBIDDEN' });
    for (const identity of [DEMO_IDENTITIES.member, DEMO_IDENTITIES.founder, DEMO_IDENTITIES.operator, DEMO_IDENTITIES.leader]) await assert.rejects(env.change('approve', request, {}, identity), { code: 'FORBIDDEN' });
    const result = finish === 'cancel' ? await env.call('redemption.cancel', { redemptionId: request.id, reason: '本人安排改变' }, DEMO_IDENTITIES.member, request.revision) : await env.change('reject', request);
    assert.equal(result.state, finish === 'cancel' ? 'cancelled' : 'rejected'); assert.equal((await env.wallet()).available, 100);
    assert.equal((env.store.snapshot().redemption_catalog[item.id] as RedemptionItem).heldStock, 0);
  }
});

test('last stock and one member spending on two items cannot oversell or overdraw under concurrency', async () => {
  const env = await setup(); await env.fund(100); await env.fund(100, DEMO_IDENTITIES.founder);
  const last = await env.item({ pointsCost: 70, totalStock: 1 });
  const lastResults = await Promise.allSettled([env.request(last), env.request(last, DEMO_IDENTITIES.founder)]);
  assert.equal(lastResults.filter(row => row.status === 'fulfilled').length, 1); assert.equal((env.store.snapshot().redemption_catalog[last.id] as RedemptionItem).heldStock, 1);
  const other = await setup(); await other.fund(100); const a = await other.item({ pointsCost: 70 }), b = await other.item({ pointsCost: 70 });
  const balanceResults = await Promise.allSettled([other.request(a), other.request(b)]);
  assert.equal(balanceResults.filter(row => row.status === 'fulfilled').length, 1); assert.equal((await other.wallet()).available, 30);
});

test('concurrent stock changes retain offer version while a new price cannot rewrite an existing intent snapshot', async () => {
  const env = await setup(); await env.fund(500); const item = await env.item(), payload = env.intent(item), request = await env.call('redemption.request', payload, DEMO_IDENTITIES.member);
  const current = env.store.snapshot().redemption_catalog[item.id] as RedemptionItem;
  const edited = await env.call('staff.redemption.catalog.save', { itemId: item.id, kind: item.kind, name: '新版物品名称', description: item.description,
    fulfillmentInstructions: item.fulfillmentInstructions, pointsCost: 80, totalStock: 3, sortOrder: 0, reason: '核定新版积分价格' }, DEMO_IDENTITIES.owner, current.revision) as RedemptionItem;
  assert(edited.offerVersion > item.offerVersion);
  assert.equal((await env.call('redemption.request', payload, DEMO_IDENTITIES.member)).pointsCost, 40);
  await assert.rejects(env.request(item), { code: 'CONFLICT_REFRESH' });
  const fresh = await env.request(edited); assert.equal(fresh.pointsCost, 80); assert.equal(request.itemName, item.name);
  await assert.rejects(env.call('staff.redemption.catalog.save', { itemId: item.id, kind: item.kind, name: edited.name, description: edited.description,
    fulfillmentInstructions: edited.fulfillmentInstructions, pointsCost: 80, totalStock: 1, sortOrder: 0, reason: '不能删去预留库存' }, DEMO_IDENTITIES.owner, (env.store.snapshot().redemption_catalog[item.id] as RedemptionItem).revision), { code: 'STATE_CONFLICT' });
});

test('unknown committed request results are recovered by the same nonce without a second reservation', async () => {
  const env = await setup(); await env.fund(); const item = await env.item(), payload = env.intent(item), original = env.store.transaction.bind(env.store); let uncertain = true;
  env.store.transaction = async work => { const result = await original(work); if (uncertain) { uncertain = false; throw Error('unknown committed outcome'); } return result; };
  await assert.rejects(env.call('redemption.request', payload, DEMO_IDENTITIES.member));
  const found = await env.call('redemption.get', { submissionId: payload.submissionId }, DEMO_IDENTITIES.member); assert(found);
  const retried = await env.call('redemption.request', payload, DEMO_IDENTITIES.member); assert.equal(retried.id, found.id);
  assert.equal((await env.wallet()).held, 40); assert.equal(Object.keys(env.store.snapshot().redemption_requests).length, 1);
});

test('request writes and their audit roll back together on any failed ledger, account, inventory or request write', async () => {
  for (const failed of ['points_wallet_ledger', 'points_accounts', 'redemption_catalog', 'redemption_requests', 'audit_logs']) {
    const env = await setup(); await env.fund(); const item = await env.item(), before = env.store.snapshot(), original = env.store.transaction.bind(env.store);
    env.store.transaction = work => original(tx => work({ ...tx, set: async (collection, id, value) => { if (collection === failed) throw Error('injected failure'); await tx.set(collection, id, value); } }));
    await assert.rejects(env.request(item)); assert.deepEqual(env.store.snapshot(), before);
  }
});

test('reversing already consumed earnings preserves the deficit, blocks more spending, and a real refund reconciles it', async () => {
  const env = await setup(), { source } = await env.fund(80), item = await env.item({ pointsCost: 60 });
  const approved = await env.change('approve', await env.request(item)), fulfilled = await env.change('fulfill', approved);
  const reversal: LedgerEntry = { ...source, id: key('reversal', source.id), businessKey: key('reversal', source.id), awardType: 'reversal', growthDelta: -100, annualDelta: -100, completedCountDelta: -1, relatedEntryId: source.id, reason: '更正错误完成记录' };
  await env.store.transaction(async tx => { await tx.set('points_ledger', reversal.id, reversal); await reverseActivityWallet(env.ctx('staff.points.reverse'), tx, source, reversal); });
  const wallet = await env.wallet(); assert.equal(wallet.balance, -60); assert.equal(wallet.deficit, 60); assert.equal(wallet.available, 0); assert.equal(wallet.restricted, true);
  await assert.rejects(env.request(item), { code: 'WALLET_RESTRICTED' });
  await env.change('refund', fulfilled, { restock: true }); assert.equal((await env.wallet()).balance, 0); assert.equal((await env.wallet()).restricted, false);
});

test('a disabled member cannot consume but owner rejection can release their reserved resources', async () => {
  const env = await setup(); await env.fund(); const item = await env.item(), request = await env.request(item), userId = userIdFor(DEMO_IDENTITIES.member);
  await env.store.transaction(async tx => { const user = await tx.get<any>('users', userId); await tx.set('users', userId, { ...user, status: 'disabled' }); });
  await assert.rejects(env.change('approve', request), { code: 'FORBIDDEN' });
  await assert.rejects(env.call('redemption.cancel', { redemptionId: request.id, reason: '账号停用' }, DEMO_IDENTITIES.member, request.revision), { code: 'FORBIDDEN' });
  await env.change('reject', request); assert.equal((env.store.snapshot().points_accounts[walletAccountId('oradv', request.memberId)] as WalletAccount).held, 0);
  assert.equal((env.store.snapshot().redemption_catalog[item.id] as RedemptionItem).heldStock, 0);
});

test('mixed redemption sequences reconcile both wallet deltas and stock against authoritative request states', async () => {
  const env = await setup(); await env.fund(1000); const item = await env.item({ pointsCost: 10, totalStock: 100 });
  let random = 17; const choose = () => (random = (random * 48271) % 2147483647) % 4;
  for (let index = 0; index < 40; index++) {
    const request = await env.request(item), operation = choose();
    if (operation === 0) await env.call('redemption.cancel', { redemptionId: request.id, reason: '本人取消' }, DEMO_IDENTITIES.member, request.revision);
    else if (operation === 1) await env.change('reject', request);
    else { const fulfilled = await env.change('fulfill', await env.change('approve', request)); if (operation === 3) await env.change('refund', fulfilled, { restock: choose() % 2 === 0 }); }
    const snapshot = env.store.snapshot(), ledger = Object.values(snapshot.points_wallet_ledger) as WalletLedgerEntry[], account = snapshot.points_accounts[walletAccountId('oradv', request.memberId)] as WalletAccount;
    assert.equal(account.balance, ledger.reduce((sum, row) => sum + row.balanceDelta, 0)); assert.equal(account.held, ledger.reduce((sum, row) => sum + row.heldDelta, 0));
    const requests = Object.values(snapshot.redemption_requests) as RedemptionRequest[], product = snapshot.redemption_catalog[item.id] as RedemptionItem;
    assert.equal(product.heldStock, requests.filter(row => ['pending', 'approved'].includes(row.state)).length);
    assert.equal(product.fulfilledStock, requests.filter(row => row.state === 'fulfilled' || row.state === 'refunded' && !row.refundRestocked).length);
    assert(product.totalStock >= product.heldStock + product.fulfilledStock); assert(account.balance >= account.held);
  }
});
