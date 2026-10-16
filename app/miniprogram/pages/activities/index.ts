import { call, currentMember, errorMessage, isMock, mockRole } from '../../services/api';
import { dateText, registrationCard } from '../../services/presentation';
import { activityVisual } from '../../services/visual';
import { memberKindText, tripNextAction } from '../../services/member';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
import type { ClubContentView } from '../../../../shared/club-content-types';
import { readReferenceChrome, syncReferenceTab, openReferencePanel, closeReferencePanel } from '../../services/reference-ui';
type JoinedRegistration = Registration & { activityStartAt?: string; activityState?: string };
interface NextTrip { activityId: string; title: string; dateText: string; stateText: string; nextAction: string; buttonLabel: string }
const heroTimers = new WeakMap<object, ReturnType<typeof setInterval>>();
function referenceActivity(activity: Activity) {
  const card = activityVisual(activity), date = new Date(Date.parse(activity.startAt) + 8 * 3600000);
  const end = new Date(Date.parse(activity.endAt) + 8 * 3600000);
  const shortDateText = Number.isFinite(date.getTime()) && Number.isFinite(end.getTime())
    ? `${date.getUTCMonth() + 1}.${date.getUTCDate()}–${end.getUTCMonth() + 1}.${end.getUTCDate()}` : '日期待定';
  return { ...card, shortDateText };
}
Page({
  data: { isMock, v2Chrome: readReferenceChrome(), refPanel: '', refParams: {}, items: [] as ReturnType<typeof referenceActivity>[], displayItems: [] as ReturnType<typeof referenceActivity>[], heroCurrent: 0, coverErrors: {} as Record<string, boolean>, heroSlides: [
    { id: 'together', cover: '/assets/covers/v2-1.jpg', kicker: 'OR · ORIGINAL RALLY', title: '一个人骑很快\n一群人走很远', caption: 'Ride Together, Ride Far.' },
    { id: 'ready', cover: '/assets/covers/dunes.jpg', kicker: 'SLOGAN', title: '从库布齐的沙\n到贺兰山的风', caption: '下一段路，和车友一起出发' },
    { id: 'record', cover: '/assets/covers/v2-3.jpg', kicker: 'BROTHERHOOD', title: '轮胎丈量\n最野的中国', caption: '每一次同行，都留下自己的足迹' },
    { id: 'practice', cover: '/assets/covers/v2-4.jpg', kicker: 'ORIGINAL RALLY', title: '去穿越\n只为更远的路', caption: 'OR · ADV 探险拉力俱乐部' },
  ], member: null as MemberSummary | null, kindLabel: '游客', nextTrip: null as NextTrip | null,
    partners: [] as { heading: string; introduction: string }[], partnerLoop: [] as { id: number; heading: string }[], partnersTitle: '', partnersIntroduction: '', partnersConfigured: false,
    partnersError: '', personalError: '', loading: false, requestVersion: 0, error: '', filter: 'all', nextCursor: null as string | null, filters: [{ value: 'all', label: '全部活动' }, { value: 'published', label: '正在招募' }, { value: 'in_progress', label: '正在同行' }, { value: 'settled', label: '往期记录' }] },
  onShow() { syncReferenceTab(this, 0); this.startHero(); void this.load(); },
  onHide() { this.stopHero(); },
  onUnload() { this.stopHero(); this.setData({ requestVersion: this.data.requestVersion + 1, member: null, kindLabel: '游客', nextTrip: null }); },
  startHero() {
    if (heroTimers.has(this)) return;
    const timer = setInterval(() => {
      if (heroTimers.get(this) === timer) this.setData({ heroCurrent: (this.data.heroCurrent + 1) % this.data.heroSlides.length });
    }, 4200);
    heroTimers.set(this, timer);
  },
  stopHero() { const timer = heroTimers.get(this); if (timer !== undefined) clearInterval(timer); heroTimers.delete(this); },
  isCurrent(version: number, role: string) { return this.data.requestVersion === version && (!isMock || mockRole() === role); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && this.data.loading) return;
    const requestVersion = this.data.requestVersion + 1, role = mockRole();
    // Personal data is removed before the first asynchronous boundary.
    this.setData({ loading: true, error: '', personalError: '', requestVersion, member: null, kindLabel: '游客', nextTrip: null });
    await Promise.all([this.loadActivities(append, requestVersion, role), this.loadPersonal(requestVersion, role), this.loadPartners(requestVersion, role)]);
    if (this.data.requestVersion === requestVersion) this.setData({ loading: false });
  },
  async loadActivities(append: boolean, requestVersion: number, role: string) {
    try {
      const result = await call<PageResult<Activity>>('activity.list', { state: this.data.filter === 'all' ? undefined : this.data.filter, cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      if (!this.isCurrent(requestVersion, role)) return;
      const items = [...(append ? this.data.items : []), ...result.items.map(referenceActivity)];
      const priority = (state: string) => state === 'published' ? 0 : state === 'in_progress' ? 1 : state === 'closed' ? 2 : 3;
      const displayItems = this.data.filter === 'all' ? [...items].sort((a, b) => priority(a.state) - priority(b.state) || Date.parse(a.startAt) - Date.parse(b.startAt)) : items;
      this.setData({ items, displayItems, nextCursor: result.nextCursor });
    } catch (error) { if (this.isCurrent(requestVersion, role)) this.setData({ error: errorMessage(error) }); }
  },
  async loadPersonal(requestVersion: number, role: string) {
    try {
      const member = await currentMember();
      if (!this.isCurrent(requestVersion, role)) return;
      if (member) {
        const own = await call<PageResult<JoinedRegistration>>('registration.mine');
        const active = own.items.filter(item => item.activityState !== 'cancelled' && ['pending_review', 'waitlisted', 'pending_confirmation', 'confirmed', 'checked_in', 'pending_settlement'].includes(item.state));
        const urgency = (state: string) => state === 'checked_in' ? 0 : state === 'pending_settlement' ? 1 : 2;
        active.sort((a, b) => urgency(a.state) - urgency(b.state) || (Date.parse(a.activityStartAt || '') || Number.MAX_SAFE_INTEGER) - (Date.parse(b.activityStartAt || '') || Number.MAX_SAFE_INTEGER));
        const selected = active[0];
        if (!this.isCurrent(requestVersion, role)) return;
        this.setData({ member, kindLabel: memberKindText(member), nextTrip: selected ? { activityId: selected.activityId, title: selected.activityTitle || '我的活动', dateText: selected.activityStartAt ? dateText(selected.activityStartAt) : '', stateText: registrationCard(selected).stateText, nextAction: tripNextAction(selected, member), buttonLabel: selected.state === 'confirmed' ? '查看行前安排' : selected.state === 'checked_in' ? '查看当日记录' : '查看本场进展' } : null });
      }
    } catch (error) { if (this.isCurrent(requestVersion, role)) this.setData({ personalError: errorMessage(error), member: null, kindLabel: '游客', nextTrip: null }); }
  },
  async loadPartners(requestVersion: number, role: string) {
    try {
      const content = await call<ClubContentView>('club.content.get', { section: 'partners' });
      if (!this.isCurrent(requestVersion, role)) return;
      const published = content.configured && content.status === 'published';
      const partners = published ? content.blocks.slice(0, 8).map(block => ({ heading: block.heading, introduction: block.body.length > 84 ? `${block.body.slice(0, 84)}…` : block.body })) : [];
      this.setData({ partners, partnerLoop: [...partners, ...partners].map((partner, id) => ({ id, heading: partner.heading })), partnersTitle: published ? content.title : '', partnersIntroduction: published ? content.introduction : '',
        partnersConfigured: !!published && (!!partners.length || !!content.introduction), partnersError: '' });
    } catch (error) {
      if (this.isCurrent(requestVersion, role)) this.setData({ partners: [], partnerLoop: [], partnersConfigured: false, partnersTitle: '', partnersIntroduction: '', partnersError: errorMessage(error) });
    }
  },
  filter(event: WechatMiniprogram.TouchEvent) { this.setData({ filter: event.currentTarget.dataset.value, items: [], displayItems: [], nextCursor: null }); void this.load(); },
  heroChange(event: WechatMiniprogram.CustomEvent<{ current: number }>) { this.setData({ heroCurrent: event.detail.current }); },
  coverError(event: WechatMiniprogram.CustomEvent) { const src = event.currentTarget.dataset.src as string; if (src) this.setData({ coverErrors: { ...this.data.coverErrors, [src]: true } }); },
  history() { wx.switchTab({ url: '/pages/history/index' }); },
  more() { void this.load(true); },
  retry() { void this.load(); },
  retryPartners() { void this.loadPartners(this.data.requestVersion, mockRole()); },
  partners() { openReferencePanel(this, 'partners'); },
  learning() { openReferencePanel(this, 'learning'); },
  open(event: WechatMiniprogram.TouchEvent) { openReferencePanel(this, 'activity', { id: event.currentTarget.dataset.id }); },
  closeReference() { closeReferencePanel(this); },
  trip() { if (this.data.nextTrip) wx.navigateTo({ url: `/pages/trip/detail?id=${encodeURIComponent(this.data.nextTrip.activityId)}` }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
});
