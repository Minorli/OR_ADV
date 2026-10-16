import { call, currentMember, errorMessage, confirm, toast, isMock } from '../../services/api';
import type { MemberSummary, PageResult, Role, Activity } from '../../../../shared/types';
import { memberNumberText } from '../../services/member-number';

interface RoleGrant { role: Role; revision: number; enabled: boolean; activityIds: string[] | null; expiresAt: string | null }
interface MemberRow {
  id: string; memberId: string; nickname: string; memberKind: 'founder' | 'regular'; memberKindVersion: number;
  memberKindExpiresAt: string | null; revision: number; recommendationPriority: number; recommendationOptIn: boolean;
  kindRequestStatus: 'pending' | 'resolved' | null; kindRequestedAt: string | null; staffRoles?: RoleGrant[];
  memberNumber?: number; memberCode?: string;
}
interface ClubSettings { clubId: string; name: string; contactName: string; contactMethod: string; contactValue: string; contactInstructions: string; revision: number; configured: boolean }
interface Qualification { id: string; memberId: string; type: string; decision: string; expiresAt: string | null; revision: number; reviewedAt: string | null }
const roles: Role[] = ['operator', 'leader', 'checkin', 'owner'];
const roleLabels = ['运营', '领队', '现场核验', '主理人'];
const contactMethods = ['wechat', 'phone', 'other'];
const contactLabels = ['微信', '电话', '其他约定方式'];

