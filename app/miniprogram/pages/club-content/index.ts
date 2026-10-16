import { ApiError, call, confirm, currentMember, errorMessage, isMock, mockRole, runtime } from '../../services/api';
import { sha256 } from '../../../../shared/hash';
import { contactPerson, emptyContact } from '../../services/member';
import type { ClubContact } from '../../services/member';
import type { MemberSummary } from '../../../../shared/types';
import type { ClubContentDraft, ClubContentSection, ClubContentView, ClubInquiry, ClubContactItem } from '../../../../shared/club-content-types';

const sections: ClubContentSection[] = ['handbook', 'points', 'core', 'contacts', 'business', 'redemption', 'partners'];
const sectionLabels = ['车队手册', '积分说明', '核心成员与职责', '联系我们', '商务合作', '积分兑换', '合作伙伴'];
const methods: ClubContactItem['method'][] = ['phone', 'wechat', 'address'];
const blank = (section: ClubContentSection): ClubContentDraft => ({ title: sectionLabels[sections.indexOf(section)], introduction: '', blocks: [], people: [], contacts: [], offers: [] });
const editable = (content: ClubContentView): ClubContentDraft => ({ title: content.title, introduction: content.introduction, blocks: content.blocks, people: content.people, contacts: content.contacts, offers: content.offers });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const inquiryKind = (section: string) => section === 'business' || section === 'redemption' ? section : '';
const environmentScope = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
const formScope = (id: string, kind: string) => ({ mode: runtime.mode, appId: runtime.appId, envId: runtime.envId, memberId: id, kind });
const formKey = (id: string, kind: string) => `oradv-club-inquiry-draft-v2-${sha256(JSON.stringify(formScope(id, kind)))}`;
const nonce = () => `inquiry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
interface ContactRow extends Omit<ClubContactItem, 'method'> { method: string; action: string }
interface ContentReadSnapshot { version: number; viewerId: string; role: string; environment: string; isOwner: boolean }
Page({
  data: {
    isMock, section: 'handbook' as ClubContentSection, sectionLabels, sectionIndex: 0, methodLabels: ['电话', '微信', '地址'],
    mode: 'view', content: null as ClubContentView | null, draft: blank('handbook'), primary: emptyContact, contactRows: [] as ContactRow[],
    member: null as MemberSummary | null, isOwner: false, viewerId: '', loadedRole: '', loadedEnvironment: '', version: 0, identityReady: false, editorDirty: false, rights: false,
    inquiries: [] as ClubInquiry[], shownInquiries: [] as ClubInquiry[], nextCursor: null as string | null, replies: {} as Record<string, string>,
    inquiryContact: '', inquiryMessage: '', selectedOffer: '', inquiryConsent: false, submissionId: '', formLocked: false,
    loading: false, busy: false, inquiryLoading: false, error: '', notice: '',
  },
  onLoad(options: Record<string, string>) {
    const section = sections.includes(options.section as ClubContentSection) ? options.section as ClubContentSection : 'handbook';
    this.setData({ section, sectionIndex: sections.indexOf(section), mode: options.mode === 'manage' ? 'manage' : 'view', draft: blank(section) });
  },
  onShow() { void this.resume(); },
  async resume() {
    if (this.data.busy || this.data.editorDirty || Object.values(this.data.replies).some(value => value.trim())) { await this.verifyCurrent(); return; }
    await this.load();
  },
  onUnload() { this.setData({ version: this.data.version + 1, member: null, viewerId: '', inquiries: [], shownInquiries: [], inquiryContact: '', inquiryMessage: '', replies: {} }); },
  matches(version: number, viewerId: string, role: string) { return this.data.version === version && this.data.viewerId === viewerId && this.data.loadedEnvironment === environmentScope() && (!isMock || mockRole() === role); },
  readSnapshot(): ContentReadSnapshot { return { version: this.data.version, viewerId: this.data.viewerId, role: this.data.loadedRole, environment: this.data.loadedEnvironment, isOwner: this.data.isOwner }; },
  readMatches(snapshot: ContentReadSnapshot) {
    if (snapshot.version === this.data.version && this.data.loadedEnvironment !== environmentScope()) {
      this.setData({ version: this.data.version + 1 }); this.clearPrivate(); this.setData({ error: '页面已更新，请重新打开栏目' }); return false;
    }
    return this.matches(snapshot.version, snapshot.viewerId, snapshot.role) && snapshot.environment === this.data.loadedEnvironment && snapshot.isOwner === this.data.isOwner;
  },
  clearPrivate() {
    this.setData({ member: null, isOwner: false, identityReady: false, viewerId: '', inquiries: [], shownInquiries: [], nextCursor: null, replies: {}, busy: false, inquiryLoading: false, loading: false,
      inquiryContact: '', inquiryMessage: '', selectedOffer: '', inquiryConsent: false, submissionId: '', formLocked: false,
      draft: blank(this.data.section), editorDirty: false, rights: false, ...(this.data.mode === 'manage' ? { content: null } : {}) });
  },
  async verifyCurrent() {
    const version = this.data.version, role = mockRole();
    if (this.data.loadedRole && this.data.loadedRole !== role || this.data.loadedEnvironment && this.data.loadedEnvironment !== environmentScope()) {
      this.setData({ version: version + 1 }); this.clearPrivate(); await this.load(); return false;
    }
    this.setData({ identityReady: false });
    try {
      const member = await currentMember();
      if (version !== this.data.version) return false;
      if (isMock && mockRole() !== role) { this.setData({ version: version + 1 }); this.clearPrivate(); await this.load(); return false; }
      if ((member?.id || '') !== this.data.viewerId || this.data.loadedRole !== role || this.data.mode === 'manage' && !member?.roles.includes('owner')) {
        this.setData({ version: version + 1 }); this.clearPrivate(); await this.load(); return false;
      }
      this.setData({ identityReady: true, member, isOwner: !!member?.roles.includes('owner') }); return true;
    } catch (error) {
      if (version === this.data.version && (!isMock || mockRole() === role)) { this.setData({ version: version + 1 }); this.clearPrivate(); this.setData({ error: errorMessage(error) }); }
      return false;
    }
  },
  async load() {
    const version = this.data.version + 1, role = mockRole();
    if (this.data.loadedRole && this.data.loadedRole !== role || this.data.loadedEnvironment && this.data.loadedEnvironment !== environmentScope()) this.clearPrivate();
    this.setData({ version, loadedRole: role, loadedEnvironment: environmentScope(), identityReady: false, loading: true, inquiryLoading: false, error: '' });
    try {
      const member = await currentMember();
      if (version !== this.data.version) return;
      if (isMock && mockRole() !== role || this.data.loadedEnvironment !== environmentScope()) { this.setData({ version: version + 1 }); this.clearPrivate(); await this.load(); return; }
      if (this.data.viewerId !== (member?.id || '')) this.clearPrivate();
      this.setData({ member, viewerId: member?.id || '', identityReady: true, isOwner: !!member?.roles.includes('owner') });
      if (this.data.mode === 'manage' && !member?.roles.includes('owner')) { this.clearPrivate(); throw new ApiError('FORBIDDEN', '仅主理人可以编辑公开栏目和处理咨询'); }
      const snapshot = this.readSnapshot();
      // Initial reads share only this generation's freshly verified identity.
      // The public queue retry still performs its own fresh verification.
      const inquiries = member && (this.data.mode === 'manage' || inquiryKind(this.data.section)) ? this.readInquiries(snapshot) : Promise.resolve();
      const [content, primary] = await Promise.all([
        call<ClubContentView>(this.data.mode === 'manage' ? 'staff.club.content.get' : 'club.content.get', { section: this.data.section }),
        call<ClubContact>('club.public'),
      ]);
      if (!this.readMatches(snapshot)) return;
      this.setData({ content, draft: copy(editable(content)), primary, editorDirty: false, rights: false });
      this.showContacts();
      if (member && this.data.mode === 'view' && inquiryKind(this.data.section)) this.restoreForm();
      await inquiries;
    } catch (error) { if (version === this.data.version && (!isMock || mockRole() === role)) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } }
    finally { if (version === this.data.version && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  showContacts() {
    const primary = this.data.primary, contacts = this.data.content?.contacts || [];
    const rows: ContactRow[] = [];
    if (primary.configured && primary.contactValue) rows.push({ label: '组织方主要联系', name: primary.contactName || primary.name, method: primary.contactMethod, value: primary.contactValue, hours: '', note: primary.contactInstructions, action: primary.contactMethod === 'phone' ? '拨打电话' : '复制联系信息' });
    for (const contact of contacts) {
      const normalized = (value: string, method: string) => method === 'phone' ? value.replace(/[\s()-]/g, '') : value.trim();
      if (!rows.some(row => row.method === contact.method && normalized(row.value, row.method) === normalized(contact.value, contact.method)))
        rows.push({ ...contact, action: contact.method === 'phone' ? '拨打电话' : contact.method === 'address' ? '复制地址' : '复制微信号' });
    }
    this.setData({ contactRows: rows });
  },
  async contact(event: WechatMiniprogram.CustomEvent) {
    const row = this.data.contactRows[Number(event.currentTarget.dataset.index)];
    if (row) await contactPerson(row.method, row.value);
  },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  points() { wx.navigateTo({ url: '/pages/points/index' }); },
  manage() { if (this.data.isOwner) wx.navigateTo({ url: `/pages/club-content/index?mode=manage&section=${this.data.section}` }); },
  publicView() { wx.navigateTo({ url: `/pages/club-content/index?section=${this.data.section}` }); },
  primarySettings() { if (this.data.isOwner) wx.navigateTo({ url: '/pages/staff-members/index' }); },
  retry() { void this.load(); },
  async selectSection(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.busy || this.data.loading) return;
    const section = sections[Number(event.detail.value)];
    if (!section || section === this.data.section) return;
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    if (this.data.editorDirty && (!await confirm('切换栏目', '当前修改尚未保存，切换后会放弃这些修改。') || !this.matches(version, viewerId, role))) return;
    this.setData({ section, sectionIndex: sections.indexOf(section), content: null, draft: blank(section), editorDirty: false, rights: false,
      inquiryContact: '', inquiryMessage: '', selectedOffer: '', inquiryConsent: false, submissionId: '', formLocked: false, inquiries: [], shownInquiries: [], nextCursor: null, notice: '' });
    await this.load();
  },
  editDraft(draft: ClubContentDraft) { this.setData({ draft, editorDirty: true, rights: false, error: '', notice: '' }); },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const field = event.currentTarget.dataset.field;
    if (this.canEdit() && ['title', 'introduction'].includes(field)) this.editDraft({ ...this.data.draft, [field]: event.detail.value });
  },
  addBlock() { if (this.canEdit() && this.data.draft.blocks.length < 8) this.editDraft({ ...this.data.draft, blocks: [...this.data.draft.blocks, { heading: '', body: '' }] }); },
  blockField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const { index, field } = event.currentTarget.dataset;
    if (this.canEdit() && ['heading', 'body'].includes(field)) this.editDraft({ ...this.data.draft, blocks: this.data.draft.blocks.map((row, i) => i === Number(index) ? { ...row, [field]: event.detail.value } : row) });
  },
  addPerson() { if (this.canEdit() && this.data.section === 'core' && this.data.draft.people.length < 8) this.editDraft({ ...this.data.draft, people: [...this.data.draft.people, { name: '', duty: '', introduction: '', responsibilities: [] }] }); },
  personField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const { index, field } = event.currentTarget.dataset;
    if (this.canEdit() && ['name', 'duty', 'introduction'].includes(field)) this.editDraft({ ...this.data.draft, people: this.data.draft.people.map((row, i) => i === Number(index) ? { ...row, [field]: event.detail.value } : row) });
  },
  addResponsibility(event: WechatMiniprogram.CustomEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (this.canEdit() && this.data.draft.people[index]?.responsibilities.length < 6) this.editDraft({ ...this.data.draft, people: this.data.draft.people.map((row, i) => i === index ? { ...row, responsibilities: [...row.responsibilities, ''] } : row) });
  },
  responsibilityField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const { index, responsibility } = event.currentTarget.dataset;
    if (this.canEdit()) this.editDraft({ ...this.data.draft, people: this.data.draft.people.map((row, i) => i === Number(index) ? { ...row, responsibilities: row.responsibilities.map((value, n) => n === Number(responsibility) ? event.detail.value : value) } : row) });
  },
  addContact() { if (this.canEdit() && this.data.section === 'contacts' && this.data.draft.contacts.length < 10) this.editDraft({ ...this.data.draft, contacts: [...this.data.draft.contacts, { label: '', name: '', method: 'wechat', value: '', hours: '', note: '' }] }); },
  contactField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const { index, field } = event.currentTarget.dataset;
    if (this.canEdit() && ['label', 'name', 'value', 'hours', 'note'].includes(field)) this.editDraft({ ...this.data.draft, contacts: this.data.draft.contacts.map((row, i) => i === Number(index) ? { ...row, [field]: event.detail.value } : row) });
  },
  contactMethod(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const index = Number(event.currentTarget.dataset.index), method = methods[Number(event.detail.value)];
    if (this.canEdit() && method) this.editDraft({ ...this.data.draft, contacts: this.data.draft.contacts.map((row, i) => i === index ? { ...row, method } : row) });
  },
  addOffer() { if (this.canEdit() && this.data.section === 'redemption' && this.data.draft.offers.length < 12) this.editDraft({ ...this.data.draft, offers: [...this.data.draft.offers, { id: `offer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: '', description: '' }] }); },
  offerField(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const { index, field } = event.currentTarget.dataset;
    if (this.canEdit() && ['name', 'description'].includes(field)) this.editDraft({ ...this.data.draft, offers: this.data.draft.offers.map((row, i) => i === Number(index) ? { ...row, [field]: event.detail.value } : row) });
  },
  canEdit() { return this.data.mode === 'manage' && this.data.isOwner && this.data.identityReady && this.data.loadedEnvironment === environmentScope() && !this.data.busy && (!isMock || this.data.loadedRole === mockRole()); },
  async removeItem(event: WechatMiniprogram.CustomEvent) {
    const { group, index, responsibility } = event.currentTarget.dataset;
    if (!this.canEdit() || !['blocks', 'people', 'contacts', 'offers', 'responsibility'].includes(group)) return;
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    if (!await confirm('移除这条内容', '仅修改当前表单，保存或发布后才会生效。') || !this.matches(version, viewerId, role)) return;
    const draft = this.data.draft;
    if (group === 'responsibility') this.editDraft({ ...draft, people: draft.people.map((row, i) => i === Number(index) ? { ...row, responsibilities: row.responsibilities.filter((_, n) => n !== Number(responsibility)) } : row) });
    else this.editDraft({ ...draft, [group]: draft[group as 'blocks' | 'people' | 'contacts' | 'offers'].filter((_, i) => i !== Number(index)) });
  },
  publishRights(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ rights: event.detail.value.includes('accepted') }); },
  saveDraft() { return this.saveContent('draft'); },
  publish() { return this.saveContent('published'); },
  async saveContent(status: 'draft' | 'published') {
    if (this.data.mode !== 'manage' || !this.data.isOwner || this.data.busy || !await this.verifyCurrent() || !this.canEdit()) return;
    if (status === 'published' && !this.data.rights) { this.setData({ error: '请确认信息已核实并取得公开所需授权' }); return; }
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    if (status === 'draft' && this.data.content?.status === 'published'
      && (!await confirm('保存为草稿', '这会暂停本栏目的公开展示。准备好后可重新确认授权并发布。') || !this.matches(version, viewerId, role))) return;
    if (!await this.verifyCurrent() || !this.matches(version, viewerId, role)) return;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      const content = await call<ClubContentView>('staff.club.content.save', { section: this.data.section, content: this.data.draft, status, rightsAcknowledged: status === 'published' && this.data.rights }, this.data.content?.revision || 0);
      if (!this.matches(version, viewerId, role)) return;
      this.setData({ content, draft: copy(editable(content)), editorDirty: false, rights: false, notice: status === 'published' ? '栏目已公开发布。' : '草稿已保存，本栏目暂未公开。' }); this.showContacts();
    } catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ busy: false }); }
  },
  restoreForm() {
    const value = wx.getStorageSync(formKey(this.data.viewerId, this.data.section));
    if (value === undefined || value === '') { this.setData({ inquiryContact: '', inquiryMessage: '', selectedOffer: '', submissionId: '', formLocked: false, inquiryConsent: false }); return; }
    const scope = formScope(this.data.viewerId, this.data.section);
    if (!value || typeof value !== 'object' || value.version !== 2 || !value.scope || Object.entries(scope).some(([key, expected]) => value.scope[key] !== expected)
      || typeof value.contact !== 'string' || typeof value.message !== 'string' || typeof value.offerId !== 'string'
      || typeof value.submissionId !== 'string' || typeof value.locked !== 'boolean' || value.contact.length > 100 || value.message.length > 1000)
      throw new ApiError('LOCAL_DRAFT_INVALID', '咨询草稿暂时无法打开，内容已保留，请联系组织方');
    this.setData({ inquiryContact: value.contact, inquiryMessage: value.message, selectedOffer: value.offerId, submissionId: value.submissionId, formLocked: value.locked, inquiryConsent: false });
  },
  persistForm() {
    if (!this.data.viewerId || !inquiryKind(this.data.section)) return;
    if (this.data.loadedEnvironment !== environmentScope()) throw new ApiError('STALE_ENVIRONMENT', '页面已更新，请重新打开咨询');
    wx.setStorageSync(formKey(this.data.viewerId, this.data.section), { version: 2, scope: formScope(this.data.viewerId, this.data.section), contact: this.data.inquiryContact, message: this.data.inquiryMessage, offerId: this.data.selectedOffer, submissionId: this.data.submissionId, locked: this.data.formLocked });
  },
  formField(field: 'inquiryContact' | 'inquiryMessage', value: string) {
    if (this.data.mode !== 'view' || !this.data.member || !this.data.identityReady || this.data.loadedEnvironment !== environmentScope() || this.data.busy || this.data.formLocked || isMock && this.data.loadedRole !== mockRole()) return;
    this.setData({ [field]: value, inquiryConsent: false, error: '' });
    try { this.persistForm(); } catch { this.setData({ error: '咨询草稿暂时无法保存，请检查设备存储后重试。' }); }
  },
  inquiryContact(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.formField('inquiryContact', event.detail.value); },
  inquiryMessage(event: WechatMiniprogram.CustomEvent<{ value: string }>) { this.formField('inquiryMessage', event.detail.value); },
  inquiryConsent(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { this.setData({ inquiryConsent: event.detail.value.includes('accepted') }); },
  selectOffer(event: WechatMiniprogram.CustomEvent) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.member) { this.profile(); return; }
    if (!this.data.identityReady || this.data.loadedEnvironment !== environmentScope() || isMock && this.data.loadedRole !== mockRole() || this.data.busy || this.data.formLocked || !this.data.content?.offers.some(offer => offer.id === id)) return;
    this.setData({ selectedOffer: id, inquiryConsent: false });
    try { this.persistForm(); } catch { this.setData({ error: '咨询草稿暂时无法保存，请检查设备存储后重试。' }); }
  },
  async submitInquiry() {
    if (this.data.mode !== 'view' || this.data.busy || !this.data.member || !inquiryKind(this.data.section) || !await this.verifyCurrent()) return;
    if (!this.data.inquiryConsent) { this.setData({ error: '请同意将本次咨询和所留联系方式交给组织方处理' }); return; }
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    const submissionId = this.data.submissionId || nonce();
    const submittedDraftKey = formKey(viewerId, this.data.section);
    this.setData({ busy: true, error: '', notice: '', submissionId, formLocked: true });
    let sent = false;
    try {
      this.persistForm(); sent = true;
      const result = await call<ClubInquiry>('club.inquiry.submit', { kind: this.data.section, contact: this.data.inquiryContact, message: this.data.inquiryMessage,
        offerId: this.data.selectedOffer, submissionId, consent: true });
      if (!this.matches(version, viewerId, role)) return;
      this.setData({ inquiries: [result, ...this.data.inquiries.filter(item => item.id !== result.id)], inquiryContact: '', inquiryMessage: '', selectedOffer: '', submissionId: '', formLocked: false,
        inquiryConsent: false, notice: '咨询已收到，可在下方查看处理记录。此记录不代表费用、兑换或合作已获确认。' }); this.showInquiries();
      try { wx.removeStorageSync(submittedDraftKey); }
      catch { this.setData({ notice: '咨询已收到，旧草稿暂时无法清除。请勿重复提交，重试会保留原记录。' }); }
    } catch (error) {
      if (!this.matches(version, viewerId, role)) return;
      const knownRejection = !sent || error instanceof ApiError && ['INVALID_INPUT', 'CONSENT_REQUIRED', 'RATE_LIMITED', 'NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code);
      this.setData({ error: errorMessage(error), formLocked: !knownRejection });
      try { this.persistForm(); } catch { this.setData({ error: '暂时无法确认提交结果。请保留当前页面，检查网络和设备存储后重试。' }); }
    } finally { if (this.matches(version, viewerId, role)) this.setData({ busy: false }); }
  },
  showInquiries() { this.setData({ shownInquiries: this.data.mode === 'manage' ? this.data.inquiries : this.data.inquiries.filter(item => item.kind === this.data.section) }); },
  async loadInquiries(append = false) {
    if (!this.data.member || this.data.inquiryLoading || this.data.mode !== 'manage' && !inquiryKind(this.data.section) || !await this.verifyCurrent()) return;
    await this.readInquiries(this.readSnapshot(), append);
  },
  async readInquiries(snapshot: ContentReadSnapshot, append = false) {
    if (!snapshot.viewerId || !this.readMatches(snapshot) || this.data.inquiryLoading) return;
    this.setData({ inquiryLoading: true });
    try {
      const result = await call<{ items: ClubInquiry[]; nextCursor: string | null }>(this.data.mode === 'manage' ? 'staff.club.inquiry.list' : 'club.inquiry.mine', append && this.data.nextCursor ? { cursor: this.data.nextCursor } : {});
      if (!this.readMatches(snapshot)) return;
      this.setData({ inquiries: append ? [...this.data.inquiries, ...result.items.filter(row => !this.data.inquiries.some(item => item.id === row.id))] : result.items, nextCursor: result.nextCursor }); this.showInquiries();
    } catch (error) { if (this.readMatches(snapshot)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.readMatches(snapshot)) this.setData({ inquiryLoading: false }); }
  },
  refreshInquiries() { if (!this.data.busy) void this.loadInquiries(); },
  moreInquiries() { if (!this.data.busy && this.data.nextCursor) void this.loadInquiries(true); },
  async withdrawInquiry(event: WechatMiniprogram.CustomEvent) {
    const row = this.data.inquiries.find(item => item.id === event.currentTarget.dataset.id);
    if (!row || row.state !== 'open' || this.data.mode !== 'view' || this.data.busy || !await this.verifyCurrent()) return;
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    if (!await confirm('撤回这条咨询', '保留提交与撤回记录，组织方将不再按待处理咨询办理。') || !this.matches(version, viewerId, role)) return;
    if (!await this.verifyCurrent() || !this.matches(version, viewerId, role)) return;
    this.setData({ busy: true, error: '' });
    try { const result = await call<ClubInquiry>('club.inquiry.withdraw', { id: row.id }, row.revision); if (this.matches(version, viewerId, role)) { this.setData({ inquiries: this.data.inquiries.map(item => item.id === result.id ? result : item) }); this.showInquiries(); } }
    catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ busy: false }); }
  },
  inquiryReply(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.canEdit()) this.setData({ replies: { ...this.data.replies, [event.currentTarget.dataset.id]: event.detail.value } });
  },
  async reviewInquiry(event: WechatMiniprogram.CustomEvent) {
    const row = this.data.inquiries.find(item => item.id === event.currentTarget.dataset.id), reply = this.data.replies[row?.id || '']?.trim();
    if (!row || row.state !== 'open' || this.data.mode !== 'manage' || !this.data.isOwner || this.data.busy || !await this.verifyCurrent() || !this.canEdit()) return;
    if (!reply) { this.setData({ error: '请填写本次处理说明' }); return; }
    const version = this.data.version, viewerId = this.data.viewerId, role = mockRole();
    this.setData({ busy: true, error: '' });
    try {
      const result = await call<ClubInquiry>('staff.club.inquiry.review', { id: row.id, reply }, row.revision);
      if (!this.matches(version, viewerId, role)) return;
      this.setData({ inquiries: this.data.inquiries.map(item => item.id === result.id ? result : item), replies: { ...this.data.replies, [row.id]: '' } }); this.showInquiries();
    } catch (error) { if (this.matches(version, viewerId, role)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(version, viewerId, role)) this.setData({ busy: false }); }
  },
});
