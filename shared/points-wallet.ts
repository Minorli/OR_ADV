import type { Context } from './context';
import { paginated, parseCursor } from './context';
import { integer, requireThat, text } from './errors';
import { key, memberIdFor, shanghaiYear } from './models';
import type { Membership } from './models';
import type { Transaction } from './store';
import type { Activity, LedgerEntry } from './types';
import type { PublicWalletPolicy, WalletAccount, WalletBalance, WalletLedgerEntry, WalletLedgerView, WalletOverview, WalletPolicy } from './points-wallet-types';

export const WALLET_ACTIONS = ['points.wallet', 'points.policy', 'staff.points.policy.get', 'staff.points.policy.save'] as const;
export const walletAccountId = (clubId: string, memberId: string) => key('wallet-account', clubId, memberId);
export const walletSourceId = (clubId: string, sourceId: string) => key('wallet-source', clubId, sourceId);
export const walletOrderEntryId = (clubId: string, redemptionId: string, kind: string) => key('wallet-order', clubId, redemptionId, kind);
const policyId = (clubId: string) => key('wallet-policy', clubId);
const policyVersionId = (clubId: string, version: number) => key('wallet-policy-version', clubId, version);
function fields(ctx: Context, allowed: string[]) { requireThat(Object.keys(ctx.request.payload).every(field => allowed.includes(field)), 'INVALID_INPUT', '积分查询包含不支持的字段'); }
function policyValid(ctx: Context, row: WalletPolicy, kind: 'head' | 'version', version?: number) {
  requireThat(row.clubId === ctx.clubId && row.kind === kind && row.id === (kind === 'head' ? policyId(ctx.clubId) : policyVersionId(ctx.clubId, version!))
    && Number.isSafeInteger(row.version) && row.version > 0 && (version === undefined || row.version === version)
    && Number.isSafeInteger(row.revision) && row.revision > 0 && typeof row.enabled === 'boolean'
    && ['growth', 'zero'].includes(row.defaultRewardMode) && typeof row.ruleText === 'string' && row.ruleText.length <= 1000,
  'STATE_CONFLICT', '积分政策记录异常，请联系管理人员核对');
}
export async function getWalletPolicy(ctx: Context, tx: Transaction): Promise<WalletPolicy> {
  const row = await tx.get<WalletPolicy>('points_policy_versions', policyId(ctx.clubId));
  if (row) { policyValid(ctx, row, 'head'); return row; }
  return { id: policyId(ctx.clubId), clubId: ctx.clubId, kind: 'head', version: 0, revision: 0, enabled: false,
    defaultRewardMode: 'growth', ruleText: '', reason: '', updatedBy: '', createdAt: ctx.now, updatedAt: ctx.now };
}
export function publicWalletPolicy(policy: WalletPolicy): PublicWalletPolicy {
  return { configured: policy.version > 0, enabled: policy.version > 0 && policy.enabled, version: policy.version,
    defaultRewardMode: policy.defaultRewardMode, ruleText: policy.ruleText };
}
async function frozenPolicy(ctx: Context, tx: Transaction, version: number): Promise<WalletPolicy> {
  const row = await tx.get<WalletPolicy>('points_policy_versions', policyVersionId(ctx.clubId, version));
  requireThat(row, 'POLICY_NOT_CONFIGURED', '请先由主理人或车队经理核定兑换积分规则');
  policyValid(ctx, row, 'version', version); return row;
}
/** Draft-only default selection. A missing old reward is never converted here. */
export async function activityWalletReward(ctx: Context, tx: Transaction, requestedAmount?: unknown, growthAmount = 0) {
  const policy = await getWalletPolicy(ctx, tx);
  const redeemable = requestedAmount === undefined
    ? policy.version && policy.defaultRewardMode === 'growth' ? integer(growthAmount, '成长奖励') : 0
    : integer(requestedAmount, '兑换积分奖励');
  if (redeemable > 0) await frozenPolicy(ctx, tx, policy.version);
  return { redeemable, walletPolicyVersion: policy.version };
}
/** Publication/award validation only; never rewrites an already frozen rule. */
export async function validateActivityWalletReward(ctx: Context, tx: Transaction, activity: Activity): Promise<void> {
  const amount = integer(activity.pointsRule.redeemable ?? 0, '兑换积分奖励');
  const version = integer(activity.pointsRule.walletPolicyVersion ?? 0, '积分政策版本');
  requireThat(amount === 0 || version > 0, 'POLICY_NOT_CONFIGURED', '请先核定兑换积分规则后再发布奖励');
  if (version) await frozenPolicy(ctx, tx, version);
}
export async function readWalletAccount(ctx: Context, tx: Transaction, memberId: string): Promise<WalletAccount> {
  const id = walletAccountId(ctx.clubId, memberId), account = await tx.get<WalletAccount>('points_accounts', id);
  if (account) requireThat(account.id === id && account.clubId === ctx.clubId && account.memberId === memberId
    && Number.isSafeInteger(account.balance) && Number.isSafeInteger(account.held) && account.held >= 0
    && Number.isSafeInteger(account.revision) && account.revision >= 1, 'STATE_CONFLICT', '兑换积分账户异常，请联系管理人员核对');
  return account ?? { id, clubId: ctx.clubId, memberId, balance: 0, held: 0, revision: 0, createdAt: ctx.now, updatedAt: ctx.now };
}
export function walletBalance(account: WalletAccount): WalletBalance {
  const difference = account.balance - account.held;
  requireThat(Number.isSafeInteger(difference), 'STATE_CONFLICT', '兑换积分计算超出有效范围');
  return { balance: account.balance, held: account.held, available: Math.max(0, difference), deficit: Math.max(0, -account.balance),
    reservedShortfall: Math.max(0, account.held - Math.max(0, account.balance)), restricted: difference < 0, revision: account.revision };
}
/** Internal append only. Callers resolve duplicate business operations before this boundary. */
export async function appendWalletEntry(ctx: Context, tx: Transaction, entry: WalletLedgerEntry): Promise<WalletAccount> {
  requireThat(entry.clubId === ctx.clubId && Number.isSafeInteger(entry.balanceDelta) && Number.isSafeInteger(entry.heldDelta), 'STATE_CONFLICT', '兑换积分增量异常');
  requireThat(!await tx.get('points_wallet_ledger', entry.id), 'STATE_CONFLICT', '兑换积分流水已存在，请刷新核对');
  const account = await readWalletAccount(ctx, tx, entry.memberId);
  const balance = account.balance + entry.balanceDelta, held = account.held + entry.heldDelta, revision = account.revision + 1;
  requireThat(Number.isSafeInteger(balance) && Number.isSafeInteger(held) && held >= 0 && Number.isSafeInteger(revision), 'STATE_CONFLICT', '兑换积分余额或预留异常');
  const next = { ...account, balance, held, revision, updatedAt: ctx.now };
  await tx.set('points_wallet_ledger', entry.id, entry); await tx.set('points_accounts', next.id, next); return next;
}
function sourceMatches(source: LedgerEntry | null, supplied: LedgerEntry): source is LedgerEntry {
  return !!source && ['id', 'clubId', 'memberId', 'activityId', 'awardType', 'businessKey', 'growthDelta', 'annualDelta',
    'completedCountDelta', 'year', 'effectiveAt', 'ruleVersion', 'relatedEntryId'].every(name => source[name as keyof LedgerEntry] === supplied[name as keyof LedgerEntry]);
}
async function sourceMember(ctx: Context, tx: Transaction, memberId: string) {
  const member = await tx.get<Membership>('memberships', memberId);
  requireThat(member?.clubId === ctx.clubId && member.id === memberId && member.id === memberIdFor(ctx.clubId, member.userId), 'STATE_CONFLICT', '积分来源成员绑定异常');
}
export async function awardActivityWallet(ctx: Context, tx: Transaction, activity: Activity, supplied: LedgerEntry): Promise<void> {
  const amount = integer(activity.pointsRule.redeemable ?? 0, '兑换积分奖励');
  if (!amount) return;
  const actor = await ctx.staff(tx, ['owner', 'operator'], activity.id);
  const current = await tx.get<Activity>('activities', activity.id), source = await tx.get<LedgerEntry>('points_ledger', supplied.id);
  requireThat(current?.clubId === ctx.clubId && current.id === activity.id && ['ended', 'settled'].includes(current.state)
    && current.ruleVersion === activity.ruleVersion && current.pointsRule.redeemable === amount
    && current.pointsRule.walletPolicyVersion === activity.pointsRule.walletPolicyVersion
    && sourceMatches(source, supplied) && source.clubId === ctx.clubId && source.activityId === activity.id && source.awardType === 'completion'
    && source.id === key(ctx.clubId, activity.id, source.memberId, 'completion') && source.businessKey === source.id
    && source.growthDelta === current.pointsRule.growth && source.annualDelta === current.pointsRule.annual && source.completedCountDelta === 1
    && source.ruleVersion === current.ruleVersion && source.effectiveAt === current.actualCompletedAt && source.year === shanghaiYear(source.effectiveAt),
  'STATE_CONFLICT', '兑换积分必须来自本场真实完成流水');
  await validateActivityWalletReward(ctx, tx, current); await sourceMember(ctx, tx, source.memberId);
  const id = walletSourceId(ctx.clubId, source.id), existing = await tx.get<WalletLedgerEntry>('points_wallet_ledger', id);
  if (existing) {
    requireThat(existing.clubId === ctx.clubId && existing.memberId === source.memberId && existing.kind === 'activity_credit'
      && existing.sourceLedgerId === source.id && existing.balanceDelta === amount && existing.heldDelta === 0
      && existing.policyVersion === current.pointsRule.walletPolicyVersion, 'STATE_CONFLICT', '原兑换积分入账不一致'); return;
  }
  await appendWalletEntry(ctx, tx, { id, clubId: ctx.clubId, memberId: source.memberId, kind: 'activity_credit', balanceDelta: amount, heldDelta: 0,
    policyVersion: current.pointsRule.walletPolicyVersion!, activityId: activity.id, sourceLedgerId: source.id, redemptionId: null,
    relatedEntryId: null, label: activity.title, reason: '活动完成奖励', actorId: actor.user.id, occurredAt: source.effectiveAt, recordedAt: ctx.now,
    ...(current.fixtureOnly ? { fixtureOnly: true } : {}) });
  await ctx.audit(tx, actor, 'wallet_entry', id, { kind: 'activity_credit', memberId: source.memberId, amount, sourceLedgerId: source.id, policyVersion: current.pointsRule.walletPolicyVersion });
}
export async function reverseActivityWallet(ctx: Context, tx: Transaction, original: LedgerEntry, reversal: LedgerEntry): Promise<void> {
  const actor = await ctx.staff(tx, ['owner'], original.activityId);
  const prior = await tx.get<LedgerEntry>('points_ledger', original.id), source = await tx.get<LedgerEntry>('points_ledger', reversal.id);
  requireThat(sourceMatches(prior, original) && sourceMatches(source, reversal) && prior.clubId === ctx.clubId && prior.awardType === 'completion'
    && source.clubId === ctx.clubId && source.awardType === 'reversal' && source.relatedEntryId === prior.id
    && source.id === key('reversal', prior.id) && source.businessKey === source.id && source.memberId === prior.memberId && source.activityId === prior.activityId
    && source.growthDelta === -prior.growthDelta && source.annualDelta === -prior.annualDelta && source.completedCountDelta === -prior.completedCountDelta,
  'STATE_CONFLICT', '兑换积分更正必须关联原完成冲正');
  const creditId = walletSourceId(ctx.clubId, prior.id), credit = await tx.get<WalletLedgerEntry>('points_wallet_ledger', creditId);
  if (!credit) return;
  requireThat(credit.clubId === ctx.clubId && credit.memberId === prior.memberId && credit.kind === 'activity_credit' && credit.sourceLedgerId === prior.id
    && Number.isSafeInteger(credit.balanceDelta) && credit.balanceDelta > 0 && credit.heldDelta === 0, 'STATE_CONFLICT', '原兑换奖励记录异常');
  const id = walletSourceId(ctx.clubId, source.id), existing = await tx.get<WalletLedgerEntry>('points_wallet_ledger', id);
  if (existing) { requireThat(existing.clubId === ctx.clubId && existing.memberId === prior.memberId && existing.kind === 'activity_reversal'
    && existing.sourceLedgerId === source.id && existing.relatedEntryId === creditId && existing.balanceDelta === -credit.balanceDelta && existing.heldDelta === 0,
  'STATE_CONFLICT', '兑换积分更正记录不一致'); return; }
  await appendWalletEntry(ctx, tx, { id, clubId: ctx.clubId, memberId: prior.memberId, kind: 'activity_reversal', balanceDelta: -credit.balanceDelta,
    heldDelta: 0, policyVersion: credit.policyVersion, activityId: prior.activityId, sourceLedgerId: source.id, redemptionId: null,
    relatedEntryId: creditId, label: credit.label, reason: source.reason, actorId: actor.user.id, occurredAt: source.effectiveAt, recordedAt: ctx.now,
    ...(credit.fixtureOnly ? { fixtureOnly: true } : {}) });
  await ctx.audit(tx, actor, 'wallet_entry', id, { kind: 'activity_reversal', memberId: prior.memberId, amount: -credit.balanceDelta, sourceLedgerId: source.id });
}
async function wallet(ctx: Context): Promise<WalletOverview> {
  fields(ctx, ['cursor']);
  const memberId = await ctx.store.transaction(async tx => (await ctx.actor(tx)).member.id), cursor = parseCursor(ctx.request.payload.cursor);
  requireThat(!cursor || typeof cursor.value === 'string' && Number.isFinite(Date.parse(cursor.value)), 'INVALID_INPUT', '积分分页位置不正确');
  const rows = await ctx.store.query<WalletLedgerEntry>('points_wallet_ledger', { clubId: ctx.clubId, memberId }, { orderBy: 'recordedAt', direction: 'desc', limit: 21, after: cursor });
  const page = paginated(rows, 'recordedAt');
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx); requireThat(actor.member.id === memberId, 'FORBIDDEN', '成员身份已变化');
    const member = await ctx.summary(tx, actor), policy = await getWalletPolicy(ctx, tx), account = await readWalletAccount(ctx, tx, memberId);
    const items: WalletLedgerView[] = [];
    for (const candidate of page.items) {
      const row = await tx.get<WalletLedgerEntry>('points_wallet_ledger', candidate.id);
      if (row?.clubId === ctx.clubId && row.memberId === memberId) items.push({ id: row.id, kind: row.kind, balanceDelta: row.balanceDelta, heldDelta: row.heldDelta,
        label: row.label, reason: row.reason, activityId: row.activityId, redemptionId: row.redemptionId, occurredAt: row.occurredAt, recordedAt: row.recordedAt });
    }
    return { member, policy: publicWalletPolicy(policy), ...walletBalance(account), items, nextCursor: page.nextCursor };
  });
}
async function policyRead(ctx: Context, staff: boolean) {
  fields(ctx, []);
  return ctx.store.transaction(async tx => { if (staff) await ctx.staff(tx, ['owner']); const row = await getWalletPolicy(ctx, tx); return staff ? row : publicWalletPolicy(row); });
}
async function policySave(ctx: Context): Promise<WalletPolicy> {
  fields(ctx, ['enabled', 'defaultRewardMode', 'ruleText', 'reason']);
  const p = ctx.request.payload;
  requireThat(typeof p.enabled === 'boolean' && ['growth', 'zero'].includes(String(p.defaultRewardMode)), 'INVALID_INPUT', '积分开关和默认奖励方式不正确');
  const ruleText = text(p.ruleText, '兑换规则', 1000), reason = text(p.reason, '核定说明', 500);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner']), previous = await getWalletPolicy(ctx, tx); ctx.revision(previous);
    const version = previous.version + 1; requireThat(Number.isSafeInteger(version), 'STATE_CONFLICT', '积分政策版本已达上限');
    requireThat(!await tx.get('points_policy_versions', policyVersionId(ctx.clubId, version)), 'STATE_CONFLICT', '积分政策版本已被占用');
    const next: WalletPolicy = { ...previous, enabled: p.enabled as boolean, defaultRewardMode: p.defaultRewardMode as 'growth' | 'zero', ruleText, reason,
      version, revision: previous.revision + 1, updatedBy: actor.user.id, updatedAt: ctx.now };
    await tx.set('points_policy_versions', policyVersionId(ctx.clubId, version), { ...next, id: policyVersionId(ctx.clubId, version), kind: 'version' });
    await tx.set('points_policy_versions', next.id, next);
    await ctx.audit(tx, actor, 'wallet_policy', next.id, { version, enabled: next.enabled, defaultRewardMode: next.defaultRewardMode }, reason); return next;
  });
}
export async function dispatchWallet(ctx: Context): Promise<unknown> {
  switch (ctx.request.action) {
    case 'points.wallet': return wallet(ctx);
    case 'points.policy': return policyRead(ctx, false);
    case 'staff.points.policy.get': return policyRead(ctx, true);
    case 'staff.points.policy.save': return policySave(ctx);
    default: requireThat(false, 'INVALID_INPUT', '未知积分操作');
  }
}
