import { call, currentMember, errorMessage, isMock, confirm, toast } from '../../services/api';
import { activityCard, registrationCard } from '../../services/presentation';
import { BETA_MAX_CAPACITY } from '../../../../shared/limits';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
interface ActivityForm {
  id: string; title: string; description: string; location: string; difficulty: string;
  startDate: string; startTime: string; endDate: string; endTime: string;
  deadlineDate: string; deadlineTime: string; capacity: string; minGrowthPoints: string;
  growth: string; annual: string; requiredQualifications: string; requiresReview: boolean;
  safetyNotice: string; equipment: string;
}
interface SettlementPreview { activityId: string; ruleVersion: number; eligibleCount: number; unresolvedCount: number; items: Registration[] }
interface SettlementResult { activityId: string; status: string; successCount: number; failureCount: number; failures: { registrationId?: string; code?: string; message?: string }[] }
function chinaDate(value: string) { return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10); }
function chinaTime(value: string) { return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(11, 16); }
function emptyForm(): ActivityForm {
  const start = new Date(Date.now() + 7 * 86400000).toISOString();
  const deadline = new Date(Date.now() + 6 * 86400000).toISOString();
  return { id: '', title: '', description: '', location: '', difficulty: '入门', startDate: chinaDate(start), startTime: '09:00', endDate: chinaDate(start), endTime: '16:00', deadlineDate: chinaDate(deadline), deadlineTime: '18:00', capacity: '12', minGrowthPoints: '0', growth: '100', annual: '100', requiredQualifications: '', requiresReview: false, safetyNotice: '', equipment: '' };
}
Page({
  data: {
    isMock, maxCapacity: BETA_MAX_CAPACITY, member: null as MemberSummary | null, authorized: false, canManage: false, isOwner: false,
    items: [] as ReturnType<typeof activityCard>[], selected: null as ReturnType<typeof activityCard> | null,
    registrations: [] as ReturnType<typeof registrationCard>[], preview: null as SettlementPreview | null, previewRows: [] as ReturnType<typeof registrationCard>[],
    settlement: null as SettlementResult | null, form: emptyForm(), editor: false,
    operationReason: '', ledgerId: '', reversalReason: '', reversalTarget: '', pane: 'activities',
    requestVersion: 0, rosterVersion: 0, loading: false, rosterLoading: false, busy: '', error: '', notice: '',
    pendingCount: 0, confirmedCount: 0, departedCount: 0, returnedCount: 0,
  },
  onShow() { void this.load(); },
  async load() {
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion, authorized: false });
    try {
      const member = await currentMember();
      if (this.data.requestVersion !== requestVersion) return;
      const authorized = !!member?.roles?.length;
      const canManage = !!member?.roles?.some(role => ['owner', 'operator'].includes(role));
      this.setData({ member, authorized, canManage, isOwner: !!member?.roles?.includes('owner') });
      if (!authorized) { this.setData({ items: [], selected: null, registrations: [] }); return; }
      const activities: Activity[] = [];
      let cursor: string | null = null;
      do {
        const result: PageResult<Activity> = await call<PageResult<Activity>>('staff.activity.list', { limit: 100, cursor });
        activities.push(...result.items); cursor = result.nextCursor;
      } while (cursor && activities.length < 1000);
      if (this.data.requestVersion !== requestVersion) return;
      const items = activities.map(activityCard);
      const selected = items.find(item => item.id === this.data.selected?.id) || items[0] || null;
      this.setData({ items, selected });
      if (selected) await this.loadRoster();
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  async loadRoster() {
    const activityId = this.data.selected?.id;
    if (!activityId) return;
    const rosterVersion = this.data.rosterVersion + 1;
    this.setData({ rosterLoading: true, error: '', preview: null, rosterVersion });
    try {
      const registrations: Registration[] = [];
      let cursor: string | null = null;
      do {
        const result: PageResult<Registration> = await call<PageResult<Registration>>('staff.registration.list', { activityId, limit: 100, cursor });
        registrations.push(...result.items); cursor = result.nextCursor;
      } while (cursor && registrations.length < 1000);
      if (this.data.rosterVersion !== rosterVersion || this.data.selected?.id !== activityId) return;
      this.setData({ registrations: registrations.map(registrationCard), pendingCount: registrations.filter(item => ['pending_review', 'pending_confirmation'].includes(item.state)).length, confirmedCount: registrations.filter(item => item.state === 'confirmed').length, departedCount: registrations.filter(item => item.state === 'checked_in').length, returnedCount: registrations.filter(item => ['pending_settlement', 'completed'].includes(item.state)).length });
    } catch (error) { if (this.data.rosterVersion === rosterVersion && this.data.selected?.id === activityId) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.rosterVersion === rosterVersion) this.setData({ rosterLoading: false }); }
  },
  retry() { void this.load(); },
  profile() { wx.navigateTo({ url: '/pages/profile/index' }); },
  pane(event: WechatMiniprogram.TouchEvent) { this.setData({ pane: event.currentTarget.dataset.pane }); },
  select(event: WechatMiniprogram.TouchEvent) {
    const selected = this.data.items.find(item => item.id === event.currentTarget.dataset.id) || null;
    this.setData({ selected, editor: false, registrations: [], settlement: null, preview: null, notice: '', pane: 'roster' });
    void this.loadRoster();
  },
  newActivity() { this.setData({ form: emptyForm(), editor: true, pane: 'activities', notice: '' }); },
  edit() {
    const activity = this.data.selected;
    if (!activity || activity.state !== 'draft') return;
    this.setData({ editor: true, pane: 'activities', form: { id: activity.id, title: activity.title, description: activity.description, location: activity.location, difficulty: activity.difficulty, startDate: chinaDate(activity.startAt), startTime: chinaTime(activity.startAt), endDate: chinaDate(activity.endAt), endTime: chinaTime(activity.endAt), deadlineDate: chinaDate(activity.applicationClosesAt), deadlineTime: chinaTime(activity.applicationClosesAt), capacity: String(activity.capacity), minGrowthPoints: String(activity.minGrowthPoints), growth: String(activity.pointsRule.growth), annual: String(activity.pointsRule.annual), requiredQualifications: activity.requiredQualifications.join('，'), requiresReview: activity.requiresReview, safetyNotice: activity.safetyNotice, equipment: activity.equipment } });
  },
  closeEditor() { this.setData({ editor: false }); },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  reviewSwitch(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) { this.setData({ 'form.requiresReview': event.detail.value }); },
  reason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ operationReason: event.detail.value }); },
  ledger(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ ledgerId: event.detail.value }); },
  reversalReason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ reversalReason: event.detail.value }); },
  async save() {
    if (this.data.busy || !this.data.canManage) return;
    const form = this.data.form;
    if (![form.title, form.description, form.location, form.safetyNotice, form.equipment].every(value => value.trim())) { toast('请填写标题、内容、地点、装备和风险说明'); return; }
    const capacity = Number(form.capacity), minGrowthPoints = Number(form.minGrowthPoints), growth = Number(form.growth), annual = Number(form.annual);
    if (![capacity, minGrowthPoints, growth, annual].every(value => Number.isSafeInteger(value) && value >= 0) || capacity < 1 || capacity > BETA_MAX_CAPACITY) { toast(`请输入有效整数，名额为 1–${BETA_MAX_CAPACITY}`); return; }
    const start = new Date(`${form.startDate}T${form.startTime}:00+08:00`), end = new Date(`${form.endDate}T${form.endTime}:00+08:00`), deadline = new Date(`${form.deadlineDate}T${form.deadlineTime}:00+08:00`);
    if (![start, end, deadline].every(value => Number.isFinite(value.getTime())) || end <= start || deadline > start) { toast('请检查开始、结束与报名截止时间'); return; }
    this.setData({ busy: 'save', error: '' });
    try {
      const activity = await call<Activity>('staff.activity.save', { id: form.id || undefined, title: form.title.trim(), description: form.description.trim(), location: form.location.trim(), difficulty: form.difficulty.trim(), startAt: start.toISOString(), endAt: end.toISOString(), applicationClosesAt: deadline.toISOString(), capacity, minGrowthPoints, pointsRule: { growth, annual }, requiredQualifications: form.requiredQualifications.split(/[,，]/).map(value => value.trim()).filter(Boolean), requiresReview: form.requiresReview, equipment: form.equipment.trim(), safetyNotice: form.safetyNotice.trim() }, form.id ? this.data.selected?.revision : undefined);
      this.setData({ selected: activityCard(activity), editor: false, notice: '草稿已保存，核对后再发布。' }); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  async lifecycle(event: WechatMiniprogram.TouchEvent) {
    const activity = this.data.selected, action = event.currentTarget.dataset.action as string;
    if (!activity || this.data.busy || !['publish', 'close', 'start', 'end', 'cancel'].includes(action)) return;
    const labels: Record<string, string> = { publish: '发布招募', close: '关闭报名', start: '开始活动', end: '结束活动', cancel: '取消活动' };
    const messages: Record<string, string> = { publish: `发布「${activity.title}」？发布后冻结本场规则 v${activity.ruleVersion}，成长奖励 ${activity.pointsRule.growth} 分、年度奖励 ${activity.pointsRule.annual} 分。`, close: '关闭后停止新的报名与自动候补提升，已确认人员继续保留。', start: `计划开始时间为 ${activity.dateText}（北京时间）。确认现在开始？本次操作记录实际开始时间，并开放现场出发核验。请先核对天气、场地、人员与安全条件。`, end: '以当前时刻作为实际完成时间，积分年度按北京时间归属。请先核对实际结束情况，再逐人完成结束核验。', cancel: '取消后停止报名和现场核验，保留申请与操作记录。请另行通知相关车友。' };
    if (action === 'cancel' && !this.data.operationReason.trim()) { toast('请先填写取消原因'); return; }
    if (!await confirm(labels[action], messages[action])) return;
    this.setData({ busy: action, error: '', notice: '' });
    try {
      await call<Activity>(`staff.activity.${action}`, { activityId: activity.id, actualCompletedAt: action === 'end' ? new Date().toISOString() : undefined, reason: this.data.operationReason.trim() || undefined }, activity.revision);
      this.setData({ notice: `${labels[action]}已完成` }); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  async promote() {
    const activity = this.data.selected;
    if (!activity || this.data.busy || !await confirm('提升最早有效候补', '将重新核对名额、截止时间和资格。候补提升后仍需联系本人，再确认参加。')) return;
    this.setData({ busy: 'promote', error: '' });
    try { await call('staff.waitlist.promote', { activityId: activity.id }, activity.revision); this.setData({ notice: '候补处理已完成，以最新名单为准。' }); await this.load(); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  async registrationAction(event: WechatMiniprogram.TouchEvent) {
    const registration = this.data.registrations.find(item => item.id === event.currentTarget.dataset.id);
    const action = event.currentTarget.dataset.action as string;
    if (!registration || this.data.busy) return;
    const descriptions: Record<string, string> = { approve: '已核对本场必要资格，批准后仍需联系确认。', reject: '资格审核未通过，将释放预留名额。请在操作说明中填写原因。', confirm: '确认已完成线下联系，并核对资格、人员和活动安排。此状态表示确认参加。', departure: '已在现场核对本人、装备和参加资格，确认可以出发。', return: '已核对本人实际结束情况，记录为正常结束，等待结算。', safe_exit: '记录安全退出，不按正常完成发放奖励。请填写原因。', no_show: '记录未到，不按正常完成发放奖励。请填写原因。' };
    if (!descriptions[action]) return;
    if (['reject', 'safe_exit', 'no_show'].includes(action) && !this.data.operationReason.trim()) { toast('请先填写操作说明 / 原因'); return; }
    if (!await confirm('核对参加者记录', `${registration.nickname || '本场车友'}：${descriptions[action]}`)) return;
    this.setData({ busy: registration.id, error: '' });
    try {
      const reason = this.data.operationReason.trim() || undefined;
      if (['approve', 'reject'].includes(action)) await call('staff.registration.review', { registrationId: registration.id, decision: action === 'approve' ? 'approved' : 'rejected', reason }, registration.revision);
      else if (action === 'confirm') await call('staff.registration.confirm', { registrationId: registration.id }, registration.revision);
      else await call('staff.checkin.record', { registrationId: registration.id, phase: ['return', 'safe_exit'].includes(action) ? 'return' : 'departure', result: action === 'safe_exit' ? 'safe_exit' : action === 'no_show' ? 'no_show' : 'present', reason }, registration.revision);
      this.setData({ notice: '人员状态已更新。' }); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  async preview() {
    const activity = this.data.selected;
    if (!activity || this.data.busy) return;
    this.setData({ busy: 'preview', error: '', settlement: null });
    try {
      const preview = await call<SettlementPreview>('staff.settlement.preview', { activityId: activity.id, ruleVersion: activity.ruleVersion }, activity.revision);
      this.setData({ preview, previewRows: preview.items.map(item => registrationCard({ ...item, nickname: this.data.registrations.find(reg => reg.id === item.id)?.nickname || item.nickname })), pane: 'settlement' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  async settle() {
    const activity = this.data.selected, preview = this.data.preview;
    if (!activity || !preview || this.data.busy || !await confirm('确认按冻结规则结算', `本场正常完成可结算 ${preview.eligibleCount} 人。规则 v${preview.ruleVersion}，成长奖励 ${activity.pointsRule.growth} 分、年度奖励 ${activity.pointsRule.annual} 分。只为完整核验的参加者记分，重试不会重复发放。`)) return;
    this.setData({ busy: 'settlement', error: '' });
    try {
      const settlement = await call<SettlementResult>('staff.settlement.run', { activityId: activity.id, ruleVersion: preview.ruleVersion }, activity.revision);
      this.setData({ settlement, notice: '请核对结算结果与待处理事项。' }); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  prepareReverse(event: WechatMiniprogram.TouchEvent) {
    const registration = this.data.registrations.find(item => item.id === event.currentTarget.dataset.id);
    if (!this.data.isOwner || !registration?.settlementId || registration.completionVoided) return;
    this.setData({ ledgerId: registration.settlementId, reversalReason: '', reversalTarget: `${registration.nickname || '本场车友'} · ${this.data.selected?.title || ''}`, pane: 'owner', notice: '' });
  },
  async reverse() {
    if (!this.data.isOwner || this.data.busy) return;
    const ledgerId = this.data.ledgerId.trim(), reason = this.data.reversalReason.trim();
    if (!ledgerId || !reason) { toast('请提供原流水标识和更正原因'); return; }
    if (!await confirm('冲正原完成记录', '冲正保留原流水，新建相反增量并同步有效完成次数。请确认这是已核实的错误完成记录，此操作留有审计。')) return;
    this.setData({ busy: 'reverse', error: '' });
    try { await call('staff.points.reverse', { ledgerId, reason }); this.setData({ notice: '冲正已完成，请核对原会员成长记录。', ledgerId: '', reversalReason: '', reversalTarget: '' }); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
});
