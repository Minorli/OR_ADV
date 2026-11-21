import { call, currentMember, errorMessage, isMock, mockRole, confirm, toast } from '../../services/api';
import { emptyContact, contactPerson } from '../../services/member';
import type { ClubContact } from '../../services/member';
import type { MemberSummary, PageResult, RankingEntry } from '../../../../shared/types';
import type { OwnRanking } from '../../../../shared/club-overview';
import { resolveBadgeDetails } from '../../../../shared/member-badges';
import type { MemberBadgeDisplay } from '../../../../shared/member-badges';
import { readReferenceChrome, syncReferenceTab, openReferencePanel, closeReferencePanel } from '../../services/reference-ui';
const currentYear = () => new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
type PublicRank = RankingEntry & { initial: string; vTone: MemberBadgeDisplay['primaryTone']; vBadges: MemberBadgeDisplay['items'] };
const initial = (nickname: string) => Array.from(nickname.trim())[0] || 'OR';
function presentRank(item: RankingEntry): PublicRank {
  const badge = resolveBadgeDetails(item.badges, item.certifiedRider);
  return { ...item, initial: initial(item.nickname), vTone: badge.primaryTone, vBadges: badge.items };
}
Page({
  data: { isMock, v2Chrome: readReferenceChrome(), refPanel: '', refParams: {}, member: null as MemberSummary | null, ownRanking: null as OwnRanking | null, ownRankingError: '', contact: emptyContact, year: currentYear(), metric: 'growth', signedIn: false, canCertify: false, items: [] as PublicRank[], nextCursor: null as string | null, loadedRole: '', requestVersion: 0, loading: false, saving: false, error: '' },
  onShow() { syncReferenceTab(this, 1); void this.load(); },
  onUnload() { this.setData({ requestVersion: this.data.requestVersion + 1 }); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const requestVersion = this.data.requestVersion + 1, role = mockRole(), year = currentYear();
    const sameRole = !append && this.data.signedIn && (!isMock || this.data.loadedRole === role) && this.data.items.length > 0;
    this.setData({ loading: true, error: '', ownRankingError: '', requestVersion, year, ...(append || sameRole ? {} : { member: null, ownRanking: null, signedIn: false, canCertify: false, items: [], nextCursor: null }) });
    try {
      const member = await currentMember();
      if (this.data.requestVersion !== requestVersion || isMock && mockRole() !== role) return;
      if (!member) {
        this.setData({ member: null, ownRanking: null, items: [], nextCursor: null, signedIn: false, canCertify: false, loadedRole: role, contact: emptyContact });
        return;
      }
      const identityChanged = this.data.member?.id && this.data.member.id !== member.id;
      this.setData({ member, loadedRole: role, ...(identityChanged ? { ownRanking: null, items: [], nextCursor: null } : {}) });
      const [ranking, contact] = await Promise.all([
        call<PageResult<RankingEntry>>('ranking.list', { metric: 'growth', year, cursor: append ? this.data.nextCursor : undefined }),
        call<ClubContact>('club.public'),
        this.loadOwnRanking(member.id, requestVersion, role, 'growth', year),
      ]);
      if (this.data.requestVersion !== requestVersion || isMock && mockRole() !== role) return;
      const fresh = ranking.items.map(presentRank);
      this.setData({ member, contact, signedIn: true, canCertify: member.roles.includes('owner'), items: [...(append ? this.data.items : []), ...fresh], nextCursor: ranking.nextCursor });
    } catch (error) { if (this.data.requestVersion === requestVersion && (!isMock || mockRole() === role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
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
    void this.loadOwnRanking(this.data.member.id, this.data.requestVersion, mockRole(), 'growth', this.data.year);
  },
  retry() { void this.load(); },
  more() { void this.load(true); },
  profile() { wx.setStorageSync('oradv-open-login', true); wx.switchTab({ url: '/pages/profile/index' }); },
  points() { if (this.data.member) wx.navigateTo({ url: '/subpackages/trip/pages/points/index' }); else this.profile(); },
  duties() { openReferencePanel(this, 'core'); },
  rules() { openReferencePanel(this, 'rules'); },
  closeReference(event?: WechatMiniprogram.CustomEvent<{ changed?: boolean; login?: boolean }>) {
    closeReferencePanel(this);
    if (event?.detail?.login) { wx.setStorageSync('oradv-open-login', true); wx.switchTab({ url: '/pages/profile/index' }); return; }
    if (event?.detail?.changed) void this.load();
  },
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
