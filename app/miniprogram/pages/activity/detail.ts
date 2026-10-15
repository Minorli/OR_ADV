import { call, currentMember, errorMessage, isMock } from '../../services/api';
import { activityCard, registrationCard } from '../../services/presentation';
import { emptyContact, contactPerson, memberKindText, tripNextAction } from '../../services/member';
import type { ClubContact } from '../../services/member';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
Page({
  data: { isMock, id: '', activity: null as ReturnType<typeof activityCard> | null, member: null as MemberSummary | null, contact: emptyContact, kindLabel: '游客', registration: null as ReturnType<typeof registrationCard> | null, nextAction: '', gap: 0, loading: false, error: '' },
  onLoad(options: Record<string, string>) { this.setData({ id: options.id || '' }); },
  onShow() { void this.load(); },
  async load() {
    this.setData({ loading: true, error: '', registration: null, nextAction: '' });
    try {
      const activity = await call<Activity>('activity.get', { activityId: this.data.id });
      this.setData({ activity: activityCard(activity) });
      const [member, contact] = await Promise.all([currentMember(), call<ClubContact>('club.public')]);
      let registration: ReturnType<typeof registrationCard> | null = null;
      if (member) {
        const result = await call<PageResult<Registration>>('registration.mine', { activityId: activity.id });
        const found = result.items.find(item => item.activityId === activity.id && item.state !== 'cancelled');
        if (found) registration = registrationCard(found);
      }
      this.setData({ member, contact, kindLabel: memberKindText(member), registration, nextAction: registration ? tripNextAction(registration, member) : '', gap: Math.max(0, activity.minGrowthPoints - (member?.growthPoints || 0)) });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  retry() { void this.load(); },
  apply() { wx.navigateTo({ url: `/pages/registration/apply?id=${encodeURIComponent(this.data.id)}` }); },
  mine() { wx.navigateTo({ url: `/pages/trip/detail?id=${encodeURIComponent(this.data.id)}` }); },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
});
