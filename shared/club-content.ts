import { Context, encodeCursor, parseCursor } from './context';
import { requireThat, text } from './errors';
import { key } from './models';
import { sha256 } from './hash';
import { PUBLIC_CONTENT_ROLES } from './permissions';
import { starterClubContent } from './club-content-starters';
import type { ClubContentDraft, ClubContentDocument, ClubContentSection, ClubContentView, ClubInquiry } from './club-content-types';

export const CLUB_CONTENT_ACTIONS = ['club.content.get', 'staff.club.content.get', 'staff.club.content.save', 'club.inquiry.submit', 'club.inquiry.mine', 'club.inquiry.withdraw', 'staff.club.inquiry.list', 'staff.club.inquiry.review'] as const;
export const CONTENT_TITLES: Record<ClubContentSection, string> = { handbook: '车队手册', points: '积分说明', core: '核心成员与职责', contacts: '联系我们', business: '商务合作', redemption: '积分兑换', partners: '合作伙伴' };
function section(value: unknown): ClubContentSection {
  requireThat(typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONTENT_TITLES, value), 'INVALID_INPUT', '请选择有效栏目');
  return value as ClubContentSection;
}
function object(value: unknown): Record<string, unknown> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', '内容格式不正确');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  requireThat(Object.keys(value).every(name => allowed.includes(name)), 'INVALID_INPUT', '内容包含不支持的字段');
}
function optional(value: unknown, label: string, max: number): string { return value === undefined || value === '' ? '' : text(value, label, max); }
function array<T>(value: unknown, max: number, read: (row: unknown) => T): T[] {
  requireThat(Array.isArray(value) && value.length <= max, 'INVALID_INPUT', '内容条目过多或格式不正确');
  return value.map(read);
}
export function emptyClubContent(selected: ClubContentSection): ClubContentDraft {
  return { title: CONTENT_TITLES[selected], introduction: '', blocks: [], people: [], contacts: [], offers: [] };
}
export function validateClubContent(value: unknown, selected: ClubContentSection): ClubContentDraft {
  const p = object(value);
  fields(p, ['title', 'introduction', 'blocks', 'people', 'contacts', 'offers']);
  const blocks = array(p.blocks, 8, value => {
    const row = object(value); fields(row, ['heading', 'body']);
    return { heading: text(row.heading, '段落标题', 50), body: text(row.body, '段落内容', 600) };
  });
  const people = array(p.people, 8, value => {
    const row = object(value); fields(row, ['name', 'duty', 'introduction', 'responsibilities']);
    return { name: text(row.name, '公开称呼', 30), duty: text(row.duty, '职责称谓', 40), introduction: optional(row.introduction, '介绍', 200), responsibilities: array(row.responsibilities, 6, item => text(item, '职责说明', 150)) };
  });
  const contacts = array(p.contacts, 10, value => {
    const row = object(value); fields(row, ['label', 'name', 'method', 'value', 'hours', 'note']);
    requireThat(['phone', 'wechat', 'address'].includes(String(row.method)), 'INVALID_INPUT', '请选择联系办法');
    const valueText = text(row.value, '联系信息', 200);
    if (row.method === 'phone') requireThat(/^\+?\d{5,20}$/.test(valueText.replace(/[\s()-]/g, '')), 'INVALID_INPUT', '请输入可拨打的电话');
    return { label: text(row.label, '联系类别', 40), name: optional(row.name, '联系人', 30), method: row.method as 'phone' | 'wechat' | 'address', value: valueText, hours: optional(row.hours, '服务时间', 80), note: optional(row.note, '联系说明', 200) };
  });
  const offers = array(p.offers, 12, value => {
    const row = object(value); fields(row, ['id', 'name', 'description']);
    const id = text(row.id, '项目标识', 50);
    requireThat(/^[a-zA-Z0-9_-]+$/.test(id), 'INVALID_INPUT', '项目标识不正确');
    return { id, name: text(row.name, '兑换项目名称', 60), description: text(row.description, '项目说明', 300) };
  });
  requireThat(new Set(offers.map(item => item.id)).size === offers.length, 'INVALID_INPUT', '兑换项目标识不能重复');
  requireThat(!people.length || selected === 'core', 'INVALID_INPUT', '成员职责应保存到核心成员栏目');
  requireThat(!contacts.length || selected === 'contacts', 'INVALID_INPUT', '联系信息应保存到联系栏目');
  requireThat(!offers.length || selected === 'redemption', 'INVALID_INPUT', '兑换项目应保存到兑换栏目');
  return { title: text(p.title, '栏目标题', 60), introduction: optional(p.introduction, '栏目介绍', 400), blocks, people, contacts, offers };
}
function view(row: ClubContentDocument | null, selected: ClubContentSection, staff: boolean): ClubContentView {
  const visible = row?.section === selected && (staff || row.status === 'published');
  return { ...(visible ? { title: row!.title, introduction: row!.introduction, blocks: row!.blocks, people: row!.people, contacts: row!.contacts, offers: row!.offers } : emptyClubContent(selected)), section: selected,
    configured: !!(row?.status === 'published'), revision: visible ? row!.revision : 0, status: visible ? row!.status : 'unconfigured', updatedAt: visible ? row!.updatedAt : '' };
}
export async function getClubContent(ctx: Context, staff = false): Promise<ClubContentView> {
  fields(ctx.request.payload, ['section']);
  const selected = section(ctx.request.payload.section);
  return ctx.store.transaction(async tx => {
    if (staff) await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
    const row = await tx.get<ClubContentDocument>('club_content', key('club-content', ctx.clubId, selected));
    requireThat(!row || row.clubId === ctx.clubId, 'FORBIDDEN', '栏目不可访问');
    if (staff && !row) return { ...starterClubContent(selected), section: selected, configured: false, revision: 0, status: 'draft', updatedAt: '' };
    return view(row, selected, staff);
  });
}
export async function saveClubContent(ctx: Context): Promise<ClubContentView> {
  const p = ctx.request.payload; fields(p, ['section', 'content', 'status', 'rightsAcknowledged']);
  const selected = section(p.section), content = validateClubContent(p.content, selected);
  requireThat(['draft', 'published'].includes(String(p.status)), 'INVALID_INPUT', '请选择草稿或公开发布');
  if (p.status === 'published') requireThat(p.rightsAcknowledged === true, 'CONSENT_REQUIRED', '请确认信息已核实，并已取得公开所需授权');
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
    const id = key('club-content', ctx.clubId, selected), prior = await tx.get<ClubContentDocument>('club_content', id);
    requireThat(!prior || prior.clubId === ctx.clubId, 'FORBIDDEN', '栏目不可访问');
    ctx.revision(prior ?? { revision: 0 });
    const row: ClubContentDocument = { ...content, id, clubId: ctx.clubId, section: selected, status: p.status as 'draft' | 'published', revision: (prior?.revision ?? 0) + 1, updatedAt: ctx.now, publishedAt: p.status === 'published' ? ctx.now : null };
    await tx.set('club_content', id, row);
    await ctx.audit(tx, actor, 'club_content', id, { section: selected, status: row.status, revision: row.revision, publicationRightsAcknowledged: p.status === 'published' });
    return view(row, selected, true);
  });
}
export async function submitClubInquiry(ctx: Context): Promise<ClubInquiry> {
  const p = ctx.request.payload; fields(p, ['kind', 'contact', 'message', 'offerId', 'consent', 'submissionId']);
  requireThat(['business', 'redemption'].includes(String(p.kind)), 'INVALID_INPUT', '请选择咨询类型');
  requireThat(p.consent === true, 'CONSENT_REQUIRED', '请同意将本次咨询和所留联系方式交给组织方处理');
  const submissionId = text(p.submissionId, '提交标识', 80);
  requireThat(/^[a-zA-Z0-9_-]{8,80}$/.test(submissionId), 'INVALID_INPUT', '提交标识不正确，请重新打开页面');
  const contact = text(p.contact, '联系办法', 100), message = text(p.message, '咨询内容', 1000), offerId = optional(p.offerId, '兑换项目', 50);
  requireThat(p.kind === 'redemption' || !offerId, 'INVALID_INPUT', '咨询项目不匹配');
  const digest = sha256(JSON.stringify([p.kind, contact, message, offerId]));
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), id = key('club-inquiry', ctx.clubId, actor.member.id, submissionId);
    const prior = await tx.get<ClubInquiry & { digest: string }>('club_inquiries', id);
    if (prior) { requireThat(prior.memberId === actor.member.id && prior.clubId === ctx.clubId && prior.digest === digest, 'REQUEST_REUSED', '这次提交标识已使用，请刷新后重试'); return inquiryView(prior); }
    let offerName = '';
    if (offerId) {
      const catalog = await tx.get<ClubContentDocument>('club_content', key('club-content', ctx.clubId, 'redemption'));
      const offer = catalog?.clubId === ctx.clubId && catalog.status === 'published' ? catalog.offers.find(item => item.id === offerId) : null;
      requireThat(offer, 'NOT_FOUND', '兑换项目已更新，请刷新后重试'); offerName = offer.name;
    }
    const quotaId = key('club-inquiry-limit', ctx.clubId, actor.member.id, ctx.now.slice(0, 10));
    const quota = await tx.get<{ count: number }>('club_inquiries', quotaId);
    requireThat(!quota || Number.isSafeInteger(quota.count) && quota.count >= 0, 'STATE_CONFLICT', '咨询记录异常，请联系组织方');
    requireThat((quota?.count ?? 0) < 5, 'RATE_LIMITED', '今天的咨询已较多，请等待组织方回复');
    const row: ClubInquiry & { digest: string; rowKind: 'inquiry' } = { id, clubId: ctx.clubId, rowKind: 'inquiry', kind: p.kind as 'business' | 'redemption', memberId: actor.member.id, nickname: actor.member.nickname, contact, message, offerId, offerName, state: 'open', reply: '', revision: 1, createdAt: ctx.now, updatedAt: ctx.now, digest };
    await tx.set('club_inquiries', id, row);
    await tx.set('club_inquiries', quotaId, { id: quotaId, clubId: ctx.clubId, rowKind: 'quota', memberId: actor.member.id, count: (quota?.count ?? 0) + 1 });
    await ctx.audit(tx, actor, 'club_inquiry', id, { kind: row.kind, state: row.state });
    return inquiryView(row);
  });
}
function inquiryView(row: ClubInquiry): ClubInquiry {
  return { id: row.id, clubId: row.clubId, kind: row.kind, memberId: row.memberId, nickname: row.nickname, contact: row.contact, message: row.message, offerId: row.offerId, offerName: row.offerName, state: row.state, reply: row.reply, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export async function listClubInquiries(ctx: Context, staff = false) {
  fields(ctx.request.payload, ['cursor']);
  const actor = await ctx.store.transaction(tx => staff ? ctx.staff(tx, ['owner']) : ctx.actor(tx));
  const cursor = parseCursor(ctx.request.payload.cursor), scope = staff ? 'staff' : actor.member.id;
  const signature = sha256(JSON.stringify([ctx.clubId, scope]));
  requireThat(!cursor || cursor.signature === signature, 'INVALID_INPUT', '咨询分页不正确，请刷新');
  const rows = await ctx.store.query<ClubInquiry>('club_inquiries', { clubId: ctx.clubId, rowKind: 'inquiry', ...(staff ? {} : { memberId: actor.member.id }) }, { orderBy: 'updatedAt', direction: 'desc', limit: 21, after: cursor });
  await ctx.store.transaction(tx => staff ? ctx.staff(tx, ['owner']) : ctx.actor(tx));
  const items = rows.slice(0, 20).filter(row => row.clubId === ctx.clubId && (staff || row.memberId === actor.member.id)).map(inquiryView), last = items[items.length - 1];
  return { items, nextCursor: rows.length > 20 && last ? encodeCursor({ id: last.id, value: last.updatedAt, signature }) : null };
}
export async function changeClubInquiry(ctx: Context, staff = false): Promise<ClubInquiry> {
  const p = ctx.request.payload; fields(p, staff ? ['id', 'reply'] : ['id']);
  return ctx.store.transaction(async tx => {
    const actor = await (staff ? ctx.staff(tx, ['owner']) : ctx.actor(tx));
    const row = await tx.get<ClubInquiry>('club_inquiries', text(p.id, '咨询记录', 100));
    requireThat(row?.clubId === ctx.clubId && (staff || row.memberId === actor.member.id), 'NOT_FOUND', '咨询记录不存在或不可访问');
    ctx.revision(row); requireThat(row.state === 'open', 'CONFLICT_REFRESH', '咨询状态已更新，请刷新');
    const updated = { ...row, state: staff ? 'closed' as const : 'withdrawn' as const, reply: staff ? text(p.reply, '处理说明', 500) : '', revision: row.revision + 1, updatedAt: ctx.now };
    await tx.set('club_inquiries', row.id, updated);
    await ctx.audit(tx, actor, 'club_inquiry', row.id, { state: updated.state, revision: updated.revision });
    return inquiryView(updated);
  });
}
export async function dispatchClubContent(ctx: Context): Promise<unknown> {
  switch (ctx.request.action) {
    case 'club.content.get': return getClubContent(ctx);
    case 'staff.club.content.get': return getClubContent(ctx, true);
    case 'staff.club.content.save': return saveClubContent(ctx);
    case 'club.inquiry.submit': return submitClubInquiry(ctx);
    case 'club.inquiry.mine': return listClubInquiries(ctx);
    case 'club.inquiry.withdraw': return changeClubInquiry(ctx);
    case 'staff.club.inquiry.list': return listClubInquiries(ctx, true);
    case 'staff.club.inquiry.review': return changeClubInquiry(ctx, true);
    default: requireThat(false, 'INVALID_INPUT', '未知栏目操作');
  }
}