Page({
  data: {
    isMock, member: null as MemberSummary | null, authorized: false, pane: 'members', loading: false, loadingMore: false, busy: '', error: '', notice: '',
    query: '', items: [] as MemberRow[], nextCursor: null as string | null, requestVersion: 0, selected: null as MemberRow | null,
    reason: '', expiryDate: '', priority: '0', roleLabels, roleIndex: 0, roleEnabled: true, roleExpiryDate: '', scopeIds: [] as string[], activities: [] as Activity[], scopeOptions: [] as (Activity & { checked: boolean })[],
    qualifications: [] as Qualification[], qualificationCursor: null as string | null, qualificationType: '', qualificationDate: '', qualificationRevision: 0,
    settings: { clubId: 'oradv', name: '原始拉力', contactName: '', contactMethod: 'wechat', contactValue: '', contactInstructions: '', revision: 0, configured: false } as ClubSettings,
    contactLabels, contactIndex: 0,
  },
  onShow() { void this.load(); },
  async load() {
    this.setData({ loading: true, error: '', authorized: false });
    try {
      const member = await currentMember();
      const authorized = !!member?.roles.includes('owner');
      this.setData({ member, authorized });
      if (!authorized) { this.setData({ items: [], selected: null, qualifications: [] }); return; }
      await this.loadMembers();
      const settings = await call<ClubSettings>('club.public');
      this.setData({ settings, contactIndex: Math.max(0, contactMethods.indexOf(settings.contactMethod)) });
      const activities: Activity[] = [];
      let cursor: string | null = null;
      do {
        const page: PageResult<Activity> = await call('staff.activity.list', { cursor });
        activities.push(...page.items); cursor = page.nextCursor;
      } while (cursor && activities.length < 200);
      this.setData({ activities });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  async loadMembers(append = false) {
    if (!this.data.authorized || append && !this.data.nextCursor) return;
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ requestVersion, loadingMore: true, error: '' });
    try {
      const result = await call<PageResult<MemberRow>>('staff.member.list', { query: this.data.query.trim() || undefined, cursor: append ? this.data.nextCursor : undefined });
      if (this.data.requestVersion !== requestVersion) return;
      const items = result.items.map(item => ({ ...item, memberCode: memberNumberText(item.memberNumber) }));
      this.setData({ items: append ? [...this.data.items, ...items] : items, nextCursor: result.nextCursor });
    } catch (error) { if (this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.data.requestVersion === requestVersion) this.setData({ loadingMore: false }); }
  },
  query(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ query: event.detail.value }); },
  search() { void this.loadMembers(); },
  more() { if (!this.data.loadingMore) void this.loadMembers(true); },
  pane(event: WechatMiniprogram.TouchEvent) { this.setData({ pane: event.currentTarget.dataset.pane }); },
  back() { wx.navigateBack({ delta: 1 }); },
  async select(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const selected = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (!selected) return;
    this.setData({ selected, error: '', priority: String(selected.recommendationPriority || 0), reason: '', expiryDate: selected.memberKindExpiresAt?.slice(0, 10) || '', qualifications: [], qualificationCursor: null, qualificationType: '', qualificationDate: '', qualificationRevision: 0, roleIndex: 0, scopeIds: [] });
    try {
      const result = await call<{ items: RoleGrant[] }>('staff.roles.list', { memberId: selected.memberId || selected.id });
      if (this.data.selected?.id !== selected.id) return;
      this.setData({ 'selected.staffRoles': result.items });
      this.selectRole();
      const qualifications = await call<PageResult<Qualification>>('staff.qualification.list', { memberId: selected.memberId || selected.id });
      if (this.data.selected?.id === selected.id) this.setData({ qualifications: qualifications.items, qualificationCursor: qualifications.nextCursor });
    } catch (error) { if (this.data.selected?.id === selected.id) this.setData({ error: errorMessage(error) }); }
  },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const name = event.currentTarget.dataset.field as string;
    if (['reason', 'expiryDate', 'priority', 'qualificationType', 'qualificationDate', 'roleExpiryDate'].includes(name)) this.setData({ [name]: event.detail.value });
  },
  clearExpiry() { this.setData({ expiryDate: '' }); },
  clearRoleExpiry() { this.setData({ roleExpiryDate: '' }); },
  async refreshSelected() {
    const selected = this.data.selected;
    if (!selected) return;
    await this.loadMembers();
    const row = this.data.items.find(item => item.id === selected.id);
    // If a search moved this member off the current page, close stale controls.
    this.setData({ selected: row || null });
  },
  async assignKind(event: WechatMiniprogram.TouchEvent) {
    const selected = this.data.selected;
    const memberKind = event.currentTarget.dataset.kind as string;
    if (!selected || this.data.busy || !this.data.authorized || !['founder', 'regular'].includes(memberKind)) return;
    if (!this.data.reason.trim()) { toast('请填写核实依据与变更原因'); return; }
    if (!await confirm('核对成员身份', `将 ${selected.nickname} 设为${memberKind === 'founder' ? '创始成员' : '普通成员'}。身份不代表员工资格，也不会免除活动门槛和现场核验。`)) return;
    this.setData({ busy: 'kind', error: '' });
    try {
      await call('staff.member.assign', { memberId: selected.memberId || selected.id, memberKind, reason: this.data.reason.trim(), expiresAt: memberKind === 'founder' && this.data.expiryDate ? `${this.data.expiryDate}T15:59:59.000Z` : null }, selected.revision);
      await this.refreshSelected(); this.setData({ notice: '成员身份已更新。已有报名以本场参加记录为准。', reason: '' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  async savePriority() {
    const selected = this.data.selected, priority = Number(this.data.priority);
    if (!selected || !this.data.authorized || this.data.busy) return;
    if (!Number.isInteger(priority) || priority < 0 || priority > 999 || !this.data.reason.trim()) { toast('推荐顺序需为 0–999，并填写调整原因'); return; }
    this.setData({ busy: 'recommendation', error: '' });
    try {
      await call('staff.recommendation.save', { memberId: selected.memberId || selected.id, priority, reason: this.data.reason.trim() }, selected.revision);
      await this.refreshSelected(); this.setData({ notice: '推荐顺序已保存。只有本人同意公开的资料会显示。', reason: '' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  role(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ roleIndex: Number(event.detail.value) }); this.selectRole(); },
  selectRole() {
    const grant = this.data.selected?.staffRoles?.find(item => item.role === roles[this.data.roleIndex]);
    const scopeIds = grant?.activityIds || [];
    this.setData({ roleEnabled: grant?.enabled ?? true, roleExpiryDate: grant?.expiresAt?.slice(0, 10) || '', scopeIds, scopeOptions: this.data.activities.map(item => ({ ...item, checked: scopeIds.includes(item.id) })) });
  },
  roleEnabled(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) { this.setData({ roleEnabled: event.detail.value }); },
  scopes(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ scopeIds: event.detail.value }); },
  async saveRole() {
    const selected = this.data.selected, role = roles[this.data.roleIndex];
    if (!selected || !role || !this.data.authorized || this.data.busy) return;
    if (!this.data.reason.trim()) { toast('请填写授权或撤销原因'); return; }
    const scoped = ['leader', 'checkin'].includes(role);
    if (scoped && !this.data.scopeIds.length) { toast('请为现场员工选择授权场次'); return; }
    if (!await confirm('核对员工授权', `${selected.nickname} · ${roleLabels[this.data.roleIndex]} · ${this.data.roleEnabled ? '启用' : '撤销'}。成员身份与员工权限分别管理。`)) return;
    this.setData({ busy: 'role', error: '' });
    try {
      const prior = selected.staffRoles?.find(item => item.role === role);
      const expiresAt = this.data.roleExpiryDate === prior?.expiresAt?.slice(0, 10) ? prior.expiresAt : this.data.roleExpiryDate ? `${this.data.roleExpiryDate}T15:59:59.000Z` : null;
      await call('staff.roles.assign', { memberId: selected.memberId || selected.id, role, enabled: this.data.roleEnabled, activityIds: scoped ? this.data.scopeIds : null, expiresAt, reason: this.data.reason.trim() }, prior?.revision);
      const result = await call<{ items: RoleGrant[] }>('staff.roles.list', { memberId: selected.memberId || selected.id });
      this.setData({ 'selected.staffRoles': result.items, notice: '员工授权已更新。', reason: '' }); this.selectRole();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  qualification(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.qualifications.find(row => row.id === event.currentTarget.dataset.id);
    if (item) this.setData({ qualificationType: item.type, qualificationDate: item.expiresAt?.slice(0, 10) || '', qualificationRevision: item.revision });
  },
  async moreQualifications() {
    const selected = this.data.selected;
    if (!selected || !this.data.qualificationCursor || this.data.busy) return;
    this.setData({ busy: 'qualifications', error: '' });
    try {
      const result = await call<PageResult<Qualification>>('staff.qualification.list', { memberId: selected.memberId || selected.id, cursor: this.data.qualificationCursor });
      if (this.data.selected?.id === selected.id) this.setData({ qualifications: [...this.data.qualifications, ...result.items], qualificationCursor: result.nextCursor });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  async reviewQualification(event: WechatMiniprogram.TouchEvent) {
    const selected = this.data.selected, decision = event.currentTarget.dataset.decision;
    if (!selected || !this.data.authorized || this.data.busy || !['approved', 'rejected'].includes(decision)) return;
    if (!this.data.qualificationType.trim() || !this.data.reason.trim()) { toast('请填写技能项目和核验依据'); return; }
    if (!await confirm('记录技能核验', '请以实际核验为依据。活动积分和参加次数不能代替技能资格。')) return;
    this.setData({ busy: 'qualification', error: '' });
    try {
      const current = this.data.qualifications.find(item => item.type === this.data.qualificationType.trim());
      await call('staff.qualification.review', { memberId: selected.memberId || selected.id, type: this.data.qualificationType.trim(), decision, expiresAt: this.data.qualificationDate ? `${this.data.qualificationDate}T15:59:59.000Z` : null, reason: this.data.reason.trim() }, current?.revision ?? 0);
      const result = await call<PageResult<Qualification>>('staff.qualification.list', { memberId: selected.memberId || selected.id });
      this.setData({ qualifications: result.items, qualificationCursor: result.nextCursor, notice: '技能核验已记录。', reason: '' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
  settingsField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const name = event.currentTarget.dataset.field as string;
    if (['name', 'contactName', 'contactValue', 'contactInstructions'].includes(name)) this.setData({ [`settings.${name}`]: event.detail.value });
  },
  contact(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ contactIndex: Number(event.detail.value) }); },
  async saveSettings() {
    if (!this.data.authorized || this.data.busy) return;
    const form = this.data.settings;
    if (!form.name.trim() || !form.contactName.trim() || !form.contactValue.trim() || !form.contactInstructions.trim()) { toast('请填写经确认可公开的俱乐部名称和实际联络说明'); return; }
    if (!await confirm('保存公开联络信息', '这些信息会公开显示，请确认联络人已同意，并且车友确实能通过该方式联系俱乐部。')) return;
    this.setData({ busy: 'settings', error: '' });
    try {
      const settings = await call<ClubSettings>('staff.club.save', { name: form.name.trim(), contactName: form.contactName.trim(), contactMethod: contactMethods[this.data.contactIndex], contactValue: form.contactValue.trim(), contactInstructions: form.contactInstructions.trim() }, form.revision);
      this.setData({ settings, notice: '公开联络信息已更新。' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
});
