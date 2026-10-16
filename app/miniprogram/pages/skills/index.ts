import { ApiError, call, currentMember, errorMessage, isMock, mockRole, confirm, toast } from '../../services/api';
import { chooseAndUploadMemberVideo, memberMediaDrafts, MemberMediaError, resolveMemberMedia, retryMemberMediaDraft } from '../../services/member-media';
import type { MemberMediaDraft } from '../../services/member-media';
import type { MemberSummary, PageResult } from '../../../../shared/types';
import type { SkillHistoryEntry, SkillQueueRow, SkillView } from '../../../../shared/learning-types';
import { dateText } from '../../services/presentation';

const message = (error: unknown) => error instanceof MemberMediaError ? error.message : errorMessage(error);
const stateText = (state?: string) => state === 'approved' ? '记录已复核' : state === 'submitted' ? '等待复核' : state === 'changes_requested' ? '请补充记录' : state === 'withdrawn' ? '已撤回' : '尚未提交';
type SkillCard = SkillView & { stateText: string; number: string };
interface ViewerFence { version: number; memberId: string; role: string }
Page({
  data: { isMock, member: null as MemberSummary | null, level: 'basic', items: [] as SkillCard[], visibleItems: [] as SkillCard[],
    approvedCount: 0, submittedCount: 0, selected: null as SkillCard | null, note: '', assetId: '', previewUrl: '', mediaConsent: false,
    drafts: [] as MemberMediaDraft[], isOwner: false, reviewMode: false, queue: [] as SkillQueueRow[], nextCursor: null as string | null,
    reviewTarget: null as SkillQueueRow | null, reviewReason: '', reviewVideoUrl: '',
    referenceEditor: false, referenceTitle: '', referenceUrl: '', referenceReason: '', referenceVerified: false,
    historyItems: [] as (SkillHistoryEntry & { stateText: string; dateText: string })[], historyCursor: null as string | null,
    historyLoaded: false, historyMode: 'own', historyTitle: '', historyMissing: 0, historyVideoUrl: '',
    loading: false, busy: false, error: '', notice: '', loadVersion: 0, loadedRole: '',
  },
  onLoad(options: Record<string, string>) { this.setData({ level: options.level === 'advanced' ? 'advanced' : 'basic', reviewMode: options.mode === 'review' }); },
  onShow() { return this.resume(); },
  onUnload() { this.clearPrivate(); },
  clearPrivate() {
    this.setData({ loadVersion: this.data.loadVersion + 1, loadedRole: '', member: null, items: [], visibleItems: [], approvedCount: 0, submittedCount: 0,
      selected: null, note: '', assetId: '', previewUrl: '', mediaConsent: false, drafts: [], isOwner: false, reviewMode: false,
      queue: [], nextCursor: null, reviewTarget: null, reviewReason: '', reviewVideoUrl: '', referenceEditor: false,
      referenceTitle: '', referenceUrl: '', referenceReason: '', referenceVerified: false, historyItems: [], historyCursor: null,
      historyLoaded: false, historyTitle: '', historyMissing: 0, historyVideoUrl: '', loading: false, busy: false, error: '', notice: '' });
  },
  viewerFence(): ViewerFence { return { version: this.data.loadVersion, memberId: this.data.member?.id || '', role: this.data.loadedRole }; },
  matches(fence: ViewerFence) {
    return !!fence.memberId && this.data.loadVersion === fence.version && this.data.member?.id === fence.memberId
      && this.data.loadedRole === fence.role && (!isMock || mockRole() === fence.role);
  },
  async assertViewer(fence: ViewerFence, owner = false) {
    if (this.matches(fence)) {
      const member = await currentMember(), owns = !!member?.roles.includes('owner');
      if (this.matches(fence) && member?.id === fence.memberId && owns === this.data.isOwner) {
        if (owner && !owns) throw new ApiError('FORBIDDEN', '仅主理人可以复核或维护示范资料');
        return;
      }
    }
    if (fence.version === this.data.loadVersion) {
      this.clearPrivate(); await this.load(); this.setData({ error: '当前身份或权限已变化，已停止本次操作，请重新核对' });
    }
    throw new ApiError('STALE_IDENTITY', '当前身份或权限已变化，请重新核对');
  },
  async verifiedCall(fence: ViewerFence, action: string, payload: Record<string, unknown> = {}, revision?: number, owner = false): Promise<unknown> {
    await this.assertViewer(fence, owner);
    const result = await call(action, payload, revision);
    await this.assertViewer(fence, owner);
    return result;
  },
  async resume() {
    if (this.data.loadedRole && this.data.loadedRole !== mockRole()) { this.clearPrivate(); await this.load(); return; }
    if (!this.data.member) { await this.load(); return; }
    const fence = this.viewerFence();
    try {
      await this.assertViewer(fence);
      if (this.matches(fence) && !this.data.busy && !this.data.selected && !this.data.reviewTarget && !this.data.reviewMode) await this.load();
    } catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
  },
  localViewer(owner = false) {
    if (this.matches(this.viewerFence()) && (!owner || this.data.isOwner)) return true;
    this.clearPrivate(); void this.load(); return false;
  },
  async load() {
    if (this.data.loadedRole && this.data.loadedRole !== mockRole()) this.clearPrivate();
    const previousMemberId = this.data.member?.id;
    const version = this.data.loadVersion + 1, role = mockRole();
    this.setData({ loading: true, busy: false, error: '', loadVersion: version,
      ...(isMock && this.data.loadedRole && this.data.loadedRole !== role ? { member: null, busy: false, items: [], visibleItems: [], selected: null, assetId: '', previewUrl: '', reviewTarget: null, reviewVideoUrl: '', queue: [], drafts: [] } : {}) });
    try {
      const member = await currentMember();
      if (version !== this.data.loadVersion || isMock && mockRole() !== role) return;
      if (previousMemberId && (member?.id !== previousMemberId || !!member.roles.includes('owner') !== this.data.isOwner)) { this.clearPrivate(); await this.load(); return; }
      const changed = this.data.member?.id !== member?.id;
      this.setData({ member, loadedRole: role, isOwner: !!member?.roles.includes('owner'), reviewMode: this.data.reviewMode && !!member?.roles.includes('owner'),
        ...(changed ? { selected: null, assetId: '', previewUrl: '', reviewTarget: null, reviewVideoUrl: '', queue: [], drafts: [] } : {}),
        ...(!member?.roles.includes('owner') ? { queue: [], reviewTarget: null, reviewVideoUrl: '', reviewReason: '' } : {}) });
      if (!member) { this.setData({ items: [], visibleItems: [] }); return; }
      const result: { items: SkillView[] } = await this.verifiedCall(this.viewerFence(), 'skills.mine');
      if (version !== this.data.loadVersion || isMock && mockRole() !== role) return;
      const items = result.items.map((item, index) => ({ ...item, stateText: stateText(item.submission?.state), number: String(index < 5 ? index + 1 : index - 4).padStart(2, '0') }));
      this.setData({ items }); this.filterItems();
      if (this.data.selected) {
        const selected = items.find(item => item.id === this.data.selected?.id) ?? null;
        this.setData({ selected });
      }
      await this.loadDrafts();
      if (this.data.reviewMode) await this.loadQueue();
    } catch (error) { if (version === this.data.loadVersion && (!isMock || mockRole() === role)) this.setData({ error: message(error) }); }
    finally { if (version === this.data.loadVersion && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  filterItems() {
    const visibleItems = this.data.items.filter(item => item.level === this.data.level);
    this.setData({ visibleItems, approvedCount: visibleItems.filter(item => item.submission?.state === 'approved').length,
      submittedCount: visibleItems.filter(item => item.submission?.state === 'submitted').length });
  },
  level(event: WechatMiniprogram.TouchEvent) {
    if (!this.localViewer() || this.data.busy) return;
    this.setData({ level: event.currentTarget.dataset.level === 'advanced' ? 'advanced' : 'basic', selected: null }); this.filterItems();
  },
  open(event: WechatMiniprogram.TouchEvent) {
    const selected = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (!selected || !this.localViewer() || this.data.busy) return;
    this.setData({ selected, note: selected.submission?.note || '', assetId: '', previewUrl: '', mediaConsent: false, referenceEditor: false,
      referenceTitle: selected.reference?.title || '', referenceUrl: selected.reference?.url || '', referenceReason: '', referenceVerified: false,
      historyItems: [], historyCursor: null, historyLoaded: false, historyVideoUrl: '', notice: '' });
  },
  close() { if (this.localViewer() && !this.data.busy) this.setData({ selected: null }); },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.localViewer()) return;
    const field = String(event.currentTarget.dataset.field);
    if (['note', 'reviewReason', 'referenceTitle', 'referenceUrl', 'referenceReason'].includes(field)) this.setData({ [field]: event.detail.value });
  },
  consent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { if (this.localViewer()) this.setData({ mediaConsent: event.detail.value.includes('accepted') }); },
  async loadDrafts() {
    const fence = this.viewerFence();
    try {
      await this.assertViewer(fence); const drafts = await memberMediaDrafts(); await this.assertViewer(fence);
      if (this.matches(fence)) this.setData({ drafts: drafts.filter(draft => draft.purpose === 'skill' && draft.memberId === fence.memberId) });
    } catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
  },
  async upload() {
    if (!this.data.selected || this.data.busy) return;
    if (!this.data.mediaConsent) { toast('请先确认视频来源与使用范围'); return; }
    const fence = this.viewerFence(), skillId = this.data.selected.id;
    this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence);
      const uploaded = await chooseAndUploadMemberVideo('skill', this.data.selected.title);
      await this.assertViewer(fence);
      if (this.matches(fence) && this.data.selected?.id === skillId) this.setData({ assetId: uploaded.assetId, previewUrl: uploaded.previewUrl, notice: '视频已保存，点击提交后进入负责人复核。' });
    } catch (error) { if (this.matches(fence) && !(error instanceof MemberMediaError && error.code === 'CANCELLED')) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) { this.setData({ busy: false }); await this.loadDrafts(); } }
  },
  async retryDraft(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.selected || this.data.busy) return;
    const draft = this.data.drafts.find(item => item.id === event.currentTarget.dataset.id);
    if (!draft || draft.label !== this.data.selected.title) { toast('请先打开与草稿对应的技能项目'); return; }
    const fence = this.viewerFence(), skillId = this.data.selected.id;
    this.setData({ busy: true, error: '' });
    try { await this.assertViewer(fence); const result = await retryMemberMediaDraft(draft.id); await this.assertViewer(fence); if (this.matches(fence) && this.data.selected?.id === skillId) this.setData({ assetId: result.assetId, previewUrl: result.previewUrl }); }
    catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) { this.setData({ busy: false }); await this.loadDrafts(); } }
  },
  async submit() {
    const selected = this.data.selected;
    if (!selected || this.data.busy) return;
    if (!this.data.assetId) { toast('请先保存本人练习视频'); return; }
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try {
      await this.verifiedCall(fence, 'skills.submit', { skillId: selected.id, assetId: this.data.assetId, note: this.data.note.trim() }, selected.submission?.revision ?? 0);
      if (!this.matches(fence)) return;
      this.setData({ assetId: '', previewUrl: '', notice: '练习记录已提交，等待负责人复核。' }); await this.load();
    } catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async viewOwnVideo() {
    const assetId = this.data.selected?.submission?.assetId;
    if (!assetId) return;
    const fence = this.viewerFence();
    try { await this.assertViewer(fence); const resolved = await resolveMemberMedia(assetId); await this.assertViewer(fence); if (this.matches(fence) && this.data.selected?.submission?.assetId === assetId) this.setData({ previewUrl: resolved.url }); }
    catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
  },
  async cancel() {
    const selected = this.data.selected;
    if (!selected?.submission || this.data.busy) return;
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence);
      if (!await confirm('撤回练习记录', '撤回后不再显示为已复核记录。已发生的提交与审核操作仍保留。')) return;
      await this.verifiedCall(fence, 'skills.cancel', { skillId: selected.id, reason: '成员主动撤回本次练习记录' }, selected.submission.revision);
      if (this.matches(fence)) { this.setData({ notice: '练习记录已撤回。' }); await this.load(); }
    }
    catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async toggleReview() {
    const fence = this.viewerFence();
    try { await this.assertViewer(fence, true); if (this.matches(fence)) { this.setData({ reviewMode: !this.data.reviewMode, queue: [], reviewTarget: null, reviewVideoUrl: '' }); if (this.data.reviewMode) await this.loadQueue(); } }
    catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
  },
  async loadQueue(append = false) {
    const fence = this.viewerFence();
    try {
      const result: PageResult<SkillQueueRow> = await this.verifiedCall(fence, 'staff.skills.queue', { cursor: append ? this.data.nextCursor : undefined }, undefined, true);
      if (!this.matches(fence) || !this.data.isOwner || !this.data.reviewMode) return;
      this.setData({ queue: [...(append ? this.data.queue : []), ...result.items], nextCursor: result.nextCursor });
    } catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
  },
  moreQueue() { void this.loadQueue(true); },
  async reviewOpen(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.queue.find(item => item.id === event.currentTarget.dataset.id);
    if (!row || this.data.busy) return;
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(fence, true);
      if (!this.matches(fence)) return;
      this.setData({ reviewTarget: row, reviewReason: '', reviewVideoUrl: '', historyItems: [], historyCursor: null, historyLoaded: false, historyVideoUrl: '' });
      const resolved = await resolveMemberMedia(row.assetId); await this.assertViewer(fence, true);
      if (this.matches(fence) && this.data.reviewTarget?.id === row.id) this.setData({ reviewVideoUrl: resolved.url });
    }
    catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async review(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.reviewTarget;
    if (!row || this.data.busy) return;
    const decision = event.currentTarget.dataset.decision as string;
    if (!this.data.reviewReason.trim()) { toast('请填写复核依据与补充建议'); return; }
    if (!this.data.reviewVideoUrl) { toast('请先打开并核对提交的视频'); return; }
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try { await this.verifiedCall(fence, 'staff.skills.review', { submissionId: row.id, decision, reason: this.data.reviewReason.trim() }, row.revision, true); if (this.matches(fence)) { this.setData({ reviewTarget: null, reviewVideoUrl: '', notice: '复核记录已保存。活动资格仍单独核定。' }); await this.load(); } }
    catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async toggleReference() {
    const fence = this.viewerFence();
    try { await this.assertViewer(fence, true); if (this.matches(fence)) this.setData({ referenceEditor: !this.data.referenceEditor }); }
    catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
  },
  referenceConsent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { if (this.localViewer(true)) this.setData({ referenceVerified: event.detail.value.includes('verified') }); },
  async saveReference() {
    const selected = this.data.selected;
    if (!selected || this.data.busy) return;
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try {
      await this.verifiedCall(fence, 'staff.skills.reference.save', { skillId: selected.id, title: this.data.referenceTitle.trim(), url: this.data.referenceUrl.trim(), verified: this.data.referenceVerified, reason: this.data.referenceReason.trim() }, selected.reference?.revision ?? 0, true);
      if (this.matches(fence)) { this.setData({ notice: '示范资料已更新。' }); await this.load(); }
    } catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  history() { return this.loadHistory(false, false); },
  reviewHistory() { return this.loadHistory(false, true); },
  moreHistory() { return this.loadHistory(true, this.data.historyMode === 'review'); },
  async loadHistory(append: boolean, review: boolean) {
    const skillId = review ? this.data.reviewTarget?.skillId : this.data.selected?.id;
    const memberId = review ? this.data.reviewTarget?.memberId : this.data.member?.id;
    if (!skillId || !memberId || this.data.busy) return;
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try {
      const result: PageResult<SkillHistoryEntry> & { missingCount: number } = await this.verifiedCall(fence,
        review ? 'staff.skills.history' : 'skills.history', { skillId, ...(review ? { memberId } : {}), cursor: append ? this.data.historyCursor : undefined }, undefined, review);
      if (!this.matches(fence)) return;
      this.setData({ historyItems: [...(append ? this.data.historyItems : []), ...result.items.map(item => ({ ...item, stateText: stateText(item.state), dateText: dateText(item.recordedAt) }))],
        historyCursor: result.nextCursor, historyLoaded: true, historyMode: review ? 'review' : 'own',
        historyTitle: review ? `${this.data.reviewTarget?.nickname || '车友'}的历次记录` : '我的历次记录',
        historyMissing: (append ? this.data.historyMissing : 0) + result.missingCount, historyVideoUrl: '' });
    } catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async historyVideo(event: WechatMiniprogram.TouchEvent) {
    const item = this.data.historyItems.find(row => row.historyId === event.currentTarget.dataset.id);
    if (!item || this.data.busy) return;
    const fence = this.viewerFence(), owner = this.data.historyMode === 'review';
    this.setData({ busy: true, error: '' });
    try {
      const resolved: { url: string } = await this.verifiedCall(fence, 'media.get', { assetId: item.assetId }, undefined, owner);
      if (this.matches(fence)) this.setData({ historyVideoUrl: resolved.url });
    } catch (error) { if (this.matches(fence)) this.setData({ error: message(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  videoFailed() { this.setData({ error: '视频暂时无法播放，请检查网络或联系负责人核对文件。' }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  learning() { wx.navigateTo({ url: '/pages/learning/index' }); },
  retry() { void this.load(); },
});
