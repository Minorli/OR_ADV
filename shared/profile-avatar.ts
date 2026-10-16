import type { Context } from './context';
import { refreshRankings } from './context';
import { requireThat, text } from './errors';
import { validateAvatarImage } from './avatar-image';
import type { Membership } from './models';
import { shanghaiYear } from './models';
import { syncRecommendation } from './members';
import { syncProfileProjections } from './identity';

function log(ctx: Context, code: string): void {
  try { ctx.options.log?.({ action: 'profile.avatar.save', code }); } catch { /* Logging cannot undo a committed profile. */ }
}
async function cleanup(ctx: Context, fileId: string): Promise<void> {
  try { await ctx.options.avatarStorage!.remove(fileId); }
  catch { log(ctx, 'AVATAR_CLEANUP_FAILED'); }
}
async function cleanupUnboundUpload(ctx: Context, memberId: string, fileId: string): Promise<void> {
  try {
    const current = await ctx.store.transaction(tx => tx.get<Membership>('memberships', memberId));
    // A transaction can have committed even if its response was lost.
    if (current?.avatarFileId !== fileId) await cleanup(ctx, fileId);
  } catch { log(ctx, 'AVATAR_CLEANUP_DEFERRED'); }
}

export async function saveAvatar(ctx: Context) {
  const current = await ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    ctx.revision(actor.member);
    return actor;
  });
  const payload = ctx.request.payload;
  requireThat(Object.keys(payload).every(name => ['imageBase64', 'nickname'].includes(name)), 'INVALID_INPUT', '含不允许修改的头像字段');
  const nickname = payload.nickname === undefined ? undefined : text(payload.nickname, '昵称', 30);
  validateAvatarImage(payload.imageBase64);
  const storage = ctx.options.avatarStorage;
  requireThat(storage, 'TEMPORARY_FAILURE', '头像服务尚未配置，请稍后重试');
  const fileId = await storage.save(current.member.id, payload.imageBase64 as string);
  // Providers must create unique files. Never delete a currently bound reference.
  requireThat(typeof fileId === 'string' && fileId.length > 0 && fileId !== current.member.avatarFileId, 'TEMPORARY_FAILURE', '头像暂未保存，请刷新后重试');
  let result;
  try {
    result = await ctx.store.transaction(async tx => {
      const actor = await ctx.actor(tx);
      ctx.revision(actor.member);
      const member: Membership = { ...actor.member, avatarFileId: fileId, nickname: nickname ?? actor.member.nickname,
        revision: actor.member.revision + 1, updatedAt: ctx.now };
      await tx.set('memberships', member.id, member);
      if (nickname !== undefined) {
        await refreshRankings(ctx, tx, member, shanghaiYear(ctx.now));
        await syncRecommendation(ctx, tx, member);
      }
      await ctx.audit(tx, actor, 'membership', member.id, { avatarChanged: true, nicknameChanged: nickname !== undefined, revision: member.revision });
      return ctx.summary(tx, { ...actor, member });
    });
  } catch (error) {
    await cleanupUnboundUpload(ctx, current.member.id, fileId);
    throw error;
  }
  if (current.member.avatarFileId) await cleanup(ctx, current.member.avatarFileId);
  if (nickname !== undefined) {
    try { await syncProfileProjections(ctx, result.id); }
    catch { log(ctx, 'PROFILE_PROJECTION_REFRESH_FAILED'); }
  }
  return result;
}

export async function ownAvatar(ctx: Context): Promise<{ url: string | null }> {
  const actor = await ctx.store.transaction(tx => ctx.actor(tx));
  requireThat(Object.keys(ctx.request.payload).length === 0, 'INVALID_INPUT', '头像查询不接受其他成员信息');
  if (!actor.member.avatarFileId) return { url: null };
  requireThat(ctx.options.avatarStorage, 'TEMPORARY_FAILURE', '头像服务暂不可用，请稍后重试');
  const url = await ctx.options.avatarStorage.url(actor.member.avatarFileId);
  await ctx.store.transaction(async tx => {
    const current = await ctx.actor(tx);
    ctx.revision(current.member, actor.member.revision);
    requireThat(current.member.avatarFileId === actor.member.avatarFileId, 'CONFLICT_REFRESH', '头像已更新，请刷新后重试');
  });
  return { url };
}
