import { call, currentMember, errorMessage, isMock, confirm, toast } from '../../services/api';
import { dateText, registrationCard } from '../../services/presentation';
import { tripNextAction } from '../../services/member';
import type { MemberSummary, PageResult, Registration } from '../../../../shared/types';
type JoinedRegistration = Registration & { activityStartAt?: string; activityState?: string; activityLocation?: string };
type MyTrip = ReturnType<typeof registrationCard> & { progressText: string; activityDateText: string; locationText: string };
function visible(items: MyTrip[], filter: string): MyTrip[] { return filter === 'active' ? items.filter(item => ['pending_review', 'waitlisted', 'pending_confirmation', 'confirmed', 'checked_in', 'pending_settlement'].includes(item.state)) : filter === 'ended' ? items.filter(item => ['completed', 'safe_exit', 'no_show', 'cancelled', 'rejected'].includes(item.state)) : items; }
Page({
  data: { isMock, member: null as MemberSummary | null, items: [] as MyTrip[], visibleItems: [] as MyTrip[], filter: 'all', filters: [{ value: 'all', label: '全部' }, { value: 'active', label: '待办与同行' }, { value: 'ended', label: '已结束' }], nextCursor: null as string | null, requestVersion: 0, loading: false, busy: '', error: '' },
  onShow() { void this.load(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && this.data.loading) return;
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion });
    try {
      const member = await currentMember();
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ member });
      if (!member) { this.setData({ items: [], visibleItems: [], nextCursor: null }); return; }
      const result = await call<PageResult<JoinedRegistration>>('registration.mine', { cursor: append ? this.data.nextCursor : undefined });
      if (this.data.requestVersion !== requestVersion) return;
      const items: MyTrip[] = [...(append ? this.data.items : []), ...result.items.map(item => ({ ...registrationCard(item), canCancel: registrationCard(item).canCancel && (!item.activityState || ['published', 'closed'].includes(item.activityState)), progressText: tripNextAction(item, member), activityDateText: item.activityStartAt ? dateText(item.activityStartAt) : '', locationText: item.activityLocation || '' }))];
      this.setData({ items, visibleItems: visible(items, this.data.filter), nextCursor: result.nextCursor });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  filter(event: WechatMiniprogram.TouchEvent) { const filter = event.currentTarget.dataset.value as string; this.setData({ filter, visibleItems: visible(this.data.items, filter) }); },
  retry() { void this.load(); },
  more() { void this.load(true); },
  explore() { wx.switchTab({ url: '/pages/activities/index' }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  detail(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/trip/detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  async cancel(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const registration = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (!registration || !await confirm('取消本次申请', '取消后释放预留名额，并停止后续核验。若已到场或出发，请先联系领队。')) return;
    this.setData({ busy: registration.id, error: '' });
    try {
      await call<Registration>('registration.cancel', { registrationId: registration.id, reason: '车友主动取消申请' }, registration.revision);
      toast('申请已取消'); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
});
