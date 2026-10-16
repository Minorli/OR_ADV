import { Context, encodeCursor, paginated, parseCursor } from './context';
import { integer, requireThat, text } from './errors';
import { key } from './models';
import type { Membership } from './models';
import type { Transaction } from './store';
import { bindOwnedMemberMedia, requireOwnedMemberMedia } from './member-media';
import { SKILL_CATALOG } from './learning-content';
import { sha256 } from './hash';
import { validatePublicVideoUrl } from './public-video-url';
import type { LearningBank, PracticeFeedback, PracticeView, SafetyQuestion, SkillHistoryEntry, SkillReference, SkillSubmission, SkillView } from './learning-types';

export const LEARNING_ACTIONS = [
  'learning.catalog', 'learning.mine', 'learning.start', 'learning.answer',
  'staff.learning.catalog.get', 'staff.learning.catalog.save', 'skills.mine',
  'skills.submit', 'skills.cancel', 'skills.history', 'staff.skills.history', 'staff.skills.queue', 'staff.skills.review', 'staff.skills.reference.save',
] as const;
interface PracticeAttempt {
  id: string; clubId: string; kind: 'attempt'; memberId: string;
  bankTitle: string; bankRevision: number; fixtureOnly: boolean; questions: SafetyQuestion[];
  answers: { questionId: string; selectedIndex: number; correct: boolean }[];
  status: 'in_progress' | 'completed'; revision: number; completedAt: string | null;
}
const bankId = (ctx: Context) => key('learning-bank', ctx.clubId);
const pointerId = (ctx: Context, memberId: string) => key('learning-current', ctx.clubId, memberId);
const submissionId = (ctx: Context, memberId: string, skillId: string) => key('skill-submission', ctx.clubId, memberId, skillId);
function fields(ctx: Context, allowed: string[]) {
  requireThat(Object.keys(ctx.request.payload).every(name => allowed.includes(name)), 'INVALID_INPUT', '含不允许修改的学习记录字段');
}
function emptyBank(ctx: Context): LearningBank {
  return { id: bankId(ctx), clubId: ctx.clubId, title: '安全知识练习', questions: [], published: false, fixtureOnly: false, revision: 0 };
}
function viewAttempt(attempt: PracticeAttempt, feedback: PracticeFeedback | null = null): PracticeView {
  const next = attempt.questions[attempt.answers.length];
  return { id: attempt.id, bankTitle: attempt.bankTitle, bankRevision: attempt.bankRevision, fixtureOnly: attempt.fixtureOnly,
    status: attempt.status, revision: attempt.revision, total: attempt.questions.length,
    answeredCount: attempt.answers.length, correctCount: attempt.answers.filter(answer => answer.correct).length,
    completedAt: attempt.completedAt, question: next ? { id: next.id, prompt: next.prompt, options: next.options } : null, feedback };
}
function validQuestion(value: unknown): SafetyQuestion {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', '题目格式不正确');
  const question = value as Record<string, unknown>;
  requireThat(Object.keys(question).every(name => ['id', 'prompt', 'options', 'rightIndex', 'explanation'].includes(name)), 'INVALID_INPUT', '题目包含不支持的字段');
  const id = text(question.id, '题目编号', 60);
  requireThat(/^[a-zA-Z0-9_-]+$/.test(id), 'INVALID_INPUT', '题目编号只使用英文字母、数字和短横线');
  requireThat(Array.isArray(question.options) && question.options.length === 4, 'INVALID_INPUT', '请提供四个选项');
  const options = question.options.map(option => text(option, '选项', 160));
  requireThat(new Set(options).size === 4, 'INVALID_INPUT', '选项不能重复');
  const rightIndex = integer(question.rightIndex, '正确答案');
  requireThat(rightIndex < options.length, 'INVALID_INPUT', '正确答案不在选项中');
  return { id, prompt: text(question.prompt, '题目', 400), options, rightIndex, explanation: text(question.explanation, '答案说明', 600) };
}
async function catalog(ctx: Context, staff = false) {
  fields(ctx, []);
  return ctx.store.transaction(async tx => {
    if (staff) await ctx.staff(tx, ['owner']);
    const bank = await tx.get<LearningBank>('learning_catalog', bankId(ctx));
    requireThat(!bank || bank.clubId === ctx.clubId, 'FORBIDDEN', '题库不可访问');
    if (staff) return bank ?? emptyBank(ctx);
    return { configured: !!bank?.published, title: bank?.published ? bank.title : '安全知识练习',
      questionCount: bank?.published ? bank.questions.length : 0, revision: bank?.published ? bank.revision : 0,
      fixtureOnly: bank?.published ? bank.fixtureOnly : false, policyStatus: 'pending' };
  });
}
async function saveCatalog(ctx: Context) {
  fields(ctx, ['title', 'question', 'removeQuestionId', 'published', 'instructorConfirmed', 'reason']);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner']);
    const previous = await tx.get<LearningBank>('learning_catalog', bankId(ctx)) ?? emptyBank(ctx);
    ctx.revision(previous);
    const p = ctx.request.payload;
    const reason = text(p.reason, '内容核定说明', 500);
    requireThat(p.published === undefined || typeof p.published === 'boolean', 'INVALID_INPUT', '发布状态不正确');
    let questions = [...previous.questions];
    if (p.question !== undefined) {
      const question = validQuestion(p.question);
      questions = [...questions.filter(item => item.id !== question.id), question];
    }
    if (p.removeQuestionId !== undefined) questions = questions.filter(item => item.id !== text(p.removeQuestionId, '题目编号', 60));
    requireThat(questions.length <= 100, 'INVALID_INPUT', '每份题库最多一百题');
    const published = p.published === undefined ? previous.published : p.published as boolean;
    if (published) {
      requireThat(questions.length >= 20, 'INVALID_INPUT', '发布前至少准备二十题');
      requireThat(p.instructorConfirmed === true, 'INVALID_INPUT', '请确认题目和答案已由指导人员核定');
    }
    const bank: LearningBank = { ...previous, title: p.title === undefined ? previous.title : text(p.title, '题库标题', 80),
      questions, published, revision: previous.revision + 1 };
    await tx.set('learning_catalog', bank.id, bank);
    await ctx.audit(tx, actor, 'learning_bank', bank.id, { revision: bank.revision, published, questionCount: questions.length }, reason);
    return bank;
  });
}
async function currentAttempt(ctx: Context, tx: Transaction, memberId: string) {
  const pointer = await tx.get<{ attemptId: string; clubId: string; memberId: string }>('learning_attempts', pointerId(ctx, memberId));
  if (!pointer) return null;
  requireThat(pointer.clubId === ctx.clubId && pointer.memberId === memberId, 'FORBIDDEN', '练习记录不可访问');
  const attempt = await tx.get<PracticeAttempt>('learning_attempts', pointer.attemptId);
  requireThat(attempt?.clubId === ctx.clubId && attempt.memberId === memberId && attempt.kind === 'attempt', 'FORBIDDEN', '练习记录不可访问');
  return attempt;
}
async function mine(ctx: Context) {
  fields(ctx, []);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    const attempt = await currentAttempt(ctx, tx, actor.member.id);
    return { attempt: attempt ? viewAttempt(attempt) : null, policyStatus: 'pending' };
  });
}
async function start(ctx: Context) {
  fields(ctx, []);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    const previous = await currentAttempt(ctx, tx, actor.member.id);
    if (previous?.status === 'in_progress') return viewAttempt(previous);
    const bank = await tx.get<LearningBank>('learning_catalog', bankId(ctx));
    requireThat(bank?.published && bank.clubId === ctx.clubId && bank.questions.length >= 20, 'LEARNING_NOT_READY', '题库尚未发布，请等待负责人核定内容');
    // Fisher–Yates runs in the trusted service, not in a client-selected payload.
    const pool = [...bank.questions];
    for (let index = pool.length - 1; index > 0; index--) {
      const selected = Math.floor(Math.random() * (index + 1));
      [pool[index], pool[selected]] = [pool[selected], pool[index]];
    }
    const attempt: PracticeAttempt = { id: key('learning-attempt', ctx.clubId, actor.member.id, ctx.id()), clubId: ctx.clubId,
      kind: 'attempt', memberId: actor.member.id, bankTitle: bank.title, bankRevision: bank.revision, fixtureOnly: bank.fixtureOnly,
      questions: pool.slice(0, 20).map(question => ({ ...question, options: [...question.options] })), answers: [],
      status: 'in_progress', revision: 1, completedAt: null };
    await tx.set('learning_attempts', attempt.id, attempt);
    await tx.set('learning_attempts', pointerId(ctx, actor.member.id), { id: pointerId(ctx, actor.member.id), clubId: ctx.clubId, kind: 'current', memberId: actor.member.id, attemptId: attempt.id });
    await ctx.audit(tx, actor, 'learning_attempt', attempt.id, { bankRevision: bank.revision, questionCount: attempt.questions.length });
    return viewAttempt(attempt);
  });
}
async function answer(ctx: Context) {
  fields(ctx, ['attemptId', 'questionId', 'selectedIndex']);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    const attempt = await tx.get<PracticeAttempt>('learning_attempts', text(ctx.request.payload.attemptId, '练习编号', 100));
    requireThat(attempt?.clubId === ctx.clubId && attempt.memberId === actor.member.id && attempt.kind === 'attempt', 'FORBIDDEN', '练习记录不可访问');
    const questionId = text(ctx.request.payload.questionId, '题目编号', 60);
    const selectedIndex = integer(ctx.request.payload.selectedIndex, '所选答案');
    requireThat(selectedIndex < 4, 'INVALID_INPUT', '所选答案不在选项中');
    const prior = attempt.answers.find(item => item.questionId === questionId);
    if (prior) {
      requireThat(prior.selectedIndex === selectedIndex, 'STATE_CONFLICT', '这道题已确认，答案不能更改');
      return viewAttempt(attempt);
    }
    ctx.revision(attempt);
    const question = attempt.questions[attempt.answers.length];
    requireThat(attempt.status === 'in_progress' && question?.id === questionId, 'STATE_CONFLICT', '请按当前练习顺序作答');
    const correct = selectedIndex === question.rightIndex;
    const answers = [...attempt.answers, { questionId, selectedIndex, correct }];
    const completed = answers.length === attempt.questions.length;
    const updated: PracticeAttempt = { ...attempt, answers, revision: attempt.revision + 1, status: completed ? 'completed' : 'in_progress', completedAt: completed ? ctx.now : null };
    await tx.set('learning_attempts', updated.id, updated);
    await ctx.audit(tx, actor, 'learning_attempt', updated.id, { answeredCount: answers.length, completed });
    return viewAttempt(updated, { questionId, prompt: question.prompt, selectedIndex, rightIndex: question.rightIndex, correct, explanation: question.explanation });
  });
}
function skillDefinition(id: unknown) {
  const skillId = text(id, '技能项目', 60);
  const skill = SKILL_CATALOG.find(item => item.id === skillId);
  requireThat(skill, 'INVALID_INPUT', '技能项目不存在');
  return skill;
}
function submissionView(row: SkillSubmission) {
  const { clubId: _club, memberId: _member, reviewedBy: _reviewer, ...view } = row;
  return view;
}
interface SkillRevision {
  id: string; clubId: string; memberId: string; skillId: string; kind: 'skill_revision'; state: 'archived';
  submissionRevision: number; record: SkillSubmission; recordedAt: string;
}
function frozenSkill(row: SkillSubmission): SkillSubmission {
  return { id: row.id, clubId: row.clubId, memberId: row.memberId, skillId: row.skillId, assetId: row.assetId, note: row.note,
    state: row.state, revision: row.revision, submittedAt: row.submittedAt, updatedAt: row.updatedAt,
    reviewedAt: row.reviewedAt, reviewedBy: row.reviewedBy, reviewReason: row.reviewReason };
}
async function archiveSkill(ctx: Context, tx: Transaction, row: SkillSubmission) {
  const id = key('skill-revision', ctx.clubId, row.id, row.revision), record = frozenSkill(row);
  const existing = await tx.get<SkillRevision>('skill_submissions', id);
  if (existing) {
    // Store adapters stamp top-level updatedAt independently of the business
    // event clock; that metadata difference must not rewrite a frozen revision.
    const { updatedAt: _currentMetadata, ...currentFacts } = record;
    const { updatedAt: _storedMetadata, ...savedFacts } = frozenSkill(existing.record);
    requireThat(existing.kind === 'skill_revision' && existing.clubId === ctx.clubId && JSON.stringify(savedFacts) === JSON.stringify(currentFacts), 'STATE_CONFLICT', '练习归档版本异常，请联系负责人核对');
    return;
  }
  const snapshot: SkillRevision = { id, clubId: ctx.clubId, memberId: row.memberId, skillId: row.skillId, kind: 'skill_revision', state: 'archived',
    submissionRevision: row.revision, record, recordedAt: ctx.now };
  await tx.set('skill_submissions', id, snapshot);
}
async function skillHistory(ctx: Context, staff = false) {
  fields(ctx, staff ? ['skillId', 'memberId', 'cursor'] : ['skillId', 'cursor']);
  const skill = skillDefinition(ctx.request.payload.skillId), cursor = parseCursor(ctx.request.payload.cursor);
  return ctx.store.transaction(async tx => {
    const actor = staff ? await ctx.staff(tx, ['owner']) : await ctx.actor(tx);
    const member = staff ? await tx.get<Membership>('memberships', text(ctx.request.payload.memberId, '成员', 100)) : actor.member;
    requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员记录不可访问');
    const current = await tx.get<SkillSubmission>('skill_submissions', submissionId(ctx, member.id, skill.id));
    if (!current) { requireThat(!cursor, 'CONFLICT_REFRESH', '练习记录已更新，请刷新'); return { items: [], nextCursor: null, missingCount: 0 }; }
    const signature = sha256(JSON.stringify([ctx.clubId, member.id, skill.id, current.revision]));
    if (cursor) requireThat(cursor.id === current.id && cursor.signature === signature && Number.isSafeInteger(cursor.value)
      && Number(cursor.value) > 0 && Number(cursor.value) <= current.revision, 'CONFLICT_REFRESH', '练习记录已更新，请刷新后查看历史');
    const items: SkillHistoryEntry[] = []; let next = cursor ? Number(cursor.value) : current.revision, missingCount = 0;
    // Deterministic revision keys avoid any unbounded query or new database index.
    for (let read = 0; read < 20 && next > 0; read++, next--) {
      const id = key('skill-revision', ctx.clubId, current.id, next);
      const saved = await tx.get<SkillRevision>('skill_submissions', id);
      if (saved) {
        requireThat(saved.clubId === ctx.clubId && saved.memberId === member.id && saved.skillId === skill.id && saved.submissionRevision === next && saved.kind === 'skill_revision', 'FORBIDDEN', '归档记录不可访问');
        items.push({ ...submissionView(saved.record), historyId: saved.id, recordedAt: saved.recordedAt });
      } else if (next === current.revision) items.push({ ...submissionView(current), historyId: id, recordedAt: current.updatedAt });
      else missingCount++;
    }
    return { items, nextCursor: next > 0 ? encodeCursor({ value: next, id: current.id, signature }) : null, missingCount };
  });
}
async function ownSkills(ctx: Context) {
  fields(ctx, []);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    const items: SkillView[] = [];
    for (const skill of SKILL_CATALOG) {
      const submission = await tx.get<SkillSubmission>('skill_submissions', submissionId(ctx, actor.member.id, skill.id));
      const reference = await tx.get<SkillReference>('learning_catalog', key('skill-reference', ctx.clubId, skill.id));
      requireThat(!submission || submission.clubId === ctx.clubId && submission.memberId === actor.member.id && submission.skillId === skill.id, 'FORBIDDEN', '练习记录不可访问');
      requireThat(!reference || reference.clubId === ctx.clubId && reference.skillId === skill.id, 'FORBIDDEN', '示范资料不可访问');
      items.push({ ...skill, submission: submission ? submissionView(submission) : null,
        reference: reference ? { title: reference.title, url: reference.url, revision: reference.revision } : null });
    }
    return { items, policyStatus: 'pending' };
  });
}
async function submitSkill(ctx: Context) {
  fields(ctx, ['skillId', 'assetId', 'note']);
  const skill = skillDefinition(ctx.request.payload.skillId);
  const assetId = text(ctx.request.payload.assetId, '练习视频', 100);
  const note = ctx.request.payload.note === undefined || ctx.request.payload.note === '' ? '' : text(ctx.request.payload.note, '练习说明', 600);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    const id = submissionId(ctx, actor.member.id, skill.id);
    const previous = await tx.get<SkillSubmission>('skill_submissions', id);
    ctx.revision(previous ?? { revision: 0 });
    const [asset] = await requireOwnedMemberMedia(tx, ctx.clubId, actor.member.id, [assetId], 'skill');
    requireThat(asset.kind === 'video', 'INVALID_INPUT', '请提交本人实际练习的视频');
    if (previous) await archiveSkill(ctx, tx, previous);
    await bindOwnedMemberMedia(tx, ctx.clubId, actor.member.id, [assetId], 'skill', id);
    const row: SkillSubmission = { id, clubId: ctx.clubId, memberId: actor.member.id, skillId: skill.id, assetId, note,
      state: 'submitted', revision: (previous?.revision ?? 0) + 1, submittedAt: ctx.now, updatedAt: ctx.now,
      reviewedAt: null, reviewedBy: null, reviewReason: '' };
    await tx.set('skill_submissions', id, row);
    await archiveSkill(ctx, tx, row);
    await ctx.audit(tx, actor, 'skill_submission', id, { skillId: skill.id, revision: row.revision, state: row.state });
    return submissionView(row);
  });
}
async function cancelSkill(ctx: Context) {
  fields(ctx, ['skillId', 'reason']);
  const skill = skillDefinition(ctx.request.payload.skillId);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    const id = submissionId(ctx, actor.member.id, skill.id);
    const row = await tx.get<SkillSubmission>('skill_submissions', id);
    requireThat(row?.clubId === ctx.clubId && row.memberId === actor.member.id, 'FORBIDDEN', '提交记录不可访问');
    ctx.revision(row);
    const reason = text(ctx.request.payload.reason, '撤回原因', 500);
    await archiveSkill(ctx, tx, row);
    const updated: SkillSubmission = { ...row, state: 'withdrawn', revision: row.revision + 1, updatedAt: ctx.now };
    await tx.set('skill_submissions', id, updated);
    await archiveSkill(ctx, tx, updated);
    await ctx.audit(tx, actor, 'skill_submission', id, { state: updated.state, revision: updated.revision }, reason);
    return submissionView(updated);
  });
}
async function skillQueue(ctx: Context) {
  fields(ctx, ['cursor']);
  await ctx.store.transaction(async tx => { await ctx.staff(tx, ['owner']); });
  const rows = await ctx.store.query<SkillSubmission>('skill_submissions', { clubId: ctx.clubId, state: 'submitted' }, { orderBy: 'updatedAt', direction: 'asc', limit: 21, after: parseCursor(ctx.request.payload.cursor) });
  const page = paginated(rows, 'updatedAt');
  const items = await ctx.store.transaction(async tx => {
    await ctx.staff(tx, ['owner']);
    const items = [];
    for (const candidate of page.items) {
      const row = await tx.get<SkillSubmission>('skill_submissions', candidate.id);
      if (!row || row.clubId !== ctx.clubId || row.state !== 'submitted') continue;
      const member = await tx.get<Membership>('memberships', row.memberId);
      if (!member || member.clubId !== ctx.clubId) continue;
      const { reviewedBy: _reviewer, ...summary } = row;
      items.push({ ...summary, nickname: member.nickname, memberNumber: member.memberNumber, skillTitle: skillDefinition(row.skillId).title });
    }
    return items;
  });
  return { items, nextCursor: page.nextCursor };
}
async function reviewSkill(ctx: Context) {
  fields(ctx, ['submissionId', 'decision', 'reason']);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner']);
    const p = ctx.request.payload;
    requireThat(p.decision === 'approved' || p.decision === 'changes_requested', 'INVALID_INPUT', '复核结论不正确');
    const reason = text(p.reason, '复核依据', 600);
    const row = await tx.get<SkillSubmission>('skill_submissions', text(p.submissionId, '提交编号', 100));
    requireThat(row?.clubId === ctx.clubId, 'FORBIDDEN', '提交记录不可访问');
    ctx.revision(row);
    requireThat(row.state === 'submitted', 'STATE_CONFLICT', '该记录当前不在待复核状态');
    const [asset] = await requireOwnedMemberMedia(tx, ctx.clubId, row.memberId, [row.assetId], 'skill');
    requireThat(asset.kind === 'video', 'STATE_CONFLICT', '提交的练习视频无法核对');
    await archiveSkill(ctx, tx, row);
    const updated: SkillSubmission = { ...row, state: p.decision, revision: row.revision + 1, updatedAt: ctx.now,
      reviewedAt: ctx.now, reviewedBy: actor.user.id, reviewReason: reason };
    await tx.set('skill_submissions', row.id, updated);
    await archiveSkill(ctx, tx, updated);
    // An evidence review is not a qualification award or a point transaction.
    await ctx.audit(tx, actor, 'skill_submission', row.id, { skillId: row.skillId, state: updated.state, revision: updated.revision }, reason);
    return submissionView(updated);
  });
}
async function saveReference(ctx: Context) {
  fields(ctx, ['skillId', 'title', 'url', 'verified', 'reason']);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner']);
    const skill = skillDefinition(ctx.request.payload.skillId);
    const url = validatePublicVideoUrl(text(ctx.request.payload.url, '示范视频地址', 1000));
    requireThat(ctx.request.payload.verified === true, 'INVALID_INPUT', '请核实视频来源、内容及使用权限');
    const reason = text(ctx.request.payload.reason, '来源核实说明', 500);
    const id = key('skill-reference', ctx.clubId, skill.id);
    const previous = await tx.get<SkillReference>('learning_catalog', id);
    ctx.revision(previous ?? { revision: 0 });
    const row: SkillReference = { id, clubId: ctx.clubId, skillId: skill.id, title: text(ctx.request.payload.title, '视频标题', 100), url, revision: (previous?.revision ?? 0) + 1 };
    await tx.set('learning_catalog', id, row);
    await ctx.audit(tx, actor, 'skill_reference', id, { skillId: skill.id, revision: row.revision }, reason);
    return { title: row.title, url: row.url, revision: row.revision };
  });
}

export async function dispatchLearning(ctx: Context): Promise<any> {
  switch (ctx.request.action) {
    case 'learning.catalog': return catalog(ctx);
    case 'staff.learning.catalog.get': return catalog(ctx, true);
    case 'staff.learning.catalog.save': return saveCatalog(ctx);
    case 'learning.mine': return mine(ctx);
    case 'learning.start': return start(ctx);
    case 'learning.answer': return answer(ctx);
    case 'skills.mine': return ownSkills(ctx);
    case 'skills.submit': return submitSkill(ctx);
    case 'skills.cancel': return cancelSkill(ctx);
    case 'skills.history': return skillHistory(ctx);
    case 'staff.skills.history': return skillHistory(ctx, true);
    case 'staff.skills.queue': return skillQueue(ctx);
    case 'staff.skills.review': return reviewSkill(ctx);
    case 'staff.skills.reference.save': return saveReference(ctx);
    default: requireThat(false, 'INVALID_INPUT', '未知学习操作');
  }
}
