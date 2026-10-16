import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import type { Activity, RpcResponse, TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-16T12:00:00.000Z';
function setup() {
  const store = createDemoStore(NOW); let seq = 0;
  const service = createService(store, { now: () => NOW, id: () => `activity-management-${++seq}` });
  const call = (payload: Record<string, unknown>, revision: number = 1, identity: TrustedIdentity | null = DEMO_IDENTITIES.owner) => service.handle({ action: 'staff.activity.content.save', payload, expectedRevision: revision, clubId: 'oradv', requestId: `request-${++seq}` }, identity);
  return { store, call, service };
}
function result(response: RpcResponse): Activity { assert(response.ok, JSON.stringify(response)); return response.data as Activity; }
function error(response: RpcResponse, code: string) { assert(!response.ok, JSON.stringify(response)); assert.equal(response.error.code, code); }
const content = { activityId: 'intro-ride', title: '雨后林道同行', description: '更新活动介绍中的集合提示。具体集合安排请查看已确认参加者的行前说明。', reason: '修正标题与活动介绍的错别字' };

test('published and historical wording corrections preserve every frozen operational rule and record bounded before/after audit', async () => {
  for (const state of ['published', 'closed', 'in_progress', 'ended', 'settled', 'cancelled'] as const) {
    const ctx = setup();
    await ctx.store.transaction(async tx => { const row = (await tx.get<Activity>('activities', 'intro-ride'))!; await tx.set('activities', row.id, { ...row, state, reservedSeats: 3, nextQueueSeq: 7 }); });
    const before = ctx.store.snapshot().activities['intro-ride'] as Activity;
    const saved = result(await ctx.call(content)); assert.equal(saved.state, state); assert.equal(saved.ruleVersion, before.ruleVersion); assert.equal(saved.revision, before.revision + 1);
    const after = ctx.store.snapshot().activities['intro-ride'] as Activity;
    assert.deepEqual({ ...after, title: before.title, description: before.description, revision: before.revision }, before);
    const audits = Object.values(ctx.store.snapshot().audit_logs) as any[];
    const audit = audits.find(row => row.action === 'staff.activity.content.save'); assert(audit);
    assert.equal(audit.reason, content.reason); assert.equal(audit.summary.before.title, before.title); assert.equal(audit.summary.after.title, content.title);
    assert(audit.summary.before.description.length <= 4000); assert(audit.summary.after.description.length <= 4000);
    assert.equal(Object.keys(ctx.store.snapshot().points_ledger || {}).length, 0);
  }
});

test('only owner and operator may correct public wording; revisions, reason, field allowlist and state are mandatory', async () => {
  for (const identity of [DEMO_IDENTITIES.member, DEMO_IDENTITIES.founder, DEMO_IDENTITIES.leader, DEMO_IDENTITIES.checkin, null]) {
    const ctx = setup(); error(await ctx.call(content, 1, identity), identity ? 'FORBIDDEN' : 'UNAUTHENTICATED');
    assert.equal((ctx.store.snapshot().activities['intro-ride'] as Activity).revision, 1);
  }
  const operator = setup(); assert.equal(result(await operator.call(content, 1, DEMO_IDENTITIES.operator)).title, content.title);
  for (const [payload, revision, code] of [
    [content, 99, 'CONFLICT_REFRESH'], [{ ...content, reason: '' }, 1, 'INVALID_INPUT'], [{ ...content, title: 'x'.repeat(81) }, 1, 'INVALID_INPUT'],
    [{ ...content, description: 'x'.repeat(4001) }, 1, 'INVALID_INPUT'], [{ ...content, pointsRule: { growth: 9999, annual: 9999 } }, 1, 'INVALID_INPUT'],
    [{ ...content, capacity: 199 }, 1, 'INVALID_INPUT'], [{ ...content, startAt: NOW }, 1, 'INVALID_INPUT'], [{ ...content, equipment: '修改条件' }, 1, 'INVALID_INPUT'],
    [{ ...content, activityId: 'draft-ride' }, 1, 'STATE_CONFLICT'],
  ] as const) { const ctx = setup(); error(await ctx.call(payload, revision), code); assert.equal(Object.keys(ctx.store.snapshot().audit_logs || {}).length, 0); }
});

test('published corrections never reopen full draft editing or let a stale page overwrite a newer correction', async () => {
  const ctx = setup();
  const full = await ctx.service.handle({ action: 'staff.activity.save', payload: { id: 'intro-ride', title: '不可重写已发布规则' }, expectedRevision: 1, clubId: 'oradv', requestId: 'full-save-frozen' }, DEMO_IDENTITIES.owner);
  error(full, 'STATE_CONFLICT');
  const latest = result(await ctx.call(content));
  error(await ctx.call({ ...content, description: '另一个旧页面的说明' }, 1), 'CONFLICT_REFRESH');
  assert.equal((ctx.store.snapshot().activities['intro-ride'] as Activity).description, latest.description);
});
