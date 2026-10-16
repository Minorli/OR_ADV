import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../../shared/service';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import type { Activity, MemberSummary, RpcRequest } from '../../shared/types';

const now = '2026-10-16T12:00:00.000Z';
function setup() {
  const store = createDemoStore(now), service = createService(store, { now: () => now }); let count = 0;
  const rpc = (action: string, payload: Record<string, unknown> = {}, viewerMode?: unknown, expectedRevision?: number) => service.handle({ action, payload, clubId: 'oradv', requestId: `viewer-${++count}`, ...(viewerMode === undefined ? {} : { viewerMode }), expectedRevision } as RpcRequest, DEMO_IDENTITIES.owner);
  return { store, rpc };
}
test('a guest viewer can only reduce the trusted owner identity and cannot read or mutate private records', async () => {
  const { store, rpc } = setup();
  const before = await rpc('identity.me'); assert(before.ok); const owner = before.data as MemberSummary;
  const snapshot = store.snapshot();
  for (const [action, payload] of [
    ['registration.mine', {}], ['points.mine', {}], ['dossier.mine', {}], ['skills.mine', {}], ['profile.avatar.get', {}],
    ['staff.member.list', {}], ['staff.activity.list', {}], ['profile.update', { nickname: '不可生效的改名' }],
    ['staff.roles.assign', { memberId: owner.id, role: 'owner', enabled: false, reason: '不可生效' }],
  ] as const) {
    const result = await rpc(action, payload, 'guest'); assert.equal(result.ok, false, action);
    if (!result.ok) assert.ok(['UNAUTHENTICATED', 'FORBIDDEN'].includes(result.error.code), `${action}: ${result.error.code}`);
  }
  const me = await rpc('identity.me', {}, 'guest'); assert(me.ok); assert.equal(me.data, null);
  const overview = await rpc('profile.overview', {}, 'guest'); assert(overview.ok);
  assert.equal((overview.data as any).member, null); assert.equal((overview.data as any).dossier, null); assert.equal((overview.data as any).statistics, null); assert.equal((overview.data as any).avatarUrl, '');
  assert.deepEqual(store.snapshot(), snapshot, 'reducing the view neither deletes nor mutates the owner records');
  const restored = await rpc('identity.ensure', { consentVersions: { privacy: 1, terms: 1 } }); assert(restored.ok); assert.equal((restored.data as MemberSummary).id, owner.id);
});
test('guest activity reads cannot inherit owner access to unpublished drafts', async () => {
  const { store, rpc } = setup();
  const sample = Object.values(store.snapshot().activities)[0] as Activity;
  const draft = { ...sample, id: 'viewer-private-draft', state: 'draft' as const };
  await store.transaction(tx => tx.set('activities', draft.id, draft));
  const privateRead = await rpc('activity.get', { activityId: draft.id }); assert(privateRead.ok);
  const guestRead = await rpc('activity.get', { activityId: draft.id }, 'guest'); assert.equal(guestRead.ok, false);
  const publicList = await rpc('activity.list', {}, 'guest'); assert(publicList.ok); assert(!(publicList.data as any).items.some((row: Activity) => row.id === draft.id));
});
test('the service rejects malformed viewer modes rather than interpreting them as an authenticated view', async () => {
  const { rpc } = setup();
  for (const mode of [null, false, true, '', 'owner', 'authenticated', {}, ['guest']]) {
    const result = await rpc('identity.me', {}, mode); assert.equal(result.ok, false, JSON.stringify(mode));
    if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT');
  }
});
test('bounded full-size activity display fields cross the relaxed envelope but keep field-level validation', async () => {
  const { store, rpc } = setup();
  const sample = Object.values(store.snapshot().activities)[0] as Activity;
  const payload = { activityId: sample.id, title: sample.title, description: '路'.repeat(4000), reason: '完善已核实的行程介绍',
    itinerary: Array.from({ length: 30 }, (_, index) => ({ dayLabel: `第${index + 1}段`, title: '路线'.repeat(50), description: '说明'.repeat(200) })) };
  const valid = await rpc('staff.activity.content.save', payload, undefined, sample.revision); assert.equal(valid.ok, true, JSON.stringify(valid));
  const invalid = await rpc('staff.activity.content.save', { ...payload, description: '路'.repeat(4001) }, undefined, sample.revision + 1); assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_INPUT');
});
