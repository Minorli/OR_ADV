import { call, currentMember, errorMessage, isMock } from '../../services/api';
import { dateText } from '../../services/presentation';
import type { LedgerEntry, MemberSummary, PointsResult } from '../../../../shared/types';
const currentYear = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
const years = Array.from({ length: currentYear - 2019 }, (_, index) => currentYear - index);
Page({
  data: { isMock, member: null as MemberSummary | null, summary: null as PointsResult | null, items: [] as (LedgerEntry & { dateText: string; title: string })[], years, year: currentYear, nextCursor: null as string | null, requestVersion: 0, loading: false, error: '' },
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
      if (!member) { this.setData({ summary: null, items: [] }); return; }
      const result = await call<PointsResult>('points.mine', { year: this.data.year, cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ summary: result, nextCursor: result.nextCursor, items: [...(append ? this.data.items : []), ...result.items.map(item => ({ ...item, dateText: dateText(item.effectiveAt), title: item.awardType === 'reversal' ? '成长记录更正' : '同行完成记录' }))] });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  year(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ year: years[Number(event.detail.value)], summary: null, items: [], nextCursor: null }); void this.load(); },
  retry() { void this.load(); },
  more() { void this.load(true); },
  profile() { wx.navigateTo({ url: '/pages/profile/index' }); },
  explore() { wx.switchTab({ url: '/pages/activities/index' }); },
});
