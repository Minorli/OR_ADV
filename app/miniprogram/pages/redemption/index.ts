import { ApiError, call, confirm, errorMessage, isMock, mockRole, runtime } from '../../services/api';
import { dateText } from '../../services/presentation';
import { sha256 } from '../../../../shared/hash';
import type { MemberSummary } from '../../../../shared/types';
import type { PublicRedemptionItem, PublicWalletPolicy, RedemptionItem, RedemptionState, RedemptionView, WalletBalance, WalletOverview, WalletPolicy } from '../../../../shared/points-wallet-types';

interface Fence { version: number; memberId: string; environment: string; role: string; owner: boolean }
interface RequestPayload { submissionId: string; itemId: string; offerVersion: number; policyVersion: number; quantity: 1 }
interface ItemPayload { submissionId: string; kind: 'goods' | 'service'; name: string; description: string; fulfillmentInstructions: string; pointsCost: number; totalStock: number; sortOrder: number; reason: string }
interface OrderIntent { version: 1; environment: string; memberId: string; payload: RequestPayload; itemName: string; cost: number }
interface ItemIntent { version: 1; environment: string; memberId: string; payload: ItemPayload }
interface ItemForm { id: string; revision: number; status: string; kindIndex: number; name: string; description: string; fulfillmentInstructions: string; pointsCost: string; totalStock: string; sortOrder: string; reason: string }
type RequestRow = RedemptionView & { stateText: string; dateText: string; canCancel: boolean };
const environment = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
const nonce = () => `redeem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const intentKey = (kind: 'order' | 'item', memberId: string, scope: string) => `oradv-redemption-${kind}-v1-${sha256(JSON.stringify([scope, memberId]))}`;
const states: RedemptionState[] = ['pending', 'approved', 'fulfilled', 'rejected', 'cancelled', 'refunded'];
const stateLabels = ['待审核', '待领取／使用', '已完成', '已拒绝', '已取消', '已退回'];
const stateText = (state: RedemptionState) => stateLabels[states.indexOf(state)] || state;
const rows = (items: RedemptionView[]): RequestRow[] => items.map(item => ({ ...item, stateText: stateText(item.state), dateText: dateText(item.createdAt), canCancel: ['pending', 'approved'].includes(item.state) }));
const emptyForm = (): ItemForm => ({ id: '', revision: 0, status: 'draft', kindIndex: 0, name: '', description: '', fulfillmentInstructions: '', pointsCost: '', totalStock: '', sortOrder: '0', reason: '' });
const noPolicy: PublicWalletPolicy = { configured: false, enabled: false, version: 0, defaultRewardMode: 'zero', ruleText: '' };
const knownRejection = (error: unknown) => error instanceof ApiError && ['INVALID_INPUT', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'RATE_LIMITED', 'CONFLICT_REFRESH', 'STATE_CONFLICT', 'INSUFFICIENT_POINTS', 'STOCK_UNAVAILABLE', 'REDEMPTION_PAUSED', 'POLICY_NOT_CONFIGURED', 'WALLET_RESTRICTED'].includes(error.code);
function number(value: string, name: string) { const parsed = Number(value); if (!value.trim() || !Number.isSafeInteger(parsed) || parsed < 0) throw new ApiError('INVALID_INPUT', `请填写有效的${name}`); return parsed; }
function storedIntent<T extends OrderIntent | ItemIntent>(kind: 'order' | 'item', fence: Fence): T | null {
  const value = wx.getStorageSync(intentKey(kind, fence.memberId, fence.environment));
  if (value === undefined || value === '' || value === null) return null;
  const invalid = () => { throw new ApiError('LOCAL_DRAFT_INVALID', '上次提交记录暂时无法核对，请保留记录并联系主理人'); };
  if (!value || typeof value !== 'object' || value.version !== 1 || value.environment !== fence.environment || value.memberId !== fence.memberId
    || !value.payload || typeof value.payload !== 'object' || typeof value.payload.submissionId !== 'string' || !/^redeem-[a-z0-9-]{8,100}$/.test(value.payload.submissionId)) invalid();
  const fields = kind === 'order' ? ['submissionId', 'itemId', 'offerVersion', 'policyVersion', 'quantity']
    : ['submissionId', 'kind', 'name', 'description', 'fulfillmentInstructions', 'pointsCost', 'totalStock', 'sortOrder', 'reason'];
  if (!Object.keys(value.payload).every(key => fields.includes(key))) invalid();
  if (kind === 'order' && (typeof value.payload.itemId !== 'string' || !value.payload.itemId || !Number.isSafeInteger(value.payload.offerVersion) || value.payload.offerVersion < 1
    || !Number.isSafeInteger(value.payload.policyVersion) || value.payload.policyVersion < 1 || value.payload.quantity !== 1 || typeof value.itemName !== 'string' || value.itemName.length > 100 || !Number.isSafeInteger(value.cost) || value.cost <= 0)) invalid();
  if (kind === 'item' && (!['goods', 'service'].includes(value.payload.kind) || !['name', 'description', 'fulfillmentInstructions', 'reason'].every(key => typeof value.payload[key] === 'string')
    || !['pointsCost', 'totalStock', 'sortOrder'].every(key => Number.isSafeInteger(value.payload[key]) && value.payload[key] >= 0))) invalid();
  return value as T;
}
Page({
  data: {
    member: null as MemberSummary | null, wallet: null as WalletOverview | null, policy: noPolicy, isOwner: false, identityReady: false,
    mode: 'catalog', managePane: 'items', version: 0, loadedEnvironment: '', loadedRole: '', loading: false, busy: false, suspended: false, error: '', notice: '',
    items: [] as PublicRedemptionItem[], cursor: null as string | null, mine: [] as RequestRow[], adminItems: [] as RedemptionItem[], queue: [] as RequestRow[],
    selected: null as PublicRedemptionItem | null, orderIntent: null as OrderIntent | null, cancelReason: '',
    editor: false, itemForm: emptyForm(), itemDirty: false, itemContentDirty: false, itemIntent: null as ItemIntent | null, kindLabels: ['俱乐部物品', '俱乐部服务'],
    policyHead: null as WalletPolicy | null, policyEnabled: false, rewardModeIndex: 0, rewardModes: ['新活动默认与成长奖励相同', '新活动默认不发兑换积分'], policyText: '', policyReason: '', policyDirty: false,
    queueStateIndex: 0, queueStateLabels: stateLabels, target: null as RequestRow | null, targetAccount: null as WalletBalance | null, adminReason: '',
    restockIndex: 0, restockLabels: ['请选择是否恢复库存', '恢复库存／服务名额', '不恢复库存／服务名额'],
  },
  onLoad(options: Record<string, string>) { this.setData({ mode: options.mode === 'manage' ? 'manage' : options.mode === 'mine' ? 'mine' : 'catalog' }); },
  onShow() { return this.resume(); },
  onHide() { this.setData({ version: this.data.version + 1, identityReady: false, suspended: true, loading: false, busy: false }); },
  onUnload() { this.clearPrivate(); },
  fence(): Fence { return { version: this.data.version, memberId: this.data.member?.id || '', environment: this.data.loadedEnvironment, role: this.data.loadedRole, owner: this.data.isOwner }; },
  matches(fence: Fence) { return !!fence.memberId && this.data.version === fence.version && this.data.member?.id === fence.memberId && this.data.loadedEnvironment === fence.environment
    && environment() === fence.environment && this.data.isOwner === fence.owner && (!isMock || mockRole() === fence.role); },
  clearPrivate() {
    this.setData({ version: this.data.version + 1, member: null, wallet: null, isOwner: false, identityReady: false, loadedEnvironment: '', loadedRole: '',
      items: [], mine: [], adminItems: [], queue: [], cursor: null, selected: null, orderIntent: null, cancelReason: '', editor: false, itemForm: emptyForm(), itemDirty: false, itemContentDirty: false, itemIntent: null,
      policy: noPolicy, policyHead: null, policyEnabled: false, policyText: '', policyReason: '', policyDirty: false, target: null, targetAccount: null, adminReason: '', restockIndex: 0,
      loading: false, busy: false, suspended: false, error: '', notice: '' });
  },
  async assertViewer(fence: Fence, owner = false): Promise<WalletOverview> {
    if (!this.matches(fence)) {
      if (fence.version === this.data.version) { this.clearPrivate(); await this.load(); this.setData({ error: '当前身份已变化，请重新核对' }); }
      throw new ApiError('STALE_IDENTITY', '当前身份已变化，请重新打开兑换页面');
    }
    this.setData({ identityReady: false });
    try {
      const wallet = await call<WalletOverview>('points.wallet');
      if (!this.matches(fence) || wallet.member.id !== fence.memberId || wallet.member.roles.includes('owner') !== fence.owner || owner && !wallet.member.roles.includes('owner')) {
        if (fence.version === this.data.version) { this.clearPrivate(); await this.load(); }
        throw new ApiError('STALE_IDENTITY', '当前身份或权限已变化，请重新核对');
      }
      this.setData({ member: wallet.member, wallet, policy: wallet.policy, identityReady: true, suspended: false }); return wallet;
    } catch (error) { if (this.matches(fence)) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } throw error; }
  },
  async confirmViewer(fence: Fence, title: string, content: string, owner = false): Promise<WalletOverview | null> {
    const accepted = await confirm(title, content);
    const wallet = await this.assertViewer(fence, owner);
    return accepted ? wallet : null;
  },
  async reloadAfter(fence: Fence, notice: string) {
    if (!this.matches(fence)) return;
    const version = this.data.version + 1;
    await this.load();
    if (this.data.version === version && this.data.member?.id === fence.memberId && this.data.loadedEnvironment === fence.environment
      && environment() === fence.environment && this.data.isOwner === fence.owner && (!isMock || mockRole() === fence.role)) this.setData({ notice });
  },
  async resume() {
    if (this.data.loadedEnvironment && this.data.loadedEnvironment !== environment() || isMock && this.data.loadedRole && this.data.loadedRole !== mockRole()) { this.clearPrivate(); await this.load(); return; }
    if (this.data.busy || this.data.itemDirty || this.data.policyDirty || this.data.adminReason.trim() || this.data.cancelReason.trim() || this.data.suspended && this.data.editor) {
      try { await this.assertViewer(this.fence(), this.data.mode === 'manage'); } catch { /* Verification already clears private state. */ } return;
    }
    await this.load();
  },
  async load() {
    const mode = this.data.mode, pane = this.data.managePane;
    this.clearPrivate();
    const version = this.data.version, scope = environment(), role = mockRole();
    this.setData({ mode, managePane: pane, loading: true, loadedEnvironment: scope, loadedRole: role });
    try {
      const wallet = await call<WalletOverview>('points.wallet');
      if (version !== this.data.version || environment() !== scope || isMock && mockRole() !== role) return;
      this.setData({ member: wallet.member, wallet, policy: wallet.policy, isOwner: wallet.member.roles.includes('owner'), identityReady: true });
      const fence = this.fence();
      if (mode === 'manage' && !fence.owner) throw new ApiError('FORBIDDEN', '仅主理人和车队经理可以管理兑换');
      const orderIntent = storedIntent<OrderIntent>('order', fence), itemIntent = fence.owner ? storedIntent<ItemIntent>('item', fence) : null;
      this.setData({ orderIntent, itemIntent });
      if (itemIntent) { const p = itemIntent.payload; this.setData({ editor: true, itemForm: { ...emptyForm(), kindIndex: p.kind === 'goods' ? 0 : 1, name: p.name, description: p.description,
        fulfillmentInstructions: p.fulfillmentInstructions, pointsCost: String(p.pointsCost), totalStock: String(p.totalStock), sortOrder: String(p.sortOrder), reason: p.reason } }); }
      await this.readSection(fence);
    } catch (error) {
      if (version === this.data.version && environment() === scope && (!isMock || mockRole() === role)) {
        this.clearPrivate();
        if (!(error instanceof ApiError && error.code === 'UNAUTHENTICATED')) this.setData({ error: errorMessage(error) });
      }
    } finally { if (version === this.data.version && environment() === scope && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  async readSection(fence: Fence, append = false) {
    const cursor = append ? this.data.cursor : undefined;
    if (this.data.mode === 'catalog') {
      const result = await call<{ policy: PublicWalletPolicy; items: PublicRedemptionItem[]; nextCursor: string | null }>('redemption.catalog', { cursor });
      if (this.matches(fence)) this.setData({ policy: result.policy, items: [...(append ? this.data.items : []), ...result.items], cursor: result.nextCursor });
    } else if (this.data.mode === 'mine') {
      const result = await call<{ member: MemberSummary; items: RedemptionView[]; nextCursor: string | null }>('redemption.mine', { cursor });
      if (!this.matches(fence)) return; if (result.member.id !== fence.memberId) throw new ApiError('STALE_IDENTITY', '申请所属身份已变化');
      this.setData({ mine: [...(append ? this.data.mine : []), ...rows(result.items)], cursor: result.nextCursor });
    } else if (this.data.managePane === 'items') {
      const result = await call<{ member: MemberSummary; policy: PublicWalletPolicy; items: RedemptionItem[]; nextCursor: string | null }>('staff.redemption.catalog.get', { cursor });
      if (!this.matches(fence)) return; if (result.member.id !== fence.memberId || !result.member.roles.includes('owner')) throw new ApiError('FORBIDDEN', '兑换管理权限已变化');
      this.setData({ adminItems: [...(append ? this.data.adminItems : []), ...result.items], policy: result.policy, cursor: result.nextCursor });
    } else if (this.data.managePane === 'requests') {
      const result = await call<{ member: MemberSummary; items: RedemptionView[]; nextCursor: string | null }>('staff.redemption.list', { state: states[this.data.queueStateIndex], cursor });
      if (!this.matches(fence)) return; if (result.member.id !== fence.memberId || !result.member.roles.includes('owner')) throw new ApiError('FORBIDDEN', '兑换管理权限已变化');
      this.setData({ queue: [...(append ? this.data.queue : []), ...rows(result.items)], cursor: result.nextCursor });
    } else {
      const head = await call<WalletPolicy>('staff.points.policy.get');
      if (this.matches(fence)) this.setData({ policyHead: head, policyEnabled: head.enabled, rewardModeIndex: head.defaultRewardMode === 'growth' ? 0 : 1, policyText: head.ruleText, policyReason: '', policyDirty: false, cursor: null });
    }
  },
  async more() {
    if (!this.data.cursor || this.data.loading || this.data.busy) return;
    const fence = this.fence(); this.setData({ loading: true, error: '' });
    try { await this.readSection(fence, true); } catch (error) { if (this.matches(fence)) { if (error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) this.clearPrivate(); this.setData({ error: errorMessage(error) }); } }
    finally { if (this.matches(fence)) this.setData({ loading: false }); }
  },
  async switchView(event: WechatMiniprogram.TouchEvent) {
    const mode = String(event.currentTarget.dataset.mode); if (!['catalog', 'mine', 'manage'].includes(mode) || mode === this.data.mode || this.data.loading || this.data.busy) return;
    if (this.data.itemDirty || this.data.policyDirty) { const fence = this.fence(); if (!await confirm('切换页面', '当前修改尚未保存，是否放弃？') || !this.matches(fence)) return; }
    this.setData({ mode }); await this.load();
  },
  async managePane(event: WechatMiniprogram.TouchEvent) {
    const pane = String(event.currentTarget.dataset.pane); if (!['items', 'requests', 'policy'].includes(pane) || this.data.busy || this.data.loading) return;
    if (this.data.itemDirty || this.data.policyDirty) { const fence = this.fence(); if (!await confirm('切换管理内容', '当前修改尚未保存，是否放弃？') || !this.matches(fence)) return; }
    this.setData({ managePane: pane }); await this.load();
  },
  selectItem(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.identityReady || this.data.busy || this.data.orderIntent) return;
    const selected = this.data.items.find(item => item.id === event.currentTarget.dataset.id); if (selected) this.setData({ selected, error: '', notice: '' });
  },
  closeItem() { if (!this.data.busy && !this.data.orderIntent) this.setData({ selected: null }); },
  async afterOrder(fence: Fence, result: RedemptionView) {
    if (!this.matches(fence)) return;
    if (result.memberId !== fence.memberId) { this.clearPrivate(); throw new ApiError('STALE_IDENTITY', '申请所属身份已变化，请重新核对'); }
    try { wx.removeStorageSync(intentKey('order', fence.memberId, fence.environment)); }
    catch { this.setData({ error: '申请已保存，本地提交记录暂时无法清除，请重试核对结果' }); return; }
    this.setData({ mode: 'mine', selected: null, orderIntent: null }); await this.reloadAfter(fence, `申请已保存 · ${stateText(result.state)}`);
  },
  async sendOrder(fence: Fence, intent: OrderIntent) {
    const existing = await call<RedemptionView | null>('redemption.get', { submissionId: intent.payload.submissionId });
    if (!this.matches(fence)) return;
    if (existing) { await this.afterOrder(fence, existing); return; }
    const result = await call<RedemptionView>('redemption.request', { ...intent.payload });
    await this.afterOrder(fence, result);
  },
  async submit() {
    const selected = this.data.selected; if (!selected || this.data.busy || this.data.orderIntent || !this.data.identityReady) return;
    const fence = this.fence(), policyVersion = this.data.policy.version; this.setData({ busy: true, error: '', notice: '' });
    try {
      const before = await this.assertViewer(fence);
      if (before.policy.version !== policyVersion) throw new ApiError('CONFLICT_REFRESH', '兑换规则已更新，请阅读新规则后重新确认');
      const wallet = await this.confirmViewer(fence, '确认兑换申请', `${selected.name}\n需要 ${selected.pointsCost} 分，提交后先预留积分和名额，交付后扣除。`);
      if (!wallet) return;
      if (wallet.policy.version !== policyVersion) throw new ApiError('CONFLICT_REFRESH', '兑换规则已更新，请阅读新规则后重新确认');
      if (!wallet.policy.enabled || wallet.restricted || wallet.available < selected.pointsCost) throw new ApiError('INVALID_INPUT', '当前可用积分或兑换状态不满足申请条件，请刷新核对');
      const intent: OrderIntent = { version: 1, environment: fence.environment, memberId: fence.memberId, itemName: selected.name, cost: selected.pointsCost,
        payload: { submissionId: nonce(), itemId: selected.id, offerVersion: selected.offerVersion, policyVersion: wallet.policy.version, quantity: 1 } };
      wx.setStorageSync(intentKey('order', fence.memberId, fence.environment), intent); this.setData({ orderIntent: intent });
      await this.sendOrder(fence, intent);
    } catch (error) {
      if (this.matches(fence)) {
        if (knownRejection(error)) { try { wx.removeStorageSync(intentKey('order', fence.memberId, fence.environment)); this.setData({ orderIntent: null }); } catch { /* Keep the original request for recovery. */ } }
        this.setData({ error: errorMessage(error) });
      }
    } finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async recoverOrder() {
    const intent = this.data.orderIntent; if (!intent || this.data.busy || !this.data.identityReady) return;
    const fence = this.fence(); this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence);
      const found = await call<RedemptionView | null>('redemption.get', { submissionId: intent.payload.submissionId });
      if (!this.matches(fence)) return;
      if (found) { await this.afterOrder(fence, found); return; }
      const catalog = await call<{ policy: PublicWalletPolicy; items: PublicRedemptionItem[] }>('redemption.catalog', { itemId: intent.payload.itemId });
      if (!this.matches(fence)) return;
      const item = catalog.items.find(row => row.id === intent.payload.itemId);
      if (!item || item.offerVersion !== intent.payload.offerVersion || item.name !== intent.itemName || item.pointsCost !== intent.cost || catalog.policy.version !== intent.payload.policyVersion) {
        throw new ApiError('CONFLICT_REFRESH', '原项目或兑换规则已变化，请先核对原申请，不要重复提交');
      }
      if (!await this.confirmViewer(fence, '继续原申请', `${intent.itemName} · ${intent.cost} 分\n暂未找到已保存的申请，是否按原内容重试？`)) return;
      await this.sendOrder(fence, intent);
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  reason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { if (this.data.identityReady && !this.data.busy) this.setData({ cancelReason: event.detail.value.slice(0, 500) }); },
  async cancel(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.mine.find(item => item.id === event.currentTarget.dataset.id); if (!row?.canCancel || this.data.busy || !this.data.identityReady) return;
    const fence = this.fence(); this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence);
      if (!await this.confirmViewer(fence, '取消兑换申请', `${row.itemName}\n取消后释放本次预留积分和名额。`)) return;
      await call('redemption.cancel', { redemptionId: row.id, reason: this.data.cancelReason.trim() || '本人取消未交付的兑换申请' }, row.revision);
      if (this.matches(fence)) await this.reloadAfter(fence, '申请已取消，预留已释放。');
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  newItem() { if (this.data.isOwner && this.data.identityReady && !this.data.busy && !this.data.itemIntent) this.setData({ editor: true, itemForm: emptyForm(), itemDirty: false, itemContentDirty: false, error: '' }); },
  openItem(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.isOwner || !this.data.identityReady || this.data.busy || this.data.itemIntent) return;
    const item = this.data.adminItems.find(row => row.id === event.currentTarget.dataset.id); if (!item) return;
    this.setData({ editor: true, itemDirty: false, itemContentDirty: false, error: '', itemForm: { id: item.id, revision: item.revision, status: item.status, kindIndex: item.kind === 'goods' ? 0 : 1,
      name: item.name, description: item.description, fulfillmentInstructions: item.fulfillmentInstructions, pointsCost: String(item.pointsCost), totalStock: String(item.totalStock), sortOrder: String(item.sortOrder), reason: '' } });
  },
  itemField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.data.isOwner || !this.data.identityReady || this.data.busy || this.data.itemIntent) return;
    const field = String(event.currentTarget.dataset.field); if (['name', 'description', 'fulfillmentInstructions', 'pointsCost', 'totalStock', 'sortOrder', 'reason'].includes(field)) this.setData({ itemForm: { ...this.data.itemForm, [field]: event.detail.value }, itemDirty: true, itemContentDirty: this.data.itemContentDirty || field !== 'reason' });
  },
  itemKind(event: WechatMiniprogram.CustomEvent<{ value: string }>) { const index = Number(event.detail.value); if ([0, 1].includes(index) && !this.data.itemForm.id && this.data.isOwner && this.data.identityReady && !this.data.busy && !this.data.itemIntent) this.setData({ itemForm: { ...this.data.itemForm, kindIndex: index }, itemDirty: true, itemContentDirty: true }); },
  async saveItem() {
    if (!this.data.isOwner || !this.data.identityReady || this.data.busy) return;
    const fence = this.fence(), form = this.data.itemForm, recovering = !!this.data.itemIntent; this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence, true);
      let payload: ItemPayload;
      if (this.data.itemIntent) payload = this.data.itemIntent.payload;
      else {
        if (!form.name.trim() || !form.reason.trim()) throw new ApiError('INVALID_INPUT', '请填写项目名称和修改原因');
        payload = { submissionId: nonce(), kind: form.kindIndex === 0 ? 'goods' : 'service', name: form.name.trim(), description: form.description.trim(), fulfillmentInstructions: form.fulfillmentInstructions.trim(),
          pointsCost: number(form.pointsCost, '兑换积分'), totalStock: number(form.totalStock, '库存或服务名额'), sortOrder: number(form.sortOrder, '显示顺序'), reason: form.reason.trim() };
      }
      if (!await this.confirmViewer(fence, form.id ? '保存项目修改' : '保存兑换项目', `${payload.name}\n${payload.pointsCost} 分 · 总量 ${payload.totalStock}`, true)) return;
      if (!form.id && !this.data.itemIntent) {
        const intent: ItemIntent = { version: 1, environment: fence.environment, memberId: fence.memberId, payload };
        wx.setStorageSync(intentKey('item', fence.memberId, fence.environment), intent); this.setData({ itemIntent: intent });
      }
      const request = form.id ? { ...payload, itemId: form.id } : { ...payload };
      if (form.id) delete (request as Partial<ItemPayload>).submissionId;
      const saved = await call<RedemptionItem>('staff.redemption.catalog.save', request, form.revision);
      if (!this.matches(fence)) return;
      if (!form.id) wx.removeStorageSync(intentKey('item', fence.memberId, fence.environment));
      this.setData({ itemIntent: null, editor: false, itemDirty: false }); await this.reloadAfter(fence, `项目已保存 · ${saved.status === 'published' ? '已发布' : saved.status === 'archived' ? '已归档' : '草稿'}`);
    } catch (error) { if (this.matches(fence)) { if (!form.id && !recovering && knownRejection(error)) { try { wx.removeStorageSync(intentKey('item', fence.memberId, fence.environment)); this.setData({ itemIntent: null }); } catch { /* Retain the locked creation intent. */ } } this.setData({ error: errorMessage(error) }); } }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async itemStatus(event: WechatMiniprogram.TouchEvent) {
    const action = String(event.currentTarget.dataset.action), form = this.data.itemForm;
    if (!['publish', 'archive'].includes(action) || !form.id || !this.data.isOwner || !this.data.identityReady || this.data.busy || this.data.itemIntent) return;
    if (this.data.itemContentDirty) { this.setData({ error: '请先保存项目修改，再发布或归档' }); return; }
    if (!form.reason.trim()) { this.setData({ error: '请填写本次操作原因' }); return; }
    const fence = this.fence(); this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence, true);
      if (!await this.confirmViewer(fence, action === 'publish' ? '发布兑换项目' : '归档兑换项目', action === 'publish' ? '请确认积分、库存和交付说明已核实。' : '归档后停止新申请，已有申请继续处理。', true)) return;
      await call(`staff.redemption.catalog.${action}`, { itemId: form.id, reason: form.reason.trim() }, form.revision);
      if (this.matches(fence)) await this.reloadAfter(fence, action === 'publish' ? '项目已发布。' : '项目已归档。');
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  policyField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.data.isOwner || !this.data.identityReady || this.data.busy) return;
    const field = String(event.currentTarget.dataset.field); if (['policyText', 'policyReason'].includes(field)) this.setData({ [field]: event.detail.value, policyDirty: true });
  },
  policyToggle(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) { if (this.data.isOwner && this.data.identityReady && !this.data.busy) this.setData({ policyEnabled: event.detail.value, policyDirty: true }); },
  rewardMode(event: WechatMiniprogram.CustomEvent<{ value: string }>) { const index = Number(event.detail.value); if ([0, 1].includes(index) && this.data.isOwner && this.data.identityReady && !this.data.busy) this.setData({ rewardModeIndex: index, policyDirty: true }); },
  async savePolicy() {
    if (!this.data.isOwner || !this.data.identityReady || this.data.busy || !this.data.policyHead) return;
    if (!this.data.policyReason.trim() || !this.data.policyText.trim()) { this.setData({ error: '请填写积分规则和变更原因' }); return; }
    const fence = this.fence(), revision = this.data.policyHead.revision;
    const payload = { enabled: this.data.policyEnabled, defaultRewardMode: this.data.rewardModeIndex === 0 ? 'growth' : 'zero', ruleText: this.data.policyText.trim(), reason: this.data.policyReason.trim() };
    this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence, true);
      if (!await this.confirmViewer(fence, '保存兑换规则', '新规则不换算历史积分，不修改已发布活动的完成奖励。', true)) return;
      await call('staff.points.policy.save', payload, revision);
      if (this.matches(fence)) { this.setData({ policyDirty: false }); await this.reloadAfter(fence, '兑换规则已保存。'); }
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async queueState(event: WechatMiniprogram.CustomEvent<{ value: string }>) { const index = Number(event.detail.value); if (!Number.isInteger(index) || index < 0 || index >= states.length || this.data.busy || this.data.loading) return; this.setData({ queueStateIndex: index }); await this.load(); },
  async openRequest(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.isOwner || !this.data.identityReady || this.data.busy) return;
    const row = this.data.queue.find(item => item.id === event.currentTarget.dataset.id); if (!row) return;
    const fence = this.fence(); this.setData({ busy: true, error: '', target: null, targetAccount: null });
    try {
      await this.assertViewer(fence, true);
      const result = await call<{ member: MemberSummary; request: RedemptionView; account: WalletBalance }>('staff.redemption.get', { redemptionId: row.id });
      if (this.matches(fence) && result.member.id === fence.memberId && result.member.roles.includes('owner')) this.setData({ target: rows([result.request])[0], targetAccount: result.account, adminReason: '', restockIndex: 0 });
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  adminReason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { if (this.data.isOwner && this.data.identityReady && !this.data.busy) this.setData({ adminReason: event.detail.value.slice(0, 500) }); },
  restock(event: WechatMiniprogram.CustomEvent<{ value: string }>) { const index = Number(event.detail.value); if ([0, 1, 2].includes(index) && this.data.isOwner && this.data.identityReady && !this.data.busy) this.setData({ restockIndex: index }); },
  async process(event: WechatMiniprogram.TouchEvent) {
    const action = String(event.currentTarget.dataset.action), target = this.data.target;
    if (!target || !this.data.isOwner || !this.data.identityReady || this.data.busy || !['approve', 'reject', 'fulfill', 'refund'].includes(action)) return;
    if (!this.data.adminReason.trim() || action === 'refund' && ![1, 2].includes(this.data.restockIndex)) { this.setData({ error: action === 'refund' ? '请填写退回原因，并明确是否恢复库存' : '请填写本次处理依据' }); return; }
    const fence = this.fence(), reason = this.data.adminReason.trim(), restock = this.data.restockIndex === 1;
    const labels: Record<string, string> = { approve: '批准申请', reject: '拒绝申请', fulfill: '确认交付并核销', refund: '整笔退回兑换积分' };
    this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence, true);
      if (!await this.confirmViewer(fence, labels[action], `${target.nickname || '成员'} · ${target.itemName}\n${target.totalCost} 分${action === 'refund' ? restock ? '，同时恢复库存／名额。' : '，不恢复库存／名额。' : action === 'fulfill' ? '。请确认物品或服务已经实际交付。' : '。本次处理将保留记录。'}`, true)) return;
      await call(`staff.redemption.${action}`, { redemptionId: target.id, reason, ...(action === 'refund' ? { restock } : {}) }, target.revision);
      if (this.matches(fence)) await this.reloadAfter(fence, `${labels[action]}已完成。`);
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async retry() { if (this.data.itemDirty || this.data.policyDirty) { const fence = this.fence(); if (!await confirm('刷新兑换记录', '当前修改尚未保存，是否放弃？') || !this.matches(fence)) return; } await this.load(); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  consultation() { wx.navigateTo({ url: '/pages/club-content/index?section=redemption' }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
});
