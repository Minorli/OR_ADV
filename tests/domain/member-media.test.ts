import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../shared/context';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { key, memberIdFor, userIdFor } from '../../shared/models';
import { bindOwnedMemberMedia, cancelMemberMedia, getMemberMediaUrl, requireOwnedMemberMedia, saveMemberMediaImage, saveMemberMediaVideo } from '../../shared/member-media';
import type { MemberMediaAsset, MemberMediaStorage } from '../../shared/member-media-types';
import type { Membership, ServiceOptions, User } from '../../shared/models';
import type { Store } from '../../shared/store';
import type { TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-16T08:00:00.000Z';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=';
const memberId = (identity = DEMO_IDENTITIES.member) => memberIdFor('oradv', userIdFor(identity));
const pause = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function setup() {
  const store = createDemoStore(NOW), files = new Map<string, string>(), removed: string[] = [], logs: unknown[] = [];
  let serial = 0, requests = 0;
  const storage: MemberMediaStorage = {
    mode: 'local',
    async saveImage(member, asset, image) { const fileId = `private/${member}/${asset}/${++serial}`; files.set(fileId, image); return { fileId, bytes: Buffer.from(image, 'base64').length, mimeType: 'image/png' }; },
    async saveVideo(member, asset, source) { assert.equal(source, '/saved/actual.mp4'); const fileId = `private/${member}/${asset}/${++serial}`; files.set(fileId, 'actual-video-bytes'); return { fileId, bytes: 2400, mimeType: 'video/mp4' }; },
    async url(id) { assert(files.has(id)); return `https://private.example.test/${encodeURIComponent(id)}?signed`; },
    async remove(id) { removed.push(id); files.delete(id); },
  };
  const context = (payload: Record<string, unknown>, identity: TrustedIdentity | null = DEMO_IDENTITIES.member, requestId = `media-${++requests}`, actualStore: Store = store) =>
    new Context(actualStore, { now: () => NOW, memberMediaStorage: storage, log: entry => logs.push(entry) } as ServiceOptions,
      { action: 'media.image.save', payload, clubId: 'oradv', requestId }, identity);
  const image = (payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.member, requestId?: string) =>
    saveMemberMediaImage(context({ purpose: 'dossier', imageBase64: PNG, ...payload }, identity, requestId));
  return { store, storage, files, removed, logs, context, image };
}

test('private image assets persist independently of profile and expose summaries without file IDs or bytes', async () => {
  const ctx = setup(), before = ctx.store.snapshot().memberships[memberId()] as Membership;
  const asset = await ctx.image({ label: '头盔照片' });
  assert.equal(asset.kind, 'image'); assert.equal(asset.purpose, 'dossier'); assert.equal(asset.storageMode, 'local');
  assert.equal(asset.bytes, Buffer.from(PNG, 'base64').length);
  const row = ctx.store.snapshot().member_media[asset.id] as MemberMediaAsset;
  assert(ctx.files.has(row.fileId!)); assert.equal(row.status, 'ready');
  assert.equal((asset as any).fileId, undefined); assert.equal((asset as any).imageBase64, undefined);
  assert.deepEqual(ctx.store.snapshot().memberships[memberId()], before);
  const resolved = await getMemberMediaUrl(ctx.context({ assetId: asset.id }));
  assert(resolved.url.startsWith('https://private.example.test/'));
  assert(!JSON.stringify(ctx.store.snapshot()).includes(PNG));
  assert(!JSON.stringify(ctx.store.snapshot().audit_logs).includes(row.fileId!));
});

test('forged ownership, file IDs, purpose and untrusted public-rights claims fail closed', async () => {
  const ctx = setup();
  for (const payload of [{ memberId: memberId(DEMO_IDENTITIES.founder) }, { fileId: 'cloud://arbitrary' }, { bytes: 1 }, { purpose: 'medical' }]) {
    await assert.rejects(ctx.image(payload), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(ctx.image({}, null), { code: 'UNAUTHENTICATED' });
  await assert.rejects(ctx.image({ purpose: 'club_public', rightsAcknowledged: true }), { code: 'FORBIDDEN' });
  await assert.rejects(ctx.image({ purpose: 'club_public' }, DEMO_IDENTITIES.owner), { code: 'INVALID_INPUT' });
  const publicAsset = await ctx.image({ purpose: 'club_public', rightsAcknowledged: true }, DEMO_IDENTITIES.owner);
  assert.equal(publicAsset.purpose, 'club_public');
  assert.equal(ctx.files.size, 1);
});

test('only own ready purpose-matched assets bind to immutable submitted snapshots', async () => {
  const ctx = setup(), image = await ctx.image();
  await assert.rejects(ctx.store.transaction(tx => requireOwnedMemberMedia(tx, 'oradv', memberId(DEMO_IDENTITIES.founder), [image.id], 'dossier')), { code: 'FORBIDDEN' });
  await assert.rejects(ctx.store.transaction(tx => requireOwnedMemberMedia(tx, 'oradv', memberId(), [image.id], 'skill')), { code: 'FORBIDDEN' });
  await assert.rejects(ctx.store.transaction(tx => requireOwnedMemberMedia(tx, 'oradv', memberId(), [image.id, image.id], 'dossier')), { code: 'INVALID_INPUT' });
  await assert.rejects(getMemberMediaUrl(ctx.context({ assetId: image.id }, DEMO_IDENTITIES.owner)), { code: 'FORBIDDEN' });
  await ctx.store.transaction(tx => bindOwnedMemberMedia(tx, 'oradv', memberId(), [image.id], 'dossier', 'trusted-submission-1'));
  assert((await getMemberMediaUrl(ctx.context({ assetId: image.id }, DEMO_IDENTITIES.owner))).url);
  await assert.rejects(getMemberMediaUrl(ctx.context({ assetId: image.id }, DEMO_IDENTITIES.founder)), { code: 'FORBIDDEN' });
  await assert.rejects(cancelMemberMedia(ctx.context({ assetId: image.id })), { code: 'STATE_CONFLICT' });
  const row = ctx.store.snapshot().member_media[image.id] as MemberMediaAsset;
  assert.deepEqual(row.bindings, ['trusted-submission-1']); assert(ctx.files.has(row.fileId!));
});

test('repeated and concurrent finish requests retain one canonical file without overwriting it', async () => {
  const ctx = setup(), ready = pause(), release = pause(); let calls = 0;
  const original = ctx.storage.saveImage;
  ctx.storage.saveImage = async (...args) => { const saved = await original(...args); if (++calls === 2) ready.release(); await release.promise; return saved; };
  const first = ctx.image({}, undefined, 'same-request'), second = ctx.image({}, undefined, 'same-request');
  await ready.promise; release.release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].id, results[1].id); assert.equal(ctx.files.size, 1); assert.equal(ctx.removed.length, 1);
  const row = ctx.store.snapshot().member_media[results[0].id] as MemberMediaAsset;
  const retried = await ctx.image({}, undefined, 'same-request'); assert.equal(retried.id, row.id); assert.equal(calls, 2);
  await assert.rejects(ctx.image({ label: 'changed' }, undefined, 'same-request'), { code: 'STATE_CONFLICT' });
  assert.equal((ctx.store.snapshot().member_media[row.id] as MemberMediaAsset).fileId, row.fileId);
});

test('unknown transaction commit preserves the canonical file and identical retry recovers the asset', async () => {
  const ctx = setup(); let transaction = 0;
  const uncertain: Store = { query: ctx.store.query.bind(ctx.store), async transaction(work) {
    const result = await ctx.store.transaction(work);
    if (++transaction === 2) throw new Error('network result unknown after commit');
    return result;
  } };
  await assert.rejects(saveMemberMediaImage(ctx.context({ purpose: 'dossier', imageBase64: PNG }, undefined, 'uncertain', uncertain)), { code: 'TEMPORARY_FAILURE' });
  assert.equal(ctx.files.size, 1); assert.equal(ctx.removed.length, 0);
  const retried = await ctx.image({}, undefined, 'uncertain');
  assert.equal((ctx.store.snapshot().member_media[retried.id] as MemberMediaAsset).status, 'ready');
  assert.equal(ctx.files.size, 1);
});

test('cancellation and disabled actors during upload never finalize evidence', async () => {
  for (const mode of ['cancel', 'disabled']) {
    const ctx = setup(), entered = pause(), release = pause(), original = ctx.storage.saveImage;
    ctx.storage.saveImage = async (...args) => { const saved = await original(...args); entered.release(); await release.promise; return saved; };
    const pending = ctx.image({}, undefined, 'interrupted'); await entered.promise;
    const id = key('media', 'oradv', memberId(), 'interrupted');
    if (mode === 'cancel') await cancelMemberMedia(ctx.context({ assetId: id }));
    else await ctx.store.transaction(async tx => { const user = (await tx.get<User>('users', userIdFor(DEMO_IDENTITIES.member)))!; await tx.set('users', user.id, { ...user, status: 'disabled' }); });
    release.release(); await assert.rejects(pending, { code: mode === 'cancel' ? 'STATE_CONFLICT' : 'FORBIDDEN' });
    assert.notEqual((ctx.store.snapshot().member_media[id] as MemberMediaAsset).status, 'ready');
  }
});

test('provider errors, missing files and oversized video cannot become ready evidence', async () => {
  const ctx = setup();
  ctx.storage.saveImage = async () => { throw new Error('private-token-and-storage-path'); };
  await assert.rejects(ctx.image(), error => (error as any).code === 'TEMPORARY_FAILURE' && !String(error).includes('token'));
  ctx.storage.saveVideo = async () => ({ fileId: 'private/oversized', bytes: 8 * 1024 * 1024 + 1, mimeType: 'video/mp4' });
  await assert.rejects(saveMemberMediaVideo(ctx.context({ purpose: 'skill', sourcePath: '/saved/actual.mp4' })), { code: 'INVALID_INPUT' });
  assert(Object.values(ctx.store.snapshot().member_media).every(row => (row as MemberMediaAsset).status !== 'ready'));
  const valid = setup(), asset = await valid.image(); valid.storage.url = async () => { throw new Error('not found secret'); };
  await assert.rejects(getMemberMediaUrl(valid.context({ assetId: asset.id })), { code: 'TEMPORARY_FAILURE' });
});

test('cloud video unavailable is explicit and retryable, without issuing grants or fake assets', async () => {
  const ctx = setup(); Object.defineProperty(ctx.storage, 'mode', { value: 'cloud' });
  await assert.rejects(saveMemberMediaVideo(ctx.context({ purpose: 'skill', sourcePath: '/saved/actual.mp4' })),
    error => (error as any).code === 'MEDIA_VIDEO_UNAVAILABLE' && (error as any).retryable === true);
  assert.deepEqual(ctx.store.snapshot().member_media ?? {}, {}); assert.equal(ctx.files.size, 0);
});

test('unbound cancellation removes only its file and owner authorization is rechecked after signing', async () => {
  const ctx = setup(), a = await ctx.image(), b = await ctx.image();
  const removed = (ctx.store.snapshot().member_media[a.id] as MemberMediaAsset).fileId!;
  await cancelMemberMedia(ctx.context({ assetId: a.id })); assert(!ctx.files.has(removed)); assert.equal(ctx.files.size, 1);
  await assert.rejects(getMemberMediaUrl(ctx.context({ assetId: a.id })), { code: 'FORBIDDEN' });
  await assert.rejects(getMemberMediaUrl(ctx.context({ assetId: b.id, fileId: 'cloud://fake' })), { code: 'INVALID_INPUT' });
  await ctx.store.transaction(tx => bindOwnedMemberMedia(tx, 'oradv', memberId(), [b.id], 'dossier', 'submitted'));
  const original = ctx.storage.url;
  ctx.storage.url = async id => {
    const url = await original(id);
    await ctx.store.transaction(async tx => {
      const roleId = key('role', 'oradv', userIdFor(DEMO_IDENTITIES.owner), 'owner');
      const role = (await tx.get<any>('staff_roles', roleId))!; await tx.set('staff_roles', roleId, { ...role, enabled: false });
    });
    return url;
  };
  await assert.rejects(getMemberMediaUrl(ctx.context({ assetId: b.id }, DEMO_IDENTITIES.owner)), { code: 'FORBIDDEN' });
});
