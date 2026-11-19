import { call, currentMember, errorMessage, isMock, mockRole, confirm, toast } from '../../services/api';
import { emptyContact, contactPerson } from '../../services/member';
import type { ClubContact } from '../../services/member';
import type { MemberSummary, PageResult, RankingEntry } from '../../../../shared/types';
import type { OwnRanking } from '../../../../shared/club-overview';
import type { ClubContentView } from '../../../../shared/club-content-types';
import { readReferenceChrome, syncReferenceTab, openReferencePanel, closeReferencePanel } from '../../services/reference-ui';
const currentYear = () => new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
type PublicRank = RankingEntry & { initial: string };
const initial = (nickname: string) => Array.from(nickname.trim())[0] || 'OR';
Page({
  data: { isMock, v2Chrome: readReferenceChrome(), refPanel: '', refParams: {}, corePeople: [] as (ClubContentView['people'][number] & { initial: string })[], coreError: '', member: null as MemberSummary | null, ownRanking: null as OwnRanking | null, ownRankingError: '', contact: emptyContact, year: currentYear(), metric: 'growth', signedIn: false, canCertify: false, filters: [{ value: 'growth', label: '成长积分' }, { value: 'annual', label: '年度积分' }, { value: 'completed_count', label: '完成次数' }], items: [] as PublicRank[], nextCursor: null as string | null, requestVersion: 0, loading: false, saving: false, error: '' },
  onShow() { syncReferenceTab(this, 1); void this.load(); },
  onUnload() { this.setData({ requestVersion: this.data.requestVersion + 1 }); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const requestVersion = this.data.requestVersion + 1, role = mockRole(), year = currentYear(), metric = this.data.metric;
    this.setData({ loading: true, error: '', ownRankingError: '', requestVersion, year });
    if (!append) void this.loadCore(requestVersion, role);
    try {
      const member = await currentMember();
      if (this.data.requestVersion !== requestVersion || isMock && mockRole() !== role) return;
      if (!member) {
        this.setData({ member: null, ownRanking: null, items: [], nextCursor: null, signedIn: false, canCertify: false, contact: emptyContact });
        return;
      }
      const [ranking, contact] = await Promise.all([
        call<PageResult<RankingEntry>>('ranking.list', { metric, year, cursor: append ? this.data.nextCursor : undefined }),
        call<ClubContact>('club.public'),
      ]);
      if (this.data.requestVersion !== requestVersion || isMock && mockRole() !== role) return;
      const fresh = ranking.items.map(item => ({ ...item, initial: initial(item.nickname) }));
      this.setData({ member, contact, signedIn: true, canCertify: member.roles.includes('owner'), items: [...(append ? this.data.items : []), ...fresh], nextCursor: ranking.nextCursor });
      await this.loadOwnRanking(member.id, requestVersion, role, metric, year);
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
  filter(event: WechatMiniprogram.TouchEvent) { this.setData({ metric: event.currentTarget.dataset.value, items: [], nextCursor: null }); void this.load(); },
  retry() { void this.load(); },
  more() { void this.load(true); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  duties() { openReferencePanel(this, 'core'); },
  rules() { openReferencePanel(this, 'rules'); },
  closeReference() { closeReferencePanel(this); },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
  async certify(event: WechatMiniprogram.TouchEvent) {
    const member = this.data.member, role = mockRole(), version = this.data.requestVersion;
    const memberPublicId = String(event.currentTarget.dataset.id || '');
    const certified = event.currentTarget.dataset.certified !== 'true';
    if (!member?.roles.includes('owner') || !memberPublicId || this.data.saving) return;
    if (!await confirm(certified ? '授予认证车手' : '取消认证车手', certified ? '确认给这位榜单车手加上认证车手称号。' : '确认取消这位车手的认证车手称号。')) return;
    if (version !== this.data.requestVersion || this.data.member?.id !== member.id || isMock && mockRole() !== role) return;
    this.setData({ saving: true, error: '' });
    try {
      await call('staff.member.certify', { memberPublicId, certified, reason: certified ? '主理人授予认证车手' : '主理人取消认证车手' });
      if (version !== this.data.requestVersion || this.data.member?.id !== member.id || isMock && mockRole() !== role) return;
      toast(certified ? '已授予认证车手' : '已取消认证车手');
      await this.load();
    } catch (error) { if (this.data.member?.id === member.id && (!isMock || mockRole() === role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.member?.id === member.id && (!isMock || mockRole() === role)) this.setData({ saving: false }); }
  },
});
