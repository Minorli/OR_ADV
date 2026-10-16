import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { memberIdFor, userIdFor } from '../../shared/models';
import type { AvatarStorage, Membership } from '../../shared/models';
import type { MemberSummary, RpcResponse, TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-16T08:00:00.000Z';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=';
// A two-pixel JPEG generated from a solid colour, without personal metadata.
const JPEG = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAAAwQQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCDAElf/9k=';
function data<T = any>(response: RpcResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { data: T }).data;
}
function error(response: RpcResponse, code: string) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal((response as { error: { code: string } }).error.code, code);
}
function setup() {
  const store = createDemoStore(NOW);
  const files = new Map<string, string>();
  const saved: string[] = [], removed: string[] = [], logs: unknown[] = [];
  let serial = 0;
  const provider: AvatarStorage = {
    save: async (memberId, image) => { const id = `private-avatar/${memberId}/${++serial}`; files.set(id, image); saved.push(id); return id; },
    url: async fileId => { assert(files.has(fileId)); return `https://private.example.test/${encodeURIComponent(fileId)}?short-lived`; },
    remove: async fileId => { removed.push(fileId); files.delete(fileId); },
  };
  const service = createService(store, { now: () => NOW, avatarStorage: provider, log: entry => logs.push(entry) });
  let sequence = 0;
  const call = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.member, expectedRevision?: number) =>
    service.handle({ action, payload, expectedRevision, clubId: 'oradv', requestId: `avatar-${++sequence}` }, identity);
  return { store, provider, saved, removed, files, logs, call };
}

test('avatar save atomically updates own nickname and private reference without exposing images or file IDs', async () => {
  const ctx = setup();
  const before = data<MemberSummary>(await ctx.call('identity.me'));
  assert.equal(data(await ctx.call('profile.avatar.get')).url, null);
  const after = data<MemberSummary>(await ctx.call('profile.avatar.save', { imageBase64: PNG, nickname: '阿川的新昵称' }, undefined, before.revision));
  assert.equal(after.nickname, '阿川的新昵称');
  assert.equal(after.hasAvatar, true);
  assert.equal(after.revision, before.revision + 1);
  assert.equal((after as any).avatarFileId, undefined);
  assert.equal((after as any).avatarUrl, undefined);
  assert.equal((after as any).imageBase64, undefined);
  const own = data(await ctx.call('profile.avatar.get'));
  assert(own.url.startsWith('https://private.example.test/'));
  const other = data(await ctx.call('profile.avatar.get', {}, DEMO_IDENTITIES.founder));
  assert.equal(other.url, null);
  const snapshot = ctx.store.snapshot();
  assert(!JSON.stringify(snapshot.public_rankings).includes('private-avatar'));
  assert(!JSON.stringify(snapshot.public_recommendations).includes('private-avatar'));
  assert(!JSON.stringify(snapshot.audit_logs).includes('private-avatar'));
  assert(!JSON.stringify(snapshot).includes(PNG));
});

test('avatar endpoints reject identity spoofing, forbidden fields and stale revisions before storage work', async () => {
  const ctx = setup();
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG }, null, 1), 'UNAUTHENTICATED');
  error(await ctx.call('profile.avatar.get', {}, null), 'UNAUTHENTICATED');
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG, memberId: 'other' }, undefined, 1), 'INVALID_INPUT');
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG, avatarFileId: 'cloud://other' }, undefined, 1), 'INVALID_INPUT');
  error(await ctx.call('profile.avatar.get', { memberId: 'other' }), 'INVALID_INPUT');
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG }), 'INVALID_INPUT');
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG }, undefined, 0), 'CONFLICT_REFRESH');
  error(await ctx.call('profile.update', { avatarFileId: 'cloud://other' }, undefined, 1), 'INVALID_INPUT');
  assert.equal(ctx.saved.length, 0);
});

test('avatar uploads reject malformed, unsupported, oversized and impossible-dimension images', async () => {
  const ctx = setup();
  const tooWide = Buffer.from(PNG, 'base64'); tooWide.writeUInt32BE(1025, 16);
  const emptyWidth = Buffer.from(PNG, 'base64'); emptyWidth.writeUInt32BE(0, 16);
  for (const imageBase64 of ['', 'data:image/png;base64,' + PNG, PNG + '!', PNG.replace(/=$/, ''),
    PNG.slice(0, -2) + 'J=',
    Buffer.from('<svg><script>bad</script></svg>').toString('base64'), Buffer.alloc(65_537).toString('base64'),
    tooWide.toString('base64'), emptyWidth.toString('base64'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')]) {
    error(await ctx.call('profile.avatar.save', { imageBase64 }, undefined, 1), 'INVALID_INPUT');
  }
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG, nickname: ' ' }, undefined, 1), 'INVALID_INPUT');
  assert.equal(ctx.saved.length, 0);
});

test('valid JPEG avatar requests can exceed the ordinary request limit without relaxing other actions', async () => {
  const ctx = setup();
  const jpeg = Buffer.from(JPEG, 'base64');
  const comment = Buffer.alloc(24_004, 65);
  comment[0] = 0xff; comment[1] = 0xfe; comment.writeUInt16BE(24_002, 2);
  const imageBase64 = Buffer.concat([jpeg.subarray(0, 2), comment, jpeg.subarray(2)]).toString('base64');
  assert(imageBase64.length > 20_000);
  const response = data<MemberSummary>(await ctx.call('profile.avatar.save', { imageBase64 }, undefined, 1));
  assert.equal(response.hasAvatar, true);
  error(await ctx.call('profile.update', { nickname: imageBase64 }, undefined, response.revision), 'INVALID_INPUT');
  const boundaryComment = Buffer.alloc(65_536 - jpeg.length, 65);
  boundaryComment[0] = 0xff; boundaryComment[1] = 0xfe; boundaryComment.writeUInt16BE(boundaryComment.length - 2, 2);
  const boundary = Buffer.concat([jpeg.subarray(0, 2), boundaryComment, jpeg.subarray(2)]);
  assert.equal(boundary.length, 65_536);
  assert.equal(data<MemberSummary>(await ctx.call('profile.avatar.save', { imageBase64: boundary.toString('base64') }, undefined, response.revision)).hasAvatar, true);
});

