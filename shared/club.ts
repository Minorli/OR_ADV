import { Context } from './context';
import { requireThat, text } from './errors';
import { key, registrationIdFor } from './models';
import type { Registration } from './types';
import type { ActivityBriefing, ClubPublic, ContactMethod } from './types';
import type { Transaction } from './store';

export function contactFields(payload: Record<string, unknown>) {
  requireThat(['phone','wechat','other'].includes(String(payload.contactMethod)), 'INVALID_INPUT', '请选择联系方式');
  const contactValue = text(payload.contactValue, '联系方式', 200);
  if (payload.contactMethod === 'phone') requireThat(/^\+?\d{5,20}$/.test(contactValue.replace(/[\s()-]/g, '')), 'INVALID_INPUT', '请输入可拨打的联系电话');
  return { contactName: text(payload.contactName, '联系人', 50), contactMethod: payload.contactMethod as ContactMethod,
    contactValue };
}
export async function publicClub(ctx: Context, tx?: Transaction): Promise<ClubPublic> {
  if (!tx) return ctx.store.transaction((transaction) => publicClub(ctx, transaction));
  const row = await tx.get<Record<string, unknown>>('clubs', ctx.clubId);
  const valid = row?.clubId === ctx.clubId;
  const validMethod = valid && ['phone','wechat','other'].includes(String(row.contactMethod));
  const contactMethod: ContactMethod = validMethod ? row!.contactMethod as ContactMethod : 'other';
  const contactName = valid && typeof row.contactName === 'string' ? row.contactName : '';
  const contactValue = valid && typeof row.contactValue === 'string' ? row.contactValue : '';
  return { clubId: ctx.clubId, name: valid && typeof row.name === 'string' ? row.name : '原始拉力', contactName, contactMethod, contactValue,
    contactInstructions: valid && typeof row.contactInstructions === 'string' ? row.contactInstructions : '',
    revision: valid && typeof row.revision === 'number' ? row.revision : 0, configured: !!(validMethod && contactName.trim() && contactValue.trim()) };
}
export async function saveClub(ctx: Context) {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every((name) => ['name','contactName','contactMethod','contactValue','contactInstructions'].includes(name)), 'INVALID_INPUT', '含不允许修改的俱乐部字段');
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner']);
    const current = await publicClub(ctx, tx);
    ctx.revision(current);
    const row = { id: ctx.clubId, clubId: ctx.clubId, name: text(p.name, '俱乐部名称', 80), ...contactFields(p),
      contactInstructions: p.contactInstructions ? text(p.contactInstructions, '联系说明', 1000) : '', revision: current.revision + 1 };
    await tx.set('clubs', ctx.clubId, row);
    await ctx.audit(tx, actor, 'club', ctx.clubId, { revision: row.revision, contactConfigured: true });
    return publicClub(ctx, tx);
  });
}
async function briefingAccess(ctx: Context, tx: Transaction, activityId: string) {
  const actor = await ctx.actor(tx);
  const roles = await ctx.roles(tx, actor);
  if (roles.some((role) => role.activityIds === null || role.activityIds.includes(activityId))) return;
  const registration = await tx.get<Registration>('registrations', registrationIdFor(ctx.clubId, activityId, actor.member.id));
  requireThat(registration?.clubId === ctx.clubId && registration.activityId === activityId && !registration.completionVoided && ['confirmed','checked_in','pending_settlement','completed'].includes(registration.state), 'FORBIDDEN', '仅确认参加者与本场工作人员可查看行前资料');
  const activity = await ctx.activity(tx, activityId);
  requireThat(activity.state !== 'cancelled' && activity.state !== 'draft', 'FORBIDDEN', '本场资料当前不可访问');
}
export async function getBriefing(ctx: Context): Promise<ActivityBriefing | null> {
  const activityId = text(ctx.request.payload.activityId, 'activityId', 100);
  return ctx.store.transaction(async (tx) => {
    await briefingAccess(ctx, tx, activityId);
    const row = await tx.get<ActivityBriefing>('activity_briefings', key('briefing', ctx.clubId, activityId));
    if (!row) return null;
    requireThat(row.clubId === ctx.clubId && row.activityId === activityId, 'FORBIDDEN', '资料不可访问');
    return row;
  });
}
export async function saveBriefing(ctx: Context) {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every((name) => ['activityId','meetingPoint','meetingTime','contactName','contactMethod','contactValue','checklist','notes'].includes(name)), 'INVALID_INPUT', '含不允许修改的资料字段');
  const activityId = text(p.activityId, 'activityId', 100);
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner','operator'], activityId);
    await ctx.activity(tx, activityId);
    const id = key('briefing', ctx.clubId, activityId);
    const previous = await tx.get<ActivityBriefing>('activity_briefings', id);
    ctx.revision(previous ?? { revision: 0 });
    requireThat(Array.isArray(p.checklist) && p.checklist.length <= 30 && p.checklist.every((item) => typeof item === 'string' && item.trim() && item.length <= 200), 'INVALID_INPUT', '准备清单不正确');
    const time = p.meetingTime === undefined || p.meetingTime === '' ? '' : text(p.meetingTime, '集合时间', 40);
    requireThat(!time || (Number.isFinite(Date.parse(time)) && /Z$|[+-]\d\d:\d\d$/.test(time)), 'INVALID_INPUT', '集合时间须包含时区');
    const briefing: ActivityBriefing = { id, clubId: ctx.clubId, activityId, meetingPoint: text(p.meetingPoint, '集合地点', 500),
      meetingTime: time ? new Date(time).toISOString() : '', ...contactFields(p), checklist: p.checklist as string[],
      notes: p.notes ? text(p.notes, '本场说明', 3000) : '', revision: (previous?.revision ?? 0) + 1, updatedAt: ctx.now };
    await tx.set('activity_briefings', id, briefing);
    await ctx.audit(tx, actor, 'activity_briefing', id, { activityId, revision: briefing.revision });
    return briefing;
  });
}
