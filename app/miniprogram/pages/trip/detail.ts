import { call, currentMember, errorMessage, isMock, confirm, toast, MOCK_CHECKLIST_PREFIX } from '../../services/api';
import { activityCard, registrationCard, dateText } from '../../services/presentation';
import { emptyContact, contactPerson, needsOfflineArrangement, tripNextAction } from '../../services/member';
import type { ActivityBriefing, ClubContact, TimelineEntry } from '../../services/member';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
interface ChecklistItem { value: string; label: string; checked: boolean }
interface DisplayRecord { id: string; title: string; dateText: string; reason: string }
function checklistKey(registrationId: string, revision: number): string { return `${isMock ? MOCK_CHECKLIST_PREFIX : 'oradv-checklist-'}${registrationId}-${revision}`; }
function record(entry: TimelineEntry): DisplayRecord {
  const result = entry.result === 'safe_exit' ? '安全退出' : entry.result === 'no_show' ? '未到' : entry.phase === 'departure' ? '出发已核验' : '结束已核验';
  return { id: entry.id, title: result, dateText: entry.verifiedAt ? dateText(entry.verifiedAt) : entry.createdAt ? dateText(entry.createdAt) : entry.day || '', reason: entry.reason || '' };
}
Page({
  data: { isMock, id: '', activity: null as ReturnType<typeof activityCard> | null, member: null as MemberSummary | null, registration: null as ReturnType<typeof registrationCard> | null, contact: emptyContact, briefing: null as ActivityBriefing | null, meetingText: '', checklist: [] as ChecklistItem[], records: [] as DisplayRecord[], timelineCursor: null as string | null, nextAction: '', feeHint: false, canCancel: false, canReadBriefing: false, requestVersion: 0, loading: false, busy: false, error: '', briefingError: '', timelineError: '' },
  onLoad(options: Record<string, string>) { this.setData({ id: options.id || '' }); },
  onShow() { void this.load(); },
  async load() {
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, requestVersion, error: '', briefing: null, meetingText: '', checklist: [], records: [], canReadBriefing: false, registration: null, briefingError: '', timelineError: '', timelineCursor: null });
    try {
      const [activity, member, contact] = await Promise.all([call<Activity>('activity.get', { activityId: this.data.id }), currentMember(), call<ClubContact>('club.public')]);
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ activity: activityCard(activity), member, contact });
      if (!member) return;
      const result = await call<PageResult<Registration>>('registration.mine', { activityId: activity.id });
      if (this.data.requestVersion !== requestVersion) return;
      const found = result.items.find(item => item.activityId === activity.id);
      if (!found) return;
      const registration = registrationCard({ ...found, activityState: activity.state });
      const canReadBriefing = activity.state !== 'cancelled' && ['confirmed', 'checked_in', 'pending_settlement', 'completed'].includes(registration.state) && !registration.completionVoided;
      this.setData({ registration, canReadBriefing, canCancel: registration.canCancel && ['published', 'closed'].includes(activity.state), feeHint: needsOfflineArrangement(registration, member), nextAction: tripNextAction(registration, member) });
      await this.loadRecords(false, requestVersion);
      if (canReadBriefing) {
        try {
          const briefing = await call<ActivityBriefing | null>('activity.briefing.get', { activityId: activity.id });
          if (this.data.requestVersion !== requestVersion) return;
          if (!briefing) { this.setData({ briefingError: '行前安排尚未发布，请联系负责人' }); return; }
          const saved = wx.getStorageSync(checklistKey(registration.id, briefing.revision));
          const checked = Array.isArray(saved) ? saved as string[] : [];
          this.setData({ briefing, meetingText: Number.isFinite(Date.parse(briefing.meetingTime)) ? dateText(briefing.meetingTime) : briefing.meetingTime, checklist: briefing.checklist.map((label, index) => ({ label, value: String(index), checked: checked.includes(String(index)) })) });
        } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ briefingError: errorMessage(error) }); }
      }
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  async loadRecords(append = false, version?: number) {
    const requestVersion = version ?? this.data.requestVersion;
    const registration = this.data.registration;
    if (!registration) return;
    try {
      const result = await call<PageResult<TimelineEntry>>('registration.timeline', { registrationId: registration.id, cursor: append ? this.data.timelineCursor : undefined });
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ records: [...(append ? this.data.records : []), ...result.items.map(record)], timelineCursor: result.nextCursor, timelineError: '' });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ timelineError: errorMessage(error) }); }
  },
  retry() { void this.load(); },
  moreRecords() { void this.loadRecords(true); },
  checklist(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    if (!this.data.registration || !this.data.briefing) return;
    const checked = event.detail.value;
    this.setData({ checklist: this.data.checklist.map(item => ({ ...item, checked: checked.includes(item.value) })) });
    wx.setStorageSync(checklistKey(this.data.registration.id, this.data.briefing.revision), checked);
  },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
  leader() { if (this.data.briefing) void contactPerson(this.data.briefing.contactMethod, this.data.briefing.contactValue); },
  publicActivity() { wx.navigateTo({ url: `/pages/activity/detail?id=${encodeURIComponent(this.data.id)}` }); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  async cancel() {
    const registration = this.data.registration;
    if (!registration || !this.data.canCancel || this.data.busy || !await confirm('取消本次申请', '取消后释放预留名额，不再提供参加者专属资料，也不能继续现场核验。')) return;
    this.setData({ busy: true, error: '' });
    try { await call('registration.cancel', { registrationId: registration.id, reason: '车友主动取消申请' }, registration.revision); toast('申请已取消'); await this.load(); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
});
