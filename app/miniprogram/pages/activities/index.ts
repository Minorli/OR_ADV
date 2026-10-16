import { call, currentMember, errorMessage, isMock } from '../../services/api';
import { dateText, registrationCard } from '../../services/presentation';
import { activityVisual } from '../../services/visual';
import { memberKindText, tripNextAction } from '../../services/member';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
type JoinedRegistration = Registration & { activityStartAt?: string; activityState?: string };
interface NextTrip { activityId: string; title: string; dateText: string; stateText: string; nextAction: string; buttonLabel: string }
Page({
  data: { isMock, items: [] as ReturnType<typeof activityVisual>[], displayItems: [] as ReturnType<typeof activityVisual>[], heroCurrent: 0, coverErrors: {} as Record<string, boolean>, heroSlides: [
    { id: 'together', cover: '/assets/covers/dunes.jpg', kicker: 'ORIGINAL RALLY / TOGETHER', title: '一个人骑很快\n一群人走很远', caption: '原始拉力 · 和熟悉的车友，走下一段路' },
    { id: 'ready', cover: '/assets/covers/forest.jpg', kicker: 'BE READY / RIDE STEADY', title: '准备充分\n再去更远的地方', caption: '从基础控车，到一场完整的非铺装同行' },
    { id: 'record', cover: '/assets/covers/ridge.jpg', kicker: 'EVERY RIDE COUNTS', title: '走过的路\n都有迹可循', caption: '每场报名、核验与完成，留下一份记录' },
  ], member: null as MemberSummary | null, kindLabel: '游客', nextTrip: null as NextTrip | null, loading: false, requestVersion: 0, error: '', filter: 'published', nextCursor: null as string | null, filters: [{ value: 'all', label: '全部活动' }, { value: 'published', label: '正在招募' }, { value: 'in_progress', label: '正在同行' }, { value: 'settled', label: '往期记录' }] },
  onShow() { void this.load(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && this.data.loading) return;
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion, nextTrip: null });
    try {
      const result = await call<PageResult<Activity>>('activity.list', { state: this.data.filter === 'all' ? undefined : this.data.filter, cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      if (this.data.requestVersion !== requestVersion) return;
      const items = [...(append ? this.data.items : []), ...result.items.map(activityVisual)];
      const priority = (state: string) => state === 'published' ? 0 : state === 'in_progress' ? 1 : state === 'closed' ? 2 : 3;
      const displayItems = this.data.filter === 'all' ? [...items].sort((a, b) => priority(a.state) - priority(b.state) || Date.parse(a.startAt) - Date.parse(b.startAt)) : items;
      this.setData({ items, displayItems, nextCursor: result.nextCursor });
      const member = await currentMember();
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ member, kindLabel: memberKindText(member), nextTrip: null });
      if (member) {
        const own = await call<PageResult<JoinedRegistration>>('registration.mine');
        const active = own.items.filter(item => item.activityState !== 'cancelled' && ['pending_review', 'waitlisted', 'pending_confirmation', 'confirmed', 'checked_in', 'pending_settlement'].includes(item.state));
        const urgency = (state: string) => state === 'checked_in' ? 0 : state === 'pending_settlement' ? 1 : 2;
        active.sort((a, b) => urgency(a.state) - urgency(b.state) || (Date.parse(a.activityStartAt || '') || Number.MAX_SAFE_INTEGER) - (Date.parse(b.activityStartAt || '') || Number.MAX_SAFE_INTEGER));
        const selected = active[0];
        if (selected && this.data.requestVersion === requestVersion) this.setData({ nextTrip: { activityId: selected.activityId, title: selected.activityTitle || '我的活动', dateText: selected.activityStartAt ? dateText(selected.activityStartAt) : '', stateText: registrationCard(selected).stateText, nextAction: tripNextAction(selected, member), buttonLabel: selected.state === 'confirmed' ? '查看行前安排' : selected.state === 'checked_in' ? '查看当日记录' : '查看本场进展' } });
      }
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  filter(event: WechatMiniprogram.TouchEvent) { this.setData({ filter: event.currentTarget.dataset.value, items: [], displayItems: [], nextCursor: null }); void this.load(); },
  heroChange(event: WechatMiniprogram.CustomEvent<{ current: number }>) { this.setData({ heroCurrent: event.detail.current }); },
  coverError(event: WechatMiniprogram.CustomEvent) { const src = event.currentTarget.dataset.src as string; if (src) this.setData({ coverErrors: { ...this.data.coverErrors, [src]: true } }); },
  history() { wx.switchTab({ url: '/pages/history/index' }); },
  more() { void this.load(true); },
  retry() { void this.load(); },
  open(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/activity/detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  trip() { if (this.data.nextTrip) wx.navigateTo({ url: `/pages/trip/detail?id=${encodeURIComponent(this.data.nextTrip.activityId)}` }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
});
