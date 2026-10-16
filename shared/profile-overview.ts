import type { Context } from './context';
import { publicClub } from './club';
import { requireThat } from './errors';
import { key, userIdFor } from './models';
import type { User } from './models';
import type { MemberDossier } from './dossier-types';
import { profileDossierProgress } from './profile-overview-types';
import type { ProfileOverview } from './profile-overview-types';

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
    return { member, dossier: profileDossierProgress(dossier), avatarFileId: actor.member.avatarFileId };
  });
  const [contactResult, viewerResult] = await Promise.allSettled([contactRead, viewerRead]);
  if (viewerResult.status === 'rejected') throw viewerResult.reason;
  if (contactResult.status === 'rejected') throw contactResult.reason;
  const viewer = viewerResult.value, { contact, contactError } = contactResult.value;
  let avatarUrl = '', avatarError = '';
  if (viewer?.avatarFileId) {
    try {
      requireThat(ctx.options.avatarStorage, 'TEMPORARY_FAILURE', '头像暂时无法显示');
      avatarUrl = await ctx.options.avatarStorage.url(viewer.avatarFileId);
    } catch { avatarError = '头像暂时无法显示，请重试'; }
    if (avatarUrl) await ctx.store.transaction(async tx => {
      const current = await ctx.actor(tx);
      ctx.revision(current.member, viewer.member.revision);
      requireThat(current.member.id === viewer.member.id && current.member.avatarFileId === viewer.avatarFileId, 'CONFLICT_REFRESH', '头像已更新，请刷新页面');
    });
  }
  return { member: viewer?.member ?? null, contact, contactError, dossier: viewer?.dossier ?? null, avatarUrl, avatarError };
}
