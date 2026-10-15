import { requireThat, text } from './errors';
import type { Context } from './context';
import { collect, refreshRankings } from './context';
import { key, memberIdFor, shanghaiYear, userIdFor } from './models';
import type { Membership, User } from './models';

async function syncProfileProjections(ctx: Context, memberId: string) {
  const projections = await collect<{ id: string }>(ctx.store, 'public_rankings', { clubId: ctx.clubId, memberId });
  for (let start = 0; start < projections.length; start += 20) {
    await ctx.store.transaction(async (tx) => {
      const member = await tx.get<Membership>('memberships', memberId);
      requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员不存在');
      const user = await tx.get<User>('users', member.userId);
      for (const projection of projections.slice(start, start + 20)) {
        const row = await tx.get<Record<string, unknown>>('public_rankings', projection.id);
        if (row) await tx.set('public_rankings', projection.id, { ...row, nickname: member.nickname,
          visible: member.rankingOptIn && user?.status === 'active', consentVersion: member.rankingConsentVersion });
      }
    });
  }
}

export async function ensureIdentity(ctx: Context) {
  requireThat(ctx.identity?.appId && ctx.identity.openId, 'UNAUTHENTICATED', '当前无法取得可信微信身份');
  const identity = ctx.identity;
  return ctx.store.transaction(async (tx) => {
    const userId = userIdFor(identity);
    const existing = await tx.get<User>('users', userId);
    if (existing) return ctx.summary(tx, await ctx.actor(tx));
    const consent = ctx.request.payload.consentVersions;
    requireThat(consent && typeof consent === 'object' && !Array.isArray(consent), 'INVALID_INPUT', '请先确认隐私和用户规则');
    const consentVersions = consent as Record<string, unknown>;
    requireThat(consentVersions.privacy === 1 && consentVersions.terms === 1, 'INVALID_INPUT', '请同意当前隐私与用户规则');
    const user: User = { id: userId, clubId: ctx.clubId, appId: identity.appId, wxOpenId: identity.openId, status: 'active',
      consentVersions: { privacy: 1, terms: 1 }, createdAt: ctx.now, updatedAt: ctx.now };
    const id = memberIdFor(ctx.clubId, userId);
    const member: Membership = { id, clubId: ctx.clubId, userId, nickname: ctx.request.payload.nickname ? text(ctx.request.payload.nickname, '昵称', 30) : '新车友',
      publicId: key('public', ctx.id()), rankingOptIn: false, rankingConsentVersion: 0, revision: 1, createdAt: ctx.now, updatedAt: ctx.now };
    await tx.set('users', user.id, user);
    await tx.set('memberships', id, member);
    await ctx.audit(tx, { user, member }, 'membership', id, { created: true });
    return ctx.summary(tx, { user, member });
  });
}

export async function currentIdentity(ctx: Context) {
  if (!ctx.identity) return null;
  return ctx.store.transaction(async (tx) => {
    if (!await tx.get<User>('users', userIdFor(ctx.identity!))) return null;
    return ctx.summary(tx, await ctx.actor(tx));
  });
}

export async function updateProfile(ctx: Context) {
  const summary = await ctx.store.transaction(async (tx) => {
    const current = await ctx.actor(tx);
    ctx.revision(current.member);
    const payload = ctx.request.payload;
    requireThat(!Object.keys(payload).some((name) => !['nickname','rankingOptIn','rankingConsentVersion'].includes(name)), 'INVALID_INPUT', '含不允许修改的字段');
    if (payload.rankingOptIn !== undefined) requireThat(typeof payload.rankingOptIn === 'boolean', 'INVALID_INPUT', '榜单选项不正确');
    if (payload.rankingOptIn === true) requireThat(payload.rankingConsentVersion === 1, 'INVALID_INPUT', '请确认公开榜单说明');
    const member: Membership = { ...current.member, nickname: payload.nickname === undefined ? current.member.nickname : text(payload.nickname, '昵称', 30),
      rankingOptIn: payload.rankingOptIn === undefined ? current.member.rankingOptIn : payload.rankingOptIn as boolean,
      rankingConsentVersion: payload.rankingOptIn === true ? 1 : current.member.rankingConsentVersion,
      revision: current.member.revision + 1, updatedAt: ctx.now };
    await tx.set('memberships', member.id, member);
    await refreshRankings(ctx, tx, member, shanghaiYear(ctx.now));
    await ctx.audit(tx, current, 'membership', member.id, { rankingOptIn: member.rankingOptIn, revision: member.revision });
    return ctx.summary(tx, { ...current, member });
  });
  // Consent is authoritative immediately. Historical projections are then
  // invalidated in small transactions, each using the latest consent value.
  await syncProfileProjections(ctx, summary.id);
  return summary;
}

export async function requestDeletion(ctx: Context) {
  const actor = await ctx.store.transaction((tx) => ctx.actor(tx));
  const result = await ctx.store.transaction(async (tx) => {
    const current = await ctx.actor(tx);
    const user = { ...current.user, status: 'deletion_requested' as const, updatedAt: ctx.now };
    const member = { ...current.member, rankingOptIn: false, revision: current.member.revision + 1, updatedAt: ctx.now };
    await tx.set('users', user.id, user);
    await tx.set('memberships', member.id, member);
    await ctx.audit(tx, current, 'membership', member.id, { status: 'deletion_requested' });
    return { status: 'deletion_requested', message: '已停止受限访问及公开展示；必要业务记录等待人工审核处理。' };
  });
  await syncProfileProjections(ctx, actor.member.id);
  return result;
}
