import { Context } from './context';
import { integer, requireThat } from './errors';
import { listRankings } from './points';
import { shanghaiYear } from './models';
import type { RankingEntry } from './types';

export const OVERVIEW_ACTIONS = ['ranking.mine'] as const;
export interface OwnRanking {
  metric: 'growth' | 'annual' | 'completed_count'; year: number;
  rankingOptIn: boolean; rank: number | null; publicCount: number | null; score: number | null;
}

/** A private summary of the same public list; never a second scoring algorithm. */
export async function ownRanking(ctx: Context, options: { deadlineMs?: number } = {}): Promise<OwnRanking> {
  const withinBudget = () => requireThat(options.deadlineMs === undefined || Date.now() <= options.deadlineMs,
    'TEMPORARY_FAILURE', '排名暂时无法显示，请稍后刷新');
  const payload = ctx.request.payload;
  requireThat(Object.keys(payload).every(field => ['metric', 'year'].includes(field)), 'INVALID_INPUT', '榜单查询包含不支持的字段');
  const metric = payload.metric ?? 'growth';
  requireThat(metric === 'growth' || metric === 'annual' || metric === 'completed_count', 'INVALID_INPUT', '榜单维度不正确');
  const year = payload.year === undefined ? shanghaiYear(ctx.now) : integer(payload.year, '年份', 2000);
  requireThat(year <= 2200, 'INVALID_INPUT', '年份不正确');
  const before = await ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    return { memberId: actor.member.id, userId: actor.user.id, publicId: actor.member.publicId, revision: actor.member.revision,
      optIn: actor.member.rankingOptIn, consentVersion: actor.member.rankingConsentVersion };
  });
  const base: OwnRanking = { metric, year, rankingOptIn: before.optIn, rank: null, publicCount: null, score: null };
  if (!before.optIn) return base;
  const entries: RankingEntry[] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 12; page++) {
    withinBudget();
    const request = { ...ctx.request, action: 'ranking.list', payload: { metric, year, cursor } };
    const child = new Context(ctx.store, { ...ctx.options, now: () => ctx.now }, request, ctx.identity, ctx.traceId);
    const result = await listRankings(child);
    withinBudget();
    for (const entry of result.items) {
      requireThat(!seen.has(entry.memberPublicId), 'CONFLICT_REFRESH', '榜单正在变化，请刷新后重新核对');
      seen.add(entry.memberPublicId); entries.push(entry);
      requireThat(entries.length <= 200, 'CONFLICT_REFRESH', '榜单超出当前统计范围，请联系负责人核对');
    }
    cursor = result.nextCursor;
    if (!cursor) break;
    requireThat(!cursors.has(cursor), 'CONFLICT_REFRESH', '榜单正在变化，请刷新后重新核对');
    cursors.add(cursor);
  }
  requireThat(!cursor, 'CONFLICT_REFRESH', '榜单记录正在更新，请刷新后重新核对');
  withinBudget();
  await ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    requireThat(actor.member.id === before.memberId && actor.user.id === before.userId && actor.member.publicId === before.publicId
      && actor.member.rankingOptIn && actor.member.rankingConsentVersion === before.consentVersion && actor.member.revision === before.revision,
    'CONFLICT_REFRESH', '公开设置或个人资料已更新，请刷新后重新核对');
  });
  const own = entries.find(entry => entry.memberPublicId === before.publicId);
  return { ...base, rank: own?.rank ?? null, score: own?.score ?? null, publicCount: entries.length };
}

export async function dispatchClubOverview(ctx: Context): Promise<OwnRanking> {
  requireThat(ctx.request.action === 'ranking.mine', 'INVALID_INPUT', '未知概览操作');
  return ownRanking(ctx);
}
