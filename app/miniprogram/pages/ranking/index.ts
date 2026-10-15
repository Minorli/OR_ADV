import { call, currentMember, errorMessage, isMock, confirm, toast } from '../../services/api';
import { emptyContact, contactPerson } from '../../services/member';
import type { ClubContact, Recommendation } from '../../services/member';
import type { MemberSummary, PageResult, RankingEntry } from '../../../../shared/types';
const year = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
Page({
  data: { isMock, member: null as MemberSummary | null, contact: emptyContact, year, mode: 'recommended', metric: 'growth', filters: [{ value: 'growth', label: '成长积分' }, { value: 'annual', label: '年度积分' }, { value: 'completed_count', label: '完成次数' }], recommendations: [] as Recommendation[], items: [] as RankingEntry[], recommendationCursor: null as string | null, nextCursor: null as string | null, requestVersion: 0, loading: false, saving: false, error: '' },
  onShow() { void this.load(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && this.data.loading) return;
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion, ...(append ? {} : { recommendations: [], items: [] }) });
    try {
      const [ranking, recommendations, member, contact] = await Promise.all([
        call<PageResult<RankingEntry>>('ranking.list', { metric: this.data.metric, year, cursor: append && this.data.mode === 'points' ? this.data.nextCursor : undefined }),
        call<PageResult<Recommendation>>('recommendation.list', { cursor: append && this.data.mode === 'recommended' ? this.data.recommendationCursor : undefined }),
        currentMember(), call<ClubContact>('club.public'),
      ]);
      if (this.data.requestVersion !== requestVersion) return;
      this.setData({ member, contact, items: [...(append && this.data.mode === 'points' ? this.data.items : []), ...ranking.items], nextCursor: ranking.nextCursor, recommendations: [...(append && this.data.mode === 'recommended' ? this.data.recommendations : []), ...recommendations.items], recommendationCursor: recommendations.nextCursor });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  mode(event: WechatMiniprogram.TouchEvent) { this.setData({ mode: event.currentTarget.dataset.mode }); void this.load(); },
  filter(event: WechatMiniprogram.TouchEvent) { this.setData({ metric: event.currentTarget.dataset.value, items: [], nextCursor: null }); void this.load(); },
  retry() { void this.load(); },
  more() { void this.load(true); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
  async optIn() {
    if (!this.data.member || this.data.saving) return;
    const next = !this.data.member.rankingOptIn;
    if (next && !await confirm('公开积分与同行记录', '同意在积分榜公开昵称、积分与完成次数。积分榜按实际记录排序，可以随时退出。此选择与俱乐部推荐分别设置。')) return;
    this.setData({ saving: true, error: '' });
    try {
      await call<MemberSummary>('profile.update', { rankingOptIn: next, rankingConsentVersion: next ? 1 : 0 }, this.data.member.revision);
      toast(next ? '已加入积分榜' : '已退出积分榜'); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
});
