import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createService } from '../../shared/service';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { key, userIdFor, memberIdFor } from '../../shared/models';
import type { Membership, User } from '../../shared/models';
import type { RpcResponse } from '../../shared/types';
const NOW = '2026-10-16T09:00:00.000Z';
const request = { action: 'profile.overview', payload: {}, clubId: 'oradv', requestId: 'profile-overview' };
const data = (result: RpcResponse): any => { assert.equal(result.ok, true, JSON.stringify(result)); return (result as any).data; };

test('profile overview reads one authorized member snapshot and exposes only dossier progress and a private avatar URL', async () => {
  const store = createDemoStore(NOW), identity = DEMO_IDENTITIES.member;
  const id = memberIdFor('oradv', userIdFor(identity));
  await store.transaction(async tx => {
    const member = await tx.get<Membership>('memberships', id); assert(member);
    await tx.set('memberships', id, { ...member, avatarFileId: 'private-file-marker' });
    await tx.set('member_dossiers', key('dossier', 'oradv', id), { id: key('dossier', 'oradv', id), clubId: 'oradv', memberId: id, kind: 'dossier', status: 'draft', revision: 1,
      draft: { riderName: '本人称呼', ridingExperience: '一年', contactMethod: 'wechat', contactValue: 'private-contact-marker', emergencyContact: null, gear: { helmet: null, armor: null, knee: null, boots: null }, bikes: [] }, submission: null, review: null });
  });
  const service = createService(store, { now: () => NOW, avatarStorage: { save: async () => '', remove: async () => {}, url: async file => { assert.equal(file, 'private-file-marker'); return 'https://private.example.test/avatar.png'; } } });
  const result = data(await service.handle(request, identity));
  assert.equal(result.member.id, id); assert.equal(result.dossier.ready, 3); assert.equal(result.dossier.total, 11);
  assert.equal(result.avatarUrl, 'https://private.example.test/avatar.png'); assert.equal(result.avatarError, '');
  assert.equal(result.dossier.parts.length, 6);
  assert(!JSON.stringify(result).includes('private-contact-marker')); assert(!JSON.stringify(result).includes('private-file-marker'));
  assert(!JSON.stringify(result).includes(identity.openId));
});

test('unregistered profile overview stays read only and never registers or grants roles', async () => {
  const store = createDemoStore(NOW), before = store.snapshot(), service = createService(store, { now: () => NOW });
  const result = data(await service.handle(request, { appId: DEMO_IDENTITIES.member.appId, openId: 'unregistered-overview' }));
  assert.equal(result.member, null); assert.equal(result.dossier, null); assert.equal(result.avatarUrl, '');
  assert.deepEqual(store.snapshot(), before);
  const forged = await service.handle({ ...request, payload: { memberId: 'someone-else', role: 'owner' } }, DEMO_IDENTITIES.member);
  assert.equal(forged.ok, false); if (!forged.ok) assert.equal(forged.error.code, 'INVALID_INPUT');
});

test('optional contact or avatar failures cannot leak SDK details or block the verified profile summary', async () => {
  const backing = createDemoStore(NOW), id = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  await backing.transaction(async tx => { const m = await tx.get<Membership>('memberships', id); await tx.set('memberships', id, { ...m!, avatarFileId: 'private-file-marker' }); });
  const store = { query: backing.query.bind(backing), transaction: <T>(work: any): Promise<T> => backing.transaction(tx => work({ ...tx, get: (collection: string, key: string) => { if (collection === 'clubs' && key === 'oradv') throw Error('private-sdk-contact-details'); return tx.get(collection, key); } })) };
  const service = createService(store, { now: () => NOW, avatarStorage: { save: async () => '', remove: async () => {}, url: async () => { throw Error('private-sdk-avatar-details'); } } });
  const result = data(await service.handle(request, DEMO_IDENTITIES.member));
  assert.equal(result.member.id, id); assert(result.contactError); assert(result.avatarError); assert.equal(result.avatarUrl, '');
  assert(result.dossier); assert(!JSON.stringify(result).includes('private-sdk')); assert(!JSON.stringify(result).includes('private-file-marker'));
});

test('avatar read rechecks actor and revision before returning a URL after an account change', async () => {
  for (const change of ['disabled', 'revision'] as const) {
    const store = createDemoStore(NOW), id = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
    await store.transaction(async tx => { const m = await tx.get<Membership>('memberships', id); await tx.set('memberships', id, { ...m!, avatarFileId: 'private-file-marker' }); });
    const service = createService(store, { now: () => NOW, avatarStorage: { save: async () => '', remove: async () => {}, url: async () => {
      await store.transaction(async tx => {
        if (change === 'disabled') { const userId = userIdFor(DEMO_IDENTITIES.member), u = await tx.get<User>('users', userId); await tx.set('users', userId, { ...u!, status: 'disabled' }); }
        else { const m = await tx.get<Membership>('memberships', id); await tx.set('memberships', id, { ...m!, revision: m!.revision + 1 }); }
      }); return 'https://private.example.test/stale.png';
    } } });
    const result = await service.handle(request, DEMO_IDENTITIES.member);
    assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('stale.png'));
  }
});