test('avatar save without a configured provider fails without persisting client data', async () => {
  const store = createDemoStore(NOW);
  const service = createService(store, { now: () => NOW });
  const response = await service.handle({ action: 'profile.avatar.save', requestId: 'missing-provider', clubId: 'oradv', payload: { imageBase64: PNG }, expectedRevision: 1 }, DEMO_IDENTITIES.member);
  error(response, 'TEMPORARY_FAILURE');
  assert(!JSON.stringify(store.snapshot()).includes(PNG));
});

test('failed avatar upload leaves nickname and revision unchanged and redacts provider errors', async () => {
  const ctx = setup();
  ctx.provider.save = async () => { throw new Error('secret-storage-token-private'); };
  const response = await ctx.call('profile.avatar.save', { imageBase64: PNG, nickname: '不能部分保存' }, undefined, 1);
  error(response, 'TEMPORARY_FAILURE');
  assert(!JSON.stringify(response).includes('private'));
  const member = data<MemberSummary>(await ctx.call('identity.me'));
  assert.equal(member.revision, 1);
  assert.notEqual(member.nickname, '不能部分保存');
});

test('concurrent avatar saves preserve the winning image and clean only the losing upload', async () => {
  const ctx = setup();
  const result = await Promise.all([
    ctx.call('profile.avatar.save', { imageBase64: PNG, nickname: '并发一' }, undefined, 1),
    ctx.call('profile.avatar.save', { imageBase64: PNG, nickname: '并发二' }, undefined, 1),
  ]);
  assert.equal(result.filter(row => row.ok).length, 1);
  assert.equal(result.filter(row => !row.ok && row.error.code === 'CONFLICT_REFRESH').length, 1);
  const id = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  const member = ctx.store.snapshot().memberships[id] as Membership;
  assert(ctx.files.has(member.avatarFileId!));
  assert(!ctx.removed.includes(member.avatarFileId!));
  assert.equal(ctx.files.size, 1);
});

test('replacement commits once even if old image cleanup fails and avatar signing fails independently', async () => {
  const ctx = setup();
  data(await ctx.call('profile.avatar.save', { imageBase64: PNG }, undefined, 1));
  const old = ctx.saved[0];
  ctx.provider.remove = async fileId => { assert.equal(fileId, old); throw new Error('private-file-secret'); };
  const updated = data<MemberSummary>(await ctx.call('profile.avatar.save', { imageBase64: PNG, nickname: '已保存的新昵称' }, undefined, 2));
  assert.equal(updated.revision, 3);
  assert.equal(updated.nickname, '已保存的新昵称');
  assert.equal(updated.hasAvatar, true);
  assert(ctx.logs.length > 0);
  assert(!JSON.stringify(ctx.logs).includes(old));
  assert(!JSON.stringify(ctx.logs).includes('secret'));
  ctx.provider.url = async () => { throw new Error('private-signing-secret'); };
  error(await ctx.call('profile.avatar.get'), 'TEMPORARY_FAILURE');
  assert.equal(data<MemberSummary>(await ctx.call('identity.me')).nickname, '已保存的新昵称');
});

test('account deletion during upload cannot bind an image and cleans its isolated file', async () => {
  const ctx = setup();
  const save = ctx.provider.save;
  ctx.provider.save = async (memberId, image) => {
    const fileId = await save(memberId, image);
    data(await ctx.call('identity.delete', { reason: '上传期间申请注销' }));
    return fileId;
  };
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG, nickname: '不可写入' }, undefined, 1), 'FORBIDDEN');
  assert.equal(ctx.files.size, 0);
});

test('avatar fetch rechecks account authority after signing and never returns a URL after deletion', async () => {
  const ctx = setup();
  data(await ctx.call('profile.avatar.save', { imageBase64: PNG }, undefined, 1));
  const url = ctx.provider.url;
  ctx.provider.url = async fileId => {
    const signed = await url(fileId);
    data(await ctx.call('identity.delete', { reason: '生成预览期间注销' }));
    return signed;
  };
  const response = await ctx.call('profile.avatar.get');
  error(response, 'FORBIDDEN');
  assert(!JSON.stringify(response).includes('https://'));
});

test('uncertain transaction response never deletes an image that actually committed', async () => {
  const ctx = setup();
  const transaction = ctx.store.transaction.bind(ctx.store);
  let once = false;
  ctx.store.transaction = async work => {
    const result = await transaction(work);
    if (!once && result && typeof result === 'object' && 'hasAvatar' in result && result.hasAvatar) {
      once = true;
      throw new Error('commit response lost');
    }
    return result;
  };
  error(await ctx.call('profile.avatar.save', { imageBase64: PNG }, undefined, 1), 'TEMPORARY_FAILURE');
  assert.equal(ctx.saved.length, 1);
  assert.equal(ctx.files.size, 1);
  assert.equal(ctx.removed.length, 0);
  assert.equal(data<MemberSummary>(await ctx.call('identity.me')).hasAvatar, true);
});
