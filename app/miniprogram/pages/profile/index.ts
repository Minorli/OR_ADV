import { call, currentMember, errorMessage, isMock, mockRole, switchMockRole, resetMock, confirm, toast } from '../../services/api';
import { mockRoleLabels, mockRoles } from '../../services/presentation';
import type { MemberSummary } from '../../../../shared/types';
Page({
  data: { isMock, member: null as MemberSummary | null, nickname: '', consent: false, roles: mockRoleLabels, roleLabel: '', staff: false, loading: false, saving: false, error: '', notice: '' },
  onShow() { void this.load(); },
  async load() {
    this.setData({ loading: true, error: '', roleLabel: mockRoleLabels[mockRoles.indexOf(mockRole())] || '游客' });
    try {
      const member = await currentMember();
      this.setData({ member, nickname: member?.nickname || '', staff: !!member?.roles?.length });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  retry() { void this.load(); },
  nickname(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ nickname: event.detail.value }); },
  consent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ consent: event.detail.value.includes('accepted') }); },
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
      this.setData({ member, nickname: member.nickname, staff: !!member.roles.length });
      toast('身份资料已保存');
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
  staff() { wx.navigateTo({ url: '/pages/staff/index' }); },
  ranking() { wx.switchTab({ url: '/pages/ranking/index' }); },
  async role(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!isMock) return;
    switchMockRole(mockRoles[Number(event.detail.value)]);
    this.setData({ notice: '', consent: false }); await this.load();
  },
  async reset() {
    if (!isMock || !await confirm('重置本地演练', '所有本地申请、活动修改与核验记录会恢复为初始虚构数据。')) return;
    resetMock(); this.setData({ notice: '本地演练已重置', consent: false }); await this.load();
  },
  async deletion() {
    if (!this.data.member || this.data.saving || !await confirm('提交注销申请', '将申请停止使用你的俱乐部身份。尚在进行的活动及依法需要保留的业务记录，应由组织方核实后处理；注销不直接抹去现场记录。')) return;
    this.setData({ saving: true, error: '' });
    try {
      await call('identity.delete', { reason: '车友主动提交注销申请' }, this.data.member.revision);
      this.setData({ member: null, nickname: '', staff: false, consent: false, notice: '注销申请已提交。已停止受限访问和公开展示；必要业务记录等待组织方审核处理。' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
});
