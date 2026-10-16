import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../shared/context';
import { DomainError } from '../../shared/errors';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { MemoryStore } from '../../shared/memory-store';
import { createService } from '../../shared/service';
import { dispatchLearning } from '../../shared/learning';
import { demoSafetyQuestions, seedLearningDemo, SKILL_CATALOG } from '../../shared/learning-content';
import { key } from '../../shared/models';
import { memberIdFor, userIdFor } from '../../shared/models';
import type { MemberMediaAsset } from '../../shared/member-media-types';
import type { TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-16T08:00:00.000Z';
async function setup(demo = true) {
  let store = createDemoStore(NOW);
  if (demo) store = new MemoryStore(seedLearningDemo(store.snapshot()));
  const service = createService(store, { now: () => NOW });
  for (const identity of [DEMO_IDENTITIES.member, DEMO_IDENTITIES.founder]) {
    await service.handle({ action: 'identity.ensure', clubId: 'oradv', requestId: 'learning-setup', payload: { consentVersions: { privacy: 1, terms: 1 } } }, identity);
  }
  const call = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.member, expectedRevision?: number) =>
    dispatchLearning(new Context(store, { now: () => NOW }, { action, payload, clubId: 'oradv', requestId: 'learning-test', expectedRevision }, identity));
  return { store, call };
}
const failure = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);

test('real empty curriculum stays empty until owner publishes an instructor-confirmed bank', async () => {
  const { call } = await setup(false);
  assert.equal((await call('learning.catalog')).configured, false);
  await failure(call('learning.start'), 'LEARNING_NOT_READY');
  await failure(call('staff.learning.catalog.get'), 'FORBIDDEN');
  await failure(call('staff.learning.catalog.save', { published: true, instructorConfirmed: true, reason: '确认' }, DEMO_IDENTITIES.owner, 0), 'INVALID_INPUT');
  const questions = demoSafetyQuestions().slice(0, 20);
  let revision = 0;
  for (const question of questions) {
    const result = await call('staff.learning.catalog.save', { question, reason: '教练核定题目' }, DEMO_IDENTITIES.owner, revision);
    revision = result.revision;
  }
  await failure(call('staff.learning.catalog.save', { published: true, reason: '发布' }, DEMO_IDENTITIES.owner, revision), 'INVALID_INPUT');
  const published = await call('staff.learning.catalog.save', { published: true, instructorConfirmed: true, reason: '经指导人员核定后发布' }, DEMO_IDENTITIES.owner, revision);
  assert.equal(published.fixtureOnly, false);
  assert.equal((await call('learning.catalog')).questionCount, 20);
});

test('server practice selects twenty unique questions, hides answers and resumes one persisted attempt', async () => {
  const { call, store } = await setup();
  assert.equal(demoSafetyQuestions().length, 50);
  const first = await call('learning.start');
  assert.equal(first.total, 20);
  assert.equal(first.fixtureOnly, true);
  assert(!('rightIndex' in first.question));
  assert(!('questions' in first));
  const snapshot = store.snapshot();
  const record = Object.values(snapshot.learning_attempts).find((row: any) => row.id === first.id) as any;
  assert.equal(new Set(record.questions.map((row: any) => row.id)).size, 20);
  assert.equal((await call('learning.start')).id, first.id);
  const answer = record.questions[0].rightIndex;
  const next = await call('learning.answer', { attemptId: first.id, questionId: first.question.id, selectedIndex: answer }, DEMO_IDENTITIES.member, first.revision);
  assert.equal(next.correctCount, 1);
  assert.equal(next.answeredCount, 1);
  assert.equal(next.feedback.correct, true);
  const restored = new MemoryStore(store.snapshot());
  const resumed = await dispatchLearning(new Context(restored, { now: () => NOW }, { action: 'learning.mine', payload: {}, clubId: 'oradv', requestId: 'resume' }, DEMO_IDENTITIES.member));
  assert.equal(resumed.attempt.id, first.id);
  assert.equal(resumed.attempt.answeredCount, 1);
  assert.equal(resumed.attempt.question.id, next.question.id);
});

