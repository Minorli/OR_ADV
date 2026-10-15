import { call, currentMember, errorMessage, isMock, confirm, toast } from '../../services/api';
import { registrationCard } from '../../services/presentation';
import type { MemberSummary, PageResult, Registration } from '../../../../shared/types';
const progress: Record<string, string> = { pending_review: '工作人员将核对本场所需资格，通过后进入待联系确认。', waitlisted: '当前不占用名额。出现空位后按顺序重新核对资格，再通知联系确认。', pending_confirmation: '资格与名额已进入确认流程，等待工作人员线下联系。', confirmed: '资格及线下安排已确认。出发前请按约定到场，由工作人员核验。', checked_in: '出发已核验。请按领队安排同行，结束后仍需核验。', pending_settlement: '结束已核验，等待工作人员复核并结算成长记录。', completed: '本场已完成结算，可前往成长记录核对积分流水。', safe_exit: '本场记录为安全退出，不自动获得完成奖励。', no_show: '本场记录为未到，不获得完成奖励。', cancelled: '申请已取消，不能再进行出发核验。', rejected: '本次资格审核未通过。请联系工作人员了解情况。' };
Page({
  data: { isMock, member: null as MemberSummary | null, items: [] as (ReturnType<typeof registrationCard> & { progressText: string })[], nextCursor: null as string | null, loading: false, busy: '', error: '' },
  onShow() { void this.load(); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  async load(append = false) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const member = await currentMember();
      this.setData({ member });
      if (!member) { this.setData({ items: [], nextCursor: null }); return; }
      const result = await call<PageResult<Registration>>('registration.mine', { cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      this.setData({ items: [...(append ? this.data.items : []), ...result.items.map(item => ({ ...registrationCard(item), progressText: (item as Registration & { completionVoided?: boolean }).completionVoided ? '本场原完成记录已复核更正，原始经历保留。积分与有效完成次数以成长流水中的冲正记录为准。' : progress[item.state] || '' }))], nextCursor: result.nextCursor });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  retry() { void this.load(); },
  more() { void this.load(true); },
  explore() { wx.switchTab({ url: '/pages/activities/index' }); },
  profile() { wx.navigateTo({ url: '/pages/profile/index' }); },
  detail(event: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/activity/detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  async cancel(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const registration = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (!registration || !await confirm('取消本次申请', '取消后释放预留名额，并停止后续核验。若已到场或出发，请先联系领队。')) return;
    this.setData({ busy: registration.id, error: '' });
    try {
      await call<Registration>('registration.cancel', { registrationId: registration.id, reason: '车友主动取消申请' }, registration.revision);
      toast('申请已取消'); await this.load();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: '' }); }
  },
});
