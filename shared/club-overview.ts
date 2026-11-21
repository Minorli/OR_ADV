import { Context } from './context';
import { integer, requireThat } from './errors';
import { rankingBoard } from './points';
import { shanghaiYear } from './models';
import { readFrom } from './store';

export const OVERVIEW_ACTIONS = ['ranking.mine'] as const;
export interface OwnRanking {
  metric: 'growth' | 'annual' | 'completed_count'; year: number;
  rankingOptIn: boolean; rank: number | null; publicCount: number | null; score: number | null;
}

/** A private summary of the same public board; one scan, never a second scoring algorithm. */
export async function ownRanking(ctx: Context, options: { deadlineMs?: number } = {}): Promise<OwnRanking> {
  const withinBudget = () => requireThat(options.deadlineMs === undefined || Date.now() <= options.deadlineMs,
    'TEMPORARY_FAILURE', '排名暂时无法显示，请稍后刷新');
  const payload = ctx.request.payload;
  requireThat(Object.keys(payload).every(field => ['metric', 'year'].includes(field)), 'INVALID_INPUT', '榜单查询包含不支持的字段');
  const metric = payload.metric ?? 'growth';
  requireThat(metric === 'growth' || metric === 'annual' || metric === 'completed_count', 'INVALID_INPUT', '榜单维度不正确');
  const year = payload.year === undefined ? shanghaiYear(ctx.now) : integer(payload.year, '年份', 2000);
  requireThat(year <= 2200, 'INVALID_INPUT', '年份不正确');
  const before = await readFrom(ctx.store, async tx => {
    const actor = await ctx.actor(tx);
    return { memberId: actor.member.id, userId: actor.user.id, publicId: actor.member.publicId, revision: actor.member.revision,
      optIn: actor.member.rankingOptIn };
  });
  withinBudget();
  const board = await rankingBoard(ctx, metric, metric === 'annual' ? year : null);
  withinBudget();
  // The identity or profile can change during the scan; never return a rank computed for an older state.
  await readFrom(ctx.store, async tx => {
    const actor = await ctx.actor(tx);
    requireThat(actor.member.id === before.memberId && actor.user.id === before.userId && actor.member.publicId === before.publicId
      && actor.member.revision === before.revision, 'CONFLICT_REFRESH', '个人资料已更新，请刷新后重新核对');
  });
  const index = board.findIndex(row => row.memberPublicId === before.publicId);
  return { metric, year, rankingOptIn: before.optIn, rank: index >= 0 ? index + 1 : null,
    score: index >= 0 ? board[index].score : null, publicCount: board.length };
}

export async function dispatchClubOverview(ctx: Context): Promise<OwnRanking> {
  requireThat(ctx.request.action === 'ranking.mine', 'INVALID_INPUT', '未知概览操作');
  return ownRanking(ctx);
}
