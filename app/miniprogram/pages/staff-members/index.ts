import { call, currentMember, errorMessage, confirm, toast, isMock, mockRole, runtime } from '../../services/api';
import type { MemberSummary, PageResult, Role, Activity } from '../../../../shared/types';
import { memberNumberText } from '../../services/member-number';
import { businessAdminTitle } from '../../../../shared/permissions';

interface RoleGrant { role: Role; revision: number; enabled: boolean; activityIds: string[] | null; expiresAt: string | null; designation?: 'manager' }
interface MemberRow {
  id: string; memberId: string; nickname: string; memberKind: 'founder' | 'regular'; memberKindVersion: number;
  memberKindExpiresAt: string | null; revision: number; recommendationPriority: number; recommendationOptIn: boolean;
  kindRequestStatus: 'pending' | 'resolved' | null; kindRequestedAt: string | null; staffRoles?: RoleGrant[];
  memberNumber?: number; memberCode?: string;
  isPrimaryOwner?: boolean;
  roleBadges?: string[];
}
interface ClubSettings { clubId: string; name: string; contactName: string; contactMethod: string; contactValue: string; contactInstructions: string; revision: number; configured: boolean }
interface Qualification { id: string; memberId: string; type: string; decision: string; expiresAt: string | null; revision: number; reviewedAt: string | null }
const roles: Role[] = ['operator', 'leader', 'checkin', 'content_admin', 'owner'];
const roleLabels = ['活动运营', '领队', '现场核验', '内容管理员', '最高业务管理员'];
const environmentScope = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
interface OwnerFence { version: number; memberId: string; role: string; environment: string }
const contactMethods = ['wechat', 'phone', 'other'];
const contactLabels = ['微信', '电话', '其他约定方式'];
const roleBadges = (row: Pick<MemberRow, 'staffRoles' | 'isPrimaryOwner'>) => (row.staffRoles || []).filter(role => role.enabled && (!role.expiresAt || Date.parse(role.expiresAt) > Date.now()))
  .map(role => role.role === 'owner' ? row.isPrimaryOwner ? '主理人' : role.designation === 'manager' ? '车队经理' : '最高业务管理员' : roleLabels[roles.indexOf(role.role)]);

