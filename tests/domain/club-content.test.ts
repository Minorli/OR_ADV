import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { emptyClubContent } from '../../shared/club-content';
import type { ClubContentSection } from '../../shared/club-content-types';
import type { Store, Transaction } from '../../shared/store';

function setup(store = createDemoStore()) {
  let n = 0;
  const service = createService(store, { now: () => '2026-10-16T08:00:00.000Z', id: () => 'content-' + (++n) });
  async function rpc(who: keyof typeof DEMO_IDENTITIES | null, action: string, payload: Record<string, unknown> = {}, revision?: number) {
    return service.handle({ action, payload, expectedRevision: revision, clubId: 'oradv', requestId: 'request-' + (++n) }, who ? DEMO_IDENTITIES[who] : null);
  }
  return { store, rpc };
}
const content = (selected: ClubContentSection, extra = {}) => ({ ...emptyClubContent(selected), introduction: '已核实的栏目内容', ...extra });

test('club content drafts stay private; publishing needs owner rights and stale edits cannot overwrite', async () => {
  const { rpc } = setup();
  const draft = content('handbook', { blocks: [{ heading: '集合与沟通', body: '阅读本场已发布安排。' }] });
  assert.equal((await rpc('member', 'staff.club.content.save', { section: 'handbook', content: draft, status: 'draft' }, 0)).ok, false);
  const saved = await rpc('owner', 'staff.club.content.save', { section: 'handbook', content: draft, status: 'draft' }, 0);
  assert(saved.ok);
  const hidden = await rpc(null, 'club.content.get', { section: 'handbook' }); assert(hidden.ok); assert.equal((hidden.data as any).configured, false); assert.deepEqual((hidden.data as any).blocks, []);
  const noRights = await rpc('owner', 'staff.club.content.save', { section: 'handbook', content: draft, status: 'published' }, 1);
  assert(!noRights.ok); assert.equal(noRights.error.code, 'CONSENT_REQUIRED');
  const published = await rpc('owner', 'staff.club.content.save', { section: 'handbook', content: draft, status: 'published', rightsAcknowledged: true }, 1); assert(published.ok);
  const publicView = await rpc(null, 'club.content.get', { section: 'handbook' }); assert(publicView.ok);
  assert.equal((publicView.data as any).configured, true); assert.equal((publicView.data as any).blocks[0].body, '阅读本场已发布安排。');
  for (const field of ['id', 'clubId', 'updatedBy', 'memberId', 'actorId']) assert.equal(field in (publicView.data as any), false);
  const stale = await rpc('owner', 'staff.club.content.save', { section: 'handbook', content: draft, status: 'draft' }, 1); assert(!stale.ok); assert.equal(stale.error.code, 'CONFLICT_REFRESH');
  assert((await rpc('owner', 'staff.club.content.save', { section: 'handbook', content: draft, status: 'draft' }, 2)).ok);
  const withdrawn = await rpc(null, 'club.content.get', { section: 'handbook' }); assert(withdrawn.ok); assert.equal((withdrawn.data as any).configured, false);
});

test('public duty titles do not grant privileges and content cannot carry points, payment or arbitrary identity fields', async () => {
  const { rpc, store } = setup();
  const before = store.snapshot();
  const core = content('core', { people: [{ name: '内测成员', duty: '主理人', introduction: '公开职责介绍', responsibilities: ['沟通活动安排'] }] });
  assert((await rpc('owner', 'staff.club.content.save', { section: 'core', content: core, status: 'published', rightsAcknowledged: true }, 0)).ok);
  assert.equal((await rpc('member', 'staff.club.content.get', { section: 'core' })).ok, false);
  assert.deepEqual(store.snapshot().staff_roles, before.staff_roles); assert.deepEqual(store.snapshot().member_stats, before.member_stats);
  for (const changed of [
    content('redemption', { offers: [{ id: 'one', name: '项目', description: '说明', pointsCost: 20 }] }),
    content('contacts', { contacts: [{ label: '组织方', name: '内测', method: 'phone', value: 'javascript:alert(1)', hours: '', note: '' }] }),
    { ...content('handbook'), owner: true },
    content('core', { people: [{ name: '内测', duty: '领队', introduction: '', responsibilities: [], memberId: 'other' }] }),
  ]) {
    const section = (changed as any).offers?.length ? 'redemption' : (changed as any).contacts?.length ? 'contacts' : (changed as any).people?.length ? 'core' : 'handbook';
    const result = await rpc('owner', 'staff.club.content.save', { section, content: changed, status: 'draft' }, 0);
    assert(!result.ok); assert.equal(result.error.code, 'INVALID_INPUT');
  }
});

