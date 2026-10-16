import { Context } from './context';
import { DomainError, requireThat } from './errors';
import { changeActivity, getActivity, listActivities, saveActivity } from './activities';
import { currentIdentity, ensureIdentity, requestDeletion, updateProfile } from './identity';
import { applyRegistration, cancelRegistration, listRegistrations, promoteWaitlist, recordCheckin, registrationTimeline, reviewRegistration } from './registrations';
import { listRankings, ownPoints, previewSettlement, reversePoints, runSettlement } from './points';
import { assignRole, recordReward, rewardSnapshot } from './staff';
import type { Store } from './store';
import type { ServiceOptions } from './models';
import type { RpcRequest, RpcResponse, TrustedIdentity } from './types';
import { assignMemberKind, listMemberRoles, listMembers, listRecommendations, requestMemberKind } from './members';
import { getBriefing, publicClub, saveBriefing, saveClub } from './club';
import { listQualifications, reviewQualification } from './qualifications';
import { ownAvatar, saveAvatar } from './profile-avatar';
import { AVATAR_REQUEST_LIMIT } from './avatar-image';
import { getDossier, saveDossier, submitDossier, reviewDossier, listDossiers } from './dossier';
import { saveMemberMediaImage, saveMemberMediaVideo, getMemberMediaUrl, cancelMemberMedia } from './member-media';
import { LEARNING_ACTIONS, dispatchLearning } from './learning';
import { CLUB_CONTENT_ACTIONS, dispatchClubContent } from './club-content';
import { HISTORY_CONTENT_ACTIONS, dispatchHistoryContent } from './history-content';
import { OVERVIEW_ACTIONS, dispatchClubOverview } from './club-overview';

