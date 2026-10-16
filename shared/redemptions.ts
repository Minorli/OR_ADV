import type { Context } from './context';
import { paginated, parseCursor } from './context';
import { integer, requireThat, text } from './errors';
import { sha256 } from './hash';
import { key, memberIdFor } from './models';
import type { Actor, Membership, User } from './models';
import { readMemberNumber } from './member-number';
import type { Transaction } from './store';
import { appendWalletEntry, getWalletPolicy, publicWalletPolicy, readWalletAccount, walletBalance, walletOrderEntryId } from './points-wallet';
import type { PublicRedemptionItem, RedemptionItem, RedemptionRequest, RedemptionState, RedemptionView, WalletLedgerEntry } from './points-wallet-types';

export const REDEMPTION_ACTIONS = ['redemption.catalog', 'redemption.request', 'redemption.mine', 'redemption.get', 'redemption.cancel',
  'staff.redemption.catalog.get', 'staff.redemption.catalog.save', 'staff.redemption.catalog.publish', 'staff.redemption.catalog.archive',
  'staff.redemption.list', 'staff.redemption.get', 'staff.redemption.approve', 'staff.redemption.reject', 'staff.redemption.fulfill', 'staff.redemption.refund'] as const;
const STATES: RedemptionState[] = ['pending', 'approved', 'fulfilled', 'rejected', 'cancelled', 'refunded'];
const requestId = (clubId: string, memberId: string, submissionId: string) => key('redemption', clubId, memberId, submissionId);
function fields(ctx: Context, allowed: string[]) { requireThat(Object.keys(ctx.request.payload).every(name => allowed.includes(name)), 'INVALID_INPUT', '兑换请求包含不支持的字段'); }
function nonce(value: unknown): string { const result = text(value, '提交标识', 100); requireThat(/^[A-Za-z0-9_.:-]{12,100}$/.test(result), 'INVALID_INPUT', '提交标识不正确，请重新打开页面'); return result; }
function increment(value: number): number { const next = value + 1; requireThat(Number.isSafeInteger(next), 'STATE_CONFLICT', '记录版本已达上限'); return next; }
function validItem(ctx: Context, row: RedemptionItem) {
  requireThat(row.clubId === ctx.clubId && typeof row.id === 'string' && ['goods', 'service'].includes(row.kind)
    && ['draft', 'published', 'archived'].includes(row.status) && [row.pointsCost, row.totalStock, row.heldStock, row.fulfilledStock, row.sortOrder].every(value => Number.isSafeInteger(value) && value >= 0)
    && Number.isSafeInteger(row.heldStock + row.fulfilledStock) && row.totalStock >= row.heldStock + row.fulfilledStock
    && Number.isSafeInteger(row.revision) && row.revision > 0 && Number.isSafeInteger(row.offerVersion) && row.offerVersion > 0,
  'STATE_CONFLICT', '兑换项目或库存记录异常，请联系管理人员核对');
}
async function item(ctx: Context, tx: Transaction, id: string): Promise<RedemptionItem> {
  const row = await tx.get<RedemptionItem>('redemption_catalog', id);
  requireThat(row?.clubId === ctx.clubId && row.id === id, 'NOT_FOUND', '兑换项目不存在'); validItem(ctx, row); return row;
}
function publicItem(row: RedemptionItem): PublicRedemptionItem {
  requireThat(row.pointsCost > 0, 'STATE_CONFLICT', '兑换项目尚未核定积分');
  return { id: row.id, kind: row.kind, name: row.name, description: row.description, fulfillmentInstructions: row.fulfillmentInstructions,
    pointsCost: row.pointsCost, stockAvailable: row.totalStock - row.heldStock - row.fulfilledStock, offerVersion: row.offerVersion, sortOrder: row.sortOrder };
}
function orderView(row: RedemptionRequest): RedemptionView {
  return { id: row.id, memberId: row.memberId, itemId: row.itemId, itemName: row.itemName, itemDescription: row.itemDescription, itemKind: row.itemKind,
    fulfillmentInstructions: row.fulfillmentInstructions, offerVersion: row.offerVersion, policyVersion: row.policyVersion, pointsCost: row.pointsCost,
    quantity: row.quantity, totalCost: row.totalCost, state: row.state, revision: row.revision, reason: row.reason, approvedAt: row.approvedAt,
    fulfilledAt: row.fulfilledAt, closedAt: row.closedAt, refundedAt: row.refundedAt, refundRestocked: row.refundRestocked, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
async function order(ctx: Context, tx: Transaction, id: string): Promise<RedemptionRequest> {
  const row = await tx.get<RedemptionRequest>('redemption_requests', id);
  requireThat(row?.clubId === ctx.clubId && row.id === id, 'NOT_FOUND', '兑换申请不存在');
  requireThat(row.id === requestId(ctx.clubId, row.memberId, row.submissionId) && STATES.includes(row.state)
    && row.quantity === 1 && Number.isSafeInteger(row.totalCost) && row.totalCost > 0 && row.totalCost === row.pointsCost
    && Number.isSafeInteger(row.revision) && row.revision > 0 && row.holdId === walletOrderEntryId(ctx.clubId, row.id, 'hold'),
  'STATE_CONFLICT', '兑换申请记录异常，请联系管理人员核对'); return row;
}
async function recipient(ctx: Context, tx: Transaction, row: RedemptionRequest) {
  const member = await tx.get<Membership>('memberships', row.memberId), user = await tx.get<User>('users', row.userId);
  requireThat(member?.clubId === ctx.clubId && member.id === row.memberId && member.userId === row.userId
    && member.id === memberIdFor(ctx.clubId, member.userId) && user?.id === row.userId && user.clubId === ctx.clubId,
  'STATE_CONFLICT', '兑换申请成员绑定异常');
  return { member, active: user.status === 'active' };
}
async function staffView(ctx: Context, tx: Transaction, row: RedemptionRequest): Promise<RedemptionView> {
  const target = await recipient(ctx, tx, row);
  return { ...orderView(row), nickname: target.member.nickname, memberNumber: readMemberNumber(target.member.memberNumber), memberActive: target.active };
}
async function activeHold(ctx: Context, tx: Transaction, row: RedemptionRequest) {
  const entry = await tx.get<WalletLedgerEntry>('points_wallet_ledger', row.holdId);
  requireThat(entry?.clubId === ctx.clubId && entry.memberId === row.memberId && entry.redemptionId === row.id && entry.kind === 'hold'
    && entry.balanceDelta === 0 && entry.heldDelta === row.totalCost && entry.policyVersion === row.policyVersion
    && !await tx.get('points_wallet_ledger', walletOrderEntryId(ctx.clubId, row.id, 'release'))
    && !await tx.get('points_wallet_ledger', walletOrderEntryId(ctx.clubId, row.id, 'consume')),
  'STATE_CONFLICT', '原积分预留记录不一致，请核对后处理');
  const account = await readWalletAccount(ctx, tx, row.memberId), product = await item(ctx, tx, row.itemId);
  requireThat(account.held >= row.totalCost && product.heldStock >= row.quantity, 'STATE_CONFLICT', '积分或库存预留不足，请核对记录');
  return { account, product };
}
async function event(ctx: Context, tx: Transaction, actor: Actor, row: RedemptionRequest, kind: 'hold' | 'release' | 'consume' | 'refund', reason: string) {
  await appendWalletEntry(ctx, tx, { id: walletOrderEntryId(ctx.clubId, row.id, kind), clubId: ctx.clubId, memberId: row.memberId, kind,
    balanceDelta: kind === 'consume' ? -row.totalCost : kind === 'refund' ? row.totalCost : 0,
    heldDelta: kind === 'hold' ? row.totalCost : ['release', 'consume'].includes(kind) ? -row.totalCost : 0,
    policyVersion: row.policyVersion, activityId: null, sourceLedgerId: null, redemptionId: row.id,
    relatedEntryId: kind === 'hold' ? null : kind === 'refund' ? walletOrderEntryId(ctx.clubId, row.id, 'consume') : row.holdId,
    label: row.itemName, reason, actorId: actor.user.id, occurredAt: ctx.now, recordedAt: ctx.now });
}
function cursor(ctx: Context, kind: 'number' | 'date') {
  const value = parseCursor(ctx.request.payload.cursor);
  requireThat(!value || /^[A-Za-z0-9_-]{1,100}$/.test(value.id) && (kind === 'number' ? typeof value.value === 'number' && Number.isSafeInteger(value.value)
    : typeof value.value === 'string' && value.value.length <= 40 && Number.isFinite(Date.parse(value.value))), 'INVALID_INPUT', '兑换分页位置不正确');
  return value;
}
async function catalog(ctx: Context, staff = false) {
  fields(ctx, ['cursor', 'itemId']);
  if (staff) await ctx.store.transaction(tx => ctx.staff(tx, ['owner']));
  const selected = ctx.request.payload.itemId !== undefined ? text(ctx.request.payload.itemId, '项目编号', 100) : null;
  const after = cursor(ctx, 'number');
  const batches = selected ? [] : await Promise.all((staff ? ['draft', 'published', 'archived'] : ['published']).map(status => ctx.store.query<RedemptionItem>('redemption_catalog',
    { clubId: ctx.clubId, status }, { orderBy: 'sortOrder', direction: 'asc', limit: 21, after })));
  const compare = (a: RedemptionItem, b: RedemptionItem) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  const page = paginated(batches.flat().sort(compare), 'sortOrder');
  return ctx.store.transaction(async tx => {
    const actor = staff ? await ctx.staff(tx, ['owner']) : null, policy = publicWalletPolicy(await getWalletPolicy(ctx, tx));
    const items: (RedemptionItem | PublicRedemptionItem)[] = [];
    for (const id of selected ? [selected] : page.items.map(row => row.id)) {
      const row = await item(ctx, tx, id);
      if (staff || row.status === 'published') items.push(staff ? row : publicItem(row));
    }
    return { ...(actor ? { member: await ctx.summary(tx, actor) } : {}), policy, items, nextCursor: selected ? null : page.nextCursor };
  });
}
async function saveItem(ctx: Context): Promise<RedemptionItem> {
  fields(ctx, ['itemId', 'submissionId', 'kind', 'name', 'description', 'fulfillmentInstructions', 'pointsCost', 'totalStock', 'sortOrder', 'reason']);
  const p = ctx.request.payload;
  requireThat(['goods', 'service'].includes(String(p.kind)), 'INVALID_INPUT', '请选择物品或服务');
  const normalized = { kind: p.kind as 'goods' | 'service', name: text(p.name, '项目名称', 60), description: text(p.description, '项目说明', 1000),
    fulfillmentInstructions: text(p.fulfillmentInstructions, '交付安排', 500), pointsCost: integer(p.pointsCost, '所需积分'),
    totalStock: integer(p.totalStock, '库存或服务名额'), sortOrder: integer(p.sortOrder ?? 0, '显示顺序'), reason: text(p.reason, '核定说明', 500) };
  const submission = p.itemId === undefined ? nonce(p.submissionId) : null, creationDigest = sha256(JSON.stringify(normalized));
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner']);
    const id = submission ? key('redeem-item', ctx.clubId, actor.user.id, submission) : text(p.itemId, '项目编号', 100);
    const existing = await tx.get<RedemptionItem>('redemption_catalog', id);
    if (existing) {
      validItem(ctx, existing); requireThat(existing.id === id, 'STATE_CONFLICT', '项目编号异常');
      if (submission) { requireThat(existing.creationDigest === creationDigest, 'IDEMPOTENCY_CONFLICT', '本次创建标识已用于其他内容，请先核对原项目'); return existing; }
      ctx.revision(existing);
      requireThat(existing.kind === normalized.kind, 'INVALID_INPUT', '物品与服务类别不可更换，请另建项目');
    } else { requireThat(!!submission, 'NOT_FOUND', '兑换项目不存在'); ctx.revision({ revision: 0 }); }
    requireThat(normalized.totalStock >= (existing?.heldStock ?? 0) + (existing?.fulfilledStock ?? 0), 'STATE_CONFLICT', '库存不能小于已预留和已交付数量');
    requireThat(existing?.status !== 'published' || normalized.pointsCost > 0, 'INVALID_INPUT', '已发布项目必须有明确的兑换积分');
    const offerChanged = !existing || ['name', 'description', 'fulfillmentInstructions', 'pointsCost'].some(name => existing[name as keyof RedemptionItem] !== normalized[name as keyof typeof normalized]);
    const next: RedemptionItem = { id, clubId: ctx.clubId, kind: normalized.kind, name: normalized.name, description: normalized.description,
      fulfillmentInstructions: normalized.fulfillmentInstructions, pointsCost: normalized.pointsCost, totalStock: normalized.totalStock,
      heldStock: existing?.heldStock ?? 0, fulfilledStock: existing?.fulfilledStock ?? 0, sortOrder: normalized.sortOrder,
      status: existing?.status ?? 'draft', offerVersion: existing ? offerChanged ? increment(existing.offerVersion) : existing.offerVersion : 1,
      revision: existing ? increment(existing.revision) : 1, creationDigest: existing?.creationDigest ?? creationDigest, updatedBy: actor.user.id,
      createdAt: existing?.createdAt ?? ctx.now, updatedAt: ctx.now };
    await tx.set('redemption_catalog', id, next);
    await ctx.audit(tx, actor, 'redemption_item', id, { status: next.status, pointsCost: next.pointsCost, totalStock: next.totalStock, offerVersion: next.offerVersion, revision: next.revision }, normalized.reason); return next;
  });
}
async function publishItem(ctx: Context, published: boolean): Promise<RedemptionItem> {
  fields(ctx, ['itemId', 'reason']); const reason = text(ctx.request.payload.reason, '核定说明', 500), id = text(ctx.request.payload.itemId, '项目编号', 100);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner']), current = await item(ctx, tx, id); ctx.revision(current);
    requireThat(!published || current.pointsCost > 0, 'INVALID_INPUT', '发布前请核定所需积分');
    const next: RedemptionItem = { ...current, status: published ? 'published' : 'archived', revision: increment(current.revision),
      offerVersion: increment(current.offerVersion), updatedBy: actor.user.id, updatedAt: ctx.now };
    await tx.set('redemption_catalog', id, next); await ctx.audit(tx, actor, 'redemption_item', id, { status: next.status, offerVersion: next.offerVersion, revision: next.revision }, reason); return next;
  });
}
async function request(ctx: Context): Promise<RedemptionView> {
  fields(ctx, ['submissionId', 'itemId', 'offerVersion', 'policyVersion', 'quantity']);
  const p = ctx.request.payload, submissionId = nonce(p.submissionId), itemId = text(p.itemId, '项目编号', 100);
  const offerVersion = integer(p.offerVersion, '项目版本', 1), policyVersion = integer(p.policyVersion, '兑换规则版本', 1);
  requireThat(p.quantity === 1, 'INVALID_INPUT', '每次申请兑换一件物品或一次服务');
  const intentDigest = sha256(JSON.stringify({ itemId, offerVersion, policyVersion, quantity: 1 }));
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), id = requestId(ctx.clubId, actor.member.id, submissionId), existing = await tx.get<RedemptionRequest>('redemption_requests', id);
    if (existing) { const stored = await order(ctx, tx, id); requireThat(stored.memberId === actor.member.id && stored.userId === actor.user.id && stored.intentDigest === intentDigest,
      'IDEMPOTENCY_CONFLICT', '本次提交标识已用于其他兑换内容，请先核对原申请'); return orderView(stored); }
    const policy = await getWalletPolicy(ctx, tx); requireThat(policy.version > 0 && policy.enabled, 'REDEMPTION_PAUSED', '俱乐部暂未开放新的积分兑换');
    requireThat(policy.version === policyVersion, 'CONFLICT_REFRESH', '兑换规则已更新，请刷新后重新确认');
    const product = await item(ctx, tx, itemId); requireThat(product.status === 'published', 'NOT_FOUND', '项目当前未开放兑换');
    requireThat(product.offerVersion === offerVersion, 'CONFLICT_REFRESH', '兑换项目已更新，请刷新后重新确认');
    requireThat(product.pointsCost > 0, 'STATE_CONFLICT', '项目积分尚未核定');
    const account = await readWalletAccount(ctx, tx, actor.member.id), balance = walletBalance(account);
    requireThat(!balance.restricted, 'WALLET_RESTRICTED', '兑换积分存在待核对差额，请联系管理人员处理');
    requireThat(balance.available >= product.pointsCost, 'INSUFFICIENT_POINTS', '可用兑换积分不足');
    requireThat(product.totalStock - product.heldStock - product.fulfilledStock >= 1, 'STOCK_UNAVAILABLE', '本项目暂时没有可用库存或名额');
    const row: RedemptionRequest = { id, clubId: ctx.clubId, memberId: actor.member.id, userId: actor.user.id, submissionId, intentDigest,
      itemId, itemName: product.name, itemDescription: product.description, itemKind: product.kind, fulfillmentInstructions: product.fulfillmentInstructions,
      offerVersion, policyVersion, pointsCost: product.pointsCost, quantity: 1, totalCost: product.pointsCost, state: 'pending', revision: 1,
      holdId: walletOrderEntryId(ctx.clubId, id, 'hold'), reason: '', processedBy: null, approvedAt: null, fulfilledAt: null,
      closedAt: null, refundedAt: null, refundRestocked: false, createdAt: ctx.now, updatedAt: ctx.now };
    await event(ctx, tx, actor, row, 'hold', '本人确认兑换申请，预留积分');
    await tx.set('redemption_catalog', product.id, { ...product, heldStock: product.heldStock + 1, revision: increment(product.revision) });
    await tx.set('redemption_requests', id, row); await ctx.audit(tx, actor, 'redemption', id, { state: row.state, itemId, totalCost: row.totalCost, offerVersion, policyVersion }); return orderView(row);
  });
}
async function get(ctx: Context, staff: boolean) {
  fields(ctx, staff ? ['redemptionId'] : ['redemptionId', 'submissionId']);
  const p = ctx.request.payload;
  requireThat(staff || (p.redemptionId !== undefined) !== (p.submissionId !== undefined), 'INVALID_INPUT', '请提供一个兑换申请查询标识');
  return ctx.store.transaction(async tx => {
    const actor = staff ? await ctx.staff(tx, ['owner']) : await ctx.actor(tx), id = p.redemptionId !== undefined ? text(p.redemptionId, '申请编号', 100) : requestId(ctx.clubId, actor.member.id, nonce(p.submissionId));
    const found = await tx.get<RedemptionRequest>('redemption_requests', id); if (!found) { requireThat(!staff, 'NOT_FOUND', '兑换申请不存在'); return null; }
    const row = await order(ctx, tx, id);
    requireThat(staff || row.memberId === actor.member.id && row.userId === actor.user.id, 'FORBIDDEN', '只能查看本人的兑换申请');
    return staff ? { member: await ctx.summary(tx, actor), request: await staffView(ctx, tx, row), account: walletBalance(await readWalletAccount(ctx, tx, row.memberId)) } : orderView(row);
  });
}
async function list(ctx: Context, staff: boolean) {
  fields(ctx, staff ? ['state', 'cursor'] : ['cursor']);
  const actor = await ctx.store.transaction(tx => staff ? ctx.staff(tx, ['owner']) : ctx.actor(tx)), after = cursor(ctx, 'date');
  const state = ctx.request.payload.state ?? 'pending'; requireThat(!staff || STATES.includes(state as RedemptionState), 'INVALID_INPUT', '兑换状态不正确');
  const rows = await ctx.store.query<RedemptionRequest>('redemption_requests', staff ? { clubId: ctx.clubId, state } : { clubId: ctx.clubId, memberId: actor.member.id },
    { orderBy: 'createdAt', direction: staff ? 'asc' : 'desc', after, limit: 21 });
  const page = paginated(rows, 'createdAt');
  return ctx.store.transaction(async tx => {
    const current = staff ? await ctx.staff(tx, ['owner']) : await ctx.actor(tx); requireThat(current.member.id === actor.member.id, 'FORBIDDEN', '成员身份已变化');
    const items: RedemptionView[] = [];
    for (const candidate of page.items) {
      const row = await order(ctx, tx, candidate.id);
      if (staff ? row.state === state : row.memberId === actor.member.id && row.userId === actor.user.id) items.push(staff ? await staffView(ctx, tx, row) : orderView(row));
    }
    return { member: await ctx.summary(tx, current), items, nextCursor: page.nextCursor };
  });
}
async function transition(ctx: Context, action: 'approve' | 'reject' | 'fulfill' | 'refund' | 'cancel'): Promise<RedemptionView> {
  fields(ctx, action === 'refund' ? ['redemptionId', 'reason', 'restock'] : ['redemptionId', 'reason']);
  const id = text(ctx.request.payload.redemptionId, '申请编号', 100), reason = text(ctx.request.payload.reason, '处理说明', 500);
  if (action === 'refund') requireThat(typeof ctx.request.payload.restock === 'boolean', 'INVALID_INPUT', '请明确是否已核实退回库存');
  return ctx.store.transaction(async tx => {
    const actor = action === 'cancel' ? await ctx.actor(tx) : await ctx.staff(tx, ['owner']), row = await order(ctx, tx, id);
    requireThat(action !== 'cancel' || row.memberId === actor.member.id && row.userId === actor.user.id, 'FORBIDDEN', '只能取消本人的兑换申请');
    const target: RedemptionState = { approve: 'approved', reject: 'rejected', fulfill: 'fulfilled', refund: 'refunded', cancel: 'cancelled' }[action] as RedemptionState;
    if (row.state === target) {
      requireThat(action !== 'refund' || row.refundRestocked === ctx.request.payload.restock, 'IDEMPOTENCY_CONFLICT', '退回已处理，请核对原库存处理记录');
      return action === 'cancel' ? orderView(row) : staffView(ctx, tx, row);
    }
    ctx.revision(row);
    requireThat(action === 'approve' ? row.state === 'pending' : action === 'fulfill' ? row.state === 'approved' : action === 'refund' ? row.state === 'fulfilled'
      : ['pending', 'approved'].includes(row.state), 'STATE_CONFLICT', '申请状态已变化，请刷新后核对');
    const next: RedemptionRequest = { ...row, state: target, reason, processedBy: actor.user.id, revision: increment(row.revision), updatedAt: ctx.now };
    if (action === 'refund') {
      const consumed = await tx.get<WalletLedgerEntry>('points_wallet_ledger', walletOrderEntryId(ctx.clubId, row.id, 'consume'));
      requireThat(consumed?.clubId === ctx.clubId && consumed.memberId === row.memberId && consumed.redemptionId === row.id && consumed.kind === 'consume'
        && consumed.balanceDelta === -row.totalCost && consumed.heldDelta === -row.totalCost, 'STATE_CONFLICT', '原核销积分记录不一致');
      const product = await item(ctx, tx, row.itemId); requireThat(product.fulfilledStock >= 1, 'STATE_CONFLICT', '原交付库存记录不一致');
      await event(ctx, tx, actor, row, 'refund', reason);
      if (ctx.request.payload.restock) await tx.set('redemption_catalog', product.id, { ...product, fulfilledStock: product.fulfilledStock - 1, revision: increment(product.revision) });
      next.refundedAt = ctx.now; next.refundRestocked = ctx.request.payload.restock as boolean;
    } else {
      const { account, product } = await activeHold(ctx, tx, row);
      if (action === 'approve' || action === 'fulfill') {
        requireThat((await recipient(ctx, tx, row)).active, 'FORBIDDEN', '成员账号当前不可交付，请取消或拒绝申请');
        requireThat(!walletBalance(account).restricted, 'WALLET_RESTRICTED', '兑换积分存在待核对差额，请先核对预留');
      }
      if (action === 'approve') next.approvedAt = ctx.now;
      else {
        const consume = action === 'fulfill'; await event(ctx, tx, actor, row, consume ? 'consume' : 'release', reason);
        await tx.set('redemption_catalog', product.id, { ...product, heldStock: product.heldStock - 1,
          fulfilledStock: product.fulfilledStock + (consume ? 1 : 0), revision: increment(product.revision) });
        if (consume) next.fulfilledAt = ctx.now; else next.closedAt = ctx.now;
      }
    }
    await tx.set('redemption_requests', id, next); await ctx.audit(tx, actor, 'redemption', id,
      { from: row.state, to: next.state, totalCost: row.totalCost, itemId: row.itemId, restock: action === 'refund' ? next.refundRestocked : undefined, revision: next.revision }, reason);
    return action === 'cancel' ? orderView(next) : staffView(ctx, tx, next);
  });
}
export async function dispatchRedemptions(ctx: Context): Promise<unknown> {
  switch (ctx.request.action) {
    case 'redemption.catalog': return catalog(ctx);
    case 'staff.redemption.catalog.get': return catalog(ctx, true);
    case 'staff.redemption.catalog.save': return saveItem(ctx);
    case 'staff.redemption.catalog.publish': return publishItem(ctx, true);
    case 'staff.redemption.catalog.archive': return publishItem(ctx, false);
    case 'redemption.request': return request(ctx);
    case 'redemption.get': return get(ctx, false);
    case 'staff.redemption.get': return get(ctx, true);
    case 'redemption.mine': return list(ctx, false);
    case 'staff.redemption.list': return list(ctx, true);
    case 'redemption.cancel': return transition(ctx, 'cancel');
    case 'staff.redemption.approve': return transition(ctx, 'approve');
    case 'staff.redemption.reject': return transition(ctx, 'reject');
    case 'staff.redemption.fulfill': return transition(ctx, 'fulfill');
    case 'staff.redemption.refund': return transition(ctx, 'refund');
    default: requireThat(false, 'INVALID_INPUT', '未知兑换操作');
  }
}
