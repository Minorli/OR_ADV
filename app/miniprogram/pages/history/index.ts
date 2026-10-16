import { call, errorMessage, isMock } from '../../services/api';
import { coverForKey } from '../../services/visual';
import { readReferenceChrome, syncReferenceTab, closeReferencePanel } from '../../services/reference-ui';
import type { HistoryFeed, HistoryFeedCard } from '../../../../shared/history-feed-types';

function archiveCard(detail: HistoryFeedCard) {
  const activity = detail.activity, value = activity.actualCompletedAt || activity.endAt;
  const date = new Date(Date.parse(value) + 8 * 3600000);
  const start = new Date(Date.parse(activity.startAt) + 8 * 3600000);
  const archiveMonth = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : 'unknown';
  const dateText = Number.isFinite(start.getTime()) ? `${start.getUTCFullYear()}.${String(start.getUTCMonth() + 1).padStart(2, '0')}.${String(start.getUTCDate()).padStart(2, '0')}` : '日期待定';
  const honors = detail.story?.honors || [];
  return { ...detail, id: activity.id, title: activity.title, location: activity.location, startAt: activity.startAt, dateText, archiveMonth,
    cover: coverForKey(activity.coverKey, activity.id), distanceText: activity.distanceKm === null || activity.distanceKm === undefined ? '里程未记录' : `${activity.distanceKm}km`,
    honorSlots: [0, 1].map(index => ({ label: honors[index]?.label || (index ? '最佳新人' : '优秀车手'), nickname: honors[index]?.nickname || '待公布', initial: Array.from(honors[index]?.nickname || '—')[0] })),
    photos: detail.story?.photos || [], photoPreviews: (detail.story?.photos || []).slice(0, 3).map((photo, index) => ({ ...photo, albumLabel: index === 2 && detail.story!.photos.length > 3 ? `+${detail.story!.photos.length - 3}` : '相册' })), documentary: detail.story?.documentary || null,
    reviewCountText: detail.reviews.total === null ? '查看评价 ›' : `${detail.reviews.total} 条 ›`,
    reviewPreviews: detail.reviews.items.map(review => ({ ...review, initial: Array.from(review.nickname)[0] || 'OR', starsText: '★★★★★'.slice(0, review.stars) + '☆☆☆☆☆'.slice(0, 5 - review.stars) })),
  };
}
type ArchiveCard = ReturnType<typeof archiveCard>;
const searchTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();
Page({
  data: {
    isMock, v2Chrome: readReferenceChrome(), refPanel: '', refParams: {}, items: [] as ArchiveCard[], visibleItems: [] as ArchiveCard[],
    months: [{ value: 'all', label: '全部时间' }], month: 'all', query: '',
    nextCursor: null as string | null, loading: false, error: '', requestVersion: 0,
    coverErrors: {} as Record<string, boolean>, playingVideoId: '', videoErrors: {} as Record<string, boolean>, year: new Date(Date.now() + 8 * 3600000).getUTCFullYear(),
  },
  onShow() { syncReferenceTab(this, 2); void this.load(); },
  onHide() { this.setData({ playingVideoId: '' }); },
  onUnload() { const timer = searchTimers.get(this); if (timer) clearTimeout(timer); searchTimers.delete(this); this.setData({ requestVersion: this.data.requestVersion + 1, playingVideoId: '' }); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const timer = searchTimers.get(this); if (timer) clearTimeout(timer); searchTimers.delete(this);
    const version = this.data.requestVersion + 1, month = this.data.month, query = this.data.query.trim();
    this.setData({ loading: true, error: '', requestVersion: version, playingVideoId: '', ...(append ? {} : { items: [], visibleItems: [], nextCursor: null }) });
    try {
      const result = await call<HistoryFeed>('history.feed', { ...(append && this.data.nextCursor ? { cursor: this.data.nextCursor } : {}), ...(month !== 'all' ? { month } : {}), ...(query ? { query } : {}) });
      if (version !== this.data.requestVersion || month !== this.data.month || query !== this.data.query.trim()) return;
      const byId = new Map<string, ArchiveCard>();
      for (const item of append ? this.data.items : []) byId.set(item.id, item);
      for (const detail of result.items) byId.set(detail.activity.id, archiveCard(detail));
      const items = [...byId.values()];
      const values = [...new Set([...this.data.months.map(row => row.value).filter(value => value !== 'all'), ...result.months])].sort().reverse();
      const months = [{ value: 'all', label: '全部时间' }, ...values.map(value => ({ value, label: value.replace('-', '.') }))];
      this.setData({ items, visibleItems: items, months, nextCursor: result.nextCursor });
    } catch (error) { if (version === this.data.requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (version === this.data.requestVersion) this.setData({ loading: false }); }
  },
  search(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const timer = searchTimers.get(this); if (timer) clearTimeout(timer);
    this.setData({ query: event.detail.value.slice(0, 60), requestVersion: this.data.requestVersion + 1, items: [], visibleItems: [], nextCursor: null, playingVideoId: '', loading: true });
    searchTimers.set(this, setTimeout(() => { searchTimers.delete(this); void this.load(); }, 300));
  },
  selectMonth(event: WechatMiniprogram.TouchEvent) { this.setData({ month: event.currentTarget.dataset.month }); void this.load(); },
  coverFailed(event: WechatMiniprogram.CustomEvent) {
    const id = String(event.currentTarget.dataset.id || '');
    this.setData({ coverErrors: { ...this.data.coverErrors, [id]: true } });
  },
  previewPhoto(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.visibleItems.find(item => item.id === event.currentTarget.dataset.id), url = String(event.currentTarget.dataset.url || '');
    if (row?.photos.some(photo => photo.url === url)) void wx.previewImage({ current: url, urls: row.photos.map(photo => photo.url) });
  },
  playVideo(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.visibleItems.find(item => item.id === event.currentTarget.dataset.id);
    if (row?.documentary && !this.data.videoErrors[row.id]) this.setData({ playingVideoId: row.id });
  },
  videoFailed(event: WechatMiniprogram.CustomEvent) { const id = String(event.currentTarget.dataset.id || ''); this.setData({ playingVideoId: '', videoErrors: { ...this.data.videoErrors, [id]: true } }); },
  open(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/history-detail/index?activityId=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  explore() { wx.switchTab({ url: '/pages/activities/index' }); },
  closeReference() { closeReferencePanel(this); },
  more() { void this.load(true); },
  retry() { void this.load(); },
});