test('answers are locked and revision protected; future answers, spoofed scores and foreign attempts fail', async () => {
  const { call, store } = await setup();
  const first = await call('learning.start');
  const record = Object.values(store.snapshot().learning_attempts).find((row: any) => row.id === first.id) as any;
  await failure(call('learning.answer', { attemptId: first.id, questionId: record.questions[1].id, selectedIndex: 0 }, DEMO_IDENTITIES.member, 1), 'STATE_CONFLICT');
  await failure(call('learning.answer', { attemptId: first.id, questionId: first.question.id, selectedIndex: 0, score: 20 }, DEMO_IDENTITIES.member, 1), 'INVALID_INPUT');
  await failure(call('learning.answer', { attemptId: first.id, questionId: first.question.id, selectedIndex: 0 }, DEMO_IDENTITIES.founder, 1), 'FORBIDDEN');
  const next = await call('learning.answer', { attemptId: first.id, questionId: first.question.id, selectedIndex: 0 }, DEMO_IDENTITIES.member, 1);
  await failure(call('learning.answer', { attemptId: first.id, questionId: first.question.id, selectedIndex: 1 }, DEMO_IDENTITIES.member, next.revision), 'STATE_CONFLICT');
  const repeated = await call('learning.answer', { attemptId: first.id, questionId: first.question.id, selectedIndex: 0 }, DEMO_IDENTITIES.member, 1);
  assert.equal(repeated.answeredCount, 1);
  await failure(call('learning.answer', { attemptId: first.id, questionId: next.question.id, selectedIndex: 0 }, DEMO_IDENTITIES.member, 1), 'CONFLICT_REFRESH');
  await failure(call('learning.mine', { memberId: 'another' }), 'INVALID_INPUT');
  await failure(call('learning.start', {}, null), 'UNAUTHENTICATED');
});

test('bank changes never alter a frozen practice and completion never grants points or qualifications', async () => {
  const { call, store } = await setup();
  let practice = await call('learning.start');
  const record = Object.values(store.snapshot().learning_attempts).find((row: any) => row.id === practice.id) as any;
  const original = record.questions[0];
  await call('staff.learning.catalog.save', { question: { ...original, prompt: '新版本题目', rightIndex: (original.rightIndex + 1) % 4 }, instructorConfirmed: true, reason: '修订演示题' }, DEMO_IDENTITIES.owner, 1);
  assert.equal((await call('learning.mine')).attempt.question.prompt, original.prompt);
  for (let index = 0; index < 20; index++) {
    practice = await call('learning.answer', { attemptId: practice.id, questionId: practice.question.id, selectedIndex: record.questions[index].rightIndex }, DEMO_IDENTITIES.member, practice.revision);
  }
  assert.equal(practice.status, 'completed');
  assert.equal(practice.correctCount, 20);
  assert.equal(practice.question, null);
  assert(!('passed' in practice));
  assert(!Object.values(store.snapshot().qualifications || {}).some((row: any) => row.memberId === record.memberId));
  const fresh = await call('learning.start');
  assert.notEqual(fresh.id, practice.id);
  assert.equal(fresh.bankRevision, 2);
});

test('skill catalog exposes five basic and seven advanced records without invented approval or reference videos', async () => {
  const { call } = await setup();
  const result = await call('skills.mine');
  assert.equal(result.policyStatus, 'pending');
  assert.equal(SKILL_CATALOG.filter(row => row.level === 'basic').length, 5);
  assert.equal(SKILL_CATALOG.filter(row => row.level === 'advanced').length, 7);
  assert(result.items.every((row: any) => row.submission === null && row.reference === null));
  await failure(call('skills.submit', { skillId: 'basic-posture', assetId: '', note: '' }, DEMO_IDENTITIES.member, 0), 'INVALID_INPUT');
  await failure(call('skills.submit', { skillId: 'basic-posture', assetId: key('media', 'missing'), note: '' }, DEMO_IDENTITIES.member, 0), 'FORBIDDEN');
  await failure(call('staff.skills.queue'), 'FORBIDDEN');
  await failure(call('staff.skills.review', { submissionId: 'unknown', decision: 'approved', reason: 'ok' }), 'FORBIDDEN');
});

test('only owner can configure verified skill references with a revision and a real https video URL', async () => {
  const { call } = await setup();
  const payload = { skillId: 'basic-posture', title: '负责人提供的示范', url: 'https://video.example.org/reference.mp4', verified: true, reason: '已核实来源与使用权限' };
  await failure(call('staff.skills.reference.save', payload, DEMO_IDENTITIES.member, 0), 'FORBIDDEN');
  await failure(call('staff.skills.reference.save', { ...payload, verified: false }, DEMO_IDENTITIES.owner, 0), 'INVALID_INPUT');
  await failure(call('staff.skills.reference.save', { ...payload, url: 'javascript:alert(1)' }, DEMO_IDENTITIES.owner, 0), 'INVALID_INPUT');
  for (const url of ['https://127.0.0.1/video.mp4', 'https://localhost/video.mp4', 'https://10.0.0.1/video.mp4',
    'https://private.internal/video.mp4', 'https://video.example.org/file.mp4?token=private', 'https://video.example.org/page',
    'https://user:password@video.example.org/file.mp4', 'https://video.example.org/%2e%2e/file.mp4']) {
    await failure(call('staff.skills.reference.save', { ...payload, url }, DEMO_IDENTITIES.owner, 0), 'INVALID_INPUT');
  }
  await call('staff.skills.reference.save', payload, DEMO_IDENTITIES.owner, 0);
  assert.equal((await call('skills.mine')).items[0].reference.url, payload.url);
  await failure(call('staff.skills.reference.save', payload, DEMO_IDENTITIES.owner, 0), 'CONFLICT_REFRESH');
});

