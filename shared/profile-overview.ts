import { Context } from './context';
import { publicClub } from './club';
import { requireThat } from './errors';
import { key, userIdFor } from './models';
import type { User } from './models';
import type { MemberDossier } from './dossier-types';
import { profileDossierProgress } from './profile-overview-types';
import type { ProfileOverview, ProfileStatistics } from './profile-overview-types';
import { ownRanking } from './club-overview';

/** One client request, one member snapshot, no additional identity RPCs. */
export async function profileOverview(ctx: Context): Promise<ProfileOverview> {
  requireThat(Object.keys(ctx.request.payload).length === 0, 'INVALID_INPUT', '个人页面查询不接受其他参数');
  const contactRead = publicClub(ctx).then(contact => ({ contact, contactError: '' }), () => ({
    contact: { clubId: ctx.clubId, name: '原始拉力', contactName: '', contactMethod: 'other' as const,
      contactValue: '', contactInstructions: '', revision: 0, configured: false }, contactError: '联系信息暂时无法显示',
  }));
  const viewerRead = ctx.store.transaction(async tx => {
    if (!ctx.identity || !await tx.get<User>('users', userIdFor(ctx.identity))) return null;
    const actor = await ctx.actor(tx), member = await ctx.summary(tx, actor);
    const dossier = await tx.get<MemberDossier>('member_dossiers', key('dossier', ctx.clubId, member.id));
    requireThat(!dossier || dossier.clubId === ctx.clubId && dossier.memberId === member.id && dossier.kind === 'dossier', 'FORBIDDEN', '当前成员资料无法显示');
    return { member, dossier: profileDossierProgress(dossier), avatarFileId: actor.member.avatarFileId, joinedAt: actor.member.createdAt };
  });
  const [contactResult, viewerResult] = await Promise.allSettled([contactRead, viewerRead]);
  if (viewerResult.status === 'rejected') throw viewerResult.reason;
  if (contactResult.status === 'rejected') throw contactResult.reason;
  const viewer = viewerResult.value, { contact, contactError } = contactResult.value;
  let statistics: ProfileStatistics | null = viewer ? { joinedAt: Number.isFinite(Date.parse(viewer.joinedAt)) ? viewer.joinedAt : null,
    rank: null, rankedMembers: null, distanceKm: null, distanceStatus: 'unrecorded' } : null;
  let statisticsError = '';
  // No opt-in means no scan. This optional calculation uses the exact public
  // ranking algorithm and never starts additional client identity requests.
  const rankRead = viewer?.member.rankingOptIn ? ownRanking(new Context(ctx.store, { ...ctx.options, now: () => ctx.now },
    { ...ctx.request, action: 'ranking.mine', payload: { metric: 'growth' } }, ctx.identity, ctx.traceId), { deadlineMs: Date.now() + 2000 })
    .then(value => { if (statistics) statistics = { ...statistics, rank: value.rank, rankedMembers: value.publicCount }; },
      () => { statisticsError = '排名暂时无法显示，请稍后刷新'; }) : Promise.resolve();
  let avatarUrl = '', avatarError = '';
  const avatarRead = (async () => { if (viewer?.avatarFileId) {
    try {
      requireThat(ctx.options.avatarStorage, 'TEMPORARY_FAILURE', '头像暂时无法显示');
      avatarUrl = await ctx.options.avatarStorage.url(viewer.avatarFileId);
    } catch { avatarError = '头像暂时无法显示，请重试'; }
    if (avatarUrl) await ctx.store.transaction(async tx => {
      const current = await ctx.actor(tx);
      ctx.revision(current.member, viewer.member.revision);
      requireThat(current.member.id === viewer.member.id && current.member.avatarFileId === viewer.avatarFileId, 'CONFLICT_REFRESH', '头像已更新，请刷新页面');
    });
  } })();
  const optional = await Promise.allSettled([rankRead, avatarRead]);
  for (const result of optional) if (result.status === 'rejected') throw result.reason;
  let member = viewer?.member ?? null;
  if (viewer) await ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    requireThat(actor.member.id === viewer.member.id, 'FORBIDDEN', '当前成员身份已变化');
    if (actor.member.revision !== viewer.member.revision) {
      member = await ctx.summary(tx, actor);
      if (statistics) statistics = { ...statistics, rank: null, rankedMembers: null };
    }
  });
  return { member, contact, contactError, dossier: viewer?.dossier ?? null, avatarUrl, avatarError, statistics, statisticsError };
}
