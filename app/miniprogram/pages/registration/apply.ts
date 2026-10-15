import { call, currentMember, errorMessage, isMock, toast } from '../../services/api';
import { activityCard, registrationStates } from '../../services/presentation';
import type { Activity, MemberSummary, Registration } from '../../../../shared/types';
Page({
  data: { isMock, id: '', activity: null as ReturnType<typeof activityCard> | null, member: null as MemberSummary | null, nickname: '', identityConsent: false, ruleConsent: false, loading: false, submitting: false, error: '', success: '' },
  onLoad(options: Record<string, string>) { this.setData({ id: options.id || '' }); void this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const activity = await call<Activity>('activity.get', { activityId: this.data.id });
      const member = await currentMember();
      this.setData({ activity: activityCard(activity), member, ruleConsent: false });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  retry() { void this.load(); },
  nickname(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ nickname: event.detail.value }); },
  identityConsent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ identityConsent: event.detail.value.includes('accepted') }); },
  ruleConsent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ ruleConsent: event.detail.value.includes('accepted') }); },
  privacy() { wx.navigateTo({ url: '/pages/profile/index?section=privacy' }); },
  mine() { wx.switchTab({ url: '/pages/mine/index' }); },
  async submit() {
    const activity = this.data.activity;
    if (!activity || this.data.submitting || this.data.success) return;
    if (!this.data.ruleConsent) { toast('请先阅读并同意本场规则'); return; }
    if (!this.data.member && !this.data.identityConsent) { toast('请先阅读身份与隐私说明'); return; }
    this.setData({ submitting: true, error: '' });
    try {
      if (!this.data.member) {
        const member = await call<MemberSummary>('identity.ensure', { nickname: this.data.nickname.trim() || undefined, consentVersions: { privacy: 1, terms: 1 } });
        this.setData({ member });
      }
      const registration = await call<Registration>('registration.apply', { activityId: activity.id, acceptedRuleVersion: activity.ruleVersion });
      this.setData({ success: registrationStates[registration.state] || registration.state });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ submitting: false }); }
  },
});
