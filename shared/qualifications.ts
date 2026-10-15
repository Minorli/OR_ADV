import { Context, paginated, parseCursor } from './context';
import { requireThat, text } from './errors';
import { key } from './models';
import type { Membership, Qualification } from './models';

export async function listQualifications(ctx: Context, own = false) {
  const memberId = await ctx.store.transaction(async (tx) => {
    if (own) return (await ctx.actor(tx)).member.id;
    await ctx.staff(tx, ['owner','operator']);
    const member = await tx.get<Membership>('memberships', text(ctx.request.payload.memberId, 'memberId', 100));
    requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员不可访问');
    return member.id;
  });
  const rows = await ctx.store.query<Qualification>('qualifications', { clubId: ctx.clubId, memberId }, { orderBy: 'id', limit: 21, after: parseCursor(ctx.request.payload.cursor) });
  const page = paginated(rows, 'id');
  return { ...page, items: page.items.map((row) => ({ id: row.id, memberId, type: row.type, decision: row.decision,
    expiresAt: row.expiresAt, revision: row.revision ?? 0, reviewedAt: row.reviewedAt ?? null })) };
}
export async function reviewQualification(ctx: Context) {
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner','operator']);
    const p = ctx.request.payload;
    const member = await tx.get<Membership>('memberships', text(p.memberId, 'memberId', 100));
    requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员不可访问');
    requireThat(p.decision === 'approved' || p.decision === 'rejected', 'INVALID_INPUT', '资格结论不正确');
    const type = text(p.type, '资格类型', 60);
    const id = key('qualification', ctx.clubId, member.id, type);
    const existing = await tx.get<Qualification>('qualifications', id);
    ctx.revision({ revision: existing?.revision ?? 0 });
    let expiresAt: string | null = null;
    if (p.expiresAt !== undefined && p.expiresAt !== null) {
      const value = text(p.expiresAt, '资格期限', 40);
      requireThat(Number.isFinite(Date.parse(value)) && /Z$|[+-]\d\d:\d\d$/.test(value), 'INVALID_INPUT', '资格期限须包含时区');
      expiresAt = new Date(value).toISOString();
      requireThat(p.decision !== 'approved' || expiresAt > ctx.now, 'INVALID_INPUT', '通过资格须在有效期内');
    }
    const reason = text(p.reason, '核验依据', 500);
    const row: Qualification = { id, clubId: ctx.clubId, memberId: member.id, type, decision: p.decision, expiresAt,
      revision: (existing?.revision ?? 0) + 1, reviewedAt: ctx.now, reviewedBy: actor.user.id, reason };
    await tx.set('qualifications', id, row);
    await ctx.audit(tx, actor, 'qualification', id, { memberId: member.id, type, decision: row.decision, expiresAt, revision: row.revision }, reason);
    return { id, memberId: member.id, type, decision: row.decision, expiresAt, revision: row.revision, reviewedAt: row.reviewedAt };
  });
}
