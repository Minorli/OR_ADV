import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../shared/context';
import { MemoryStore } from '../../shared/memory-store';
import { demoSnapshot, DEMO_IDENTITIES } from '../../shared/demo';
import { key, memberIdFor, userIdFor } from '../../shared/models';
import { getDossier, listDossiers, reviewDossier, saveDossier, submitDossier } from '../../shared/dossier';
import { DOSSIER_CONSENT_VERSION, emptyDossierDraft } from '../../shared/dossier-types';
import type { DossierDraft } from '../../shared/dossier-types';
import type { TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-17T08:00:00.000Z';
function setup() {
  const store = new MemoryStore(demoSnapshot(NOW), () => NOW);
  let n = 0;
  const context = (who: TrustedIdentity | null, action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) =>
    new Context(store, { now: () => NOW }, { action, payload, expectedRevision, requestId: `dossier-test-${++n}`, clubId: 'oradv' }, who);
  return { store, context };
}
const memberId = (who: TrustedIdentity) => memberIdFor('oradv', userIdFor(who));
async function ready(store: MemoryStore, draft: DossierDraft, who = DEMO_IDENTITIES.member) {
  const owner = memberId(who);
  const assets = ['helmet', 'armor', 'knee', 'boots', 'bike-photo', 'bike-tire'];
  await store.transaction(async tx => {
    for (const name of assets) {
      const id = key('media', owner, name);
      await tx.set('member_media', id, { id, clubId: 'oradv', memberId: owner, purpose: 'dossier', kind: 'image', status: 'ready',
        userId: userIdFor(who), storageMode: 'local', fileId: `mock-private/${id}`, label: name, bytes: 100, mimeType: 'image/jpeg', rightsAcknowledged: false, requestDigest: 'fixture', revision: 1, createdAt: NOW, updatedAt: NOW, bindings: [] });
    }
  });
  const asset = (name: string) => key('media', owner, name);
  return { ...draft, riderName: '北向骑手', ridingExperience: '三年骑行，开始学习非铺装', contactValue: 'fictional_contact',
    gear: { helmet: asset('helmet'), armor: asset('armor'), knee: asset('knee'), boots: asset('boots') },
    bikes: [{ id: 'bike-one', brand: '测试品牌', model: 'ADV', year: '2023', plate: '', odometerKm: 12000, photoAssetId: asset('bike-photo'), tireAssetId: asset('bike-tire') }] };
}
const consent = { consent: true, consentVersion: DOSSIER_CONSENT_VERSION };

test('dossier drafts are private, revision checked and preserve partial editable fields', async () => {
  const { context, store } = setup();
  const initial = await getDossier(context(DEMO_IDENTITIES.member, 'dossier.mine'));
  assert.equal(initial.revision, 0); assert.equal(initial.status, 'draft');
  const draft = { ...emptyDossierDraft(), riderName: '未完成档案', emergencyContact: { name: '', phone: '', relationship: '' } };
  const saved = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, 0));
  assert.equal(saved.revision, 1); assert.equal(saved.draft.riderName, '未完成档案');
  assert.deepEqual((await getDossier(context(DEMO_IDENTITIES.member, 'dossier.mine'))).draft, draft);
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, 0)), { code: 'CONFLICT_REFRESH' });
  await assert.rejects(getDossier(context(DEMO_IDENTITIES.founder, 'staff.dossier.get', { memberId: saved.memberId }), true), { code: 'FORBIDDEN' });
  await assert.rejects(getDossier(context(null, 'dossier.mine')), { code: 'UNAUTHENTICATED' });
  await assert.rejects(getDossier(context(DEMO_IDENTITIES.member, 'dossier.mine', { memberId: memberId(DEMO_IDENTITIES.owner) })), { code: 'INVALID_INPUT' });
  assert.equal(Object.keys(store.snapshot().public_rankings ?? {}).some(k => k.includes('dossier')), false);
});