async function mediaFixture(ctx: Awaited<ReturnType<typeof setup>>, suffix: string, changes: Partial<MemberMediaAsset> = {}) {
  const memberId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  const id = key('media', 'learning-test', suffix);
  const row: MemberMediaAsset = { id, clubId: 'oradv', memberId, userId: userIdFor(DEMO_IDENTITIES.member),
    kind: 'video', purpose: 'skill', storageMode: 'local', label: '真实视频适配器的测试结果', status: 'ready', requestDigest: 'test-digest',
    fileId: `local-private/${suffix}.mp4`, bytes: 128, mimeType: 'video/mp4', bindings: [], rightsAcknowledged: true,
    revision: 1, createdAt: NOW, updatedAt: NOW, ...changes };
  await ctx.store.transaction(tx => tx.set('member_media', id, row));
  return id;
}

test('skill evidence is owned, saved, correctly scoped video; cancelled or forged evidence cannot be submitted', async () => {
  const ctx = await setup();
  for (const [suffix, changes, code] of [
    ['cancelled', { status: 'cancelled' }, 'FORBIDDEN'], ['image', { kind: 'image', mimeType: 'image/jpeg' }, 'INVALID_INPUT'],
    ['wrong-purpose', { purpose: 'dossier' }, 'FORBIDDEN'], ['foreign', { memberId: 'foreign-member' }, 'FORBIDDEN'],
  ] as [string, Partial<MemberMediaAsset>, string][]) {
    const assetId = await mediaFixture(ctx, suffix, changes);
    await failure(ctx.call('skills.submit', { skillId: 'basic-posture', assetId }, DEMO_IDENTITIES.member, 0), code);
  }
  const assetId = await mediaFixture(ctx, 'own-video');
  await failure(ctx.call('skills.submit', { skillId: 'basic-posture', assetId, decision: 'approved' }, DEMO_IDENTITIES.member, 0), 'INVALID_INPUT');
  const submitted = await ctx.call('skills.submit', { skillId: 'basic-posture', assetId, note: '本人练习记录' }, DEMO_IDENTITIES.member, 0);
  assert.equal(submitted.state, 'submitted');
  assert(!('reviewedBy' in submitted));
  const asset = ctx.store.snapshot().member_media[assetId] as MemberMediaAsset;
  assert.deepEqual(asset.bindings, [submitted.id]);
  assert.equal((await ctx.call('skills.mine', {}, DEMO_IDENTITIES.founder)).items[0].submission, null);
});

test('only owner reviews a pinned skill revision; resubmission clears approval and never changes qualifications', async () => {
  const ctx = await setup();
  const assetId = await mediaFixture(ctx, 'review-video');
  const submitted = await ctx.call('skills.submit', { skillId: 'basic-posture', assetId, note: '第一次' }, DEMO_IDENTITIES.member, 0);
  const queue = await ctx.call('staff.skills.queue', {}, DEMO_IDENTITIES.owner);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].id, submitted.id);
  assert(!('fileId' in queue.items[0]));
  assert(!('reviewedBy' in queue.items[0]));
  const payload = { submissionId: submitted.id, decision: 'approved', reason: '已核对本人练习片段，现场资格另行判断' };
  await failure(ctx.call('staff.skills.review', payload, DEMO_IDENTITIES.operator, 1), 'FORBIDDEN');
  await failure(ctx.call('staff.skills.review', { ...payload, reason: '' }, DEMO_IDENTITIES.owner, 1), 'INVALID_INPUT');
  await failure(ctx.call('staff.skills.review', payload, DEMO_IDENTITIES.owner, 0), 'CONFLICT_REFRESH');
  const reviewed = await ctx.call('staff.skills.review', payload, DEMO_IDENTITIES.owner, 1);
  assert.equal(reviewed.state, 'approved');
  assert.equal((await ctx.call('staff.skills.queue', {}, DEMO_IDENTITIES.owner)).items.length, 0);
  const nextAsset = await mediaFixture(ctx, 'resubmit-video');
  const again = await ctx.call('skills.submit', { skillId: 'basic-posture', assetId: nextAsset }, DEMO_IDENTITIES.member, reviewed.revision);
  assert.equal(again.state, 'submitted');
  assert.equal(again.reviewReason, '');
  assert.equal(again.reviewedAt, null);
  await failure(ctx.call('staff.skills.review', payload, DEMO_IDENTITIES.owner, reviewed.revision), 'CONFLICT_REFRESH');
  const withdrawn = await ctx.call('skills.cancel', { skillId: 'basic-posture', reason: '需要重新整理片段' }, DEMO_IDENTITIES.member, again.revision);
  assert.equal(withdrawn.state, 'withdrawn');
  await failure(ctx.call('staff.skills.review', payload, DEMO_IDENTITIES.owner, withdrawn.revision), 'STATE_CONFLICT');
  const memberId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  assert(!Object.values(ctx.store.snapshot().qualifications || {}).some((row: any) => row.memberId === memberId));
  assert(Object.values(ctx.store.snapshot().audit_logs).some((row: any) => row.action === 'staff.skills.review'));
});