export function createService(store: Store, options: ServiceOptions = {}) {
  return {
    async handle(request: RpcRequest, identity: TrustedIdentity | null, traceId?: string): Promise<RpcResponse> {
      let ctx: Context | undefined;
      try {
        requireThat(request && typeof request === 'object' && typeof request.action === 'string' && request.action.length <= 80, 'INVALID_INPUT', '请求格式不正确');
        requireThat(typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 100, 'INVALID_INPUT', '缺少请求标识');
        requireThat(request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload), 'INVALID_INPUT', '参数格式不正确');
        requireThat(JSON.stringify(request).length <= (['profile.avatar.save','media.image.save'].includes(request.action) ? AVATAR_REQUEST_LIMIT : request.action === 'staff.learning.catalog.save' ? 262144 : ['staff.club.content.save','staff.history.save'].includes(request.action) ? 65536 : 20000), 'INVALID_INPUT', '请求内容过大');
        ctx = new Context(store, options, request, identity, traceId);
        requireThat(request.clubId === ctx.clubId, 'FORBIDDEN', '没有此俱乐部访问权限');
        let data: unknown;
        if (LEARNING_ACTIONS.some(action => action === request.action)) data = await dispatchLearning(ctx);
        else if (CLUB_CONTENT_ACTIONS.some(action => action === request.action)) data = await dispatchClubContent(ctx);
        else if (HISTORY_CONTENT_ACTIONS.some(action => action === request.action)) data = await dispatchHistoryContent(ctx);
        else if (OVERVIEW_ACTIONS.some(action => action === request.action)) data = await dispatchClubOverview(ctx);
        else switch (request.action) {
          case 'media.image.save': data = await saveMemberMediaImage(ctx); break;
          case 'media.video.save': data = await saveMemberMediaVideo(ctx); break;
          case 'media.get': data = await getMemberMediaUrl(ctx); break;
          case 'media.cancel': data = await cancelMemberMedia(ctx); break;
          case 'dossier.mine': data = await getDossier(ctx); break;
          case 'dossier.save': data = await saveDossier(ctx); break;
          case 'dossier.submit': data = await submitDossier(ctx); break;
          case 'staff.dossier.list': data = await listDossiers(ctx); break;
          case 'staff.dossier.get': data = await getDossier(ctx, true); break;
          case 'staff.dossier.review': data = await reviewDossier(ctx); break;
          case 'identity.ensure': data = await ensureIdentity(ctx); break;
          case 'identity.me': data = await currentIdentity(ctx); break;
          case 'identity.delete': data = await requestDeletion(ctx); break;
          case 'identity.memberKind.request': data = await requestMemberKind(ctx); break;
          case 'profile.update': data = await updateProfile(ctx); break;
          case 'profile.avatar.save': data = await saveAvatar(ctx); break;
          case 'profile.avatar.get': data = await ownAvatar(ctx); break;
          case 'activity.list': data = await listActivities(ctx); break;
          case 'activity.get': data = await getActivity(ctx); break;
          case 'club.public': data = await publicClub(ctx); break;
          case 'staff.club.save': data = await saveClub(ctx); break;
          case 'activity.briefing.get': data = await getBriefing(ctx); break;
          case 'staff.briefing.save': data = await saveBriefing(ctx); break;
          case 'registration.apply': data = await applyRegistration(ctx); break;
          case 'registration.cancel': data = await cancelRegistration(ctx); break;
          case 'registration.mine': data = await listRegistrations(ctx); break;
          case 'registration.timeline': data = await registrationTimeline(ctx); break;
          case 'points.mine': data = await ownPoints(ctx); break;
          case 'ranking.list': data = await listRankings(ctx); break;
          case 'recommendation.list': data = await listRecommendations(ctx); break;
          case 'staff.member.list': data = await listMembers(ctx); break;
          case 'staff.member.assign': data = await assignMemberKind(ctx); break;
          case 'staff.recommendation.save': data = await assignMemberKind(ctx, true); break;
          case 'staff.roles.list': data = await listMemberRoles(ctx); break;
          case 'staff.qualification.list': data = await listQualifications(ctx); break;
          case 'staff.qualification.review': data = await reviewQualification(ctx); break;
          case 'qualifications.mine': data = await listQualifications(ctx, true); break;
          case 'staff.activity.list': data = await listActivities(ctx, true); break;
          case 'staff.activity.save': data = await saveActivity(ctx); break;
          case 'staff.activity.publish': case 'staff.activity.close': case 'staff.activity.start': case 'staff.activity.end': case 'staff.activity.cancel':
            data = await changeActivity(ctx, request.action.split('.')[2]); break;
          case 'staff.registration.list': data = await listRegistrations(ctx, true); break;
          case 'staff.registration.review': data = await reviewRegistration(ctx); break;
          case 'staff.registration.confirm': data = await reviewRegistration(ctx, true); break;
          case 'staff.waitlist.promote': case 'staff.registration.promote': data = await promoteWaitlist(ctx); break;
          case 'staff.checkin': case 'staff.checkin.record': data = await recordCheckin(ctx); break;
          case 'staff.settlement.preview': data = await previewSettlement(ctx); break;
          case 'staff.settlement.run': data = await runSettlement(ctx); break;
          case 'staff.points.reverse': data = await reversePoints(ctx); break;
          case 'staff.roles.assign': data = await assignRole(ctx); break;
          case 'staff.rewards.snapshot': data = await rewardSnapshot(ctx); break;
          case 'staff.rewards.record': data = await recordReward(ctx); break;
          default: throw new DomainError('INVALID_INPUT', '未知操作');
        }
        return { ok: true, data, traceId: ctx.traceId };
      } catch (error) {
        const known = error instanceof DomainError;
        return { ok: false, error: { code: known ? error.code : 'TEMPORARY_FAILURE', message: known ? error.message : '服务暂时不可用，请稍后重试', retryable: known ? error.retryable : true }, traceId: ctx?.traceId ?? traceId ?? 'invalid-request' };
      }
    },
  };
}