Page({
  data: {
    isMock, member: null as MemberSummary | null, authorized: false, adminTitle: '', pane: 'members', loading: false, loadingMore: false, busy: '', error: '', notice: '', version: 0, selectionVersion: 0, loadedRole: '', loadedEnvironment: '',
    query: '', items: [] as MemberRow[], nextCursor: null as string | null, requestVersion: 0, selected: null as MemberRow | null,
    reason: '', expiryDate: '', priority: '0', roleLabels, roleValues: roles, roleIndex: 0, roleEnabled: true, roleExpiryDate: '', roleScoped: false, roleProtected: false, roleManager: false, scopeIds: [] as string[], activities: [] as Activity[], scopeOptions: [] as (Activity & { checked: boolean })[],
    qualifications: [] as Qualification[], qualificationCursor: null as string | null, qualificationType: '', qualificationDate: '', qualificationRevision: 0,
    settings: { clubId: 'oradv', name: '原始拉力', contactName: '', contactMethod: 'wechat', contactValue: '', contactInstructions: '', revision: 0, configured: false } as ClubSettings,
    contactLabels, contactIndex: 0, settingsDirty: false,
  },
  onShow() { return this.resume(); },
  onUnload() { this.clearPrivate(); },
  async resume() { if (this.data.selected || this.data.settingsDirty || this.data.busy) { await this.verifyOwner(); return; } await this.load(); },
  fence(): OwnerFence { return { version: this.data.version, memberId: this.data.member?.id || '', role: this.data.loadedRole, environment: this.data.loadedEnvironment }; },
  matches(fence: OwnerFence) {
    if (fence.version === this.data.version && (fence.environment !== environmentScope() || isMock && fence.role !== mockRole())) { this.clearPrivate(); return false; }
    return fence.version === this.data.version && !!fence.memberId && this.data.member?.id === fence.memberId && this.data.authorized && this.data.loadedEnvironment === fence.environment;
  },
  clearPrivate() {
    this.setData({ version: this.data.version + 1, requestVersion: this.data.requestVersion + 1, selectionVersion: this.data.selectionVersion + 1, member: null, authorized: false, adminTitle: '', loading: false, loadingMore: false,
      selected: null, items: [], nextCursor: null, qualifications: [], qualificationCursor: null, activities: [], scopeOptions: [], scopeIds: [], busy: '', reason: '', expiryDate: '', roleExpiryDate: '', roleProtected: false, roleManager: false, query: '', priority: '0',
      qualificationType: '', qualificationDate: '', qualificationRevision: 0, notice: '', settingsDirty: false, settings: { clubId: 'oradv', name: '原始拉力', contactName: '', contactMethod: 'wechat', contactValue: '', contactInstructions: '', revision: 0, configured: false } });
  },
  async verifyOwner() {
    const fence = this.fence();
    if (!this.matches(fence)) { this.clearPrivate(); await this.load(); return false; }
    try {
      const member = await currentMember();
      if (!this.matches(fence) || member?.id !== fence.memberId || !member?.roles.includes('owner')) {
        if (fence.version === this.data.version) { this.clearPrivate(); await this.load(); this.setData({ error: '当前管理身份已变化，请重新核对后操作' }); }
        return false;
      }
      this.setData({ member, adminTitle: businessAdminTitle(member) }); return true;
    } catch (error) { if (fence.version === this.data.version) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } return false; }
  },
  selectionMatches(fence: OwnerFence, selectedId: string) { return this.matches(fence) && this.data.selected?.id === selectedId; },
  async load() {
    this.clearPrivate();
    const version = this.data.version, role = mockRole(), environment = environmentScope();
    this.setData({ loading: true, error: '', loadedRole: role, loadedEnvironment: environment });
    try {
      const member = await currentMember();
      if (version !== this.data.version) return;
      if (environmentScope() !== environment || isMock && mockRole() !== role) { this.clearPrivate(); await this.load(); return; }
      const authorized = !!member?.roles.includes('owner');
      this.setData({ member, authorized, adminTitle: businessAdminTitle(member) });
      if (!authorized) { this.setData({ items: [], selected: null, qualifications: [] }); return; }
      await this.loadMembers();
      const fence = this.fence(); if (!this.matches(fence)) return;
      const settings = await call<ClubSettings>('club.public');
      if (!this.matches(fence)) return;
      this.setData({ settings, contactIndex: Math.max(0, contactMethods.indexOf(settings.contactMethod)) });
      const activities: Activity[] = [];
      let cursor: string | null = null;
      do {
        const page: PageResult<Activity> = await call('staff.activity.list', { cursor });
        if (!this.matches(fence)) return;
        activities.push(...page.items); cursor = page.nextCursor;
      } while (cursor && activities.length < 200);
      this.setData({ activities });
    } catch (error) { if (version === this.data.version) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } }
    finally { if (version === this.data.version) this.setData({ loading: false }); }
  },
  async loadMembers(append = false) {
    if (!this.data.authorized || append && !this.data.nextCursor) return;
    const fence = this.fence(); if (!this.matches(fence)) return;
    const requestVersion = this.data.requestVersion + 1;
    this.setData({ requestVersion, loadingMore: true, error: '' });
    try {
      const result = await call<PageResult<MemberRow>>('staff.member.list', { query: this.data.query.trim() || undefined, cursor: append ? this.data.nextCursor : undefined });
      if (!this.matches(fence) || this.data.requestVersion !== requestVersion) return;
      const items = result.items.map(item => ({ ...item, memberCode: memberNumberText(item.memberNumber), roleBadges: roleBadges(item) }));
      this.setData({ items: append ? [...this.data.items, ...items] : items, nextCursor: result.nextCursor });
    } catch (error) { if (this.matches(fence) && this.data.requestVersion === requestVersion) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence) && this.data.requestVersion === requestVersion) this.setData({ loadingMore: false }); }
  },
  query(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ query: event.detail.value }); },
  async search() { if (await this.verifyOwner()) await this.loadMembers(); },
  async more() { if (!this.data.loadingMore && await this.verifyOwner()) await this.loadMembers(true); },
  pane(event: WechatMiniprogram.TouchEvent) { this.setData({ pane: event.currentTarget.dataset.pane }); },
  back() { wx.navigateBack({ delta: 1 }); },
  async select(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !await this.verifyOwner()) return;
    const selected = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (!selected) return;
    const fence = this.fence(), selectionVersion = this.data.selectionVersion + 1;
    this.setData({ selected, selectionVersion, error: '', priority: String(selected.recommendationPriority || 0), reason: '', expiryDate: selected.memberKindExpiresAt?.slice(0, 10) || '', qualifications: [], qualificationCursor: null, qualificationType: '', qualificationDate: '', qualificationRevision: 0, roleIndex: 0, scopeIds: [] });
    try {
      const [result, qualifications] = await Promise.all([call<{ items: RoleGrant[]; isPrimaryOwner: boolean }>('staff.roles.list', { memberId: selected.memberId || selected.id }), call<PageResult<Qualification>>('staff.qualification.list', { memberId: selected.memberId || selected.id })]);
      if (!this.selectionMatches(fence, selected.id) || selectionVersion !== this.data.selectionVersion) return;
      this.setData({ 'selected.staffRoles': result.items, 'selected.isPrimaryOwner': result.isPrimaryOwner, 'selected.roleBadges': roleBadges({ staffRoles: result.items, isPrimaryOwner: result.isPrimaryOwner }), qualifications: qualifications.items, qualificationCursor: qualifications.nextCursor });
      this.selectRole();
    } catch (error) { if (this.selectionMatches(fence, selected.id) && selectionVersion === this.data.selectionVersion) this.setData({ error: errorMessage(error) }); }
  },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.matches(this.fence()) || this.data.busy) return;
    const name = event.currentTarget.dataset.field as string;
    if (['reason', 'expiryDate', 'priority', 'qualificationType', 'qualificationDate', 'roleExpiryDate'].includes(name)) this.setData({ [name]: event.detail.value });
  },
  clearExpiry() { this.setData({ expiryDate: '' }); },
  clearRoleExpiry() { this.setData({ roleExpiryDate: '' }); },
  async refreshSelected() {
    const selected = this.data.selected, fence = this.fence();
    if (!selected) return;
    await this.loadMembers();
    if (!this.matches(fence)) return;
    const row = this.data.items.find(item => item.id === selected.id);
    // If a search moved this member off the current page, close stale controls.
    this.setData({ selected: row || null });
  },
  async assignKind(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !await this.verifyOwner()) return;
    const fence = this.fence();
    const selected = this.data.selected;
    const memberKind = event.currentTarget.dataset.kind as string;
    if (!selected || this.data.busy || !this.data.authorized || !['founder', 'regular'].includes(memberKind)) return;
    if (!this.data.reason.trim()) { toast('请填写核实依据与变更原因'); return; }
    if (!await confirm('核对成员身份', `将 ${selected.nickname} 设为${memberKind === 'founder' ? '创始合伙人' : '俱乐部成员'}。业务身份不授予员工权限，也不修改客观积分。`)) return;
    if (!await this.verifyOwner() || !this.selectionMatches(fence, selected.id)) return;
    this.setData({ busy: 'kind', error: '' });
    try {
      await call('staff.member.assign', { memberId: selected.memberId || selected.id, memberKind, reason: this.data.reason.trim(), expiresAt: memberKind === 'founder' && this.data.expiryDate ? `${this.data.expiryDate}T15:59:59.000Z` : null }, selected.revision);
      if (!this.selectionMatches(fence, selected.id)) return;
      await this.refreshSelected(); if (this.matches(fence)) this.setData({ notice: '成员身份已更新。已有报名以本场参加记录为准。', reason: '' });
    } catch (error) { if (this.selectionMatches(fence, selected.id)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  async savePriority() {
    if (this.data.busy || !await this.verifyOwner()) return;
    const fence = this.fence();
    const selected = this.data.selected, priority = Number(this.data.priority);
    if (!selected || !this.data.authorized || this.data.busy) return;
    if (!Number.isInteger(priority) || priority < 0 || priority > 999 || !this.data.reason.trim()) { toast('推荐顺序需为 0–999，并填写调整原因'); return; }
    this.setData({ busy: 'recommendation', error: '' });
    try {
      await call('staff.recommendation.save', { memberId: selected.memberId || selected.id, priority, reason: this.data.reason.trim() }, selected.revision);
      if (!this.selectionMatches(fence, selected.id)) return;
      await this.refreshSelected(); if (this.matches(fence)) this.setData({ notice: '推荐顺序已保存。只有本人同意公开的资料会显示。', reason: '' });
    } catch (error) { if (this.selectionMatches(fence, selected.id)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  role(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ roleIndex: Number(event.detail.value) }); this.selectRole(); },
  selectRole() {
    const grant = this.data.selected?.staffRoles?.find(item => item.role === roles[this.data.roleIndex]);
    const scopeIds = grant?.activityIds || [];
    const roleProtected = roles[this.data.roleIndex] === 'owner' && this.data.selected?.isPrimaryOwner === true;
    this.setData({ roleProtected, roleScoped: ['leader', 'checkin'].includes(roles[this.data.roleIndex]), roleManager: grant?.designation === 'manager' && !roleProtected,
      roleEnabled: roleProtected ? true : grant?.enabled ?? true, roleExpiryDate: roleProtected ? '' : grant?.expiresAt?.slice(0, 10) || '', scopeIds, scopeOptions: this.data.activities.map(item => ({ ...item, checked: scopeIds.includes(item.id) })) });
  },
  roleEnabled(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) { this.setData({ roleEnabled: event.detail.value }); },
  roleManager(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) { if (!this.data.roleProtected && this.matches(this.fence())) this.setData({ roleManager: event.detail.value }); },
  scopes(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ scopeIds: event.detail.value }); },
  async saveRole() {
    if (this.data.busy || !await this.verifyOwner()) return;
    const fence = this.fence();
    const selected = this.data.selected, role = roles[this.data.roleIndex];
    if (!selected || !role || !this.data.authorized || this.data.busy) return;
    if (!this.data.reason.trim()) { toast('请填写授权或撤销原因'); return; }
    if (selected.isPrimaryOwner && role === 'owner' && (!this.data.roleEnabled || this.data.roleExpiryDate || this.data.roleManager)) { this.setData({ error: '可信主理人的最高权限保持长期有效，不能撤销或设置到期。' }); this.selectRole(); return; }
    const scoped = ['leader', 'checkin'].includes(role);
    if (scoped && !this.data.scopeIds.length) { toast('请为现场员工选择授权场次'); return; }
    if (!await confirm('核对员工授权', `${selected.nickname} · ${roleLabels[this.data.roleIndex]} · ${this.data.roleEnabled ? '启用' : '撤销'}。成员身份与员工权限分别管理。`)) return;
    if (!await this.verifyOwner() || !this.selectionMatches(fence, selected.id)) return;
    this.setData({ busy: 'role', error: '' });
    try {
      const prior = selected.staffRoles?.find(item => item.role === role);
      const expiresAt = this.data.roleExpiryDate === prior?.expiresAt?.slice(0, 10) ? prior.expiresAt : this.data.roleExpiryDate ? `${this.data.roleExpiryDate}T15:59:59.000Z` : null;
      await call('staff.roles.assign', { memberId: selected.memberId || selected.id, role, enabled: this.data.roleEnabled, activityIds: scoped ? this.data.scopeIds : null, expiresAt, reason: this.data.reason.trim(), ...(role === 'owner' ? { designation: this.data.roleManager ? 'manager' : null } : {}) }, prior?.revision);
      if (!this.selectionMatches(fence, selected.id)) return;
      const result = await call<{ items: RoleGrant[]; isPrimaryOwner: boolean }>('staff.roles.list', { memberId: selected.memberId || selected.id });
      if (!this.selectionMatches(fence, selected.id)) return;
      this.setData({ 'selected.staffRoles': result.items, 'selected.isPrimaryOwner': result.isPrimaryOwner, 'selected.roleBadges': roleBadges({ staffRoles: result.items, isPrimaryOwner: result.isPrimaryOwner }), notice: '员工授权已更新。', reason: '' }); this.selectRole();
    } catch (error) { if (this.selectionMatches(fence, selected.id)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  qualification(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.qualifications.find(row => row.id === event.currentTarget.dataset.id);
    if (item) this.setData({ qualificationType: item.type, qualificationDate: item.expiresAt?.slice(0, 10) || '', qualificationRevision: item.revision });
  },
  async moreQualifications() {
    if (this.data.busy || !await this.verifyOwner()) return;
    const fence = this.fence();
    const selected = this.data.selected;
    if (!selected || !this.data.qualificationCursor || this.data.busy) return;
    this.setData({ busy: 'qualifications', error: '' });
    try {
      const result = await call<PageResult<Qualification>>('staff.qualification.list', { memberId: selected.memberId || selected.id, cursor: this.data.qualificationCursor });
      if (this.selectionMatches(fence, selected.id)) this.setData({ qualifications: [...this.data.qualifications, ...result.items], qualificationCursor: result.nextCursor });
    } catch (error) { if (this.selectionMatches(fence, selected.id)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  async reviewQualification(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !await this.verifyOwner()) return;
    const fence = this.fence();
    const selected = this.data.selected, decision = event.currentTarget.dataset.decision;
    if (!selected || !this.data.authorized || this.data.busy || !['approved', 'rejected'].includes(decision)) return;
    if (!this.data.qualificationType.trim() || !this.data.reason.trim()) { toast('请填写技能项目和核验依据'); return; }
    if (!await confirm('记录技能核验', '请以实际核验为依据。活动积分和参加次数不能代替技能资格。')) return;
    if (!await this.verifyOwner() || !this.selectionMatches(fence, selected.id)) return;
    this.setData({ busy: 'qualification', error: '' });
    try {
      const current = this.data.qualifications.find(item => item.type === this.data.qualificationType.trim());
      await call('staff.qualification.review', { memberId: selected.memberId || selected.id, type: this.data.qualificationType.trim(), decision, expiresAt: this.data.qualificationDate ? `${this.data.qualificationDate}T15:59:59.000Z` : null, reason: this.data.reason.trim() }, current?.revision ?? 0);
      if (!this.selectionMatches(fence, selected.id)) return;
      const result = await call<PageResult<Qualification>>('staff.qualification.list', { memberId: selected.memberId || selected.id });
      if (!this.selectionMatches(fence, selected.id)) return;
      this.setData({ qualifications: result.items, qualificationCursor: result.nextCursor, notice: '技能核验已记录。', reason: '' });
    } catch (error) { if (this.selectionMatches(fence, selected.id)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
  settingsField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.matches(this.fence()) || this.data.busy) return;
    const name = event.currentTarget.dataset.field as string;
    if (['name', 'contactName', 'contactValue', 'contactInstructions'].includes(name)) this.setData({ [`settings.${name}`]: event.detail.value, settingsDirty: true });
  },
  contact(event: WechatMiniprogram.CustomEvent<{ value: string }>) { if (this.matches(this.fence())) this.setData({ contactIndex: Number(event.detail.value), settingsDirty: true }); },
  async saveSettings() {
    if (this.data.busy || !await this.verifyOwner()) return;
    const fence = this.fence();
    const form = this.data.settings;
    if (!form.name.trim() || !form.contactName.trim() || !form.contactValue.trim() || !form.contactInstructions.trim()) { toast('请填写经确认可公开的俱乐部名称和实际联络说明'); return; }
    if (!await confirm('保存公开联络信息', '这些信息会公开显示，请确认联络人已同意，并且车友确实能通过该方式联系俱乐部。')) return;
    if (!await this.verifyOwner() || !this.matches(fence)) return;
    this.setData({ busy: 'settings', error: '' });
    try {
      const settings = await call<ClubSettings>('staff.club.save', { name: form.name.trim(), contactName: form.contactName.trim(), contactMethod: contactMethods[this.data.contactIndex], contactValue: form.contactValue.trim(), contactInstructions: form.contactInstructions.trim() }, form.revision);
      if (this.matches(fence)) this.setData({ settings, settingsDirty: false, notice: '公开联络信息已更新。' });
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: '' }); }
  },
});
