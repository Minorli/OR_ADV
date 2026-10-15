import { call, currentMember, errorMessage, isMock } from '../../services/api';
import { activityCard } from '../../services/presentation';
import type { Activity, MemberSummary, PageResult } from '../../../../shared/types';
Page({
  data: { isMock, items: [] as ReturnType<typeof activityCard>[], member: null as MemberSummary | null, loading: false, requestVersion: 0, error: '', filter: 'all', nextCursor: null as string | null, filters: [{ value: 'all', label: '全部活动' }, { value: 'published', label: '正在招募' }, { value: 'in_progress', label: '正在同行' }, { value: 'settled', label: '往期记录' }] },
  onShow() { void this.load(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && this.data.loading) return;
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion });
    try {
      const result = await call<PageResult<Activity>>('activity.list', { state: this.data.filter === 'all' ? undefined : this.data.filter, cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ items: [...(append ? this.data.items : []), ...result.items.map(activityCard)], nextCursor: result.nextCursor });
      const member = await currentMember();
      if (this.data.requestVersion === requestVersion) this.setData({ member });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  filter(event: WechatMiniprogram.TouchEvent) { this.setData({ filter: event.currentTarget.dataset.value, items: [], nextCursor: null }); void this.load(); },
  more() { void this.load(true); },
  retry() { void this.load(); },
  open(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/activity/detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  profile() { wx.navigateTo({ url: '/pages/profile/index' }); },
  points() { wx.switchTab({ url: '/pages/points/index' }); },
});
