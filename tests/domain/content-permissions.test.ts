import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot, DEMO_IDENTITIES } from '../../shared/demo';
import { MemoryStore } from '../../shared/memory-store';
import { createService } from '../../shared/service';
import { seedLearningDemo } from '../../shared/learning-content';
import { key, memberIdFor, registrationIdFor, userIdFor } from '../../shared/models';
import type { Activity, Registration, RpcResponse, TrustedIdentity } from '../../shared/types';
import type { MemberMediaStorage } from '../../shared/member-media-types';

const NOW = '2026-10-16T12:00:00.000Z', memberId = (identity: TrustedIdentity) => memberIdFor('oradv', userIdFor(identity));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=';
function setup() {
  const seed = seedLearningDemo(demoSnapshot(NOW)); seed.activities['intro-ride'] = { ...seed.activities['intro-ride'] as Activity, state: 'settled' };
  const store = new MemoryStore(seed, () => NOW); let sequence = 0;
  const storage: MemberMediaStorage = { mode: 'local', saveImage: async (_member, id, image) => ({ fileId: `private/${id}`, bytes: Buffer.from(image, 'base64').length, mimeType: 'image/png' }), remove: async () => {}, url: async id => `https://files.example.test/${id}?signed` };
  const service = createService(store, { now: () => NOW, id: () => `content-permissions-${++sequence}`, memberMediaStorage: storage });
  const call = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity = DEMO_IDENTITIES.owner, expectedRevision?: number) => service.handle({ action, payload, expectedRevision, clubId: 'oradv', requestId: `request-${++sequence}` }, identity);
  const grant = (role: string, identity = DEMO_IDENTITIES.member, extra: Record<string, unknown> = {}) => call('staff.roles.assign', { memberId: memberId(identity), role, activityIds: null, reason: '经主理人核实的工作授权', ...extra });
  return { store, call, grant };
}
function data(response: RpcResponse): any { assert(response.ok, JSON.stringify(response)); return response.data; }
function denied(response: RpcResponse, code = 'FORBIDDEN') { assert(!response.ok, JSON.stringify(response)); assert.equal(response.error.code, code); }
const story = (photoAssetIds: string[] = []) => ({ activityId: 'intro-ride', intro: '核实过的活动回顾', photoAssetIds, documentaryUrl: '', documentaryTitle: '', videoRightsAcknowledged: false, published: true, reason: '核实图片和活动文字使用权', honors: [] });

test('content administrators publish public club, history, curriculum and reference content without gaining business identity or private powers', async () => {
  const ctx = setup(); data(await ctx.grant('content_admin'));
  const who = DEMO_IDENTITIES.member, before = data(await ctx.call('identity.me', {}, who));
  assert.deepEqual(before.roles, ['content_admin']); assert.equal(before.memberKind, 'regular'); assert.equal(before.growthPoints, 0);
  const draft = { title: '车队手册', introduction: '由俱乐部核实的公开说明', blocks: [{ heading: '活动准备', body: '参加前查看本场安排。' }], people: [], contacts: [], offers: [] };
  const saved = data(await ctx.call('staff.club.content.save', { section: 'handbook', content: draft, status: 'published', rightsAcknowledged: true }, who, 0));
  assert.equal(saved.configured, true); assert.equal(data(await ctx.call('staff.club.content.get', { section: 'handbook' }, who)).revision, saved.revision);
  assert.equal(data(await ctx.call('staff.history.save', story(), who, 0)).published, true);
  assert.deepEqual(data(await ctx.call('staff.history.reviews', { activityId: 'intro-ride' }, who)).items, []);
  const bank = data(await ctx.call('staff.learning.catalog.get', {}, who));
  assert.equal(data(await ctx.call('staff.learning.catalog.save', { published: true, instructorConfirmed: true, reason: '题目已由指导人员核定' }, who, bank.revision)).published, true);
  assert.equal(data(await ctx.call('staff.skills.reference.save', { skillId: 'basic-posture', title: '经核定的示范', url: 'https://films.example.com/basic.mp4', verified: true, reason: '已核实教学内容和授权' }, who, 0)).revision, 1);
  const after = data(await ctx.call('identity.me', {}, who)); assert.equal(after.memberKind, before.memberKind); assert.equal(after.growthPoints, before.growthPoints); assert.equal(after.rankingOptIn, false); assert.equal(after.recommendationOptIn, false);
});

test('public content capability cannot access personnel, private inquiry contacts, submissions, points or activity operations', async () => {
  const ctx = setup(); data(await ctx.grant('content_admin')); const who = DEMO_IDENTITIES.member;
  for (const [action, payload] of [
    ['staff.member.list', {}], ['staff.roles.list', { memberId: memberId(who) }], ['staff.roles.assign', { memberId: memberId(who), role: 'owner' }],
    ['staff.member.assign', { memberId: memberId(who), memberKind: 'founder', reason: '不能自授' }], ['staff.recommendation.save', { memberId: memberId(who), priority: 999, reason: '不能改编排' }],
    ['staff.dossier.list', {}], ['staff.dossier.get', { memberId: memberId(DEMO_IDENTITIES.owner) }], ['staff.skills.queue', {}],
    ['staff.skills.history', { skillId: 'basic-posture', memberId: memberId(DEMO_IDENTITIES.owner) }],
    ['staff.skills.review', { submissionId: 'not-accessible', decision: 'approved', reason: '不能审核私人记录' }],
    ['staff.club.inquiry.list', {}], ['staff.club.inquiry.review', { id: 'not-accessible', reply: '不能查看私人咨询' }],
    ['staff.qualification.list', { memberId: memberId(who) }], ['staff.activity.list', {}], ['staff.activity.save', { title: '不能创建运营活动' }],
    ['staff.activity.publish', { activityId: 'draft-ride' }], ['staff.registration.list', { activityId: 'intro-ride' }],
    ['staff.settlement.preview', { activityId: 'intro-ride', ruleVersion: 1 }], ['staff.points.reverse', { ledgerId: 'not-accessible', reason: '不能调整积分' }],
  ] as [string, Record<string, unknown>][]) denied(await ctx.call(action, payload, who, 1));
});

