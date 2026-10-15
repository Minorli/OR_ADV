import { call, currentMember, errorMessage, isMock } from '../../services/api';
import { activityCard, registrationCard } from '../../services/presentation';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
Page({
  data: { isMock, id: '', activity: null as ReturnType<typeof activityCard> | null, member: null as MemberSummary | null, registration: null as ReturnType<typeof registrationCard> | null, gap: 0, loading: false, error: '' },
  onLoad(options: Record<string, string>) { this.setData({ id: options.id || '' }); },
  onShow() { void this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const activity = await call<Activity>('activity.get', { activityId: this.data.id });
      const member = await currentMember();
      let registration: ReturnType<typeof registrationCard> | null = null;
      if (member) {
        const result = await call<PageResult<Registration>>('registration.mine', { activityId: activity.id, limit: 100 });
        const found = result.items.find(item => item.activityId === activity.id && item.state !== 'cancelled');
        if (found) registration = registrationCard(found);
      }
      this.setData({ activity: activityCard(activity), member, registration, gap: Math.max(0, activity.minGrowthPoints - (member?.growthPoints || 0)) });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  retry() { void this.load(); },
  apply() { wx.navigateTo({ url: `/pages/registration/apply?id=${encodeURIComponent(this.data.id)}` }); },
  mine() { wx.switchTab({ url: '/pages/mine/index' }); },
});
