import { call, currentMember, errorMessage, isMock, mockRole, switchMockRole, resetMock, confirm, toast } from '../../services/api';
import { mockRoleLabels, mockRoles, dateText } from '../../services/presentation';
import { emptyContact, contactPerson, memberKindText } from '../../services/member';
import type { ClubContact } from '../../services/member';
import type { MemberSummary } from '../../../../shared/types';
Page({
  data: { isMock, member: null as MemberSummary | null, contact: emptyContact, kindLabel: '游客', memberNumber: '', kindExpiresText: '', nickname: '', consent: false, kindReason: '', roles: mockRoleLabels, roleLabel: '', staff: false, isOwner: false, showPrivacy: false, showEdit: false, loading: false, saving: false, error: '', notice: '' },
  onShow() {
    if (wx.getStorageSync('oradv-open-privacy')) { this.setData({ showPrivacy: true }); wx.setStorageSync('oradv-open-privacy', false); }
    void this.load();
  },
  async load() {
    this.setData({ loading: true, error: '', roleLabel: mockRoleLabels[mockRoles.indexOf(mockRole())] || '游客' });
    try {
      const [member, contact] = await Promise.all([currentMember(), call<ClubContact>('club.public')]);
      this.setData({ member, contact, kindLabel: memberKindText(member), memberNumber: member?.id.slice(-8) || '', kindExpiresText: member?.memberKindExpiresAt ? dateText(member.memberKindExpiresAt) : '', nickname: member?.nickname || '', staff: !!member?.roles?.length, isOwner: !!member?.roles?.includes('owner') });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  retry() { void this.load(); },
  edit() { this.setData({ showEdit: !this.data.showEdit }); },
  privacy() { this.setData({ showPrivacy: !this.data.showPrivacy }); },
  nickname(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ nickname: event.detail.value }); },
  consent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ consent: event.detail.value.includes('accepted') }); },
  kindReason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ kindReason: event.detail.value }); },
  async save() {
    if (this.data.saving) return;
    if (!this.data.member && !this.data.consent) { toast('请先阅读并同意身份与隐私说明'); return; }
    const nickname = this.data.nickname.trim();
    if (this.data.member && !nickname) { toast('昵称不能为空'); return; }
    this.setData({ saving: true, error: '', notice: '' });
    try {
      const member = this.data.member
        ? await call<MemberSummary>('profile.update', { nickname }, this.data.member.revision)
        : await call<MemberSummary>('identity.ensure', { nickname: nickname || undefined, consentVersions: { privacy: 1, terms: 1 } });
      this.setData({ member, nickname: member.nickname, kindLabel: memberKindText(member), memberNumber: member.id.slice(-8), staff: !!member.roles.length, isOwner: member.roles.includes('owner'), showEdit: false });
      toast('身份资料已保存');
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
  async copyMemberNumber() {
    if (!this.data.member || !this.data.memberNumber) return;
    try { await wx.setClipboardData({ data: this.data.memberNumber }); toast('成员编号已复制'); }
    catch (error) { toast(errorMessage(error)); }
  },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  staff() { wx.navigateTo({ url: '/pages/staff/index' }); },
  members() { wx.navigateTo({ url: '/pages/staff-members/index' }); },
  ranking() { wx.switchTab({ url: '/pages/ranking/index' }); },
  contact() { void contactPerson(this.data.contact.contactMethod, this.data.contact.contactValue); },
  async requestKind() {
    if (!this.data.member || this.data.saving || this.data.member.memberKind === 'founder' || this.data.member.kindRequestStatus === 'pending') return;
    if (!await confirm('申请核对成员身份', '主理人将通过既有联系渠道核实。核定前仍按普通成员的参加流程办理，不影响已有活动记录。')) return;
    this.setData({ saving: true, error: '' });
    try {
      await call('identity.memberKind.request', { reason: this.data.kindReason.trim() || '申请核对既有成员身份' });
      this.setData({ notice: '核对申请已提交，请等待主理人处理。', kindReason: '' }); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
  async recommendation() {
    const member = this.data.member;
    if (!member || this.data.saving) return;
    const next = !member.recommendationOptIn;
    if (next && !await confirm('参加俱乐部推荐', '同意在俱乐部推荐中公开昵称与成员身份。积分与完成次数仅在另外同意积分榜公开后展示。推荐由成员身份和俱乐部编排决定，可以随时退出；退出不影响成员身份。')) return;
    this.setData({ saving: true, error: '' });
    try {
      const updated = await call<MemberSummary>('profile.update', { recommendationOptIn: next, recommendationConsentVersion: next ? 1 : 0 }, member.revision);
      this.setData({ member: updated }); toast(next ? '已同意公开推荐' : '已退出公开推荐');
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
  async rankingConsent() {
    const member = this.data.member;
    if (!member || this.data.saving) return;
    const next = !member.rankingOptIn;
    if (next && !await confirm('公开积分与同行记录', '同意在积分榜公开昵称、积分与完成次数。积分榜按实际记录排序；你随时可以退出。此选择与俱乐部推荐分别设置。')) return;
    this.setData({ saving: true, error: '' });
    try {
      const updated = await call<MemberSummary>('profile.update', { rankingOptIn: next, rankingConsentVersion: next ? 1 : 0 }, member.revision);
      this.setData({ member: updated }); toast(next ? '已加入积分榜' : '已退出积分榜');
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
  async role(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!isMock) return;
    switchMockRole(mockRoles[Number(event.detail.value)]);
    this.setData({ notice: '', consent: false, showEdit: false }); await this.load();
  },
  async reset() {
    if (!isMock || !await confirm('重置本机演示', '本机演示会恢复整套虚构活动、成员、核验与积分记录，并清空演示准备清单。只影响本机演示，不修改真实云端或旧版保存的数据。')) return;
    resetMock(); this.setData({ notice: '本机演示已重置', consent: false }); await this.load();
  },
  async deletion() {
    if (!this.data.member || this.data.saving || !await confirm('提交注销申请', '将申请停止使用你的俱乐部身份。尚在进行的活动及依法需要保留的业务记录，由组织方核实后处理。')) return;
    this.setData({ saving: true, error: '' });
    try {
      await call('identity.delete', { reason: '车友主动提交注销申请' }, this.data.member.revision);
      this.setData({ member: null, nickname: '', kindLabel: '游客', memberNumber: '', staff: false, isOwner: false, consent: false, notice: '注销申请已提交。已停止受限访问与公开展示，必要记录等待组织方审核。' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
});
