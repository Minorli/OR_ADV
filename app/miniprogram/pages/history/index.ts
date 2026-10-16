import { call, errorMessage, isMock } from '../../services/api';
import { activityVisual } from '../../services/visual';
import type { Activity, PageResult } from '../../../../shared/types';

function archiveCard(activity: Activity) {
  const value = activity.actualCompletedAt || activity.endAt;
  const date = new Date(Date.parse(value) + 8 * 3600000);
  const archiveMonth = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : 'unknown';
  const card = activityVisual(activity);
  // Keep the native data bridge small even for a full archive batch.
  return { id: card.id, state: card.state, title: card.title, location: card.location,
    startAt: card.startAt, dateText: card.dateText, cover: card.cover,
    durationText: card.durationText, difficulty: card.difficulty,
    pointsRule: card.pointsRule, archiveMonth };
}
type ArchiveCard = ReturnType<typeof archiveCard>;
Page({
  data: {
    isMock, items: [] as ArchiveCard[], visibleItems: [] as ArchiveCard[],
    months: [{ value: 'all', label: '全部时间' }], month: 'all', query: '',
    nextCursor: null as string | null, loading: false, error: '', requestVersion: 0,
    coverErrors: {} as Record<string, boolean>, year: new Date(Date.now() + 8 * 3600000).getUTCFullYear(),
  },
  onShow() { void this.load(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const version = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion: version });
    try {
      const activities: Activity[] = [];
      let cursor = append ? this.data.nextCursor : null;
      // Browse public archives across API pages, then sort the loaded set.
      // A bounded batch leaves a visible continuation for very large archives.
      for (let page = 0; page < 10; page++) {
        const result: PageResult<Activity> = await call('activity.list', { state: 'settled', cursor });
        if (version !== this.data.requestVersion) return;
        activities.push(...result.items); cursor = result.nextCursor;
        if (!cursor) break;
      }
      const byId = new Map<string, ArchiveCard>();
      for (const item of append ? this.data.items : []) byId.set(item.id, item);
      for (const activity of activities) byId.set(activity.id, archiveCard(activity));
      const items = [...byId.values()].sort((a, b) => b.startAt.localeCompare(a.startAt) || a.id.localeCompare(b.id));
      const values = [...new Set(items.map(row => row.archiveMonth))].filter(value => value !== 'unknown').sort().reverse();
      const months = [{ value: 'all', label: '全部时间' }, ...values.map(value => ({ value, label: value.replace('-', '.') }))];
      const month = months.some(row => row.value === this.data.month) ? this.data.month : 'all';
      this.setData({ items, months, month, nextCursor: cursor });
      this.applyFilters();
    } catch (error) { if (version === this.data.requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (version === this.data.requestVersion) this.setData({ loading: false }); }
  },
  applyFilters() {
    const query = this.data.query.trim().toLocaleLowerCase();
    const visibleItems = this.data.items.filter(row => (this.data.month === 'all' || row.archiveMonth === this.data.month)
      && (!query || `${row.title} ${row.location}`.toLocaleLowerCase().includes(query)));
    this.setData({ visibleItems });
  },
  search(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ query: event.detail.value.slice(0, 60) }); this.applyFilters(); },
  selectMonth(event: WechatMiniprogram.TouchEvent) { this.setData({ month: event.currentTarget.dataset.month }); this.applyFilters(); },
  coverFailed(event: WechatMiniprogram.CustomEvent) {
    const id = String(event.currentTarget.dataset.id || '');
    this.setData({ coverErrors: { ...this.data.coverErrors, [id]: true } });
  },
  open(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/activity/detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  explore() { wx.switchTab({ url: '/pages/activities/index' }); },
  more() { void this.load(true); },
  retry() { void this.load(); },
});
