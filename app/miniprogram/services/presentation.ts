import type { Activity, Registration } from '../../../shared/types';
export const activityStates: Record<string, string> = { draft: '草稿', published: '招募中', closed: '报名已关闭', in_progress: '进行中', ended: '待结算', settled: '已结算', cancelled: '已取消' };
export const registrationStates: Record<string, string> = { pending_review: '待资格审核', waitlisted: '候补中', pending_confirmation: '待联系确认', confirmed: '确认参加', checked_in: '已出发核验', pending_settlement: '已结束待核验', completed: '已完成', safe_exit: '安全退出', no_show: '未到', cancelled: '已取消', rejected: '审核未通过' };
export function dateText(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待确认';
  // Use a fixed UTC+8 offset: WeChat devices need not share the club timezone.
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${china.getUTCFullYear()}.${pad(china.getUTCMonth() + 1)}.${pad(china.getUTCDate())} ${pad(china.getUTCHours())}:${pad(china.getUTCMinutes())}`;
}
export function activityCard(activity: Activity) {
  return { ...activity, stateText: activityStates[activity.state] || activity.state, dateText: dateText(activity.startAt), endText: dateText(activity.endAt), deadlineText: dateText(activity.applicationClosesAt), slots: Math.max(0, activity.capacity - activity.reservedSeats), canApply: activity.state === 'published' && Date.parse(activity.applicationClosesAt) > Date.now() };
}
export function registrationCard(registration: Registration) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const lastDay = registration.lastDepartureDay;
  const completionVoided = (registration as Registration & { completionVoided?: boolean }).completionVoided === true;
  return { ...registration, completionVoided, stateText: registration.activityState === 'cancelled' ? '活动已取消' : completionVoided ? '完成已更正' : registrationStates[registration.state] || registration.state, createdText: dateText(registration.createdAt), canCancel: ['pending_review', 'waitlisted', 'pending_confirmation', 'confirmed'].includes(registration.state), canReview: ['pending_review', 'waitlisted'].includes(registration.state), canConfirm: registration.state === 'pending_confirmation', canDepart: registration.state === 'confirmed' || (registration.state === 'checked_in' && !!lastDay && lastDay < today), canReturn: registration.state === 'checked_in' && lastDay === today };
}
export const mockRoleLabels = ['游客', '俱乐部成员', '创始合伙人', '主理人', '运营', '领队', '签到员'];
export const mockRoles = ['guest', 'member', 'founder', 'owner', 'operator', 'leader', 'checkin'] as const;