test('dossier submit requires real completeness, purpose consent and owned image assets without touching member authority', async () => {
  const { context, store } = setup();
  const before = store.snapshot();
  const empty = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: emptyDossierDraft() }, 0));
  await assert.rejects(submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, empty.revision)), { code: 'INVALID_INPUT' });
  const draft = await ready(store, emptyDossierDraft());
  const saved = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, empty.revision));
  await assert.rejects(submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', { ...consent, consent: false }, saved.revision)), { code: 'CONSENT_REQUIRED' });
  const pending = await submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, saved.revision));
  assert.equal(pending.status, 'pending'); assert.equal(pending.review, null);
  assert.deepEqual(pending.submission?.snapshot, draft);
  assert.equal(pending.submission?.submissionRevision, pending.revision);
  assert.equal(Object.values(store.snapshot().member_dossiers).filter((r: any) => r.kind === 'dossier_submission').length, 1);
  for (const collection of ['memberships', 'staff_roles', 'points_ledger', 'qualifications']) assert.deepEqual(store.snapshot()[collection], before[collection]);
});

test('owner review is bound to submitted revision, requires a return reason and edits invalidate previous approval', async () => {
  const { context, store } = setup();
  const draft = await ready(store, emptyDossierDraft());
  const saved = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, 0));
  const pending = await submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, saved.revision));
  const p = { memberId: pending.memberId, decision: 'approved', reason: '已与本人核对本次资料', submissionRevision: pending.submission!.submissionRevision };
  await assert.rejects(reviewDossier(context(DEMO_IDENTITIES.operator, 'staff.dossier.review', p, pending.revision)), { code: 'FORBIDDEN' });
  await assert.rejects(reviewDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', { ...p, submissionRevision: p.submissionRevision - 1 }, pending.revision)), { code: 'CONFLICT_REFRESH' });
  await assert.rejects(reviewDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', { ...p, decision: 'returned', reason: '' }, pending.revision)), { code: 'INVALID_INPUT' });
  const approved = await reviewDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', p, pending.revision));
  assert.equal(approved.status, 'approved'); assert.equal(approved.review!.decision, 'approved');
  const edited = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, ridingExperience: '修改后的经验' } }, approved.revision));
  assert.equal(edited.status, 'draft'); assert.equal(edited.review, null);
  assert.deepEqual(edited.submission?.snapshot, draft, 'old snapshot is not overwritten by draft changes');
  await assert.rejects(reviewDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', p, edited.revision)), { code: 'STATE_CONFLICT' });
  const resubmitted = await submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, edited.revision));
  const returned = await reviewDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', { ...p, decision: 'returned', reason: '轮胎照片需要重新拍摄', submissionRevision: resubmitted.submission!.submissionRevision }, resubmitted.revision));
  assert.equal(returned.review!.reason, '轮胎照片需要重新拍摄');
  const history = Object.values(store.snapshot().member_dossiers).filter((r: any) => r.kind === 'dossier_submission') as any[];
  assert.equal(history.length, 2); assert.equal(history[0].review.decision, 'approved');
});

test('draft rejects forged metadata, foreign media, duplicate bikes and more than three bikes', async () => {
  const { context, store } = setup();
  const draft = await ready(store, emptyDossierDraft());
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft, status: 'approved' }, 0)), { code: 'INVALID_INPUT' });
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, identityNumber: 'forbidden' } }, 0)), { code: 'INVALID_INPUT' });
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, gear: { ...draft.gear, helmet: 'cloud://arbitrary-client-file' } } }, 0)));
  const other = await ready(store, emptyDossierDraft(), DEMO_IDENTITIES.founder);
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, gear: other.gear } }, 0)), { code: 'FORBIDDEN' });
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, bikes: [draft.bikes[0], draft.bikes[0]] } }, 0)), { code: 'INVALID_INPUT' });
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, bikes: Array.from({ length: 4 }, (_, i) => ({ ...draft.bikes[0], id: `bike-${i}` })) } }, 0)), { code: 'INVALID_INPUT' });
  assert.equal(store.snapshot().member_dossiers, undefined);
});

