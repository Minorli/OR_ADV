import { ApiError, call, confirm, currentMember, errorMessage, isMock, mockRole, toast } from '../../services/api';
import { chooseAndUploadMemberImage, resolveMemberMedia } from '../../services/member-media';
import type { ActivityStory, OwnHistoryReview, PublicHistoryDetail, StaffHistoryReview } from '../../../../shared/history-content-types';
import { HISTORY_REVIEW_CONSENT_VERSION } from '../../../../shared/history-content-types';
import type { MemberSummary } from '../../../../shared/types';

const dateText = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '.');
Page({
  data: {
    isMock, activityId: '', manage: false, isOwner: false, member: null as MemberSummary | null,
    detail: null as PublicHistoryDetail | null, own: null as OwnHistoryReview | null, date: '',
    photos: [] as { url: string; label: string }[], documentaryUrl: '', videoError: '', playing: false,
    reviews: [] as (PublicHistoryDetail['reviews']['items'][number] & { starText: string })[], nextCursor: null as string | null,
    stars: 5, starOptions: [1, 2, 3, 4, 5], comment: '', publishConsent: false, nicknameConsent: false, honorConsent: false,
    story: null as ActivityStory | null, intro: '', photoAssetIds: [] as string[], photoUrls: {} as Record<string, string>,
    documentaryInput: '', documentaryTitle: '', filmRights: false, photoRights: false, published: false, reason: '',
    queue: [] as (StaffHistoryReview & { starText: string })[], queueCursor: null as string | null, reviewReasons: {} as Record<string, string>,
    honorChoices: [{ label: '不设置', value: '' }], honor0Index: 0, honor1Index: 0, honor0Label: '', honor1Label: '',
    loading: false, busy: false, dirty: false, error: '', notice: '', loadVersion: 0,
  },
  onLoad(options: Record<string, string>) { this.setData({ activityId: options.activityId || options.id || '', manage: options.mode === 'manage' }); },
  onShow() { return this.resume(); },
  onUnload() { this.clearPrivate(); this.setData({ documentaryUrl: '', playing: false }); },
  async onPullDownRefresh() { await this.load(); wx.stopPullDownRefresh(); },
  valid(version: number, role: string) {
    if (version !== this.data.loadVersion) return false;
    if (isMock && role !== mockRole()) {
      this.clearPrivate();
      return false;
    }
    return true;
  },
  clearPrivate() {
    this.setData({ loadVersion: this.data.loadVersion + 1, member: null, isOwner: false, own: null, story: null, queue: [], photoUrls: {}, photoAssetIds: [],
      loading: false, busy: false, dirty: false, comment: '', stars: 5, intro: '', documentaryInput: '', documentaryTitle: '', reason: '', reviewReasons: {}, queueCursor: null,
      publishConsent: false, nicknameConsent: false, honorConsent: false, photoRights: false, filmRights: false, published: false, honor0Label: '', honor1Label: '',
      honorChoices: [{ label: '不设置', value: '' }], honor0Index: 0, honor1Index: 0 });
  },
  async assertViewer(owner = false) {
    const version = this.data.loadVersion, role = mockRole(), id = this.data.member?.id;
    const member = await currentMember();
    if (this.valid(version, role) && id && member?.id === id && (!owner || member.roles.includes('owner'))) return;
    if (version === this.data.loadVersion) { this.clearPrivate(); this.setData({ error: '当前身份已变化，已停止本次操作，请重新打开记录' }); }
    throw new ApiError('STALE_IDENTITY', '当前身份已变化，已停止本次操作，请重新打开记录');
  },
  async resume() {
    const version = this.data.loadVersion, role = mockRole(), id = this.data.member?.id ?? null;
    try {
      const member = await currentMember();
      if (!this.valid(version, role)) { await this.load(); return; }
      if ((member?.id ?? null) !== id || this.data.manage && !member?.roles.includes('owner')) { this.clearPrivate(); await this.load(); return; }
      if (!this.data.busy && !this.data.dirty) await this.load();
    } catch (error) { if (this.valid(version, role)) this.setData({ error: errorMessage(error) }); }
  },
  async load() {
    const version = this.data.loadVersion + 1, role = mockRole();
    this.setData({ loadVersion: version, loading: true, busy: false, dirty: false, isOwner: false, error: '', detail: null, member: null, own: null, queue: [], story: null, photos: [], reviews: [], documentaryUrl: '', playing: false, photoUrls: {}, comment: '', publishConsent: false, nicknameConsent: false, honorConsent: false });
    try {
      const [detail, member] = await Promise.all([call<PublicHistoryDetail>('history.detail', { activityId: this.data.activityId }), currentMember()]);
      if (!this.valid(version, role)) return;
      const isOwner = !!member?.roles.includes('owner');
      this.setData({ detail, member, isOwner, date: dateText(detail.activity.endAt), photos: detail.story?.photos ?? [], documentaryUrl: detail.story?.documentary?.url ?? '', videoError: '',
        reviews: detail.reviews.items.map(row => ({ ...row, starText: '★'.repeat(row.stars) + '☆'.repeat(5 - row.stars) })), nextCursor: detail.reviews.nextCursor });
      if (member) {
        const own = await call<OwnHistoryReview>('history.review.mine', { activityId: this.data.activityId });
        if (!this.valid(version, role)) return;
        await this.assertViewer();
        if (!this.valid(version, role)) return;
        this.setData({ own, stars: own.review?.stars ?? 5, comment: own.review?.comment ?? '',
          publishConsent: own.review?.publishConsent ?? false, nicknameConsent: own.review?.nicknameConsent ?? false, honorConsent: own.review?.honorConsent ?? false });
      }
      if (this.data.manage) {
        if (!isOwner) throw new Error('仅主理人可以编辑本场回顾');
        await this.loadManage(version, role);
      }
    } catch (error) { if (this.valid(version, role)) this.setData({ error: error instanceof Error ? error.message : errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ loading: false }); }
  },
  async loadManage(version?: number, role?: string) {
    version = version ?? this.data.loadVersion; role = role ?? mockRole();
    if (!this.valid(version, role)) return;
    await this.assertViewer(true);
    if (!this.valid(version, role)) return;
    const [story, result] = await Promise.all([call<ActivityStory>('staff.history.get', { activityId: this.data.activityId }), call<{ items: StaffHistoryReview[]; nextCursor: string | null }>('staff.history.reviews', { activityId: this.data.activityId })]);
    if (!this.valid(version, role)) return;
    await this.assertViewer(true);
    if (!this.valid(version, role)) return;
    this.setData({ story, intro: story.intro, photoAssetIds: story.photoAssetIds, documentaryInput: story.documentaryUrl, documentaryTitle: story.documentaryTitle,
      filmRights: story.videoRightsAcknowledged, published: story.published, reason: '', queue: result.items.map(row => ({ ...row, starText: '★'.repeat(row.stars) + '☆'.repeat(5 - row.stars) })), queueCursor: result.nextCursor,
      honor0Label: story.honors[0]?.label ?? '', honor1Label: story.honors[1]?.label ?? '' });
    this.honorOptions();
    const urls: Record<string, string> = {};
    for (const assetId of story.photoAssetIds) {
      try { urls[assetId] = (await resolveMemberMedia(assetId)).url; }
      catch { urls[assetId] = ''; }
      if (!this.valid(version, role)) return;
    }
    await this.assertViewer(true);
    this.setData({ photoUrls: urls });
  },
  honorOptions() {
    const choices = [{ label: '不设置', value: '' }, ...this.data.queue.filter(row => row.status === 'approved' && row.honorConsent).map(row => ({ label: row.nickname, value: row.publicId }))];
    for (const honor of this.data.story?.honors ?? []) if (!choices.some(row => row.value === honor.reviewPublicId)) choices.push({ label: '已保存的作者', value: honor.reviewPublicId });
    this.setData({ honorChoices: choices, honor0Index: Math.max(0, choices.findIndex(row => row.value === this.data.story?.honors[0]?.reviewPublicId)),
      honor1Index: Math.max(0, choices.findIndex(row => row.value === this.data.story?.honors[1]?.reviewPublicId)) });
  },
  async moreReviews() {
    if (!this.data.nextCursor || this.data.busy) return;
    const version = this.data.loadVersion, role = mockRole(); this.setData({ busy: true, error: '' });
    try {
      const detail = await call<PublicHistoryDetail>('history.detail', { activityId: this.data.activityId, cursor: this.data.nextCursor });
      if (!this.valid(version, role)) return;
      const rows = [...this.data.reviews, ...detail.reviews.items.map(row => ({ ...row, starText: '★'.repeat(row.stars) + '☆'.repeat(5 - row.stars) }))];
      this.setData({ reviews: [...new Map(rows.map(row => [row.publicId, row])).values()], nextCursor: detail.reviews.nextCursor });
    } catch (error) { if (this.valid(version, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ busy: false }); }
  },
  async moreQueue() {
    if (!this.data.queueCursor || this.data.busy || !this.data.isOwner) return;
    const version = this.data.loadVersion, role = mockRole(); this.setData({ busy: true });
    try {
      await this.assertViewer(true);
      if (!this.valid(version, role)) return;
      const result = await call<{ items: StaffHistoryReview[]; nextCursor: string | null }>('staff.history.reviews', { activityId: this.data.activityId, cursor: this.data.queueCursor });
      if (!this.valid(version, role)) return;
      await this.assertViewer(true);
      if (!this.valid(version, role)) return;
      this.setData({ queue: [...this.data.queue, ...result.items.map(row => ({ ...row, starText: '★'.repeat(row.stars) + '☆'.repeat(5 - row.stars) }))], queueCursor: result.nextCursor }); this.honorOptions();
    } catch (error) { if (this.valid(version, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ busy: false }); }
  },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const name = String(event.currentTarget.dataset.field);
    if (['comment', 'intro', 'documentaryInput', 'documentaryTitle', 'reason', 'honor0Label', 'honor1Label'].includes(name)) this.setData({ [name]: event.detail.value, dirty: true });
  },
  consent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    this.setData({ publishConsent: event.detail.value.includes('publish'), nicknameConsent: event.detail.value.includes('nickname'), honorConsent: event.detail.value.includes('honor'), dirty: true });
  },
  chooseStars(event: WechatMiniprogram.TouchEvent) { this.setData({ stars: Number(event.currentTarget.dataset.stars), dirty: true }); },
  rights(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ photoRights: event.detail.value.includes('photos'), filmRights: event.detail.value.includes('film'), dirty: true }); },
  visibility(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) { this.setData({ published: event.detail.value, dirty: true }); },
  honor(event: WechatMiniprogram.CustomEvent<{ value: string }>) { const slot = Number(event.currentTarget.dataset.slot); if (slot === 0 || slot === 1) this.setData({ [`honor${slot}Index`]: Number(event.detail.value), dirty: true }); },
  reviewReason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ reviewReasons: { ...this.data.reviewReasons, [event.currentTarget.dataset.id]: event.detail.value }, dirty: true }); },
  async saveReview() {
    if (this.data.busy || !this.data.member || !this.data.own?.eligible) return;
    if (!this.data.publishConsent || !this.data.nicknameConsent) { this.setData({ error: '请分别确认公开评价与昵称的说明' }); return; }
    const version = this.data.loadVersion, role = mockRole(); this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer();
      if (!this.valid(version, role)) return;
      await call('history.review.save', { activityId: this.data.activityId, stars: this.data.stars, comment: this.data.comment,
        publishConsent: true, nicknameConsent: true, honorConsent: this.data.honorConsent, consentVersion: HISTORY_REVIEW_CONSENT_VERSION }, this.data.own.revision);
      if (!this.valid(version, role)) return;
      await this.load(); this.setData({ notice: '评价已交给主理人核对，发布后才会展示。' });
    } catch (error) { if (this.valid(version, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ busy: false }); }
  },
  async withdraw() {
    if (!this.data.own?.review || this.data.busy || !await confirm('撤回公开评价', '评价与相关荣誉将停止后续公开展示。')) return;
    const version = this.data.loadVersion, role = mockRole(); this.setData({ busy: true, error: '' });
    try { await this.assertViewer(); if (!this.valid(version, role)) return; await call('history.review.withdraw', { activityId: this.data.activityId }, this.data.own!.revision); if (this.valid(version, role)) { await this.load(); this.setData({ notice: '评价已撤回。' }); } }
    catch (error) { if (this.valid(version, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ busy: false }); }
  },
  async uploadPhoto() {
    if (!this.data.isOwner || this.data.busy) return;
    if (!this.data.photoRights) { toast('请先确认图片公开使用权'); return; }
    if (this.data.photoAssetIds.length >= 12) { toast('每场最多12张图片'); return; }
    const version = this.data.loadVersion, role = mockRole(); this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(true);
      if (!this.valid(version, role)) return;
      const asset = await chooseAndUploadMemberImage('club_public', '本场活动影像', true);
      if (!this.valid(version, role)) return;
      await this.assertViewer(true);
      if (!this.valid(version, role)) return;
      this.setData({ photoAssetIds: [...this.data.photoAssetIds, asset.assetId], photoUrls: { ...this.data.photoUrls, [asset.assetId]: asset.previewUrl }, dirty: true });
    } catch (error) { if (this.valid(version, role) && !/cancel/i.test(String((error as { errMsg?: string })?.errMsg))) this.setData({ error: error instanceof Error ? error.message : errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ busy: false }); }
  },
  removePhoto(event: WechatMiniprogram.TouchEvent) { this.setData({ photoAssetIds: this.data.photoAssetIds.filter(id => id !== event.currentTarget.dataset.id), dirty: true }); },
  async saveStory() {
    if (!this.data.story || this.data.busy || !this.data.isOwner) return;
    const version = this.data.loadVersion, role = mockRole(), choices = this.data.honorChoices;
    const honors = [0, 1].flatMap(slot => {
      const index = slot === 0 ? this.data.honor0Index : this.data.honor1Index, label = slot === 0 ? this.data.honor0Label : this.data.honor1Label, selected = choices[index];
      return selected?.value ? [{ reviewPublicId: selected.value, label }] : [];
    });
    this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(true);
      if (!this.valid(version, role)) return;
      await call('staff.history.save', { activityId: this.data.activityId, intro: this.data.intro, photoAssetIds: this.data.photoAssetIds, documentaryUrl: this.data.documentaryInput,
        documentaryTitle: this.data.documentaryTitle, videoRightsAcknowledged: this.data.filmRights, published: this.data.published, reason: this.data.reason, honors }, this.data.story.revision);
      if (this.valid(version, role)) { await this.load(); this.setData({ notice: '本场回顾已保存。' }); }
    } catch (error) { if (this.valid(version, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ busy: false }); }
  },
  async moderate(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.queue.find(item => item.id === event.currentTarget.dataset.id);
    if (!row || this.data.busy || !this.data.isOwner) return;
    const version = this.data.loadVersion, role = mockRole(); this.setData({ busy: true, error: '' });
    try {
      await this.assertViewer(true);
      if (!this.valid(version, role)) return;
      await call('staff.history.review', { activityId: this.data.activityId, reviewId: row.id, decision: event.currentTarget.dataset.decision, reason: this.data.reviewReasons[row.id] ?? '' }, row.revision);
      if (this.valid(version, role)) { await this.loadManage(); this.setData({ notice: '评价处理结果已保存。' }); }
    } catch (error) { if (this.valid(version, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.valid(version, role)) this.setData({ busy: false }); }
  },
  preview(event: WechatMiniprogram.TouchEvent) { const url = event.currentTarget.dataset.url; if (this.data.photos.some(row => row.url === url)) void wx.previewImage({ current: url, urls: this.data.photos.map(row => row.url) }); },
  photoFailed(event: WechatMiniprogram.CustomEvent) { this.setData({ photos: this.data.photos.filter(row => row.url !== event.currentTarget.dataset.url) }); },
  videoFailed() { this.setData({ documentaryUrl: '', playing: false, videoError: '影片暂时无法播放，请稍后刷新。' }); },
  videoPlaying() { if (this.data.documentaryUrl) this.setData({ playing: true }); },
  videoStopped() { this.setData({ playing: false }); },
  manage() { wx.navigateTo({ url: `/pages/history-detail/index?activityId=${encodeURIComponent(this.data.activityId)}&mode=manage` }); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  retry() { void this.load(); },
});
