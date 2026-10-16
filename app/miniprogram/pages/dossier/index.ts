import { ApiError, call, confirm, currentMember, errorMessage, isMock, mockRole, toast } from '../../services/api';
import { chooseAndUploadMemberImage, discardMemberMediaDraft, memberMediaDrafts, MemberMediaError, resolveMemberMedia, retryMemberMediaDraft } from '../../services/member-media';
import { DOSSIER_CONSENT_VERSION, emptyDossierDraft } from '../../../../shared/dossier-types';
import type { DossierDraft, DossierGear, DossierQueueItem, MemberDossier } from '../../../../shared/dossier-types';

const gearNames: Record<DossierGear, string> = { helmet: '头盔', armor: '护甲 / 骑行服', knee: '护膝 / 护胫', boots: '越野靴' };
const labels = { draft: '草稿', pending: '等待主理人审核', approved: '本次资料已通过', returned: '请补充后重新提交' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const friendly = (error: unknown) => error instanceof MemberMediaError ? error.message : errorMessage(error);
interface PendingUpload { draftId: string; label: string; gear?: DossierGear; bikeId?: string; part?: 'photoAssetId' | 'tireAssetId'; available?: boolean }
const pendingKey = (id: string) => `oradv-dossier-upload-targets-v1-${id}`;
Page({
  data: {
    isMock, mode: 'own', memberId: '', viewerId: '', loadedRole: '', version: 0, queue: [] as DossierQueueItem[], nextCursor: null as string | null, contactMethods: ['微信', '电话'],
    dossier: null as MemberDossier | null, draft: emptyDossierDraft(), gearRows: [] as { key: DossierGear; name: string; assetId: string | null; url: string; error: string }[],
    bikeRows: [] as (DossierDraft['bikes'][number] & { photoUrl: string; tireUrl: string; photoError: string; tireError: string })[],
    urls: {} as Record<string, string>, photoErrors: {} as Record<string, string>, statusText: '', consent: false, emergencyEnabled: false,
    pendingUploads: [] as PendingUpload[],
    dirty: false, loading: false, saving: false, uploading: false, uploadLabel: '', error: '', notice: '', reviewReason: '', photoCount: 0, photoTotal: 4,
  },
  onLoad(options: Record<string, string>) {
    this.setData({ mode: options.mode === 'review' && options.memberId ? 'review' : options.mode === 'queue' ? 'queue' : 'own', memberId: options.memberId || '' });
  },
  onShow() { return this.resume(); },
  onUnload() { this.setData({ version: this.data.version + 1 }); },
  clearPrivate() {
    this.renderDraft(emptyDossierDraft(), { version: this.data.version + 1, dossier: null, viewerId: '', dirty: false, consent: false,
      urls: {}, photoErrors: {}, queue: [], nextCursor: null, pendingUploads: [], statusText: '', reviewReason: '',
      saving: false, uploading: false, uploadLabel: '', notice: '' });
  },
  async resume() {
    const role = mockRole();
    if (this.data.loadedRole && this.data.loadedRole !== role) { this.clearPrivate(); await this.load(); return; }
    const version = this.data.version, viewerId = this.data.viewerId;
    try {
      const member = await currentMember();
      if (version !== this.data.version || isMock && mockRole() !== role) return;
      if (member?.id !== viewerId || this.data.mode !== 'own' && !member?.roles.includes('owner')) {
        this.clearPrivate(); await this.load(); return;
      }
      // Same-identity foregrounding must preserve both unsaved edits and an
      // in-flight media selection, while identity validation always runs.
      if (!this.data.saving && !this.data.uploading && !this.data.dirty) await this.load();
    } catch (error) { if (version === this.data.version && (!isMock || mockRole() === role)) this.setData({ error: friendly(error) }); }
  },
  async assertViewer() {
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    let valid = !!viewerId && this.data.loadedRole === role;
    if (valid) {
      const member = await currentMember();
      valid = this.matches(version, viewerId, role) && member?.id === viewerId
        && (this.data.mode === 'own' || !!member.roles.includes('owner'));
    }
    if (valid) return;
    if (version === this.data.version) {
      this.clearPrivate(); await this.load();
      this.setData({ error: '当前身份已变化，已停止本次操作，请重新核对资料' });
    }
    throw new ApiError('STALE_IDENTITY', '当前身份已变化，请重新核对资料');
  },
  matches(version: number, viewerId: string, role: string) {
    return this.data.version === version && this.data.viewerId === viewerId && (!isMock || mockRole() === role);
  },
  renderDraft(draft: DossierDraft, extra: Record<string, unknown> = {}) {
    const urls = (extra.urls || this.data.urls) as Record<string, string>;
    const errors = (extra.photoErrors || this.data.photoErrors) as Record<string, string>;
    const gearRows = (Object.keys(gearNames) as DossierGear[]).map(key => ({ key, name: gearNames[key], assetId: draft.gear[key], url: urls[draft.gear[key] || ''] || '', error: errors[draft.gear[key] || ''] || '' }));
    const bikeRows = draft.bikes.map(b => ({ ...b, photoUrl: urls[b.photoAssetId || ''] || '', tireUrl: urls[b.tireAssetId || ''] || '', photoError: errors[b.photoAssetId || ''] || '', tireError: errors[b.tireAssetId || ''] || '' }));
    const all = [...Object.values(draft.gear), ...draft.bikes.flatMap(b => [b.photoAssetId, b.tireAssetId])];
    this.setData({ draft, gearRows, bikeRows, photoCount: all.filter(Boolean).length, photoTotal: all.length, emergencyEnabled: !!draft.emergencyContact, ...extra });
  },
  async load(more = false) {
    const role = mockRole(), version = this.data.version + 1;
    if (this.data.loadedRole && this.data.loadedRole !== role) this.renderDraft(emptyDossierDraft(), { dossier: null, viewerId: '', dirty: false, consent: false, urls: {}, photoErrors: {}, queue: [], pendingUploads: [] });
    this.setData({ loading: true, error: '', version, loadedRole: role });
    try {
      const member = await currentMember();
      if (version !== this.data.version || isMock && mockRole() !== role) return;
      if (!member) { this.renderDraft(emptyDossierDraft(), { dossier: null, viewerId: '', urls: {}, photoErrors: {}, queue: [], pendingUploads: [] }); throw new ApiError('UNAUTHENTICATED', '请先在“我的”建立微信身份，再填写骑手资料'); }
      if (this.data.viewerId && this.data.viewerId !== member.id) this.renderDraft(emptyDossierDraft(), { dossier: null, dirty: false, consent: false, urls: {}, photoErrors: {}, queue: [], pendingUploads: [] });
      this.setData({ viewerId: member.id });
      if (this.data.mode !== 'own' && !member.roles.includes('owner')) { this.setData({ dossier: null, queue: [] }); throw new ApiError('FORBIDDEN', '仅主理人可以查看已提交的资料'); }
      if (this.data.mode === 'queue') {
        const result = await call<{ items: DossierQueueItem[]; nextCursor: string | null }>('staff.dossier.list', more && this.data.nextCursor ? { cursor: this.data.nextCursor } : {});
        if (this.matches(version, member.id, role)) this.setData({ queue: more ? [...this.data.queue, ...result.items] : result.items, nextCursor: result.nextCursor });
        return;
      }
      const dossier = await call<MemberDossier>(this.data.mode === 'review' ? 'staff.dossier.get' : 'dossier.mine', this.data.mode === 'review' ? { memberId: this.data.memberId } : {});
      if (!this.matches(version, member.id, role)) return;
      this.renderDraft(clone(dossier.draft), { dossier, statusText: labels[dossier.status], dirty: false, consent: false, urls: {}, photoErrors: {}, notice: '', reviewReason: '' });
      await Promise.all([this.loadPhotos(), this.data.mode === 'own' ? this.loadPendingUploads() : Promise.resolve()]);
    } catch (error) { if (version === this.data.version && (!isMock || mockRole() === role)) this.setData({ error: friendly(error) }); }
    finally { if (version === this.data.version && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  async loadPhotos() {
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    const ids = [...new Set([...Object.values(this.data.draft.gear), ...this.data.draft.bikes.flatMap(b => [b.photoAssetId, b.tireAssetId])].filter((id): id is string => !!id))];
    const results = await Promise.all(ids.map(async assetId => {
      try { const result = await resolveMemberMedia(assetId); return { assetId, url: result.url, error: result.url ? '' : '照片暂时无法读取，请重试' }; }
      catch (error) { return { assetId, url: '', error: friendly(error) }; }
    }));
    if (!this.matches(version, viewerId, role)) return;
    const urls = { ...this.data.urls }, photoErrors = { ...this.data.photoErrors };
    for (const result of results) { urls[result.assetId] = result.url || ''; photoErrors[result.assetId] = result.error; }
    this.renderDraft(this.data.draft, { urls, photoErrors });
  },
  retry() { void this.load(); },
  more() { if (!this.data.loading && this.data.nextCursor) void this.load(true); },
  reviewMember(event: WechatMiniprogram.CustomEvent) { wx.navigateTo({ url: `/pages/dossier/index?mode=review&memberId=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  updateDraft(draft: DossierDraft) { this.renderDraft(draft, { dirty: true, consent: false, error: '', notice: '' }); },
  async loadPendingUploads() {
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    const drafts = await memberMediaDrafts(), saved = wx.getStorageSync(pendingKey(viewerId));
    if (!this.matches(version, viewerId, role)) return;
    const slots = Array.isArray(saved) ? saved as PendingUpload[] : [];
    const pendingUploads = drafts.filter(d => d.purpose === 'dossier').map(draft => {
      const slot = slots.find(s => s && s.draftId === draft.id);
      const gear = slot?.gear && Object.prototype.hasOwnProperty.call(gearNames, slot.gear) ? slot.gear : undefined;
      const bikeId = slot?.bikeId && this.data.draft.bikes.some(b => b.id === slot.bikeId) ? slot.bikeId : undefined;
      const part = slot?.part === 'photoAssetId' || slot?.part === 'tireAssetId' ? slot.part : undefined;
      return { draftId: draft.id, label: draft.label, ...(gear ? { gear } : {}), ...(bikeId && part ? { bikeId, part } : {}), available: !!gear || !!bikeId && !!part };
    });
    this.setData({ pendingUploads });
  },
  async rememberUpload(draftId: string, slot: PendingUpload) {
    const old = wx.getStorageSync(pendingKey(this.data.viewerId));
    const slots = Array.isArray(old) ? old as PendingUpload[] : [];
    wx.setStorageSync(pendingKey(this.data.viewerId), [...slots.filter(s => s?.draftId !== draftId), { ...slot, draftId }]);
    await this.loadPendingUploads();
  },
  async forgetUpload(draftId: string) {
    const old = wx.getStorageSync(pendingKey(this.data.viewerId));
    if (Array.isArray(old)) wx.setStorageSync(pendingKey(this.data.viewerId), old.filter(s => s?.draftId !== draftId));
    await this.loadPendingUploads();
  },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.mode !== 'own' || this.data.saving) return;
    const name = event.currentTarget.dataset.field;
    if (['riderName', 'ridingExperience', 'contactValue'].includes(name)) this.updateDraft({ ...this.data.draft, [name]: event.detail.value });
  },
  contactMethod(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.mode === 'own' && !this.data.saving) this.updateDraft({ ...this.data.draft, contactMethod: event.detail.value === '1' ? 'phone' : 'wechat' });
  },
  emergency(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) {
    if (this.data.mode !== 'own' || this.data.saving) return;
    this.updateDraft({ ...this.data.draft, emergencyContact: event.detail.value ? { name: '', phone: '', relationship: '' } : null });
  },
  emergencyField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const name = event.currentTarget.dataset.field;
    if (this.data.mode !== 'own' || this.data.saving || !this.data.draft.emergencyContact || !['name', 'phone', 'relationship'].includes(name)) return;
    this.updateDraft({ ...this.data.draft, emergencyContact: { ...this.data.draft.emergencyContact, [name]: event.detail.value } });
  },
  bikeField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.mode !== 'own' || this.data.saving) return;
    const { id, field } = event.currentTarget.dataset;
    if (!['brand', 'model', 'year', 'plate', 'odometerKm'].includes(field)) return;
    const value = field === 'odometerKm' ? event.detail.value.trim() === '' ? null : Number(event.detail.value) : event.detail.value;
    this.updateDraft({ ...this.data.draft, bikes: this.data.draft.bikes.map(b => b.id === id ? { ...b, [field]: value } : b) });
  },
  addBike() {
    if (this.data.mode !== 'own' || this.data.saving) return;
    if (this.data.draft.bikes.length >= 3) { toast('最多保存三辆车'); return; }
    this.updateDraft({ ...this.data.draft, bikes: [...this.data.draft.bikes, { id: `bike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, brand: '', model: '', year: '', plate: '', odometerKm: null, photoAssetId: null, tireAssetId: null }] });
  },
  async removeBike(event: WechatMiniprogram.CustomEvent) {
    if (this.data.mode !== 'own' || this.data.saving || this.data.uploading) return;
    const id = event.currentTarget.dataset.id, version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    if (await confirm('移除这辆车', '只从当前草稿移除。本次资料仍需保存，已提交的审核快照会保留。') && this.matches(version, viewerId, role))
      this.updateDraft({ ...this.data.draft, bikes: this.data.draft.bikes.filter(b => b.id !== id) });
  },
  async upload(event: WechatMiniprogram.CustomEvent) {
    if (this.data.mode !== 'own' || this.data.saving || this.data.uploading || !this.data.dossier) return;
    const { gear, bikeId, part } = event.currentTarget.dataset;
    if (gear && !Object.prototype.hasOwnProperty.call(gearNames, gear) || !gear && (!bikeId || !['photoAssetId', 'tireAssetId'].includes(part))) return;
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    const uploadLabel = gear ? gearNames[gear as DossierGear] : part === 'tireAssetId' ? '轮胎照片' : '车辆照片';
    this.setData({ uploading: true, uploadLabel, error: '' });
    try {
      await this.assertViewer();
      const result = await chooseAndUploadMemberImage('dossier', uploadLabel);
      if (!this.matches(version, viewerId, role)) return;
      const draft = gear ? { ...this.data.draft, gear: { ...this.data.draft.gear, [gear]: result.assetId } }
        : { ...this.data.draft, bikes: this.data.draft.bikes.map(b => b.id === bikeId ? { ...b, [part]: result.assetId } : b) };
      this.renderDraft(draft, { dirty: true, consent: false, urls: { ...this.data.urls, [result.assetId]: result.previewUrl }, error: '', notice: '照片已选择，请保存草稿。提交后由主理人审核。' });
    } catch (error) {
      if (this.matches(version, viewerId, role) && (error as { code?: string })?.code !== 'CANCELLED' && !/cancel/i.test(String((error as { errMsg?: string })?.errMsg || (error as Error)?.message || ''))) {
        this.setData({ error: friendly(error) });
        if (error instanceof MemberMediaError && error.draftId) {
          try { await this.rememberUpload(error.draftId, { draftId: error.draftId, label: uploadLabel, ...(gear ? { gear } : { bikeId, part }) }); }
          catch { if (this.matches(version, viewerId, role)) this.setData({ error: '照片原件已保留，本机待办未能更新，请检查存储后重新打开。' }); }
        }
      }
    } finally { if (this.matches(version, viewerId, role)) this.setData({ uploading: false, uploadLabel: '' }); }
  },
  async retryUpload(event: WechatMiniprogram.CustomEvent) {
    const pending = this.data.pendingUploads.find(item => item.draftId === event.currentTarget.dataset.id);
    if (this.data.mode !== 'own' || this.data.saving || this.data.uploading || !pending?.available) return;
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    this.setData({ uploading: true, uploadLabel: pending.label, error: '' });
    try {
      await this.assertViewer();
      const result = await retryMemberMediaDraft(pending.draftId);
      if (!this.matches(version, viewerId, role)) return;
      const draft = pending.gear ? { ...this.data.draft, gear: { ...this.data.draft.gear, [pending.gear]: result.assetId } }
        : { ...this.data.draft, bikes: this.data.draft.bikes.map(b => b.id === pending.bikeId ? { ...b, [pending.part!]: result.assetId } : b) };
      this.renderDraft(draft, { dirty: true, consent: false, urls: { ...this.data.urls, [result.assetId]: result.previewUrl }, notice: '照片已保存，请保存当前资料草稿。' });
      await this.forgetUpload(pending.draftId);
    } catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: friendly(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ uploading: false, uploadLabel: '' }); }
  },
  async discardUpload(event: WechatMiniprogram.CustomEvent) {
    const draftId = event.currentTarget.dataset.id;
    if (this.data.mode !== 'own' || this.data.saving || this.data.uploading || !this.data.pendingUploads.some(item => item.draftId === draftId)) return;
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    if (!await confirm('移除待传照片', '仅删除这份尚未完成的本机照片副本，不影响已提交的审核资料。') || !this.matches(version, viewerId, role)) return;
    this.setData({ uploading: true, error: '' });
    try { await this.assertViewer(); await discardMemberMediaDraft(draftId); if (this.matches(version, viewerId, role)) await this.forgetUpload(draftId); }
    catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: friendly(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ uploading: false }); }
  },
  photoFailed(event: WechatMiniprogram.CustomEvent) {
    const id = event.currentTarget.dataset.assetId;
    if (id) this.renderDraft(this.data.draft, { photoErrors: { ...this.data.photoErrors, [id]: '照片预览失败，请重新读取或更换照片' } });
  },
  retryPhotos() { void this.loadPhotos(); },
  preview(event: WechatMiniprogram.CustomEvent) {
    const url = this.data.urls[event.currentTarget.dataset.assetId];
    if (url) void wx.previewImage({ current: url, urls: [url] }).catch(error => this.setData({ error: errorMessage(error) }));
  },
  consent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ consent: event.detail.value.includes('accepted') }); },
  async persist() {
    const current = this.data.dossier;
    if (!current) throw new ApiError('INVALID_INPUT', '请先读取资料');
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    await this.assertViewer();
    const result = await call<MemberDossier>('dossier.save', { draft: this.data.draft }, current.revision);
    if (!this.matches(version, viewerId, role)) throw new ApiError('STALE_IDENTITY', '当前身份已改变，请重新打开资料页面');
    this.renderDraft(clone(result.draft), { dossier: result, statusText: labels[result.status], dirty: false });
    return result;
  },
  async save() {
    if (this.data.mode !== 'own' || this.data.saving || this.data.uploading) return;
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    this.setData({ saving: true, error: '', notice: '' });
    try { await this.persist(); if (this.matches(version, viewerId, role)) this.setData({ notice: '草稿已保存，可以稍后继续。' }); }
    catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ saving: false }); }
  },
  async submit() {
    if (this.data.mode !== 'own' || this.data.saving || this.data.uploading) return;
    if (!this.data.consent) { this.setData({ error: '请阅读资料用途并勾选本人提交确认' }); return; }
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    this.setData({ saving: true, error: '', notice: '' });
    try {
      await this.assertViewer();
      const current = this.data.dirty || !this.data.dossier?.revision ? await this.persist() : this.data.dossier;
      if (!this.matches(version, viewerId, role)) return;
      const result = await call<MemberDossier>('dossier.submit', { consent: true, consentVersion: DOSSIER_CONSENT_VERSION }, current!.revision);
      if (!this.matches(version, viewerId, role)) return;
      this.renderDraft(clone(result.draft), { dossier: result, statusText: labels[result.status], dirty: false, consent: false, notice: '资料已提交。只有主理人核对后才会更新审核结论。' });
    } catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ saving: false }); }
  },
  reviewReason(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ reviewReason: event.detail.value }); },
  async review(event: WechatMiniprogram.CustomEvent) {
    const dossier = this.data.dossier;
    if (this.data.mode !== 'review' || !dossier?.submission || this.data.saving) return;
    const decision = event.currentTarget.dataset.decision;
    if (!['approved', 'returned'].includes(decision)) return;
    if (!this.data.reviewReason.trim()) { this.setData({ error: '请填写本次核对说明；退回时需明确补充项目' }); return; }
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    this.setData({ saving: true, error: '' });
    try {
      await this.assertViewer();
      const result = await call<MemberDossier>('staff.dossier.review', { memberId: dossier.memberId, decision, reason: this.data.reviewReason.trim(), submissionRevision: dossier.submission.submissionRevision }, dossier.revision);
      if (!this.matches(version, viewerId, role)) return;
      this.setData({ dossier: result, statusText: labels[result.status], notice: decision === 'approved' ? '本次资料审核已通过；成员权限、积分和考核资格分别管理。' : '已退回，并将补充说明交给成员。' });
    } catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ saving: false }); }
  },
});
