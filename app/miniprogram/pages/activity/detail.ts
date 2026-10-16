import { call, currentMember, errorMessage, isMock } from '../../services/api';
import { registrationCard } from '../../services/presentation';
import { activityVisual } from '../../services/visual';
import { emptyContact, contactPerson, memberKindText, tripNextAction } from '../../services/member';
import type { ClubContact } from '../../services/member';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
Page({
  data: { isMock, id: '', activity: null as ReturnType<typeof activityVisual> | null, member: null as MemberSummary | null, contact: emptyContact, kindLabel: '游客', registration: null as ReturnType<typeof registrationCard> | null, nextAction: '', gap: 0, loading: false, requestVersion: 0, coverFailed: false, error: '' },
  onLoad(options: Record<string, string>) { this.setData({ id: options.id || '' }); },
  onShow() { void this.load(); },
  async load() {
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', registration: null, nextAction: '', requestVersion });
    try {
      const activity = await call<Activity>('activity.get', { activityId: this.data.id });
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ activity: activityVisual(activity) });
      const [member, contact] = await Promise.all([currentMember(), call<ClubContact>('club.public')]);
      if (this.data.requestVersion !== requestVersion) return;
      let registration: ReturnType<typeof registrationCard> | null = null;
      if (member) {
        const result = await call<PageResult<Registration>>('registration.mine', { activityId: activity.id });
        const found = result.items.find(item => item.activityId === activity.id && item.state !== 'cancelled');
        if (found) registration = registrationCard({ ...found, activityState: activity.state });
      }
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ member, contact, kindLabel: memberKindText(member), registration, nextAction: registration ? tripNextAction(registration, member) : '', gap: Math.max(0, activity.minGrowthPoints - (member?.growthPoints || 0)) });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  coverError() { this.setData({ coverFailed: true }); },
  retry() { void this.load(); },
  apply() { wx.navigateTo({ url: `/pages/registration/apply?id=${encodeURIComponent(this.data.id)}` }); },
  mine() { wx.navigateTo({ url: `/pages/trip/detail?id=${encodeURIComponent(this.data.id)}` }); },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
});
