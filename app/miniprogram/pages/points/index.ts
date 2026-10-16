import { ApiError, call, errorMessage, isMock, mockRole, runtime } from '../../services/api';
import { dateText } from '../../services/presentation';
import type { LedgerEntry, MemberSummary, PointsResult } from '../../../../shared/types';
import type { WalletLedgerView, WalletOverview } from '../../../../shared/points-wallet-types';

const currentYear = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
const years = Array.from({ length: currentYear - 2019 }, (_, index) => currentYear - index);
const scope = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
const walletKinds: Record<WalletLedgerView['kind'], string> = { activity_credit: '活动奖励', activity_reversal: '活动积分更正', hold: '兑换预留', release: '预留释放', consume: '兑换核销', refund: '兑换退回' };
type WalletRow = WalletLedgerView & { kindText: string; dateText: string };
const walletRows = (items: WalletLedgerView[]): WalletRow[] => items.map(item => ({ ...item, kindText: walletKinds[item.kind], dateText: dateText(item.recordedAt) }));
Page({
  data: { isMock, member: null as MemberSummary | null, summary: null as PointsResult | null,
    items: [] as (LedgerEntry & { dateText: string; title: string })[], years, year: currentYear, yearIndex: 0,
    wallet: null as WalletOverview | null, walletItems: [] as WalletRow[], walletCursor: null as string | null,
    nextCursor: null as string | null, requestVersion: 0, loadedScope: '', loadedRole: '',
    loading: false, walletLoading: false, error: '', ledgerError: '', walletError: '' },
  onShow() { return this.load(); },
  onHide() { this.clearPrivate(); },
  onUnload() { this.clearPrivate(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  clearPrivate() {
    this.setData({ requestVersion: this.data.requestVersion + 1, member: null, summary: null, items: [], wallet: null,
      walletItems: [], walletCursor: null, nextCursor: null, loadedScope: '', loadedRole: '', loading: false, walletLoading: false,
      error: '', ledgerError: '', walletError: '' });
  },
  matches(version: number, environment: string, role: string) {
    return this.data.requestVersion === version && this.data.loadedScope === environment && scope() === environment
      && (!isMock || mockRole() === role);
  },
  async load(append = false) {
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const previousMember = this.data.member?.id, previousItems = append ? this.data.items : [], cursor = append ? this.data.nextCursor : undefined;
    if (!append) this.clearPrivate();
    const version = this.data.requestVersion + 1, environment = scope(), role = mockRole();
    this.setData({ loading: true, error: '', ledgerError: '', requestVersion: version, loadedScope: environment, loadedRole: role });
    try {
      // The wallet includes the trusted member summary; no extra identity RPC.
      const [wallet, growth] = await Promise.allSettled([
        call<WalletOverview>('points.wallet'), call<PointsResult>('points.mine', { year: this.data.year, cursor, limit: 20 }),
      ]);
      if (!this.matches(version, environment, role)) return;
      if (wallet.status === 'rejected') throw wallet.reason;
      if (growth.status === 'fulfilled' && growth.value.memberId !== wallet.value.member.id) throw new ApiError('STALE_IDENTITY', '积分记录所属身份已变化，请刷新核对');
      if (append && wallet.value.member.id !== previousMember) { this.clearPrivate(); await this.load(); return; }
      this.setData({ member: wallet.value.member, wallet: wallet.value, walletItems: walletRows(wallet.value.items), walletCursor: wallet.value.nextCursor, walletError: '' });
      if (growth.status === 'rejected') {
        if (growth.reason instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(growth.reason.code)) throw growth.reason;
        this.setData({ ledgerError: errorMessage(growth.reason) }); return;
      }
      this.setData({ summary: growth.value, nextCursor: growth.value.nextCursor,
        items: [...previousItems, ...growth.value.items.map(item => ({ ...item, dateText: dateText(item.effectiveAt), title: item.activityTitle || (item.awardType === 'reversal' ? '成长记录更正' : '同行完成记录') }))] });
    } catch (error) {
      if (this.matches(version, environment, role)) {
        this.clearPrivate();
        if (!(error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code))) this.setData({ error: errorMessage(error) });
      }
    } finally { if (this.matches(version, environment, role)) this.setData({ loading: false }); }
  },
  async moreWallet() {
    if (this.data.loading || this.data.walletLoading || !this.data.walletCursor || !this.data.member) return;
    const version = this.data.requestVersion, environment = this.data.loadedScope, role = this.data.loadedRole, memberId = this.data.member.id;
    this.setData({ walletLoading: true, walletError: '' });
    try {
      const result = await call<WalletOverview>('points.wallet', { cursor: this.data.walletCursor });
      if (!this.matches(version, environment, role)) return;
      if (result.member.id !== memberId) { this.clearPrivate(); await this.load(); return; }
      this.setData({ wallet: result, walletItems: [...this.data.walletItems, ...walletRows(result.items)], walletCursor: result.nextCursor });
    } catch (error) { if (this.matches(version, environment, role)) {
      if (error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code)) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); }
      else this.setData({ walletError: errorMessage(error) });
    } }
    finally { if (this.matches(version, environment, role)) this.setData({ walletLoading: false }); }
  },
  year(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const index = Number(event.detail.value); if (!Number.isSafeInteger(index) || index < 0 || index >= years.length) return;
    this.setData({ year: years[index], yearIndex: index }); return this.load();
  },
  retry() { return this.load(); },
  more() { return this.load(true); },
  activity(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/trip/detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  redemption() { wx.navigateTo({ url: '/pages/redemption/index' }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  explore() { wx.switchTab({ url: '/pages/activities/index' }); },
});