test('another content editor can retain bound public story photos but cannot adopt others drafts or private media', async () => {
  const ctx = setup(); data(await ctx.grant('content_admin')); const who = DEMO_IDENTITIES.member;
  const image = (purpose: string) => ctx.call('media.image.save', { purpose, imageBase64: PNG, rightsAcknowledged: true }, DEMO_IDENTITIES.owner);
  const publicPhoto = data(await image('club_public')), unbound = data(await image('club_public')), privatePhoto = data(await image('dossier'));
  const initial = data(await ctx.call('staff.history.save', story([publicPhoto.id]), DEMO_IDENTITIES.owner, 0));
  assert(data(await ctx.call('media.get', { assetId: publicPhoto.id, bindingId: initial.id }, who)).url);
  assert.equal(data(await ctx.call('staff.history.save', { ...story([publicPhoto.id]), intro: '第二位编辑核实后的说明' }, who, initial.revision)).photoAssetIds[0], publicPhoto.id);
  denied(await ctx.call('media.get', { assetId: unbound.id }, who)); denied(await ctx.call('media.get', { assetId: privatePhoto.id }, who));
  denied(await ctx.call('staff.history.save', story([unbound.id]), who, initial.revision + 1));
  denied(await ctx.call('staff.history.save', story([privatePhoto.id]), who, initial.revision + 1));
  const roleId = key('role', 'oradv', userIdFor(who), 'content_admin');
  data(await ctx.call('staff.roles.assign', { memberId: memberId(who), role: 'content_admin', enabled: false, reason: '撤销内容工作授权' }, DEMO_IDENTITIES.owner, 1));
  denied(await ctx.call('staff.club.content.get', { section: 'handbook' }, who)); denied(await ctx.call('media.get', { assetId: publicPhoto.id, bindingId: initial.id }, who));
  assert.equal((ctx.store.snapshot().staff_roles[roleId] as any).enabled, false);
});

test('manager is a display designation on owner authority and cannot impersonate the protected primary', async () => {
  const ctx = setup(); data(await ctx.grant('owner', DEMO_IDENTITIES.member, { designation: 'manager' }));
  const manager = data(await ctx.call('identity.me', {}, DEMO_IDENTITIES.member)); assert(manager.roles.includes('owner')); assert.equal(manager.adminDesignation, 'manager');
  data(await ctx.call('staff.roles.list', { memberId: memberId(DEMO_IDENTITIES.owner) }, DEMO_IDENTITIES.member));
  denied(await ctx.call('staff.roles.assign', { memberId: memberId(DEMO_IDENTITIES.owner), role: 'owner', designation: 'manager' }, DEMO_IDENTITIES.member, 1), 'STATE_CONFLICT');
  denied(await ctx.grant('content_admin', DEMO_IDENTITIES.founder, { designation: 'manager' }), 'INVALID_INPUT');
});

test('content editors lose access to withdrawn or deleted-author submissions while owners retain audit history', async () => {
  for (const boundary of ['withdraw', 'delete']) {
    const ctx = setup(); data(await ctx.grant('content_admin')); const author = DEMO_IDENTITIES.founder, authorId = memberId(author);
    const registration: Registration = { id: registrationIdFor('oradv', 'intro-ride', authorId), clubId: 'oradv', activityId: 'intro-ride', memberId: authorId, state: 'completed', seatState: 'released', reviewDecision: 'approved', queueSeq: 1, attempt: 1, revision: 1, acceptedRuleVersion: 1, holdExpiresAt: null, settlementId: 'completion-fixture', createdAt: NOW, updatedAt: NOW };
    await ctx.store.transaction(tx => tx.set('registrations', registration.id, registration));
    const own = data(await ctx.call('history.review.save', { activityId: 'intro-ride', stars: 4, comment: '只在本人仍同意时交给内容编辑', publishConsent: true, nicknameConsent: true, honorConsent: false, consentVersion: 1 }, author, 0));
    assert.equal(data(await ctx.call('staff.history.reviews', { activityId: 'intro-ride' }, DEMO_IDENTITIES.member)).items.length, 1);
    if (boundary === 'withdraw') data(await ctx.call('history.review.withdraw', { activityId: 'intro-ride' }, author, own.revision));
    else data(await ctx.call('identity.delete', {}, author));
    assert.deepEqual(data(await ctx.call('staff.history.reviews', { activityId: 'intro-ride' }, DEMO_IDENTITIES.member)).items, []);
    assert.equal(data(await ctx.call('staff.history.reviews', { activityId: 'intro-ride' })).items[0].comment, own.review.comment);
    denied(await ctx.call('staff.history.review', { activityId: 'intro-ride', reviewId: own.review.id, decision: 'rejected', reason: '不能处理已撤回公开意愿的投稿' }, DEMO_IDENTITIES.member, boundary === 'withdraw' ? 2 : 1), boundary === 'withdraw' ? 'STATE_CONFLICT' : 'FORBIDDEN');
  }
});
