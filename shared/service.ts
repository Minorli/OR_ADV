import { Context } from './context';
import { DomainError, requireThat } from './errors';
import { changeActivity, getActivity, listActivities, saveActivity } from './activities';
import { currentIdentity, ensureIdentity, requestDeletion, updateProfile } from './identity';
import { applyRegistration, cancelRegistration, listRegistrations, promoteWaitlist, recordCheckin, reviewRegistration } from './registrations';
import { listRankings, ownPoints, previewSettlement, reversePoints, runSettlement } from './points';
import { assignRole, recordReward, rewardSnapshot } from './staff';
import type { Store } from './store';
import type { ServiceOptions } from './models';
import type { RpcRequest, RpcResponse, TrustedIdentity } from './types';

export function createService(store: Store, options: ServiceOptions = {}) {
  return {
    async handle(request: RpcRequest, identity: TrustedIdentity | null, traceId?: string): Promise<RpcResponse> {
      let ctx: Context | undefined;
      try {
        requireThat(request && typeof request === 'object' && typeof request.action === 'string' && request.action.length <= 80, 'INVALID_INPUT', '请求格式不正确');
        requireThat(typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 100, 'INVALID_INPUT', '缺少请求标识');
        requireThat(request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload), 'INVALID_INPUT', '参数格式不正确');
        requireThat(JSON.stringify(request).length <= 20000, 'INVALID_INPUT', '请求内容过大');
        ctx = new Context(store, options, request, identity, traceId);
        requireThat(request.clubId === ctx.clubId, 'FORBIDDEN', '没有此俱乐部访问权限');
        let data: unknown;
        switch (request.action) {
          case 'identity.ensure': data = await ensureIdentity(ctx); break;
          case 'identity.me': data = await currentIdentity(ctx); break;
          case 'identity.delete': data = await requestDeletion(ctx); break;
          case 'profile.update': data = await updateProfile(ctx); break;
          case 'activity.list': data = await listActivities(ctx); break;
          case 'activity.get': data = await getActivity(ctx); break;
          case 'registration.apply': data = await applyRegistration(ctx); break;
          case 'registration.cancel': data = await cancelRegistration(ctx); break;
          case 'registration.mine': data = await listRegistrations(ctx); break;
          case 'points.mine': data = await ownPoints(ctx); break;
          case 'ranking.list': data = await listRankings(ctx); break;
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
