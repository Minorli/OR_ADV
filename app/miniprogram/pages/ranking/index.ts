import { call, currentMember, errorMessage, isMock, mockRole, confirm, toast } from '../../services/api';
import { emptyContact, contactPerson } from '../../services/member';
import type { ClubContact, Recommendation } from '../../services/member';
import type { MemberSummary, PageResult, RankingEntry } from '../../../../shared/types';
import type { OwnRanking } from '../../../../shared/club-overview';
import type { ClubContentView } from '../../../../shared/club-content-types';
import { readReferenceChrome, syncReferenceTab, openReferencePanel, closeReferencePanel } from '../../services/reference-ui';
const currentYear = () => new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
type PublicMember = Recommendation & { initial: string; hasPublicPoints: boolean };
type PublicRank = RankingEntry & { initial: string };
const initial = (nickname: string) => Array.from(nickname.trim())[0] || 'OR';
Page({
  data: { isMock, v2Chrome: readReferenceChrome(), refPanel: '', refParams: {}, corePeople: [] as (ClubContentView['people'][number] & { initial: string })[], coreError: '', member: null as MemberSummary | null, ownRanking: null as OwnRanking | null, ownRankingError: '', contact: emptyContact, year: currentYear(), mode: 'recommended', metric: 'growth', filters: [{ value: 'growth', label: '成长积分' }, { value: 'annual', label: '年度积分' }, { value: 'completed_count', label: '完成次数' }], recommendations: [] as PublicMember[], founderRail: [] as PublicMember[], items: [] as PublicRank[], recommendationCursor: null as string | null, nextCursor: null as string | null, requestVersion: 0, loading: false, saving: false, error: '' },
  onShow() { syncReferenceTab(this, 1); void this.load(); },
  onUnload() { this.setData({ requestVersion: this.data.requestVersion + 1, member: null, ownRanking: null }); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && this.data.loading) return;
    const requestVersion = this.data.requestVersion + 1, role = mockRole(), year = currentYear(), metric = this.data.metric;
    this.setData({ loading: true, error: '', ownRankingError: '', member: null, ownRanking: null, requestVersion, year, ...(append ? {} : { recommendations: [], founderRail: [], items: [], saving: false }) });
    if (!append) void this.loadCore(requestVersion, role);
    try {
      const [ranking, recommendations, member, contact] = await Promise.all([
        call<PageResult<RankingEntry>>('ranking.list', { metric: this.data.metric, year, cursor: append && this.data.mode === 'points' ? this.data.nextCursor : undefined }),
        call<PageResult<Recommendation>>('recommendation.list', { cursor: append && this.data.mode === 'recommended' ? this.data.recommendationCursor : undefined }),
        currentMember(), call<ClubContact>('club.public'),
      ]);
      if (this.data.requestVersion !== requestVersion || isMock && mockRole() !== role) return;
      const publicMembers = [...(append && this.data.mode === 'recommended' ? this.data.recommendations : []), ...recommendations.items.map(item => ({ ...item, initial: initial(item.nickname), hasPublicPoints: typeof item.growthPoints === 'number' && typeof item.completedCount === 'number' }))];
      this.setData({ member, contact, items: [...(append && this.data.mode === 'points' ? this.data.items : []), ...ranking.items.map(item => ({ ...item, initial: initial(item.nickname) }))], nextCursor: ranking.nextCursor, recommendations: publicMembers,
        founderRail: publicMembers.filter(item => item.memberKind === 'founder').slice(0, 6), recommendationCursor: recommendations.nextCursor });
      if (member) await this.loadOwnRanking(member.id, requestVersion, role, metric, year);
    } catch (error) { if (this.data.requestVersion === requestVersion && (!isMock || mockRole() === role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  async loadCore(version: number, role: string) {
    try {
      const content = await call<ClubContentView>('club.content.get', { section: 'core' });
      if (version !== this.data.requestVersion || isMock && mockRole() !== role) return;
      this.setData({ corePeople: content.configured && content.status === 'published' ? content.people.map(person => ({ ...person, initial: initial(person.name) })) : [], coreError: '' });
    } catch (error) { if (version === this.data.requestVersion && (!isMock || mockRole() === role)) this.setData({ corePeople: [], coreError: errorMessage(error) }); }
  },
  async loadOwnRanking(memberId: string, version: number, role: string, metric: string, year: number) {
    try {
      const ownRanking = await call<OwnRanking>('ranking.mine', { metric, year });
      if (version !== this.data.requestVersion || this.data.member?.id !== memberId || isMock && mockRole() !== role) return;
      this.setData({ ownRanking, ownRankingError: '' });
    } catch (error) {
      if (version === this.data.requestVersion && this.data.member?.id === memberId && (!isMock || mockRole() === role)) this.setData({ ownRanking: null, ownRankingError: errorMessage(error) });
    }
  },
  retryOwnRanking() {
    if (!this.data.member) return;
    this.setData({ ownRanking: null, ownRankingError: '' });
    void this.loadOwnRanking(this.data.member.id, this.data.requestVersion, mockRole(), this.data.metric, this.data.year);
  },
  mode(event: WechatMiniprogram.TouchEvent) { this.setData({ mode: event.currentTarget.dataset.mode }); void this.load(); },
  filter(event: WechatMiniprogram.TouchEvent) { this.setData({ metric: event.currentTarget.dataset.value, items: [], nextCursor: null }); void this.load(); },
  retry() { void this.load(); },
  more() { void this.load(true); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  duties() { openReferencePanel(this, 'core'); },
  rules() { openReferencePanel(this, 'rules'); },
  closeReference() { closeReferencePanel(this); },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
  async optIn() {
    const member = this.data.member, role = mockRole(), version = this.data.requestVersion;
    if (!member || this.data.saving) return;
    const next = !member.rankingOptIn;
    if (next && !await confirm('公开积分与同行记录', '同意在积分榜公开昵称、积分与完成次数。积分榜按实际记录排序，可以随时退出。此选择与俱乐部推荐分别设置。')) return;
    if (version !== this.data.requestVersion || this.data.member?.id !== member.id || isMock && mockRole() !== role) return;
    this.setData({ saving: true, error: '' });
    try {
      await call<MemberSummary>('profile.update', { rankingOptIn: next, rankingConsentVersion: next ? 1 : 0 }, member.revision);
      if (version !== this.data.requestVersion || this.data.member?.id !== member.id || isMock && mockRole() !== role) return;
      toast(next ? '已加入积分榜' : '已退出积分榜'); await this.load();
    } catch (error) { if (this.data.member?.id === member.id && (!isMock || mockRole() === role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.member?.id === member.id && (!isMock || mockRole() === role)) this.setData({ saving: false }); }
  },
});
