import type { Context } from './context';
import { encodeCursor, parseCursor } from './context';
import { integer, requireThat, text } from './errors';
import { key } from './models';
import type { Membership } from './models';
import type { Transaction } from './store';
import { bindOwnedMemberMedia, requireOwnedMemberMedia } from './member-media';
import { DOSSIER_CONSENT_VERSION, DOSSIER_GEAR, emptyDossierDraft } from './dossier-types';
import type { DossierBike, DossierDraft, DossierQueueItem, DossierReview, DossierSubmission, MemberDossier } from './dossier-types';

const COLLECTION = 'member_dossiers';
const dossierId = (clubId: string, memberId: string) => key('dossier', clubId, memberId);
function object(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', `${label}格式不正确`);
  const row = value as Record<string, unknown>;
  requireThat(Object.keys(row).every(k => allowed.includes(k)), 'INVALID_INPUT', `${label}包含不支持的字段`);
  return row;
}
function optional(value: unknown, label: string, max: number): string {
  requireThat(typeof value === 'string' && value.length <= max, 'INVALID_INPUT', `${label}格式不正确`);
  return value.trim();
}
function asset(value: unknown): string | null {
  if (value === null || value === '') return null;
  const id = text(value, '照片', 120);
  requireThat(/^[a-zA-Z0-9_-]+$/.test(id), 'INVALID_INPUT', '照片标识不正确，请重新上传');
  return id;
}
function bike(value: unknown): DossierBike {
  const p = object(value, ['id', 'brand', 'model', 'year', 'plate', 'odometerKm', 'photoAssetId', 'tireAssetId'], '车辆');
  const id = text(p.id, '车辆标识', 40);
  requireThat(/^[a-zA-Z0-9_-]+$/.test(id), 'INVALID_INPUT', '车辆标识不正确');
  const year = optional(p.year, '车辆年份', 4);
  requireThat(!year || /^\d{4}$/.test(year) && Number(year) >= 1900 && Number(year) <= 2100, 'INVALID_INPUT', '请填写四位车辆年份');
  const odometerKm = p.odometerKm === null ? null : integer(p.odometerKm, '车辆里程');
  requireThat(odometerKm === null || odometerKm <= 2000000, 'INVALID_INPUT', '车辆里程超出范围');
  return { id, brand: optional(p.brand, '品牌', 40), model: optional(p.model, '车型', 80), year, plate: optional(p.plate, '车牌备注', 30),
    odometerKm, photoAssetId: asset(p.photoAssetId), tireAssetId: asset(p.tireAssetId) };
}
export function validateDossierDraft(value: unknown): DossierDraft {
  const p = object(value, ['riderName', 'ridingExperience', 'contactMethod', 'contactValue', 'emergencyContact', 'gear', 'bikes'], '资料');
  requireThat(p.contactMethod === 'wechat' || p.contactMethod === 'phone', 'INVALID_INPUT', '联系渠道不正确');
  const contactValue = optional(p.contactValue, '联系方式', 80);
  requireThat(p.contactMethod !== 'phone' || !contactValue || /^[+0-9 ()-]{5,30}$/.test(contactValue), 'INVALID_INPUT', '电话格式不正确');
  let emergencyContact: DossierDraft['emergencyContact'] = null;
  if (p.emergencyContact !== null) {
    const row = object(p.emergencyContact, ['name', 'phone', 'relationship'], '紧急联系人');
    emergencyContact = { name: optional(row.name, '紧急联系人称呼', 40), phone: optional(row.phone, '紧急联系人电话', 30), relationship: optional(row.relationship, '联系人关系', 30) };
    requireThat(!emergencyContact.phone || /^[+0-9 ()-]{5,30}$/.test(emergencyContact.phone), 'INVALID_INPUT', '紧急联系人电话格式不正确');
  }
  const g = object(p.gear, [...DOSSIER_GEAR], '护具照片');
  requireThat(Array.isArray(p.bikes) && p.bikes.length <= 3, 'INVALID_INPUT', '最多保存三辆车辆');
  const bikes = p.bikes.map(bike);
  requireThat(new Set(bikes.map(b => b.id)).size === bikes.length, 'INVALID_INPUT', '车辆标识重复');
  return { riderName: optional(p.riderName, '骑手称呼', 40), ridingExperience: optional(p.ridingExperience, '骑行经历', 300), contactMethod: p.contactMethod, contactValue, emergencyContact,
    gear: { helmet: asset(g.helmet), armor: asset(g.armor), knee: asset(g.knee), boots: asset(g.boots) }, bikes };
}
export function dossierMediaIds(draft: DossierDraft): string[] {
  return [...new Set([...Object.values(draft.gear), ...draft.bikes.flatMap(b => [b.photoAssetId, b.tireAssetId])].filter((id): id is string => !!id))];
}
function complete(draft: DossierDraft) {
  requireThat(draft.riderName && draft.ridingExperience && draft.contactValue, 'INVALID_INPUT', '请补全骑手称呼、骑行经历和联系方式');
  requireThat(DOSSIER_GEAR.every(name => draft.gear[name]), 'INVALID_INPUT', '请补全四类护具照片');
  requireThat(draft.bikes.length >= 1 && draft.bikes.every(b => b.brand && b.model && b.photoAssetId && b.tireAssetId), 'INVALID_INPUT', '请填写至少一辆车的品牌、车型、车辆照片和轮胎照片');
  if (draft.emergencyContact) requireThat(draft.emergencyContact.name && draft.emergencyContact.phone && draft.emergencyContact.relationship,
    'INVALID_INPUT', '请补全紧急联系人，或关闭此可选项');
}
function empty(ctx: Context, memberId: string): MemberDossier {
  return { id: dossierId(ctx.clubId, memberId), clubId: ctx.clubId, memberId, kind: 'dossier', revision: 0,
    status: 'draft', draft: emptyDossierDraft(), submission: null, review: null, createdAt: ctx.now, updatedAt: ctx.now };
}
async function target(ctx: Context, tx: Transaction, id: unknown): Promise<Membership> {
  const member = await tx.get<Membership>('memberships', text(id, 'memberId', 100));
  requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员资料不可访问');
  return member;
}
export async function getDossier(ctx: Context, staff = false): Promise<MemberDossier> {
  object(ctx.request.payload, staff ? ['memberId'] : [], '查询');
  return ctx.store.transaction(async tx => {
    const actor = staff ? await ctx.staff(tx, ['owner']) : await ctx.actor(tx);
    const member = staff ? await target(ctx, tx, ctx.request.payload.memberId) : actor.member;
    const row = await tx.get<MemberDossier>(COLLECTION, dossierId(ctx.clubId, member.id));
    if (staff) {
      requireThat(row?.status === 'pending' && row.submission, 'STATE_CONFLICT', '这份资料当前不在待审队列，请刷新');
      return { ...row, draft: row.submission.snapshot };
    }
    return row ?? empty(ctx, member.id);
  });
}
export async function saveDossier(ctx: Context): Promise<MemberDossier> {
  object(ctx.request.payload, ['draft'], '保存请求');
  const draft = validateDossierDraft(ctx.request.payload.draft);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), id = dossierId(ctx.clubId, actor.member.id);
    const stored = await tx.get<MemberDossier>(COLLECTION, id), prior = stored ?? empty(ctx, actor.member.id);
    ctx.revision(prior);
    const mediaIds = dossierMediaIds(draft);
    if (mediaIds.length) {
      const media = await requireOwnedMemberMedia(tx, ctx.clubId, actor.member.id, mediaIds, 'dossier');
      requireThat(media.every(asset => asset.kind === 'image'), 'INVALID_INPUT', '骑手资料仅接受照片');
    }
    if (stored && JSON.stringify(prior.draft) === JSON.stringify(draft)) return prior;
    const row: MemberDossier = { ...prior, draft, revision: prior.revision + 1, status: 'draft', review: null, updatedAt: ctx.now };
    await tx.set(COLLECTION, id, row);
    await ctx.audit(tx, actor, 'member_dossier', id, { revision: row.revision, state: row.status, bikeCount: draft.bikes.length, photoCount: mediaIds.length });
    return row;
  });
}
export async function submitDossier(ctx: Context): Promise<MemberDossier> {
  const p = object(ctx.request.payload, ['consent', 'consentVersion'], '提交请求');
  requireThat(p.consent === true && p.consentVersion === DOSSIER_CONSENT_VERSION, 'CONSENT_REQUIRED', '请阅读资料用途并确认本人提交');
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), id = dossierId(ctx.clubId, actor.member.id);
    const prior = await tx.get<MemberDossier>(COLLECTION, id);
    requireThat(prior, 'INVALID_INPUT', '请先保存资料草稿');
    ctx.revision(prior);
    requireThat(prior.status !== 'pending' && prior.status !== 'approved', 'STATE_CONFLICT', '这份资料已提交，请勿重复操作');
    const draft = validateDossierDraft(prior.draft); complete(draft);
    const revision = prior.revision + 1;
    const submission: DossierSubmission = { id: key('dossier_submission', ctx.clubId, actor.member.id, revision), submissionRevision: revision,
      submittedAt: ctx.now, snapshot: draft, consentVersion: DOSSIER_CONSENT_VERSION, attested: true };
    const media = await bindOwnedMemberMedia(tx, ctx.clubId, actor.member.id, dossierMediaIds(draft), 'dossier', submission.id);
    requireThat(media.every(asset => asset.kind === 'image'), 'INVALID_INPUT', '骑手资料仅接受照片');
    await tx.set(COLLECTION, submission.id, { ...submission, kind: 'dossier_submission', clubId: ctx.clubId, memberId: actor.member.id, review: null, createdAt: ctx.now });
    const row: MemberDossier = { ...prior, draft, submission, revision, status: 'pending', review: null, updatedAt: ctx.now };
    await tx.set(COLLECTION, id, row);
    await ctx.audit(tx, actor, 'member_dossier', id, { revision, submissionRevision: revision, state: row.status, consentVersion: DOSSIER_CONSENT_VERSION });
    return row;
  });
}
export async function reviewDossier(ctx: Context): Promise<MemberDossier> {
  const p = object(ctx.request.payload, ['memberId', 'decision', 'reason', 'submissionRevision'], '审核请求');
  requireThat(p.decision === 'approved' || p.decision === 'returned', 'INVALID_INPUT', '审核结论不正确');
  const reason = text(p.reason, '审核说明', 500), submissionRevision = integer(p.submissionRevision, '提交版本', 1);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner']), member = await target(ctx, tx, p.memberId);
    const id = dossierId(ctx.clubId, member.id), row = await tx.get<MemberDossier>(COLLECTION, id);
    requireThat(row?.status === 'pending' && row.submission, 'STATE_CONFLICT', '资料已修改或处理，请刷新');
    ctx.revision(row);
    requireThat(row.submission.submissionRevision === submissionRevision, 'CONFLICT_REFRESH', '提交版本已变化，请刷新');
    const archived = await tx.get<DossierSubmission & { review: DossierReview | null }>(COLLECTION, row.submission.id);
    requireThat(archived && !archived.review && archived.submissionRevision === submissionRevision, 'STATE_CONFLICT', '提交档案状态异常，请刷新');
    const review: DossierReview = { decision: p.decision as DossierReview['decision'], reason, reviewedAt: ctx.now, submissionRevision };
    const next: MemberDossier = { ...row, status: review.decision, review, revision: row.revision + 1, updatedAt: ctx.now };
    await tx.set(COLLECTION, row.submission.id, { ...archived, review, reviewedBy: actor.user.id });
    await tx.set(COLLECTION, id, next);
    await ctx.audit(tx, actor, 'member_dossier', id, { revision: next.revision, submissionRevision, state: next.status }, reason);
    return next;
  });
}
export async function listDossiers(ctx: Context): Promise<{ items: DossierQueueItem[]; nextCursor: string | null }> {
  object(ctx.request.payload, ['cursor'], '审核队列');
  await ctx.store.transaction(tx => ctx.staff(tx, ['owner']));
  const cursor = parseCursor(ctx.request.payload.cursor);
  if (cursor) requireThat(cursor.signature === 'dossier-pending-v1', 'INVALID_INPUT', '分页游标不正确');
  const rows = await ctx.store.query<MemberDossier>(COLLECTION, { clubId: ctx.clubId, kind: 'dossier', status: 'pending' }, { orderBy: 'id', limit: 21, after: cursor });
  const items = await ctx.store.transaction(async tx => {
    await ctx.staff(tx, ['owner']);
    const summaries: DossierQueueItem[] = [];
    for (const row of rows.slice(0, 20)) {
      const member = await target(ctx, tx, row.memberId);
      if (row.submission) summaries.push({ memberId: row.memberId, nickname: member.nickname, ...(member.memberNumber === undefined ? {} : { memberNumber: member.memberNumber }),
        revision: row.revision, submissionRevision: row.submission.submissionRevision, submittedAt: row.submission.submittedAt });
    }
    return summaries;
  });
  const last = rows[Math.min(rows.length, 20) - 1];
  return { items, nextCursor: rows.length > 20 && last ? encodeCursor({ value: last.id, id: last.id, signature: 'dossier-pending-v1' }) : null };
}
