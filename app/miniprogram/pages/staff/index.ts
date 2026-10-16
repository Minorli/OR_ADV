import { call, currentMember, errorMessage, isMock, mockRole, runtime, confirm, toast } from '../../services/api';
import { activityCard, registrationCard } from '../../services/presentation';
import { coverForKey } from '../../services/visual';
import { DomainError } from '../../../../shared/errors';
import { ACTIVITY_COVER_KEYS, activityDisplayFields, type ActivityItineraryStage } from '../../../../shared/activity-display';
import { BETA_MAX_CAPACITY } from '../../../../shared/limits';
import { rosterPresentation, type StaffRegistration } from './roster';
import type { Activity, MemberSummary, PageResult, Registration } from '../../../../shared/types';
import { businessAdminTitle, canOperateActivities } from '../../../../shared/permissions';
interface ActivityForm {
  id: string; revision: number; reason: string; title: string; description: string; location: string; difficulty: string;
  startDate: string; startTime: string; endDate: string; endTime: string;
  deadlineDate: string; deadlineTime: string; capacity: string; minGrowthPoints: string;
  growth: string; annual: string; redeemable: string; requiredQualifications: string; requiresReview: boolean;
  safetyNotice: string; equipment: string; coverKey: string; distanceKm: string; itinerary: ActivityItineraryStage[];
}
interface SettlementPreview { activityId: string; ruleVersion: number; eligibleCount: number; unresolvedCount: number; items: Registration[] }
interface SettlementResult { activityId: string; status: string; successCount: number; failureCount: number; failures: { registrationId?: string; code?: string; message?: string }[] }
interface Briefing { activityId: string; meetingPoint: string; meetingTime: string; contactName: string; contactMethod: string; contactValue: string; checklist: string[]; notes: string; revision: number }
interface StaffFence { version: number; memberId: string; role: string; environment: string }
const coverChoices = [{ key: '', label: '自动选择封面', cover: coverForKey('') }, ...ACTIVITY_COVER_KEYS.map((key, index) => ({ key, label: index < 3 ? ['沙地', '林道', '山脊'][index] : `封面 ${index - 2}`, cover: coverForKey(key) }))];
const environmentScope = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
const canManageActivity = (member: MemberSummary | null) => !!member?.roles.some(role => ['owner', 'operator'].includes(role));
function emptyBriefing(): Briefing { return { activityId: '', meetingPoint: '', meetingTime: '', contactName: '', contactMethod: 'wechat', contactValue: '', checklist: [], notes: '', revision: 0 }; }
function chinaDate(value: string) { return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10); }
function chinaTime(value: string) { return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(11, 16); }
function structuredStages(stages: ActivityItineraryStage[] = []) { return stages.map(stage => ({ ...stage })); }
function emptyForm(): ActivityForm {
  const start = new Date(Date.now() + 7 * 86400000).toISOString();
  const deadline = new Date(Date.now() + 6 * 86400000).toISOString();
  return { id: '', revision: 0, reason: '', title: '', description: '', location: '', difficulty: '入门', startDate: chinaDate(start), startTime: '09:00', endDate: chinaDate(start), endTime: '16:00', deadlineDate: chinaDate(deadline), deadlineTime: '18:00', capacity: '12', minGrowthPoints: '0', growth: '100', annual: '100', redeemable: '', requiredQualifications: '', requiresReview: false, safetyNotice: '', equipment: '', coverKey: '', distanceKm: '', itinerary: [] };
}
Page({
  data: {
    isMock, coverChoices, coverIndex: 0, maxCapacity: BETA_MAX_CAPACITY, member: null as MemberSummary | null, authorized: false, canManage: false, isOwner: false, adminTitle: '',
    items: [] as ReturnType<typeof activityCard>[], selected: null as ReturnType<typeof activityCard> | null,
    registrations: [] as ReturnType<typeof registrationCard>[], preview: null as SettlementPreview | null, previewRows: [] as ReturnType<typeof registrationCard>[],
    settlement: null as SettlementResult | null, form: emptyForm(), editor: false, editorKind: 'draft', formDirty: false, formMemberId: '', formEnvironment: '',
    operationReason: '', ledgerId: '', reversalReason: '', reversalTarget: '', pane: 'overview',
    today: chinaDate(new Date().toISOString()), rosterQuery: '', rosterFilter: 'all',
    displayedRegistrations: [] as ReturnType<typeof rosterPresentation>['visible'],
    rosterFilters: [{ value: 'all', label: '全部' }, { value: 'unreturned', label: '待回场' }, { value: 'pending', label: '待确认' }, { value: 'confirmed', label: '已确认' }, { value: 'today', label: '今日核验' }, { value: 'waitlisted', label: '候补' }],
    unreturnedCount: 0, todayDepartureCount: 0, todayReturnCount: 0,
    briefing: emptyBriefing(), briefingChecklist: '', briefingDate: '', briefingTime: '', briefingLoading: false, briefingDirty: false, briefingContactIndex: 0, contactLabels: ['微信', '电话', '其他约定方式'],
    requestVersion: 0, rosterVersion: 0, loadedRole: '', loadedEnvironment: '', loading: false, rosterLoading: false, busy: '', error: '', notice: '',
    pendingCount: 0, confirmedCount: 0, departedCount: 0, returnedCount: 0,
  },
  onShow() { return this.resume(); },
  onUnload() { this.clearPrivate(); },
  async resume() { if (this.data.editor || this.data.briefingDirty || this.data.busy) { await this.verifyIdentity(this.data.editor || this.data.briefingDirty); return; } await this.load(); },
  fence(): StaffFence { return { version: this.data.requestVersion, memberId: this.data.member?.id || '', role: this.data.loadedRole, environment: this.data.loadedEnvironment }; },
  matches(fence: StaffFence) {
    if (fence.version === this.data.requestVersion && (environmentScope() !== fence.environment || isMock && mockRole() !== fence.role)) { this.clearPrivate(); this.setData({ error: '当前身份或环境已变化，请重新打开工作台' }); return false; }
    return this.data.requestVersion === fence.version && (this.data.member?.id || '') === fence.memberId && this.data.loadedRole === fence.role && this.data.loadedEnvironment === fence.environment;
  },
  resetPrivate() {
    this.setData({ member: null, authorized: false, canManage: false, isOwner: false, adminTitle: '', items: [], selected: null, registrations: [], displayedRegistrations: [], preview: null, previewRows: [], settlement: null,
      form: emptyForm(), editor: false, editorKind: 'draft', formDirty: false, formMemberId: '', formEnvironment: '', operationReason: '', ledgerId: '', reversalReason: '', reversalTarget: '', pane: 'overview', rosterQuery: '', rosterFilter: 'all',
      briefing: emptyBriefing(), briefingChecklist: '', briefingDate: '', briefingTime: '', briefingContactIndex: 0, briefingLoading: false, briefingDirty: false, rosterLoading: false, busy: '', notice: '',
      pendingCount: 0, confirmedCount: 0, departedCount: 0, returnedCount: 0, unreturnedCount: 0, todayDepartureCount: 0, todayReturnCount: 0 });
  },
  clearPrivate() { this.setData({ requestVersion: this.data.requestVersion + 1, rosterVersion: this.data.rosterVersion + 1, loading: false }); this.resetPrivate(); },
  async verifyIdentity(manage = false) {
    const fence = this.fence();
    if (!fence.memberId || !this.matches(fence)) { this.clearPrivate(); await this.load(); return false; }
    try {
      const member = await currentMember();
      if (!this.matches(fence) || !member || member.id !== fence.memberId || !canOperateActivities(member) || manage && !canManageActivity(member)) {
        if (fence.version === this.data.requestVersion) { this.clearPrivate(); await this.load(); this.setData({ error: '当前身份或权限已变化，请重新核对活动后操作' }); }
        return false;
      }
      this.setData({ member, canManage: canManageActivity(member), isOwner: member.roles.includes('owner'), adminTitle: businessAdminTitle(member), ...(!member.roles.includes('owner') ? { ledgerId: '', reversalReason: '', reversalTarget: '' } : {}) });
      return true;
    } catch (error) { if (fence.version === this.data.requestVersion) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } return false; }
  },
  async load() {
    const role = mockRole(), environment = environmentScope();
    if (this.data.loadedRole && this.data.loadedRole !== role || this.data.loadedEnvironment && this.data.loadedEnvironment !== environment) this.clearPrivate();
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ loading: true, error: '', requestVersion, authorized: false, canManage: false, isOwner: false, loadedRole: role, loadedEnvironment: environment, rosterVersion: this.data.rosterVersion + 1 });
    try {
      const member = await currentMember();
      if (this.data.requestVersion !== requestVersion) return;
      if (isMock && mockRole() !== role || environmentScope() !== environment) { this.clearPrivate(); await this.load(); return; }
      const authorized = canOperateActivities(member);
      const canManage = canManageActivity(member);
      if (this.data.member?.id !== member?.id || !canManage && this.data.editor) this.resetPrivate();
      this.setData({ member, authorized, canManage, isOwner: !!member?.roles?.includes('owner'), adminTitle: businessAdminTitle(member), ...(!member?.roles.includes('owner') ? { ledgerId: '', reversalReason: '', reversalTarget: '' } : {}) });
      if (!authorized) { this.resetPrivate(); this.setData({ member }); return; }
      const fence = this.fence(), activities: Activity[] = [];
      let cursor: string | null = null;
      do {
        const result: PageResult<Activity> = await call<PageResult<Activity>>('staff.activity.list', { limit: 100, cursor });
        if (!this.matches(fence)) return;
        activities.push(...result.items); cursor = result.nextCursor;
      } while (cursor && activities.length < 1000);
      if (!this.matches(fence)) return;
      const items = activities.map(activityCard);
      const selected = items.find(item => item.id === this.data.selected?.id) || items.find(item => item.state === 'in_progress') || items.find(item => ['published', 'closed', 'ended'].includes(item.state)) || items[0] || null;
      this.setData({ items, selected, ...(this.data.selected?.id !== selected?.id ? { registrations: [], displayedRegistrations: [], briefing: emptyBriefing() } : {}) });
      if (selected) await Promise.all([this.loadRoster(), this.loadBriefing()]);
    } catch (error) { if (this.data.requestVersion === requestVersion) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loading: false }); }
  },
  async loadRoster() {
    const activityId = this.data.selected?.id, fence = this.fence();
    if (!activityId || !this.data.authorized || !this.matches(fence)) return;
    const rosterVersion = this.data.rosterVersion + 1;
    this.setData({ rosterLoading: true, error: '', preview: null, rosterVersion });
    try {
      const registrations: StaffRegistration[] = [];
      let cursor: string | null = null;
      do {
        const result: PageResult<StaffRegistration> = await call<PageResult<StaffRegistration>>('staff.registration.list', { activityId, cursor });
        if (!this.matches(fence) || this.data.rosterVersion !== rosterVersion) return;
        registrations.push(...result.items); cursor = result.nextCursor;
      } while (cursor && registrations.length < 1000);
      if (!this.matches(fence) || this.data.rosterVersion !== rosterVersion || this.data.selected?.id !== activityId) return;
      this.setData({ registrations: registrations.map(registrationCard), pendingCount: registrations.filter(item => ['pending_review', 'pending_confirmation'].includes(item.state)).length, confirmedCount: registrations.filter(item => item.state === 'confirmed').length, departedCount: registrations.filter(item => item.state === 'checked_in').length, returnedCount: registrations.filter(item => ['pending_settlement', 'completed'].includes(item.state)).length });
      this.applyRosterFilters();
    } catch (error) { if (this.matches(fence) && this.data.rosterVersion === rosterVersion && this.data.selected?.id === activityId) this.setData({ error: errorMessage(error), registrations: [], displayedRegistrations: [], unreturnedCount: 0, todayDepartureCount: 0, todayReturnCount: 0 }); }
    finally { if (this.matches(fence) && this.data.rosterVersion === rosterVersion) this.setData({ rosterLoading: false }); }
  },
  retry() { void this.load(); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  members() { if (this.data.isOwner) wx.navigateTo({ url: '/pages/staff-members/index' }); },
  applyRosterFilters() {
    const today = chinaDate(new Date().toISOString());
    const result = rosterPresentation(this.data.registrations as StaffRegistration[], today, this.data.rosterFilter, this.data.rosterQuery);
    this.setData({ today, displayedRegistrations: result.visible, unreturnedCount: result.unreturnedCount, departedCount: result.unreturnedCount, todayDepartureCount: result.todayDepartureCount, todayReturnCount: result.todayReturnCount });
  },
  searchRoster(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ rosterQuery: event.detail.value }); this.applyRosterFilters(); },
  filterRoster(event: WechatMiniprogram.TouchEvent) { this.setData({ rosterFilter: event.currentTarget.dataset.filter }); this.applyRosterFilters(); },
  focusUnreturned() { this.setData({ pane: 'roster', rosterFilter: 'unreturned' }); this.applyRosterFilters(); },
  focusPending() { this.setData({ pane: 'roster', rosterFilter: 'pending' }); this.applyRosterFilters(); },
  pane(event: WechatMiniprogram.TouchEvent) { this.setData({ pane: event.currentTarget.dataset.pane }); },
  async select(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !await this.verifyIdentity()) return;
    const fence = this.fence();
    if ((this.data.formDirty || this.data.briefingDirty) && (!await confirm('切换活动', '本页修改尚未保存，是否放弃并切换？') || !this.matches(fence))) return;
    const selected = this.data.items.find(item => item.id === event.currentTarget.dataset.id) || null;
    this.setData({ selected, editor: false, formDirty: false, briefingDirty: false, registrations: [], displayedRegistrations: [], briefing: emptyBriefing(), settlement: null, preview: null, notice: '', pane: 'roster', rosterFilter: 'all', rosterQuery: '' });
    await Promise.all([this.loadRoster(), this.loadBriefing()]);
  },
  async newActivity() {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const fence = this.fence();
    if (this.data.editor && this.data.formDirty && (!await confirm('创建另一场活动', '当前草稿尚未保存，是否放弃本页修改？') || !this.matches(fence))) return;
    this.setData({ form: emptyForm(), coverIndex: 0, editor: true, editorKind: 'draft', formDirty: false, formMemberId: fence.memberId, formEnvironment: fence.environment, pane: 'activities', notice: '', error: '' }, () => wx.pageScrollTo({ selector: '#activity-editor', duration: 180 }));
  },
  async edit() {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const activity = this.data.selected;
    if (!activity) return;
    this.openEditor(activity);
  },
  async editListed(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const fence = this.fence();
    if ((this.data.formDirty || this.data.briefingDirty) && (!await confirm('切换编辑', '本页修改尚未保存，是否放弃并切换？') || !this.matches(fence))) return;
    const activity = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (activity) { this.setData({ selected: activity }); this.openEditor(activity); }
  },
  openEditor(activity: ReturnType<typeof activityCard>) {
    this.setData({ coverIndex: Math.max(0, coverChoices.findIndex(item => item.key === activity.coverKey)), editor: true, editorKind: activity.state === 'draft' ? 'draft' : 'content', formDirty: false, formMemberId: this.data.member!.id, formEnvironment: environmentScope(), pane: 'activities', error: '',
      form: { id: activity.id, revision: activity.revision, reason: '', title: activity.title, description: activity.description, location: activity.location, difficulty: activity.difficulty, startDate: chinaDate(activity.startAt), startTime: chinaTime(activity.startAt), endDate: chinaDate(activity.endAt), endTime: chinaTime(activity.endAt), deadlineDate: chinaDate(activity.applicationClosesAt), deadlineTime: chinaTime(activity.applicationClosesAt), capacity: String(activity.capacity), minGrowthPoints: String(activity.minGrowthPoints), growth: String(activity.pointsRule.growth), annual: String(activity.pointsRule.annual), redeemable: String(activity.pointsRule.redeemable ?? 0), requiredQualifications: activity.requiredQualifications.join('，'), requiresReview: activity.requiresReview, safetyNotice: activity.safetyNotice, equipment: activity.equipment, coverKey: activity.coverKey || '', distanceKm: activity.distanceKm == null ? '' : String(activity.distanceKm), itinerary: structuredStages(activity.itinerary) },
    }, () => wx.pageScrollTo({ selector: '#activity-editor', duration: 180 }));
  },
  async closeEditor() { const fence = this.fence(); if (this.data.formDirty && !await confirm('收起编辑', '本页修改尚未保存，是否放弃？') || !this.matches(fence)) return; this.setData({ editor: false, formDirty: false }); },
  formMatches() { return this.data.editor && this.data.canManage && this.matches(this.fence()) && this.data.formMemberId === this.data.member?.id && this.data.formEnvironment === environmentScope() && (!this.data.form.id || this.data.form.id === this.data.selected?.id); },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const field = String(event.currentTarget.dataset.field);
    const editable = this.data.editorKind === 'content' ? ['title', 'description', 'reason', 'distanceKm'] : Object.keys(emptyForm()).filter(key => !['id', 'revision', 'itinerary', 'coverKey', 'requiresReview'].includes(key));
    if (this.formMatches() && !this.data.busy && editable.includes(field)) this.setData({ [`form.${field}`]: event.detail.value, formDirty: true });
  },
  cover(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const index = Number(event.detail.value);
    if (this.formMatches() && !this.data.busy && Number.isSafeInteger(index) && coverChoices[index]) this.setData({ coverIndex: index, 'form.coverKey': coverChoices[index].key, formDirty: true });
  },
  itineraryField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const { index, field } = event.currentTarget.dataset;
    if (!this.formMatches() || this.data.busy || !Number.isSafeInteger(Number(index)) || !this.data.form.itinerary[Number(index)] || !['dayLabel', 'title', 'description'].includes(field)) return;
    this.setData({ 'form.itinerary': this.data.form.itinerary.map((stage, i) => i === Number(index) ? { ...stage, [field]: event.detail.value } : stage), formDirty: true });
  },
  addStage() { if (this.formMatches() && !this.data.busy && this.data.form.itinerary.length < 30) this.setData({ 'form.itinerary': [...this.data.form.itinerary, { dayLabel: 'D' + (this.data.form.itinerary.length + 1), title: '', description: '' }], formDirty: true }); },
  removeStage(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (this.formMatches() && !this.data.busy && Number.isSafeInteger(index) && index >= 0 && index < this.data.form.itinerary.length) this.setData({ 'form.itinerary': this.data.form.itinerary.filter((_, i) => i !== index), formDirty: true });
  },
  reviewSwitch(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) { if (this.formMatches() && this.data.editorKind === 'draft' && !this.data.busy) this.setData({ 'form.requiresReview': event.detail.value, formDirty: true }); },
  previewActivity() { if (this.data.selected && this.matches(this.fence())) wx.navigateTo({ url: `/pages/activity/detail?id=${encodeURIComponent(this.data.selected.id)}` }); },
  async loadBriefing() {
    const activityId = this.data.selected?.id, fence = this.fence();
    if (!activityId || !this.data.authorized || !this.matches(fence)) return;
    this.setData({ briefingLoading: true });
    try {
      const value = await call<Briefing | null>('activity.briefing.get', { activityId });
      if (!this.matches(fence) || this.data.selected?.id !== activityId) return;
      const briefing = value || { ...emptyBriefing(), activityId };
      this.setData({ briefing, briefingDirty: false, briefingContactIndex: Math.max(0, ['wechat', 'phone', 'other'].indexOf(briefing.contactMethod)), briefingChecklist: briefing.checklist.join('\n'), briefingDate: briefing.meetingTime ? chinaDate(briefing.meetingTime) : chinaDate(this.data.selected.startAt), briefingTime: briefing.meetingTime ? chinaTime(briefing.meetingTime) : '08:30' });
    } catch (error) { if (this.matches(fence) && this.data.selected?.id === activityId) this.setData({ error: errorMessage(error), briefing: emptyBriefing(), briefingChecklist: '' }); }
    finally { if (this.matches(fence) && this.data.selected?.id === activityId) this.setData({ briefingLoading: false }); }
  },
  briefingField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.data.canManage || this.data.busy || !this.matches(this.fence())) return;
    const field = event.currentTarget.dataset.field as string;
    if (['meetingPoint', 'contactName', 'contactValue', 'notes'].includes(field)) this.setData({ [`briefing.${field}`]: event.detail.value, briefingDirty: true });
    else if (['briefingChecklist', 'briefingDate', 'briefingTime'].includes(field)) this.setData({ [field]: event.detail.value, briefingDirty: true });
  },
  briefingContact(event: WechatMiniprogram.CustomEvent<{ value: string }>) { if (this.data.canManage && !this.data.busy && this.matches(this.fence())) this.setData({ briefingContactIndex: Number(event.detail.value), briefingDirty: true }); },
  async saveBriefing() {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const activity = this.data.selected, form = this.data.briefing, fence = this.fence();
    if (!activity) return;
    const meeting = new Date(`${this.data.briefingDate}T${this.data.briefingTime}:00+08:00`);
    if (!form.meetingPoint.trim() || !form.contactName.trim() || !form.contactValue.trim() || !Number.isFinite(meeting.getTime())) { toast('请填写集合地点、时间和本场联络方式'); return; }
    this.setData({ busy: 'briefing', error: '' });
    try {
      const briefing = await call<Briefing>('staff.briefing.save', { activityId: activity.id, meetingPoint: form.meetingPoint.trim(), meetingTime: meeting.toISOString(), contactName: form.contactName.trim(), contactMethod: ['wechat', 'phone', 'other'][this.data.briefingContactIndex], contactValue: form.contactValue.trim(), checklist: this.data.briefingChecklist.split('\n').map(value => value.trim()).filter(Boolean), notes: form.notes.trim() }, form.revision);
      if (!this.matches(fence) || this.data.selected?.id !== activity.id) return;
      this.setData({ briefing, briefingDirty: false, notice: '行前说明已更新，请提醒已确认的车友查看最新版本。' });
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  reason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ operationReason: event.detail.value }); },
  ledger(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ ledgerId: event.detail.value }); },
  reversalReason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ reversalReason: event.detail.value }); },
  async save() {
    if (this.data.busy || !await this.verifyIdentity(true) || !this.formMatches()) return;
    const form = this.data.form, fence = this.fence(), contentOnly = this.data.editorKind === 'content';
    if (!(contentOnly ? [form.title, form.description, form.reason] : [form.title, form.description, form.location, form.safetyNotice, form.equipment]).every(value => value.trim())) { toast(contentOnly ? '请填写标题、介绍和修改原因' : '请填写标题、内容、地点、装备和风险说明'); return; }
    const capacity = Number(form.capacity), minGrowthPoints = Number(form.minGrowthPoints), growth = Number(form.growth), annual = Number(form.annual), redeemable = form.redeemable.trim() === '' ? undefined : Number(form.redeemable);
    if (!contentOnly && (![capacity, minGrowthPoints, growth, annual, ...(redeemable === undefined ? [] : [redeemable])].every(value => Number.isSafeInteger(value) && value >= 0) || capacity < 1 || capacity > BETA_MAX_CAPACITY)) { toast(`请输入有效整数，名额为 1–${BETA_MAX_CAPACITY}`); return; }
    const start = new Date(`${form.startDate}T${form.startTime}:00+08:00`), end = new Date(`${form.endDate}T${form.endTime}:00+08:00`), deadline = new Date(`${form.deadlineDate}T${form.deadlineTime}:00+08:00`);
    if (!contentOnly && (![start, end, deadline].every(value => Number.isFinite(value.getTime())) || end <= start || deadline > start)) { toast('请检查开始、结束与报名截止时间'); return; }
    const distanceKm = form.distanceKm.trim() ? Number(form.distanceKm) : null;
    if (distanceKm !== null && (!Number.isSafeInteger(distanceKm) || distanceKm < 1 || distanceKm > 100000)) { toast('路线里程请填写1–100000的整数，或留空'); return; }
    let display;
    try { display = activityDisplayFields({ coverKey: form.coverKey || null, distanceKm, itinerary: form.itinerary }); } catch (error) { toast(error instanceof DomainError ? error.message : errorMessage(error)); return; }
    this.setData({ busy: 'save', error: '' });
    try {
      const activity = contentOnly
        ? await call<Activity>('staff.activity.content.save', { activityId: form.id, title: form.title.trim(), description: form.description.trim(), reason: form.reason.trim(), ...display }, form.revision)
        : await call<Activity>('staff.activity.save', { ...(form.id ? { id: form.id } : {}), ...display, title: form.title.trim(), description: form.description.trim(), location: form.location.trim(), difficulty: form.difficulty.trim(), startAt: start.toISOString(), endAt: end.toISOString(), applicationClosesAt: deadline.toISOString(), capacity, minGrowthPoints, pointsRule: { growth, annual, ...(redeemable === undefined ? {} : { redeemable }) }, requiredQualifications: form.requiredQualifications.split(/[,，]/).map(value => value.trim()).filter(Boolean), requiresReview: form.requiresReview, equipment: form.equipment.trim(), safetyNotice: form.safetyNotice.trim() }, form.id ? form.revision : undefined);
      if (!this.matches(fence)) return;
      this.setData({ selected: activityCard(activity), editor: false, formDirty: false, busy: '', pane: 'roster', notice: contentOnly ? '活动内容已更新，修改原因已记录。' : '草稿已保存。可先预览，再发布招募。' }); await this.load();
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  async lifecycle(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const activity = this.data.selected, action = event.currentTarget.dataset.action as string;
    if (!activity || this.data.busy || !['publish', 'close', 'start', 'end', 'cancel'].includes(action)) return;
    const fence = this.fence();
    const labels: Record<string, string> = { publish: '发布招募', close: '关闭报名', start: '开始活动', end: '结束活动', cancel: '取消活动' };
    const messages: Record<string, string> = { publish: `发布「${activity.title}」？发布后冻结本场规则 v${activity.ruleVersion}，成长奖励 ${activity.pointsRule.growth} 分、年度奖励 ${activity.pointsRule.annual} 分、兑换奖励 ${activity.pointsRule.redeemable ?? 0} 分。`, close: '关闭后停止新的报名与自动候补提升，已确认人员继续保留。', start: `计划开始时间为 ${activity.dateText}（北京时间）。确认现在开始？本次操作记录实际开始时间，并开放现场出发核验。请先核对天气、场地、人员与安全条件。`, end: '以当前时刻作为实际完成时间，积分年度按北京时间归属。请先核对实际结束情况，再逐人完成结束核验。', cancel: '取消后停止报名和现场核验，保留申请与操作记录。请另行通知相关车友。' };
    if (action === 'cancel' && !this.data.operationReason.trim()) { toast('请先填写取消原因'); return; }
    if (!await confirm(labels[action], messages[action])) return;
    if (!await this.verifyIdentity(true) || !this.matches(fence) || this.data.selected?.id !== activity.id || this.data.selected.revision !== activity.revision) return;
    this.setData({ busy: action, error: '', notice: '' });
    try {
      await call<Activity>(`staff.activity.${action}`, { activityId: activity.id, actualCompletedAt: action === 'end' ? new Date().toISOString() : undefined, reason: this.data.operationReason.trim() || undefined }, activity.revision);
      if (!this.matches(fence)) return;
      this.setData({ busy: '', notice: `${labels[action]}已完成` }); await this.load();
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  async promote() {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const fence = this.fence();
    const activity = this.data.selected;
    if (!activity || this.data.busy || !await confirm('提升最早有效候补', '将重新核对名额、截止时间和资格。候补提升后仍需联系本人，再确认参加。')) return;
    if (!await this.verifyIdentity(true) || !this.matches(fence) || this.data.selected?.id !== activity.id) return;
    this.setData({ busy: 'promote', error: '' });
    try { await call('staff.waitlist.promote', { activityId: activity.id }, activity.revision); if (!this.matches(fence)) return; this.setData({ busy: '', notice: '候补处理已完成，以最新名单为准。' }); await this.load(); }
    catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  async registrationAction(event: WechatMiniprogram.TouchEvent) {
    const action = event.currentTarget.dataset.action as string, manage = ['approve', 'reject', 'confirm'].includes(action);
    if (this.data.busy || !await this.verifyIdentity(manage)) return;
    const fence = this.fence();
    const registration = this.data.registrations.find(item => item.id === event.currentTarget.dataset.id);
    if (!registration || this.data.busy) return;
    const descriptions: Record<string, string> = { approve: '已核对本场必要资格，批准后仍需联系确认。', reject: '资格审核未通过，将释放预留名额。请在操作说明中填写原因。', confirm: '确认已与本人完成线下安排，并核对必要资格。此操作只确认参加，不记录付款或金额。', departure: '已在现场核对本人、装备和参加资格，确认可以出发。', return: '已核对本人实际结束情况，记录为正常结束，等待结算。', safe_exit: '记录安全退出，不按正常完成发放奖励。请填写原因。', no_show: '记录未到，不按正常完成发放奖励。请填写原因。' };
    if (!descriptions[action]) return;
    if (['reject', 'safe_exit', 'no_show'].includes(action) && !this.data.operationReason.trim()) { toast('请先填写操作说明 / 原因'); return; }
    if (!await confirm('核对参加者记录', `${registration.nickname || '本场车友'}：${descriptions[action]}`)) return;
    if (!await this.verifyIdentity(manage) || !this.matches(fence) || this.data.selected?.id !== registration.activityId) return;
    this.setData({ busy: registration.id, error: '' });
    try {
      const reason = this.data.operationReason.trim() || undefined;
      if (['approve', 'reject'].includes(action)) await call('staff.registration.review', { registrationId: registration.id, decision: action === 'approve' ? 'approved' : 'rejected', reason }, registration.revision);
      else if (action === 'confirm') await call('staff.registration.confirm', { registrationId: registration.id }, registration.revision);
      else await call('staff.checkin.record', { registrationId: registration.id, phase: ['return', 'safe_exit'].includes(action) ? 'return' : 'departure', result: action === 'safe_exit' ? 'safe_exit' : action === 'no_show' ? 'no_show' : 'present', reason }, registration.revision);
      if (!this.matches(fence)) return;
      this.setData({ busy: '', notice: '人员状态已更新。' }); await this.load();
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  async preview() {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const fence = this.fence();
    const activity = this.data.selected;
    if (!activity || this.data.busy) return;
    this.setData({ busy: 'preview', error: '', settlement: null });
    try {
      const preview = await call<SettlementPreview>('staff.settlement.preview', { activityId: activity.id, ruleVersion: activity.ruleVersion }, activity.revision);
      if (!this.matches(fence) || this.data.selected?.id !== activity.id) return;
      this.setData({ preview, previewRows: preview.items.map(item => registrationCard({ ...item, nickname: this.data.registrations.find(reg => reg.id === item.id)?.nickname || item.nickname })), pane: 'settlement' });
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  async settle() {
    if (this.data.busy || !await this.verifyIdentity(true)) return;
    const fence = this.fence();
    const activity = this.data.selected, preview = this.data.preview;
    if (!activity || !preview || this.data.busy || !await confirm('确认按冻结规则结算', `本场正常完成可结算 ${preview.eligibleCount} 人。规则 v${preview.ruleVersion}，成长奖励 ${activity.pointsRule.growth} 分、年度奖励 ${activity.pointsRule.annual} 分、兑换奖励 ${activity.pointsRule.redeemable ?? 0} 分。只为完整核验的参加者记分，重试不会重复发放。`)) return;
    if (!await this.verifyIdentity(true) || !this.matches(fence) || this.data.selected?.id !== activity.id || this.data.preview !== preview) return;
    this.setData({ busy: 'settlement', error: '' });
    try {
      const settlement = await call<SettlementResult>('staff.settlement.run', { activityId: activity.id, ruleVersion: preview.ruleVersion }, activity.revision);
      if (!this.matches(fence)) return;
      this.setData({ busy: '', settlement, notice: '请核对结算结果与待处理事项。' }); await this.load();
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  prepareReverse(event: WechatMiniprogram.TouchEvent) {
    const registration = this.data.registrations.find(item => item.id === event.currentTarget.dataset.id);
    if (!this.data.isOwner || !registration?.settlementId || registration.completionVoided) return;
    this.setData({ ledgerId: registration.settlementId, reversalReason: '', reversalTarget: `${registration.nickname || '本场车友'} · ${this.data.selected?.title || ''}`, pane: 'owner', notice: '' });
  },
  async reverse() {
    if (this.data.busy || !await this.verifyIdentity() || !this.data.isOwner) return;
    const fence = this.fence();
    const ledgerId = this.data.ledgerId.trim(), reason = this.data.reversalReason.trim();
    if (!ledgerId || !reason) { toast('请提供原流水标识和更正原因'); return; }
    if (!await confirm('冲正原完成记录', '冲正保留原流水，新建相反增量并同步有效完成次数。请确认这是已核实的错误完成记录，此操作留有审计。')) return;
    if (!await this.verifyIdentity() || !this.data.isOwner || !this.matches(fence)) return;
    this.setData({ busy: 'reverse', error: '' });
    try { await call('staff.points.reverse', { ledgerId, reason }); if (this.matches(fence)) this.setData({ notice: '冲正已完成，请核对原会员成长记录。', ledgerId: '', reversalReason: '', reversalTarget: '' }); }
    catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
});
