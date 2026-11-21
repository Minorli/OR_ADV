import { call, currentMember, errorMessage, isMock, mockRole, toast } from '../../services/api';
import { dateText, registrationCard } from '../../services/presentation';
import { activityVisual, seedActivityPreview } from '../../services/visual';
import { memberKindText, tripNextAction } from '../../services/member';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
import type { ClubContentView } from '../../../../shared/club-content-types';
import type { ClubHeroView } from '../../../../shared/club-hero';
import { readReferenceChrome, syncReferenceTab, openReferencePanel, closeReferencePanel } from '../../services/reference-ui';
type JoinedRegistration = Registration & { activityStartAt?: string; activityState?: string };
interface NextTrip { activityId: string; title: string; dateText: string; stateText: string; nextAction: string; buttonLabel: string }
const DEFAULT_HERO_SLIDES = [
  { id: 'road', cover: '/assets/hero/road.jpg', kicker: 'ORIGINAL RALLY', title: '不赶路，感受路', caption: '原创开荒线路，每一步探险都是首发' },
  { id: 'together', cover: '/assets/hero/together.jpg', kicker: 'ORIGINAL RALLY', title: '独行虽速，忠行致远', caption: '严苛准入，但我们不抛弃、不放弃' },
  { id: 'craft', cover: '/assets/hero/craft.jpg', kicker: 'ORIGINAL RALLY', title: '把热爱，交给最专业的同路人', caption: '金牌技师・冠军车手・顶级影像全程护航' },
  { id: 'real', cover: '/assets/hero/real.jpg', kicker: 'ORIGINAL RALLY', title: '无剧本，只有一往无前的真实', caption: '全年全地形全气候，只做硬核本色穿越' },
];
const heroTimers = new WeakMap<object, ReturnType<typeof setInterval>>();
const heroTouches = new WeakMap<object, { x: number; y: number }>();
function referenceActivity(activity: Activity) {
  const card = activityVisual(activity), date = new Date(Date.parse(activity.startAt) + 8 * 3600000);
  const end = new Date(Date.parse(activity.endAt) + 8 * 3600000);
  const shortDateText = Number.isFinite(date.getTime()) && Number.isFinite(end.getTime())
    ? `${date.getUTCMonth() + 1}.${date.getUTCDate()}–${end.getUTCMonth() + 1}.${end.getUTCDate()}` : '日期待定';
  return { ...card, shortDateText };
}
Page({
  data: { isMock, v2Chrome: readReferenceChrome(), refPanel: '', refParams: {}, items: [] as ReturnType<typeof referenceActivity>[], displayItems: [] as ReturnType<typeof referenceActivity>[], heroCurrent: 0, coverErrors: {} as Record<string, boolean>, heroSlides: DEFAULT_HERO_SLIDES, marqueePaused: false, sponsorLogos: [
    { id: 'og', src: '/assets/sponsors/og.png' }, { id: 'cardo', src: '/assets/sponsors/cardo.png' }, { id: 'simpson', src: '/assets/sponsors/simpson.png' }, { id: 'shuodong', src: '/assets/sponsors/shuodong.png' },
    { id: 'juemiao', src: '/assets/sponsors/juemiao.png' }, { id: 'fox', src: '/assets/sponsors/fox.png' }, { id: 'percent', src: '/assets/sponsors/percent.png' }, { id: 'arc', src: '/assets/sponsors/arc.png' },
  ], member: null as MemberSummary | null, kindLabel: '游客', nextTrip: null as NextTrip | null,
    partners: [] as { heading: string; introduction: string }[], partnerLoop: [] as { id: number; heading: string }[], partnersTitle: '', partnersIntroduction: '', partnersConfigured: false,
    partnersError: '', personalError: '', loading: false, requestVersion: 0, error: '', filter: 'all', nextCursor: null as string | null, filters: [{ value: 'all', label: '全部活动' }, { value: 'published', label: '正在招募' }, { value: 'in_progress', label: '正在同行' }, { value: 'settled', label: '往期记录' }] },
  onShow() {
    syncReferenceTab(this, 0);
    if (wx.getStorageSync('oradv-open-practice')) {
      wx.setStorageSync('oradv-open-practice', false);
      this.setData({ filter: 'published', items: [], displayItems: [], nextCursor: null });
      toast('请选择正在招募的练车或同行场次报名');
    }
    this.startHero();
    void this.load();
  },
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
    this.setData({ loading: true, error: '', personalError: '', requestVersion, member: null, kindLabel: '游客', nextTrip: null, ...(append ? {} : { coverErrors: {} }) });
    await Promise.all([this.loadActivities(append, requestVersion, role), this.loadPersonal(requestVersion, role), this.loadPartners(requestVersion, role), append ? Promise.resolve() : this.loadHero(requestVersion, role)]);
    if (this.data.requestVersion === requestVersion) this.setData({ loading: false });
  },
  async loadHero(requestVersion: number, role: string) {
    try {
      const hero = await call<ClubHeroView>('club.hero.get');
      if (!this.isCurrent(requestVersion, role)) return;
      const slides = hero?.configured && Array.isArray(hero.slides) && hero.slides.length > 0 ? hero.slides : DEFAULT_HERO_SLIDES;
      this.setData({ heroSlides: slides, heroCurrent: this.data.heroCurrent % slides.length });
    } catch { /* Keep built-in hero slides if optional custom slides fail to load. */ }
  },
  async loadActivities(append: boolean, requestVersion: number, role: string) {
    try {
      const result = await call<PageResult<Activity>>('activity.list', { state: this.data.filter === 'all' ? undefined : this.data.filter, cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      let activeExtras: Activity[] = [];
      if (!append && this.data.filter === 'all' && result.nextCursor) {
        const [recruiting, ongoing] = await Promise.all([
          call<PageResult<Activity>>('activity.list', { state: 'published', limit: 20 }).catch(() => ({ items: [] as Activity[], nextCursor: null })),
          call<PageResult<Activity>>('activity.list', { state: 'in_progress', limit: 20 }).catch(() => ({ items: [] as Activity[], nextCursor: null })),
        ]);
        activeExtras = [...recruiting.items, ...ongoing.items];
      }
      if (!this.isCurrent(requestVersion, role)) return;
      const mergedRaw = [...(append ? this.data.items : []), ...activeExtras.map(referenceActivity), ...result.items.map(referenceActivity)];
      const seenIds = new Set<string>();
      const items = mergedRaw.filter(item => { if (seenIds.has(item.id)) return false; seenIds.add(item.id); return true; });
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
  heroDot(event: WechatMiniprogram.TouchEvent) {
    const count = this.data.heroSlides.length;
    const index = Number(event.currentTarget.dataset.index);
    if (count > 0 && Number.isInteger(index) && index >= 0 && index < count) {
      this.setData({ heroCurrent: index });
      if (heroTimers.has(this)) { this.stopHero(); this.startHero(); }
    }
  },
  heroTouchStart(event: WechatMiniprogram.TouchEvent) {
    const touch = event.touches && event.touches[0];
    if (touch) heroTouches.set(this, { x: touch.clientX, y: touch.clientY });
  },
  heroTouchEnd(event: WechatMiniprogram.TouchEvent) {
    const start = heroTouches.get(this);
    heroTouches.delete(this);
    const touch = event.changedTouches && event.changedTouches[0];
    const count = this.data.heroSlides.length;
    if (!start || !touch || count <= 1) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < 36 || Math.abs(dx) <= Math.abs(dy)) return;
    const next = (this.data.heroCurrent + (dx < 0 ? 1 : count - 1)) % count;
    this.setData({ heroCurrent: next });
    if (heroTimers.has(this)) { this.stopHero(); this.startHero(); }
  },
  coverError(event: WechatMiniprogram.CustomEvent) { const src = event.currentTarget.dataset.src as string; if (src) this.setData({ coverErrors: { ...this.data.coverErrors, [src]: true } }); },
  history() { wx.switchTab({ url: '/pages/history/index' }); },
  more() { void this.load(true); },
  retry() { void this.load(); },
  retryPartners() { void this.loadPartners(this.data.requestVersion, mockRole()); },
  marqueePause() { if (!this.data.marqueePaused) this.setData({ marqueePaused: true }); },
  marqueeResume() { if (this.data.marqueePaused) this.setData({ marqueePaused: false }); },
  sponsorTap() { if (this.data.partnersConfigured) this.partners(); else toast('合作伙伴详情整理中，欢迎通过“我的 → 商务合作”联系俱乐部'); },
  partners() { openReferencePanel(this, 'partners'); },
  learning() { openReferencePanel(this, 'learning'); },
  open(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget?.dataset?.id || '');
    const found = this.data.displayItems.find(item => item.id === id);
    if (found) seedActivityPreview(found);
    openReferencePanel(this, 'activity', { id: event.currentTarget.dataset.id });
  },
  closeReference(event?: WechatMiniprogram.CustomEvent<{ changed?: boolean; login?: boolean }>) {
    closeReferencePanel(this);
    if (event?.detail?.login) { wx.setStorageSync('oradv-open-login', true); wx.switchTab({ url: '/pages/profile/index' }); return; }
    if (event?.detail?.changed) void this.load();
  },
  trip() { if (this.data.nextTrip) wx.navigateTo({ url: `/subpackages/trip/pages/trip/detail?id=${encodeURIComponent(this.data.nextTrip.activityId)}` }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  points() { wx.navigateTo({ url: '/subpackages/trip/pages/points/index' }); },
});
