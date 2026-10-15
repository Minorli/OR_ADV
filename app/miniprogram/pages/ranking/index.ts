import { call, currentMember, errorMessage, isMock, confirm, toast } from '../../services/api';
import type { MemberSummary, PageResult, RankingEntry } from '../../../../shared/types';
const year = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
Page({
  data: { isMock, member: null as MemberSummary | null, year, metric: 'growth', filters: [{ value: 'growth', label: '累计成长' }, { value: 'annual', label: '年度积累' }, { value: 'completed_count', label: '完成同行' }], items: [] as RankingEntry[], nextCursor: null as string | null, requestVersion: 0, loading: false, saving: false, error: '' },
  onShow() { void this.load(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && this.data.loading) return;
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion });
    try {
      const result = await call<PageResult<RankingEntry>>('ranking.list', { metric: this.data.metric, year, cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      const member = await currentMember();
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ member, items: [...(append ? this.data.items : []), ...result.items], nextCursor: result.nextCursor });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  filter(event: WechatMiniprogram.TouchEvent) { this.setData({ metric: event.currentTarget.dataset.value, items: [], nextCursor: null }); void this.load(); },
  retry() { void this.load(); },
  more() { void this.load(true); },
  profile() { wx.navigateTo({ url: '/pages/profile/index' }); },
  async optIn() {
    if (!this.data.member || this.data.saving) return;
    const next = !this.data.member.rankingOptIn;
    if (next && !await confirm('自愿公开成长记录', '同意在公开同行榜展示昵称、积分与完成次数。榜单用于分享经历，你随时可以退出；不展示微信身份标识和资格材料。')) return;
    this.setData({ saving: true, error: '' });
    try {
      await call<MemberSummary>('profile.update', { rankingOptIn: next, rankingConsentVersion: next ? 1 : 0 }, this.data.member.revision);
      toast(next ? '已加入公开同行榜' : '已退出公开同行榜'); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
});
