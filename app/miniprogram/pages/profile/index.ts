import { call, currentMember, errorMessage, isMock, mockRole, switchMockRole, resetMock, confirm, toast } from '../../services/api';
import { mockRoleLabels, mockRoles, dateText } from '../../services/presentation';
import { emptyContact, contactPerson, memberKindText } from '../../services/member';
import type { ClubContact } from '../../services/member';
import type { MemberSummary } from '../../../../shared/types';
import { AvatarError, prepareAvatar } from '../../services/profile-avatar';
import { memberNumberText } from '../../services/member-number';
Page({
  data: {
    isMock, member: null as MemberSummary | null, contact: emptyContact, kindLabel: '游客', memberNumber: '', kindExpiresText: '',
    nickname: '', nicknameStatus: 'unchanged', nicknameError: '', consent: false, kindReason: '', roles: mockRoleLabels, roleLabel: '',
    staff: false, isOwner: false, showPrivacy: false, showEdit: false, loading: false, saving: false, error: '', notice: '',
    avatarUrl: '', avatarDraftUrl: '', avatarBase64: '', avatarError: '', avatarLoading: false, avatarProcessing: false, draftPreviewFailed: false,
    loadVersion: 0, profileVersion: 0, avatarVersion: 0, avatarReadVersion: 0, loadedRole: '',
  },
  onShow() {
    if (wx.getStorageSync('oradv-open-privacy')) { this.setData({ showPrivacy: true }); wx.setStorageSync('oradv-open-privacy', false); }
    if (!this.data.saving) void this.load();
  },
  onUnload() { this.setData({ loadVersion: this.data.loadVersion + 1, profileVersion: this.data.profileVersion + 1, avatarVersion: this.data.avatarVersion + 1 }); },
  identityMatches(version: number, memberId: string | null, role: string) {
    return this.data.profileVersion === version && (this.data.member?.id || null) === memberId && (!isMock || mockRole() === role);
  },
  clearIdentity() {
    this.setData({ member: null, memberNumber: '', nickname: '', nicknameStatus: 'unchanged', nicknameError: '', avatarUrl: '', avatarDraftUrl: '', avatarBase64: '', avatarError: '', avatarLoading: false, avatarProcessing: false, draftPreviewFailed: false, saving: false,
      profileVersion: this.data.profileVersion + 1, avatarVersion: this.data.avatarVersion + 1, avatarReadVersion: this.data.avatarReadVersion + 1 });
  },
  async load() {
    const role = mockRole(), loadVersion = this.data.loadVersion + 1;
    if (isMock && this.data.loadedRole && this.data.loadedRole !== role) this.clearIdentity();
    this.setData({ loading: true, error: '', loadedRole: role, loadVersion, roleLabel: mockRoleLabels[mockRoles.indexOf(role)] || '游客' });
    try {
      const [member, contact] = await Promise.all([currentMember(), call<ClubContact>('club.public')]);
      if (loadVersion !== this.data.loadVersion || isMock && mockRole() !== role) return;
      const changed = (member?.id || null) !== (this.data.member?.id || null);
      if (changed) this.clearIdentity();
      this.setData({ member, contact, kindLabel: memberKindText(member), memberNumber: member ? memberNumberText(member.memberNumber) : '', kindExpiresText: member?.memberKindExpiresAt ? dateText(member.memberKindExpiresAt) : '',
        ...(!this.data.showEdit || changed ? { nickname: member?.nickname || '', nicknameStatus: 'unchanged', nicknameError: '' } : {}),
        staff: !!member?.roles?.length, isOwner: !!member?.roles?.includes('owner') });
      if (member?.hasAvatar && !this.data.avatarUrl) await this.loadAvatar();
      else if (!member?.hasAvatar) this.setData({ avatarUrl: '' });
    } catch (error) { if (loadVersion === this.data.loadVersion && (!isMock || mockRole() === role)) this.setData({ error: errorMessage(error) }); }
    finally { if (loadVersion === this.data.loadVersion && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  async loadAvatar() {
    const member = this.data.member;
    if (!member?.hasAvatar) return;
    const version = this.data.profileVersion, role = mockRole(), readVersion = this.data.avatarReadVersion + 1;
    this.setData({ avatarLoading: true, avatarError: '', avatarReadVersion: readVersion });
    try {
      const result = await call<{ url: string | null }>('profile.avatar.get');
      if (!this.identityMatches(version, member.id, role) || readVersion !== this.data.avatarReadVersion) return;
      this.setData({ avatarUrl: result.url || '', avatarError: result.url ? '' : '头像暂时无法显示，可以重试读取。' });
    } catch (error) { if (this.identityMatches(version, member.id, role) && readVersion === this.data.avatarReadVersion) this.setData({ avatarUrl: '', avatarError: errorMessage(error) }); }
    finally { if (this.identityMatches(version, member.id, role) && readVersion === this.data.avatarReadVersion) this.setData({ avatarLoading: false }); }
  },
  retryAvatar() { void this.loadAvatar(); },
  avatarFailed(event: WechatMiniprogram.CustomEvent) {
    const { scope, src } = event.currentTarget.dataset;
    if (scope === 'draft') {
      if (src === this.data.avatarDraftUrl) this.setData({ draftPreviewFailed: true, avatarError: '头像预览未能显示，请重新选择后保存。' });
    } else if (src === this.data.avatarUrl) this.setData({ avatarUrl: '', avatarError: '头像未能显示，可以重试读取。' });
  },
  async chooseAvatar(event: WechatMiniprogram.CustomEvent<{ avatarUrl?: string }>) {
    const member = this.data.member, path = event.detail.avatarUrl;
    if (!member || !path || this.data.saving) return;
    const version = this.data.profileVersion, role = mockRole(), avatarVersion = this.data.avatarVersion + 1;
    this.setData({ avatarProcessing: true, avatarVersion, avatarError: '' });
    try {
      const draft = await prepareAvatar(path);
      if (!this.identityMatches(version, member.id, role) || avatarVersion !== this.data.avatarVersion) return;
      this.setData({ avatarDraftUrl: draft.previewUrl, avatarBase64: draft.imageBase64, draftPreviewFailed: false });
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
      this.setData({ member, nickname: member.nickname, nicknameStatus: 'unchanged', nicknameError: '', kindLabel: memberKindText(member), memberNumber: memberNumberText(member.memberNumber), staff: !!member.roles.length, isOwner: member.roles.includes('owner'), showEdit: false,
        avatarBase64: '', avatarDraftUrl: '', draftPreviewFailed: false, avatarUrl: '', loadedRole: resultRole });
      toast(original ? '个人资料已保存' : isMock ? '演示身份已建立' : '已用微信登录');
      if (member.hasAvatar) await this.loadAvatar();
    } catch (error) {
      if (this.data.profileVersion === version && (!isMock || mockRole() === role || mockRole() === resultRole)) this.setData({ error: errorMessage(error) });
    } finally { if (this.data.profileVersion === version && (!isMock || mockRole() === role || mockRole() === resultRole)) this.setData({ saving: false }); }
  },
  async copyMemberNumber() {
    if (!this.data.member || memberNumberText(this.data.member.memberNumber) === '待分配') return;
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
  async requestKind() {
    if (!this.data.member || this.data.saving || this.data.member.memberKind === 'founder' || this.data.member.kindRequestStatus === 'pending') return;
    const memberId = this.data.member.id, role = mockRole(), version = this.data.profileVersion;
    if (!await confirm('申请核对成员身份', '主理人将通过既有联系渠道核实。核定前仍按普通成员的参加流程办理，不影响已有活动记录。') || !this.identityMatches(version, memberId, role)) return;
    this.setData({ saving: true, error: '', loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      await call('identity.memberKind.request', { reason: this.data.kindReason.trim() || '申请核对既有成员身份' });
      if (!this.identityMatches(version, memberId, role)) return;
      this.setData({ notice: '核对申请已提交，请等待主理人处理。', kindReason: '' }); await this.load();
    } catch (error) { if (this.identityMatches(version, memberId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.identityMatches(version, memberId, role)) this.setData({ saving: false }); }
  },
  async recommendation() {
    const member = this.data.member;
    if (!member || this.data.saving) return;
    const version = this.data.profileVersion, role = mockRole();
    const next = !member.recommendationOptIn;
    if (next && !await confirm('参加俱乐部推荐', '同意在俱乐部推荐中公开昵称与成员身份。积分与完成次数仅在另外同意积分榜公开后展示。推荐由成员身份和俱乐部编排决定，可以随时退出；退出不影响成员身份。')) return;
    if (!this.identityMatches(version, member.id, role)) return;
    this.setData({ saving: true, error: '', loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      const updated = await call<MemberSummary>('profile.update', { recommendationOptIn: next, recommendationConsentVersion: next ? 1 : 0 }, member.revision);
      if (!this.identityMatches(version, member.id, role)) return;
      this.setData({ member: updated }); toast(next ? '已同意公开推荐' : '已退出公开推荐');
    } catch (error) { if (this.identityMatches(version, member.id, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.identityMatches(version, member.id, role)) this.setData({ saving: false }); }
  },
  async rankingConsent() {
    const member = this.data.member;
    if (!member || this.data.saving) return;
    const version = this.data.profileVersion, role = mockRole();
    const next = !member.rankingOptIn;
    if (next && !await confirm('公开积分与同行记录', '同意在积分榜公开昵称、积分与完成次数。积分榜按实际记录排序；你随时可以退出。此选择与俱乐部推荐分别设置。')) return;
    if (!this.identityMatches(version, member.id, role)) return;
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
    if (!isMock || !await confirm('重置本机演示', '本机演示会恢复整套虚构活动、成员、核验与积分记录，并清空演示准备清单。只影响本机演示，不修改真实云端或旧版保存的数据。')) return;
    try { resetMock(); this.clearIdentity(); this.setData({ notice: '本机演示已重置', consent: false, showEdit: false }); await this.load(); }
    catch (error) { this.setData({ error: error instanceof AvatarError ? error.message : errorMessage(error) }); }
  },
  async deletion() {
    const member = this.data.member, originalVersion = this.data.profileVersion, role = mockRole();
    if (!member || this.data.saving || !await confirm('提交注销申请', '将申请停止使用你的俱乐部身份。尚在进行的活动及依法需要保留的业务记录，由组织方核实后处理。') || !this.identityMatches(originalVersion, member.id, role)) return;
    const version = originalVersion + 1;
    this.setData({ saving: true, error: '', profileVersion: version, loadVersion: this.data.loadVersion + 1, loading: false });
    try {
      await call('identity.delete', { reason: '车友主动提交注销申请' }, member.revision);
      if (!this.identityMatches(version, member.id, role)) return;
      this.clearIdentity();
      this.setData({ kindLabel: '游客', memberNumber: '', staff: false, isOwner: false, consent: false, notice: '注销申请已提交。已停止受限访问与公开展示，必要记录等待组织方审核处理。' });
    } catch (error) { if (this.identityMatches(version, member.id, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.identityMatches(version, member.id, role)) this.setData({ saving: false }); }
  },
});