test('private inquiries are idempotent, actor-scoped, owner-processed and never alter points or inventory', async () => {
  const { rpc, store } = setup(); const before = store.snapshot();
  const input = { kind: 'business', contact: '演示联系方法', message: '希望沟通合作安排', consent: true, submissionId: 'stable-submit-one' };
  const created = await rpc('member', 'club.inquiry.submit', input); assert(created.ok);
  const repeated = await rpc('member', 'club.inquiry.submit', input); assert(repeated.ok); assert.equal((repeated.data as any).id, (created.data as any).id);
  const reused = await rpc('member', 'club.inquiry.submit', { ...input, message: '不同内容' }); assert(!reused.ok); assert.equal(reused.error.code, 'REQUEST_REUSED');
  const own = await rpc('member', 'club.inquiry.mine'); assert(own.ok); assert.equal((own.data as any).items.length, 1);
  const other = await rpc('founder', 'club.inquiry.mine'); assert(other.ok); assert.deepEqual((other.data as any).items, []);
  assert.equal((await rpc(null, 'club.inquiry.mine')).ok, false); assert.equal((await rpc('operator', 'staff.club.inquiry.list')).ok, false);
  const owner = await rpc('owner', 'staff.club.inquiry.list'); assert(owner.ok); assert.equal((owner.data as any).items[0].contact, input.contact);
  const id = (created.data as any).id;
  assert.equal((await rpc('founder', 'club.inquiry.withdraw', { id }, 1)).ok, false);
  const closed = await rpc('owner', 'staff.club.inquiry.review', { id, reply: '已记录，后续通过所留方式沟通。' }, 1); assert(closed.ok); assert.equal((closed.data as any).state, 'closed');
  assert.equal((await rpc('member', 'club.inquiry.withdraw', { id }, 1)).ok, false);
  assert.deepEqual(store.snapshot().member_stats, before.member_stats); assert.deepEqual(store.snapshot().points_ledger, before.points_ledger);
});

test('redemption consultation refers to current published offers without claiming a points deduction', async () => {
  const { rpc, store } = setup();
  const draft = content('redemption', { offers: [{ id: 'gloves', name: '手套咨询', description: '可向组织方核实可用项目及处理办法。' }] });
  const input = { kind: 'redemption', offerId: 'gloves', contact: '演示联系', message: '请说明目前的处理办法', consent: true, submissionId: 'offer-inquiry-one' };
  assert.equal((await rpc('member', 'club.inquiry.submit', input)).ok, false);
  assert((await rpc('owner', 'staff.club.content.save', { section: 'redemption', content: draft, status: 'published', rightsAcknowledged: true }, 0)).ok);
  const before = store.snapshot(); const result = await rpc('member', 'club.inquiry.submit', input); assert(result.ok); assert.equal((result.data as any).offerName, '手套咨询');
  assert.deepEqual(store.snapshot().member_stats, before.member_stats); assert.deepEqual(store.snapshot().club_content, before.club_content);
  assert(!('pointsDeducted' in (result.data as any)));
});

test('inquiry quota, consent and withdrawal are enforced from actual records', async () => {
  const { rpc } = setup();
  const p = { kind: 'business', contact: '演示联系', message: '咨询', submissionId: 'inquiry-zero', consent: false };
  const denied = await rpc('member', 'club.inquiry.submit', p); assert(!denied.ok); assert.equal(denied.error.code, 'CONSENT_REQUIRED');
  let id = '';
  for (let i = 0; i < 5; i++) { const result = await rpc('member', 'club.inquiry.submit', { ...p, submissionId: 'inquiry-number-' + i, consent: true }); assert(result.ok); id = (result.data as any).id; }
  const limited = await rpc('member', 'club.inquiry.submit', { ...p, submissionId: 'inquiry-sixth', consent: true }); assert(!limited.ok); assert.equal(limited.error.code, 'RATE_LIMITED');
  const withdrawn = await rpc('member', 'club.inquiry.withdraw', { id }, 1); assert(withdrawn.ok); assert.equal((withdrawn.data as any).state, 'withdrawn');
});

test('content and inquiry changes roll back with failed audit instead of leaving unaudited private writes', async () => {
  const memory = createDemoStore(), before = memory.snapshot();
  const store: Store = { query: memory.query.bind(memory), transaction: work => memory.transaction(tx => work({ get: tx.get.bind(tx), set: async (collection, id, value) => { if (collection === 'audit_logs') throw new Error('audit unavailable'); await tx.set(collection, id, value); } } as Transaction)) };
  const service = createService(store);
  for (const request of [
    { action: 'staff.club.content.save', payload: { section: 'handbook', content: content('handbook'), status: 'draft' }, expectedRevision: 0, who: DEMO_IDENTITIES.owner },
    { action: 'club.inquiry.submit', payload: { kind: 'business', contact: '演示联系', message: '咨询', consent: true, submissionId: 'rollback-one' }, expectedRevision: undefined, who: DEMO_IDENTITIES.member },
  ]) { const response = await service.handle({ ...request, clubId: 'oradv', requestId: 'rollback' }, request.who); assert(!response.ok); assert.equal(response.error.code, 'TEMPORARY_FAILURE'); }
  assert.deepEqual(memory.snapshot(), before);
});
