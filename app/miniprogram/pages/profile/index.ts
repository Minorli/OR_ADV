import { call, currentMember, errorMessage, isMock, mockRole, switchMockRole, resetMock, confirm, toast, runtime } from '../../services/api';
import { mockRoleLabels, mockRoles, dateText } from '../../services/presentation';
import { emptyContact, contactPerson, memberKindText } from '../../services/member';
import type { MemberSummary } from '../../../../shared/types';
import { businessAdminTitle, canManagePublicContent, canOperateActivities } from '../../../../shared/permissions';
import { AvatarError, prepareAvatar } from '../../services/profile-avatar';
import { memberNumberText } from '../../services/member-number';
import type { MemberDossier } from '../../../../shared/dossier-types';
import { profileDossierProgress } from '../../../../shared/profile-overview-types';
import type { ProfileOverview } from '../../../../shared/profile-overview-types';
const profileEnvironment = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
const activeLoads = new WeakMap<object, { role: string; version: number; lifecycle: number; environment: string; promise: Promise<void> }>();
const identityReads = new WeakMap<object, { role: string; version: number; lifecycle: number; environment: string; memberId: string | null; promise: Promise<MemberSummary | null> }>();
function freshIdentity(page: object, role: string, version: number, lifecycle: number, memberId: string | null): Promise<MemberSummary | null> {
  const pending = identityReads.get(page);
  if (pending && pending.role === role && pending.version === version && pending.lifecycle === lifecycle && pending.environment === profileEnvironment() && pending.memberId === memberId) return pending.promise;
  let promise: Promise<MemberSummary | null>;
  promise = currentMember().finally(() => { if (identityReads.get(page)?.promise === promise) identityReads.delete(page); });
  identityReads.set(page, { role, version, lifecycle, environment: profileEnvironment(), memberId, promise });
  return promise;
}
interface ProfileReadSnapshot { member: MemberSummary; profileVersion: number; loadVersion: number; role: string; lifecycle: number; environment: string }
const accessFor = (member: MemberSummary | null) => ({ staff: canOperateActivities(member), isOwner: !!member?.roles.includes('owner'), canManageContent: canManagePublicContent(member), adminTitle: businessAdminTitle(member) });
Page({
  data: {
    isMock, member: null as MemberSummary | null, contact: emptyContact, kindLabel: '游客', memberNumber: '', kindExpiresText: '',
    nickname: '', nicknameStatus: 'unchanged', nicknameError: '', consent: false, kindReason: '', roles: mockRoleLabels, roleLabel: '',
    staff: false, isOwner: false, canManageContent: false, adminTitle: '', showPrivacy: false, showEdit: false, loading: false, saving: false, error: '', notice: '',
    avatarUrl: '', avatarDraftUrl: '', avatarBase64: '', avatarError: '', avatarLoading: false, avatarProcessing: false, draftPreviewFailed: false,
    loadVersion: 0, profileVersion: 0, lifecycleVersion: 0, loadedScope: '', avatarVersion: 0, avatarReadVersion: 0, loadedRole: '',
    identityVerified: false, dossierReadVersion: 0, dossierLoading: false, dossierError: '', dossierStatus: '尚未提交骑手资料', dossierNote: '分次准备，保存后可继续填写。',
    dossierCount: '0 / 11', dossierParts: [] as { name: string; ready: boolean }[],
  },
  onShow() {
    if (wx.getStorageSync('oradv-open-privacy')) { this.setData({ showPrivacy: true }); wx.setStorageSync('oradv-open-privacy', false); }
    return this.resume();
  },
  async resume() {
    const pending = activeLoads.get(this), role = mockRole();
    if (pending && pending.version === this.data.loadVersion && pending.role === role && pending.lifecycle === this.data.lifecycleVersion && pending.environment === profileEnvironment()) { await pending.promise; return; }
    if (this.data.saving || this.data.avatarProcessing || this.data.showEdit) { await this.verifyIdentity(); return; }
    await this.load();
  },
  onHide() { this.setData({ lifecycleVersion: this.data.lifecycleVersion + 1, identityVerified: false }); },
  onUnload() { this.setData({ loadVersion: this.data.loadVersion + 1, profileVersion: this.data.profileVersion + 1, avatarVersion: this.data.avatarVersion + 1 }); },
  identityMatches(version: number, memberId: string | null, role: string) {
    return this.data.profileVersion === version && this.data.loadedScope === profileEnvironment() && (this.data.member?.id || null) === memberId && (!isMock || mockRole() === role);
  },
  readMatches(snapshot: ProfileReadSnapshot) {
    return this.data.lifecycleVersion === snapshot.lifecycle && this.data.loadedScope === snapshot.environment && this.data.loadVersion === snapshot.loadVersion && this.identityMatches(snapshot.profileVersion, snapshot.member.id, snapshot.role);
  },
  clearIdentity() {
    this.setData({ member: null, memberNumber: '', nickname: '', nicknameStatus: 'unchanged', nicknameError: '', avatarUrl: '', avatarDraftUrl: '', avatarBase64: '', avatarError: '', avatarLoading: false, avatarProcessing: false, draftPreviewFailed: false, saving: false, kindReason: '', consent: false, kindExpiresText: '', showEdit: false,
      staff: false, isOwner: false, canManageContent: false, adminTitle: '', identityVerified: false, dossierReadVersion: this.data.dossierReadVersion + 1, dossierLoading: false, dossierError: '', dossierStatus: '尚未提交骑手资料', dossierNote: '分次准备，保存后可继续填写。', dossierCount: '0 / 11', dossierParts: [],
      profileVersion: this.data.profileVersion + 1, avatarVersion: this.data.avatarVersion + 1, avatarReadVersion: this.data.avatarReadVersion + 1 });
  },
  async verifyIdentity() {
    const role = mockRole(), version = this.data.profileVersion, lifecycle = this.data.lifecycleVersion, scope = profileEnvironment(), memberId = this.data.member?.id || null;
    if (this.data.loadedScope && this.data.loadedScope !== scope || isMock && this.data.loadedRole && this.data.loadedRole !== role) { this.clearIdentity(); await this.load(); return false; }
    this.setData({ identityVerified: false });
    try {
      const member = await freshIdentity(this, role, version, lifecycle, memberId);
      if (version !== this.data.profileVersion || lifecycle !== this.data.lifecycleVersion || scope !== profileEnvironment()) return false;
      if (isMock && mockRole() !== role || (member?.id || null) !== memberId) { this.clearIdentity(); await this.load(); return false; }
      this.setData({ identityVerified: true, ...accessFor(member) });
      return true;
    } catch (error) {
      if (version === this.data.profileVersion && lifecycle === this.data.lifecycleVersion && scope === profileEnvironment() && (!isMock || mockRole() === role)) { this.clearIdentity(); this.setData({ error: errorMessage(error) }); }
      return false;
    }
  },
  load(): Promise<void> {
    const role = mockRole();
    let promise: Promise<void>;
    promise = this.loadOverview().finally(() => { if (activeLoads.get(this)?.promise === promise) activeLoads.delete(this); });
    activeLoads.set(this, { role, version: this.data.loadVersion, lifecycle: this.data.lifecycleVersion, environment: profileEnvironment(), promise });
    return promise;
  },
  async loadOverview() {
    const role = mockRole(), loadVersion = this.data.loadVersion + 1, lifecycle = this.data.lifecycleVersion, scope = profileEnvironment();
    if (this.data.loadedScope && this.data.loadedScope !== scope || isMock && this.data.loadedRole && this.data.loadedRole !== role) this.clearIdentity();
    this.setData({ loading: true, error: '', identityVerified: false, loadedRole: role, loadedScope: scope, loadVersion,
      avatarReadVersion: this.data.avatarReadVersion + 1, dossierReadVersion: this.data.dossierReadVersion + 1, avatarLoading: false, dossierLoading: false,
      roleLabel: mockRoleLabels[mockRoles.indexOf(role)] || '游客' });
    try {
      const result = await call<ProfileOverview>('profile.overview');
      if (loadVersion !== this.data.loadVersion || lifecycle !== this.data.lifecycleVersion || scope !== profileEnvironment()) return;
      if (isMock && mockRole() !== role) { this.clearIdentity(); await this.load(); return; }
      const member = result.member, changed = (member?.id || null) !== (this.data.member?.id || null);
      if (changed) this.clearIdentity();
      this.setData({ member, contact: result.contact, error: result.contactError, kindLabel: memberKindText(member), memberNumber: member ? memberNumberText(member.memberNumber) : '',
        kindExpiresText: member?.memberKindExpiresAt ? dateText(member.memberKindExpiresAt) : '',
        ...(!this.data.showEdit || changed ? { nickname: member?.nickname || '', nicknameStatus: 'unchanged', nicknameError: '' } : {}),
        ...accessFor(member), identityVerified: true,
        avatarUrl: result.avatarUrl, avatarError: result.avatarError, dossierError: '', loading: false,
        dossierStatus: result.dossier?.status || '尚未提交骑手资料', dossierNote: result.dossier?.note || '分次准备，保存后可继续填写。',
        dossierCount: result.dossier ? `${result.dossier.ready} / ${result.dossier.total}` : '0 / 11', dossierParts: result.dossier?.parts || [] });
    } catch (error) {
      if (loadVersion === this.data.loadVersion && lifecycle === this.data.lifecycleVersion && scope === profileEnvironment() && (!isMock || mockRole() === role)) { this.clearIdentity(); this.setData({ error: errorMessage(error) }); }
    }
    finally { if (loadVersion === this.data.loadVersion && lifecycle === this.data.lifecycleVersion && scope === profileEnvironment() && this.data.loading && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  async loadDossier() {
    if (!await this.verifyIdentity()) return;
    const member = this.data.member;
    if (!member) return;
    await this.readDossier({ member, profileVersion: this.data.profileVersion, loadVersion: this.data.loadVersion, role: mockRole(), lifecycle: this.data.lifecycleVersion, environment: profileEnvironment() });
  },
  async readDossier(snapshot: ProfileReadSnapshot) {
    if (!this.readMatches(snapshot)) return;
    const readVersion = this.data.dossierReadVersion + 1;
    this.setData({ dossierLoading: true, dossierError: '', dossierReadVersion: readVersion });
    try {
      const dossier = await call<MemberDossier>('dossier.mine');
      if (!this.readMatches(snapshot) || readVersion !== this.data.dossierReadVersion) return;
      if (dossier.memberId !== snapshot.member.id) { this.clearIdentity(); this.setData({ error: '当前成员资料已变化，请重新加载' }); return; }
      const progress = profileDossierProgress(dossier);
      this.setData({ dossierStatus: progress.status, dossierNote: progress.note, dossierCount: `${progress.ready} / ${progress.total}`, dossierParts: progress.parts });
    } catch (error) { if (this.readMatches(snapshot) && readVersion === this.data.dossierReadVersion) this.setData({ dossierError: errorMessage(error) }); }
    finally { if (this.readMatches(snapshot) && readVersion === this.data.dossierReadVersion) this.setData({ dossierLoading: false }); }
  },
  async loadAvatar() {
    if (!await this.verifyIdentity()) return;
    const member = this.data.member;
    if (!member?.hasAvatar) return;
    await this.readAvatar({ member, profileVersion: this.data.profileVersion, loadVersion: this.data.loadVersion, role: mockRole(), lifecycle: this.data.lifecycleVersion, environment: profileEnvironment() });
  },
  async readAvatar(snapshot: ProfileReadSnapshot) {
    if (!this.readMatches(snapshot)) return;
    const readVersion = this.data.avatarReadVersion + 1;
    this.setData({ avatarLoading: true, avatarError: '', avatarReadVersion: readVersion });
    try {
      const result = await call<{ url: string | null }>('profile.avatar.get');
      if (!this.readMatches(snapshot) || readVersion !== this.data.avatarReadVersion) return;
      this.setData({ avatarUrl: result.url || '', avatarError: result.url ? '' : '头像暂时无法显示，请重试。' });
    } catch (error) { if (this.readMatches(snapshot) && readVersion === this.data.avatarReadVersion) this.setData({ avatarUrl: '', avatarError: errorMessage(error) }); }
    finally { if (this.readMatches(snapshot) && readVersion === this.data.avatarReadVersion) this.setData({ avatarLoading: false }); }
  },
  retryAvatar() { void this.loadAvatar(); },
  avatarFailed(event: WechatMiniprogram.CustomEvent) {
    const { scope, src } = event.currentTarget.dataset;
    if (scope === 'draft') {
      if (src === this.data.avatarDraftUrl) this.setData({ draftPreviewFailed: true, avatarError: '头像预览未能显示，请重新选择后保存。' });
    } else if (src === this.data.avatarUrl) this.setData({ avatarUrl: '', avatarError: '头像暂时无法显示，请重试。' });
  },
  async chooseAvatar(event: WechatMiniprogram.CustomEvent<{ avatarUrl?: string }>) {
    const path = event.detail.avatarUrl;
    if (!path || this.data.saving || !await this.verifyIdentity()) return;
    const member = this.data.member;
    if (!member || this.data.saving) return;
    const version = this.data.profileVersion, role = mockRole(), avatarVersion = this.data.avatarVersion + 1;
    this.setData({ avatarProcessing: true, avatarVersion, avatarError: '' });
    try {
      const draft = await prepareAvatar(path);
      if (!this.identityMatches(version, member.id, role) || avatarVersion !== this.data.avatarVersion) return;
      this.setData({ avatarDraftUrl: draft.previewUrl, avatarBase64: draft.imageBase64, draftPreviewFailed: false, showEdit: true });
    } catch (error) {
      if (this.identityMatches(version, member.id, role) && avatarVersion === this.data.avatarVersion) this.setData({ avatarError: error instanceof AvatarError ? error.message : errorMessage(error) });
    } finally { if (this.identityMatches(version, member.id, role) && avatarVersion === this.data.avatarVersion) this.setData({ avatarProcessing: false }); }
  },
  avatarChoiceFailed(event: WechatMiniprogram.CustomEvent<{ errMsg?: string }>) {
    if (!/cancel/i.test(event.detail.errMsg || '')) this.setData({ avatarError: '头像选择未完成，请重试。' });
  },
  retry() { void this.load(); },
  edit() {
    const showEdit = !this.data.showEdit;
    this.setData({ showEdit }, () => { if (showEdit) wx.pageScrollTo({ selector: '#profile-editor', duration: 180 }); });
  },
  privacy() { this.setData({ showPrivacy: !this.data.showPrivacy }); },
  nickname(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const nickname = event.detail.value;
    this.setData({ nickname, nicknameStatus: !nickname.trim() || nickname.trim() === this.data.member?.nickname ? 'unchanged' : 'pending', nicknameError: '' });
  },
  nicknameBlur(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const nickname = event.detail.value;
    const rejected = ['rejected', 'timeout'].includes(this.data.nicknameStatus);
    if (nickname !== this.data.nickname && !rejected) this.nickname(event);
    else this.setData({ nickname });
  },
  nicknameReview(event: WechatMiniprogram.CustomEvent<{ pass: boolean; timeout?: boolean }>) {
    const passed = event.detail.pass === true && !event.detail.timeout;
    this.setData({ nicknameStatus: passed ? 'passed' : event.detail.timeout ? 'timeout' : 'rejected',
      nicknameError: passed ? '' : event.detail.timeout ? '昵称检测暂未完成，请重新填写后再保存。' : '这个昵称未通过检测，请换一个称呼。' });
  },
  consent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ consent: event.detail.value.includes('accepted') }); },
  kindReason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ kindReason: event.detail.value }); },
  async save() {
    if (this.data.saving || this.data.avatarProcessing || !await this.verifyIdentity()) return;
    if (this.data.saving || this.data.avatarProcessing) return;
    const original = this.data.member;
    if (!original && !this.data.consent) { toast('请先阅读并同意身份与隐私说明'); return; }
    const nickname = this.data.nickname.trim();
    const nicknameChanged = !!original && !!nickname && nickname !== original.nickname;
    if (original && (['rejected', 'timeout'].includes(this.data.nicknameStatus) || nicknameChanged && this.data.nicknameStatus !== 'passed')) {
      this.setData({ nicknameError: this.data.nicknameError || '请等待昵称检测完成后保存。' }); return;
    }
    if (original && !nicknameChanged && !this.data.avatarBase64) { this.setData({ showEdit: false }); return; }
    const version = this.data.profileVersion + 1, role = mockRole();
    const resultRole = !original && isMock && role === 'guest' ? 'member' : role;
    this.setData({ saving: true, error: '', notice: '', profileVersion: version, loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      const member = original
        ? this.data.avatarBase64
          ? await call<MemberSummary>('profile.avatar.save', { imageBase64: this.data.avatarBase64, ...(nicknameChanged ? { nickname } : {}) }, original.revision)
          : await call<MemberSummary>('profile.update', { nickname }, original.revision)
        : await call<MemberSummary>('identity.ensure', { consentVersions: { privacy: 1, terms: 1 } });
      if (!this.identityMatches(version, original?.id || null, resultRole)) return;
      this.setData({ member, nickname: original ? member.nickname : '', nicknameStatus: 'unchanged', nicknameError: '', kindLabel: memberKindText(member), memberNumber: memberNumberText(member.memberNumber), ...accessFor(member), showEdit: !original,
        avatarBase64: '', avatarDraftUrl: '', draftPreviewFailed: false, avatarUrl: '', loadedRole: resultRole });
      toast(original ? '个人资料已保存' : isMock ? '本地身份已建立' : '已用微信登录');
      const snapshot: ProfileReadSnapshot = { member, profileVersion: version, loadVersion: this.data.loadVersion, role: resultRole, lifecycle: this.data.lifecycleVersion, environment: profileEnvironment() };
      await Promise.all([member.hasAvatar ? this.readAvatar(snapshot) : Promise.resolve(), this.readDossier(snapshot)]);
    } catch (error) {
      if (this.data.profileVersion === version && (!isMock || mockRole() === role || mockRole() === resultRole)) this.setData({ error: errorMessage(error) });
    } finally { if (this.data.profileVersion === version && (!isMock || mockRole() === role || mockRole() === resultRole)) this.setData({ saving: false }); }
  },
  async copyMemberNumber() {
    if (!await this.verifyIdentity() || !this.data.member || memberNumberText(this.data.member.memberNumber) === '待分配') return;
    try { await wx.setClipboardData({ data: memberNumberText(this.data.member.memberNumber) }); toast('成员编号已复制'); }
    catch (error) { toast(errorMessage(error)); }
  },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  trips() { wx.navigateTo({ url: '/pages/mine/index' }); },
  activities() { wx.switchTab({ url: '/pages/activities/index' }); },
  quickMembers() { if (this.data.isOwner) this.members(); else this.ranking(); },
  privacySettings() { this.setData({ showPrivacy: true }); wx.pageScrollTo({ selector: '#profile-privacy', duration: 180 }); },
  staff() { wx.navigateTo({ url: '/pages/staff/index' }); },
  members() { wx.navigateTo({ url: '/pages/staff-members/index' }); },
  ranking() { wx.switchTab({ url: '/pages/ranking/index' }); },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
  dossier() { if (this.data.member) wx.navigateTo({ url: '/pages/dossier/index' }); else { this.setData({ showEdit: true }); wx.pageScrollTo({ selector: '#profile-editor', duration: 180 }); } },
  dossierQueue() { if (this.data.isOwner) wx.navigateTo({ url: '/pages/dossier/index?mode=queue' }); },
  safety() { wx.navigateTo({ url: '/pages/learning/index' }); },
  basicSkills() { wx.navigateTo({ url: '/pages/skills/index?level=basic' }); },
  advancedSkills() { wx.navigateTo({ url: '/pages/skills/index?level=advanced' }); },
  practice() { this.activities(); },
  redemption() { wx.navigateTo({ url: '/pages/redemption/index' }); },
  handbook() { wx.navigateTo({ url: '/pages/club-content/index?section=handbook' }); },
  core() { wx.navigateTo({ url: '/pages/club-content/index?section=core' }); },
  rules() { wx.navigateTo({ url: '/pages/club-content/index?section=points' }); },
  contacts() { wx.navigateTo({ url: '/pages/club-content/index?section=contacts' }); },
  business() { wx.navigateTo({ url: '/pages/club-content/index?section=business' }); },
  clubManagement() { if (this.data.canManageContent) wx.navigateTo({ url: '/pages/club-content/index?mode=manage' }); },
  async requestKind() {
    if (this.data.saving || !await this.verifyIdentity()) return;
    if (!this.data.member || this.data.saving || this.data.member.memberKind === 'founder' || this.data.member.kindRequestStatus === 'pending') return;
    const memberId = this.data.member.id, role = mockRole(), version = this.data.profileVersion;
    if (!await confirm('申请核对成员身份', '主理人将通过既有联系渠道核实。核定前仍按普通成员的参加流程办理，不影响已有活动记录。') || !this.identityMatches(version, memberId, role) || !await this.verifyIdentity()) return;
    this.setData({ saving: true, error: '', loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      await call('identity.memberKind.request', { reason: this.data.kindReason.trim() || '申请核对既有成员身份' });
      if (!this.identityMatches(version, memberId, role)) return;
      this.setData({ notice: '核对申请已提交，请等待主理人处理。', kindReason: '' }); await this.load();
    } catch (error) { if (this.identityMatches(version, memberId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.identityMatches(version, memberId, role)) this.setData({ saving: false }); }
  },
  async recommendation() {
    if (this.data.saving || !await this.verifyIdentity()) return;
    const member = this.data.member;
    if (!member || this.data.saving) return;
    const version = this.data.profileVersion, role = mockRole();
    const next = !member.recommendationOptIn;
    if (next && !await confirm('参加俱乐部推荐', '同意在俱乐部推荐中公开昵称与成员身份。积分与完成次数仅在另外同意积分榜公开后展示。推荐由成员身份和俱乐部编排决定，可以随时退出；退出不影响成员身份。')) return;
    if (!this.identityMatches(version, member.id, role) || !await this.verifyIdentity()) return;
    this.setData({ saving: true, error: '', loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      const updated = await call<MemberSummary>('profile.update', { recommendationOptIn: next, recommendationConsentVersion: next ? 1 : 0 }, member.revision);
      if (!this.identityMatches(version, member.id, role)) return;
      this.setData({ member: updated }); toast(next ? '已同意公开推荐' : '已退出公开推荐');
    } catch (error) { if (this.identityMatches(version, member.id, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.identityMatches(version, member.id, role)) this.setData({ saving: false }); }
  },
  async rankingConsent() {
    if (this.data.saving || !await this.verifyIdentity()) return;
    const member = this.data.member;
    if (!member || this.data.saving) return;
    const version = this.data.profileVersion, role = mockRole();
    const next = !member.rankingOptIn;
    if (next && !await confirm('公开积分与同行记录', '同意在积分榜公开昵称、积分与完成次数。积分榜按实际记录排序；你随时可以退出。此选择与俱乐部推荐分别设置。')) return;
    if (!this.identityMatches(version, member.id, role) || !await this.verifyIdentity()) return;
    this.setData({ saving: true, error: '', loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      const updated = await call<MemberSummary>('profile.update', { rankingOptIn: next, rankingConsentVersion: next ? 1 : 0 }, member.revision);
      if (!this.identityMatches(version, member.id, role)) return;
      this.setData({ member: updated }); toast(next ? '已加入积分榜' : '已退出积分榜');
    } catch (error) { if (this.identityMatches(version, member.id, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.identityMatches(version, member.id, role)) this.setData({ saving: false }); }
  },
  async role(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!isMock) return;
    this.clearIdentity();
    switchMockRole(mockRoles[Number(event.detail.value)]);
    this.setData({ notice: '', consent: false, showEdit: false }); await this.load();
  },
  async reset() {
    if (!isMock || !await confirm('重置本地数据', '将恢复本地活动、成员、核验和积分记录，并清空本地准备清单。')) return;
    try { resetMock(); this.clearIdentity(); this.setData({ notice: '本地数据已重置', consent: false, showEdit: false }); await this.load(); }
    catch (error) { this.setData({ error: error instanceof AvatarError ? error.message : errorMessage(error) }); }
  },
  async deletion() {
    if (this.data.saving || !await this.verifyIdentity()) return;
    const member = this.data.member, originalVersion = this.data.profileVersion, role = mockRole();
    if (!member || this.data.saving || !await confirm('提交注销申请', '将申请停止使用你的俱乐部身份。尚在进行的活动及依法需要保留的业务记录，由组织方核实后处理。') || !this.identityMatches(originalVersion, member.id, role) || !await this.verifyIdentity()) return;
    const version = originalVersion + 1;
    this.setData({ saving: true, error: '', profileVersion: version, loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      await call('identity.delete', { reason: '车友主动提交注销申请' }, member.revision);
      if (!this.identityMatches(version, member.id, role)) return;
      this.clearIdentity();
      this.setData({ kindLabel: '游客', memberNumber: '', staff: false, isOwner: false, canManageContent: false, adminTitle: '', consent: false, notice: '注销申请已提交。已停止受限访问与公开展示，必要记录等待组织方审核处理。' });
    } catch (error) { if (this.identityMatches(version, member.id, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.identityMatches(version, member.id, role)) this.setData({ saving: false }); }
  },
});
