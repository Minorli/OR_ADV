import { errorMessage, toast } from './api';
import type { ClubPublic, MemberSummary, Registration } from '../../../shared/types';
export type { ClubPublic as ClubContact, ActivityBriefing, RecommendationEntry as Recommendation } from '../../../shared/types';
export interface TimelineEntry {
  id: string; phase?: 'departure' | 'return'; day?: string; result?: string;
  state?: string; createdAt?: string; verifiedAt?: string; reason?: string;
}
export const emptyContact: ClubPublic = { clubId: 'oradv', name: '原始拉力', contactName: '', contactMethod: 'other', contactValue: '', contactInstructions: '', revision: 0, configured: false };
export function founder(member: MemberSummary | null): boolean { return member?.memberKind === 'founder'; }
export function memberKindText(member: MemberSummary | null): string { return !member ? '游客' : founder(member) ? '创始合伙人' : '俱乐部成员'; }
export function needsOfflineArrangement(registration: Registration, member: MemberSummary | null): boolean {
  return registration.activityState !== 'cancelled' && registration.state === 'pending_confirmation' && registration.seatState === 'held' && registration.confirmationPath !== 'founder_direct';
}
export function tripNextAction(registration: Registration, member: MemberSummary | null): string {
  if (registration.activityState === 'cancelled') return '本场活动已取消，原申请与操作记录保留。后续安排请联系组织方。';
  if (registration.state === 'checked_in' && registration.lastReturnDay && registration.lastReturnDay === registration.lastDepartureDay) return '今日结束已核验，后续行程仍需按天核对。';
  if (registration.completionVoided) return '原完成奖励已更正，查看成长记录核对原因。';
  if (needsOfflineArrangement(registration, member)) return '请按通知联系工作人员安排线下缴费，管理员确认后方可参加。';
  const text: Record<string, string> = { pending_review: '等待工作人员核对本场资格，暂无需安排线下缴费。', waitlisted: '候补不占名额，等待空位与资格复核，暂无需安排线下缴费。', pending_confirmation: '等待工作人员确认本场参加安排。', confirmed: '已确认参加，请查看集合安排与准备清单。', checked_in: '已出发核验，请按领队安排同行，结束后仍需核验。', pending_settlement: '已完成结束核验，等待本场结算。', completed: '本场已完成，查看经历与积分来源。', safe_exit: '本场记录为安全退出，不自动获得完成奖励。', no_show: '本场记录为未到，不获得完成奖励。', cancelled: '申请已取消。需要再次参加时，请重新查看活动条件。', rejected: '本次审核未通过，联系工作人员了解处理说明。' };
  return text[registration.state] || '查看本场最新安排。';
}
export async function contactPerson(method: string, value: string): Promise<void> {
  if (!value) { toast('联系办法尚未提供，请稍后再试'); return; }
  try {
    const phoneNumber = value.replace(/[\s()-]/g, '');
    if (method === 'phone' && /^\+?\d{5,20}$/.test(phoneNumber)) await wx.makePhoneCall({ phoneNumber });
    else { await wx.setClipboardData({ data: value }); toast('联系信息已复制'); }
  } catch (error) { toast(errorMessage(error)); }
}