test('immutable skill revisions preserve old approved evidence, notes and reasons through resubmission and withdrawal', async () => {
  const ctx = await setup(), firstAsset = await mediaFixture(ctx, 'archive-first'), nextAsset = await mediaFixture(ctx, 'archive-next');
  let record = await ctx.call('skills.submit', { skillId: 'basic-posture', assetId: firstAsset, note: '第一段实际练习' }, DEMO_IDENTITIES.member, 0);
  record = await ctx.call('staff.skills.review', { submissionId: record.id, decision: 'approved', reason: '第一段已核对，保留本次意见' }, DEMO_IDENTITIES.owner, record.revision);
  record = await ctx.call('skills.submit', { skillId: 'basic-posture', assetId: nextAsset, note: '补充新的练习片段' }, DEMO_IDENTITIES.member, record.revision);
  record = await ctx.call('skills.cancel', { skillId: 'basic-posture', reason: '需要整理说明' }, DEMO_IDENTITIES.member, record.revision);
  const history = await ctx.call('skills.history', { skillId: 'basic-posture' });
  assert.deepEqual(history.items.map((row: any) => row.revision), [4, 3, 2, 1]);
  const approved = history.items.find((row: any) => row.revision === 2);
  assert.equal(approved.assetId, firstAsset); assert.equal(approved.note, '第一段实际练习');
  assert.equal(approved.reviewReason, '第一段已核对，保留本次意见'); assert.equal(approved.state, 'approved');
  assert(history.items.every((row: any) => !('reviewedBy' in row) && !('memberId' in row)));
  const frozen = Object.values(ctx.store.snapshot().skill_submissions).filter((row: any) => row.kind === 'skill_revision') as any[];
  assert.equal(frozen.length, 4); assert(frozen.every(row => row.state === 'archived'));
  assert.equal((await ctx.call('staff.skills.queue', {}, DEMO_IDENTITIES.owner)).items.length, 0);
  const memberId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  assert.deepEqual((await ctx.call('staff.skills.history', { skillId: 'basic-posture', memberId }, DEMO_IDENTITIES.owner)).items, history.items);
  assert.deepEqual((await ctx.call('skills.history', { skillId: 'basic-posture' }, DEMO_IDENTITIES.founder)).items, []);
  await failure(ctx.call('skills.history', { skillId: 'basic-posture', memberId }), 'INVALID_INPUT');
  await failure(ctx.call('staff.skills.history', { skillId: 'basic-posture', memberId }), 'FORBIDDEN');
  const before = ctx.store.snapshot(); await failure(ctx.call('staff.skills.review', { submissionId: record.id, decision: 'approved', reason: '不能复用旧版本' }, DEMO_IDENTITIES.owner, 2), 'CONFLICT_REFRESH');
  assert.deepEqual(ctx.store.snapshot(), before);
});

test('skill history paginates with bounded deterministic revision reads and detects a changed record', async () => {
  const ctx = await setup(), assetId = await mediaFixture(ctx, 'archive-many'); let revision = 0;
  for (let index = 0; index < 24; index++) {
    const row = await ctx.call('skills.submit', { skillId: 'basic-posture', assetId, note: `练习记录${index}` }, DEMO_IDENTITIES.member, revision);
    revision = row.revision;
  }
  const first = await ctx.call('skills.history', { skillId: 'basic-posture' });
  assert.equal(first.items.length, 20); assert(first.nextCursor);
  const next = await ctx.call('skills.history', { skillId: 'basic-posture', cursor: first.nextCursor });
  assert.deepEqual(next.items.map((row: any) => row.revision), [4, 3, 2, 1]); assert.equal(next.nextCursor, null);
  await ctx.call('skills.submit', { skillId: 'basic-posture', assetId }, DEMO_IDENTITIES.member, revision);
  await failure(ctx.call('skills.history', { skillId: 'basic-posture', cursor: first.nextCursor }), 'CONFLICT_REFRESH');
  await failure(ctx.call('skills.history', { skillId: 'basic-forward', cursor: first.nextCursor }), 'CONFLICT_REFRESH');
});