test('queue pages expose only owner review summaries and stale edits cannot be approved concurrently', async () => {
  const { context, store } = setup();
  const draft = await ready(store, emptyDossierDraft());
  const saved = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, 0));
  const pending = await submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, saved.revision));
  await assert.rejects(listDossiers(context(DEMO_IDENTITIES.operator, 'staff.dossier.list')), { code: 'FORBIDDEN' });
  const queue = await listDossiers(context(DEMO_IDENTITIES.owner, 'staff.dossier.list'));
  assert.equal(queue.items.length, 1);
  assert(!JSON.stringify(queue).includes('fictional_contact'));
  const result = await Promise.allSettled([
    saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, riderName: '新版本' } }, pending.revision)),
    reviewDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', { memberId: pending.memberId, decision: 'approved', reason: '核对完成', submissionRevision: pending.submission!.submissionRevision }, pending.revision)),
  ]);
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await getDossier(context(DEMO_IDENTITIES.member, 'dossier.mine'))).status, 'draft');
});

test('owner cannot read an unsubmitted private draft and unchanged saves preserve approved review', async () => {
  const { context, store } = setup();
  const draft = await ready(store, emptyDossierDraft());
  const saved = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, 0));
  const lookup = () => getDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.get', { memberId: saved.memberId }), true);
  await assert.rejects(lookup, { code: 'STATE_CONFLICT' });
  const pending = await submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, saved.revision));
  assert.deepEqual((await lookup()).draft, draft);
  const approved = await reviewDossier(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', { memberId: saved.memberId, decision: 'approved', reason: '核对本次资料', submissionRevision: pending.submission!.submissionRevision }, pending.revision));
  const unchanged = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, approved.revision));
  assert.deepEqual(unchanged, approved, 'saving unchanged fields does not revoke a valid review');
  await assert.rejects(lookup, { code: 'STATE_CONFLICT' });
});

test('each vehicle requires its own tire field and wrong-purpose or video evidence is rejected', async () => {
  const { context, store } = setup();
  const draft = await ready(store, emptyDossierDraft());
  const saved = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft: { ...draft, bikes: [...draft.bikes, { ...draft.bikes[0], id: 'second-bike', tireAssetId: null }] } }, 0));
  await assert.rejects(submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, saved.revision)), { code: 'INVALID_INPUT' });
  const id = draft.gear.helmet!;
  await store.transaction(async tx => { const row = await tx.get<any>('member_media', id); await tx.set('member_media', id, { ...row, kind: 'video', mimeType: 'video/mp4' }); });
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, saved.revision)), { code: 'INVALID_INPUT' });
  await store.transaction(async tx => { const row = await tx.get<any>('member_media', id); await tx.set('member_media', id, { ...row, kind: 'image', mimeType: 'image/jpeg', purpose: 'skill' }); });
  await assert.rejects(saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, saved.revision)), { code: 'FORBIDDEN' });
});

test('failed submission or review audit rolls back media binding, snapshot and conclusion together', async () => {
  const { context, store } = setup();
  const draft = await ready(store, emptyDossierDraft());
  const saved = await saveDossier(context(DEMO_IDENTITIES.member, 'dossier.save', { draft }, 0));
  const fault = (ctx: Context) => new Context({ query: store.query.bind(store), transaction: work => store.transaction(tx => work({ ...tx,
    set: async (collection, id, value) => { if (collection === 'audit_logs') throw new Error('injected audit failure'); return tx.set(collection, id, value); },
  })) }, { now: () => NOW }, ctx.request, ctx.identity);
  const before = store.snapshot();
  await assert.rejects(submitDossier(fault(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, saved.revision))), /audit failure/);
  assert.deepEqual(store.snapshot(), before);
  const pending = await submitDossier(context(DEMO_IDENTITIES.member, 'dossier.submit', consent, saved.revision)), submitted = store.snapshot();
  await assert.rejects(reviewDossier(fault(context(DEMO_IDENTITIES.owner, 'staff.dossier.review', { memberId: saved.memberId, decision: 'approved', reason: '核对资料', submissionRevision: pending.submission!.submissionRevision }, pending.revision))), /audit failure/);
  assert.deepEqual(store.snapshot(), submitted);
});
