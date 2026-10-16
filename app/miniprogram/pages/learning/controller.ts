import { defineReferencePage } from '../../services/reference-controller';
import { closeReferenceLeaf, markReferenceChanged } from '../../services/reference-ui';
import { ApiError, call, currentMember, errorMessage, isMock, mockRole, runtime, toast } from '../../services/api';
import type { LearningBank, PracticeView, SafetyQuestion } from '../../../../shared/learning-types';
import type { MemberSummary } from '../../../../shared/types';
import { canManagePublicContent } from '../../../../shared/permissions';

interface QuestionDraft { id: string; prompt: string; option0: string; option1: string; option2: string; option3: string; rightIndex: number; explanation: string }
const emptyQuestion = (): QuestionDraft => ({ id: '', prompt: '', option0: '', option1: '', option2: '', option3: '', rightIndex: 0, explanation: '' });
interface Catalog { configured: boolean; title: string; questionCount: number; fixtureOnly: boolean; policyStatus: string }
const environmentScope = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
interface ViewerFence { version: number; memberId: string; role: string; environment: string }
export const controller = defineReferencePage({
  referenceClose() { closeReferenceLeaf(this); },
  data: { embedded: false, isMock, member: null as MemberSummary | null, catalog: null as Catalog | null, practice: null as PracticeView | null,
    displayQuestion: null as PracticeView['question'], feedback: null as (NonNullable<PracticeView['feedback']> & { rightText: string }) | null,
    selectedIndex: -1, optionLabels: ['A', 'B', 'C', 'D'], questionNumber: 1, progress: 0,
    loading: false, busy: false, error: '', notice: '', loadVersion: 0, loadedRole: '', loadedEnvironment: '', autoStartAttempted: false,
    isOwner: false, canManageContent: false, editor: false, bank: null as LearningBank | null, questionLabels: [] as string[],
    draft: emptyQuestion(), reason: '', instructorConfirmed: false,
  },
  onShow() { return this.resume(); },
  onUnload() { this.clearPrivate(); },
  clearPrivate() {
    this.setData({ loadVersion: this.data.loadVersion + 1, loadedRole: '', loadedEnvironment: '', member: null, practice: null, displayQuestion: null, feedback: null,
      selectedIndex: -1, questionNumber: 1, progress: 0, bank: null, questionLabels: [], draft: emptyQuestion(), reason: '',
      instructorConfirmed: false, isOwner: false, canManageContent: false, editor: false, busy: false, loading: false, error: '', notice: '' });
  },
  viewerFence(): ViewerFence { return { version: this.data.loadVersion, memberId: this.data.member?.id || '', role: this.data.loadedRole, environment: this.data.loadedEnvironment }; },
  matches(fence: ViewerFence) {
    return !!fence.memberId && this.data.loadVersion === fence.version && this.data.member?.id === fence.memberId
      && this.data.loadedRole === fence.role && this.data.loadedEnvironment === fence.environment && environmentScope() === fence.environment
      && (!isMock || mockRole() === fence.role);
  },
  async assertViewer(fence: ViewerFence, owner = false) {
    if (this.matches(fence)) {
      const member = await currentMember();
      const owns = !!member?.roles.includes('owner'), manages = canManagePublicContent(member);
      if (this.matches(fence) && member?.id === fence.memberId && owns === this.data.isOwner && manages === this.data.canManageContent) {
        if (owner && !manages) throw new ApiError('FORBIDDEN', '没有题库管理权限');
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
    if (['learning.start', 'learning.answer', 'staff.learning.catalog.save'].includes(action)) markReferenceChanged(this);
    return result;
  },
  async resume() {
    if (this.data.loadedEnvironment && this.data.loadedEnvironment !== environmentScope()) { this.clearPrivate(); await this.load(); return; }
    if (this.data.loadedRole && this.data.loadedRole !== mockRole()) { this.clearPrivate(); await this.load(); return; }
    if (!this.data.member || !this.data.busy && !this.data.editor && !this.data.practice) { await this.load(); return; }
    const fence = this.viewerFence();
    try {
      await this.assertViewer(fence);
    } catch (error) { if (this.matches(fence)) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } }
  },
  localViewer(owner = false) {
    if (this.matches(this.viewerFence()) && (!owner || this.data.canManageContent)) return true;
    this.clearPrivate(); void this.load(); return false;
  },
  async load() {
    if (this.data.loadedRole && this.data.loadedRole !== mockRole()) this.clearPrivate();
    const previousMemberId = this.data.member?.id;
    const version = this.data.loadVersion + 1, role = mockRole(), environment = environmentScope();
    this.setData({ loading: true, busy: false, error: '', loadVersion: version, loadedEnvironment: environment, member: null, practice: null, displayQuestion: null, feedback: null, bank: null, questionLabels: [] });
    try {
      const [catalog, member] = await Promise.all([call<Catalog>('learning.catalog'), currentMember()]);
      if (version !== this.data.loadVersion || environment !== environmentScope() || isMock && mockRole() !== role) return;
      if (previousMemberId && (member?.id !== previousMemberId || !!member.roles.includes('owner') !== this.data.isOwner || canManagePublicContent(member) !== this.data.canManageContent)) { this.clearPrivate(); await this.load(); return; }
      this.setData({ catalog, member, loadedRole: role, isOwner: !!member?.roles.includes('owner'), canManageContent: canManagePublicContent(member), editor: this.data.editor && canManagePublicContent(member),
        ...(!canManagePublicContent(member) ? { bank: null, questionLabels: [], draft: emptyQuestion(), reason: '', instructorConfirmed: false } : {}) });
      if (member) {
        const fence = this.viewerFence();
        // Reuse this load's fresh identity only for its personal read. Practice
        // writes and privileged bank operations keep their verification checks.
        const result = await call<{ attempt: PracticeView | null }>('learning.mine');
        if (!this.matches(fence)) return;
        this.showPractice(result.attempt);
        if (this.data.editor) await this.loadBank();
        if (this.matches(fence) && this.data.embedded && !result.attempt && catalog.configured && !this.data.autoStartAttempted) {
          this.setData({ autoStartAttempted: true });
          await this.start();
        }
      }
    } catch (error) { if (version === this.data.loadVersion && environment === environmentScope() && (!isMock || mockRole() === role)) { this.clearPrivate(); this.setData({ error: errorMessage(error) }); } }
    finally { if (version === this.data.loadVersion && environment === environmentScope() && (!isMock || mockRole() === role)) this.setData({ loading: false }); }
  },
  showPractice(practice: PracticeView | null) {
    this.setData({ practice, displayQuestion: practice?.question ?? null, feedback: null, selectedIndex: -1,
      questionNumber: practice ? Math.min(practice.answeredCount + 1, practice.total) : 1,
      progress: practice ? Math.round(practice.answeredCount / practice.total * 100) : 0 });
  },
  async start() {
    if (this.data.busy || !this.data.member) return;
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '', notice: '' });
    try {
      const practice: PracticeView = await this.verifiedCall(fence, 'learning.start');
      if (this.matches(fence)) this.showPractice(practice);
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  select(event: WechatMiniprogram.TouchEvent) {
    if (this.localViewer() && !this.data.busy && !this.data.feedback) this.setData({ selectedIndex: Number(event.currentTarget.dataset.index) });
  },
  async answer() {
    const practice = this.data.practice, question = this.data.displayQuestion;
    if (!practice || !question || this.data.busy || this.data.feedback) return;
    if (this.data.selectedIndex < 0) { toast('请先选择一个答案'); return; }
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try {
      const updated: PracticeView = await this.verifiedCall(fence, 'learning.answer', { attemptId: practice.id, questionId: question.id, selectedIndex: this.data.selectedIndex }, practice.revision);
      if (!this.matches(fence)) return;
      this.setData({ practice: updated, feedback: updated.feedback ? { ...updated.feedback, rightText: question.options[updated.feedback.rightIndex] } : null,
        progress: Math.round(updated.answeredCount / updated.total * 100) });
      if (!updated.feedback) this.showPractice(updated);
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  next() { if (this.localViewer() && !this.data.busy) this.showPractice(this.data.practice); },
  retry() { void this.load(); },
  profile() { wx.switchTab({ url: '/pages/profile/index' }); },
  skills() { wx.navigateTo({ url: '/pages/skills/index?level=basic' }); },
  async toggleEditor() {
    const fence = this.viewerFence();
    try { await this.assertViewer(fence, true); if (this.matches(fence)) { this.setData({ editor: !this.data.editor }); if (this.data.editor) await this.loadBank(); } }
    catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
  },
  async loadBank() {
    const fence = this.viewerFence();
    try {
      const bank: LearningBank = await this.verifiedCall(fence, 'staff.learning.catalog.get', {}, undefined, true);
      if (!this.matches(fence) || !this.data.canManageContent) return;
      this.setData({ bank, questionLabels: bank.questions.map((question, index) => `${index + 1}. ${question.prompt}`) });
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
  },
  chooseQuestion(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.localViewer(true)) return;
    const question = this.data.bank?.questions[Number(event.detail.value)];
    if (question) this.setData({ draft: { id: question.id, prompt: question.prompt, option0: question.options[0], option1: question.options[1], option2: question.options[2], option3: question.options[3], rightIndex: question.rightIndex, explanation: question.explanation } });
  },
  newQuestion() { if (this.localViewer(true)) this.setData({ draft: emptyQuestion(), reason: '', instructorConfirmed: false }); },
  field(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (!this.localViewer(true)) return;
    const field = String(event.currentTarget.dataset.field);
    if (['id', 'prompt', 'option0', 'option1', 'option2', 'option3', 'explanation'].includes(field)) this.setData({ [`draft.${field}`]: event.detail.value });
    else if (field === 'reason') this.setData({ reason: event.detail.value });
  },
  rightAnswer(event: WechatMiniprogram.CustomEvent<{ value: string }>) { if (this.localViewer(true)) this.setData({ 'draft.rightIndex': Number(event.detail.value) }); },
  instructor(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) { if (this.localViewer(true)) this.setData({ instructorConfirmed: event.detail.value.includes('confirmed') }); },
  async saveQuestion() {
    if (!this.data.bank || this.data.busy) return;
    const draft = this.data.draft;
    const fence = this.viewerFence();
    const question: SafetyQuestion = { id: draft.id.trim(), prompt: draft.prompt.trim(), options: [draft.option0, draft.option1, draft.option2, draft.option3].map(value => value.trim()), rightIndex: draft.rightIndex, explanation: draft.explanation.trim() };
    this.setData({ busy: true, error: '' });
    try {
      await this.verifiedCall(fence, 'staff.learning.catalog.save', { question, published: false, reason: this.data.reason.trim() }, this.data.bank.revision, true);
      if (!this.matches(fence)) return;
      this.setData({ notice: '题目已保存为草稿。核定并发布后，车友才能开始新的练习。' });
      await this.loadBank();
      const catalog = await call<Catalog>('learning.catalog'); if (this.matches(fence)) this.setData({ catalog });
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
  async publish() {
    if (!this.data.bank || this.data.busy) return;
    const fence = this.viewerFence();
    this.setData({ busy: true, error: '' });
    try {
      await this.verifiedCall(fence, 'staff.learning.catalog.save', { published: !this.data.bank.published, instructorConfirmed: this.data.instructorConfirmed, reason: this.data.reason.trim() }, this.data.bank.revision, true);
      if (!this.matches(fence)) return;
      this.setData({ notice: this.data.bank.published ? '已暂停新练习，已开始的记录仍可继续。' : '题库已发布。练习分数不会自动授予活动资格。' });
      await this.loadBank(); const catalog = await call<Catalog>('learning.catalog'); if (this.matches(fence)) this.setData({ catalog });
    } catch (error) { if (this.matches(fence)) this.setData({ error: errorMessage(error) }); }
    finally { if (this.matches(fence)) this.setData({ busy: false }); }
  },
});
