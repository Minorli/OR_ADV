import { Context, encodeCursor, parseCursor } from './context';
import { DomainError, requireThat, text } from './errors';
import { sha256 } from './hash';
import { historyDetail } from './history-content';
import type { Activity } from './types';
import type { HistoryFeed, HistoryFeedCard } from './history-feed-types';

const PAGE_SIZE = 5, SCAN_LIMIT = 100;
export const HISTORY_FEED_ACTIONS = ['history.feed'] as const;
const monthFor = (activity: Pick<Activity, 'actualCompletedAt' | 'endAt'>) => {
  const value = Date.parse(activity.actualCompletedAt || activity.endAt);
  return Number.isFinite(value) ? new Date(value + 8 * 3600000).toISOString().slice(0, 7) : null;
};
function matches(activity: Pick<Activity, 'title' | 'location' | 'description' | 'actualCompletedAt' | 'endAt'>, month: string, query: string) {
  return (!month || monthFor(activity) === month) && (!query || `${activity.title} ${activity.location} ${activity.description}`.toLocaleLowerCase().includes(query));
}

/** One public request with bounded metadata scanning and two content readers. */
export async function historyFeed(ctx: Context): Promise<HistoryFeed> {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every(name => ['cursor', 'month', 'query'].includes(name)), 'INVALID_INPUT', '往期列表包含不支持的字段');
  const month = p.month === undefined || p.month === '' ? '' : text(p.month, '月份', 7);
  requireThat(!month || /^\d{4}-(0[1-9]|1[0-2])$/.test(month), 'INVALID_INPUT', '月份不正确');
  const query = p.query === undefined || typeof p.query === 'string' && !p.query.trim() ? '' : text(p.query, '搜索内容', 60).toLocaleLowerCase();
  const signature = sha256(JSON.stringify([ctx.clubId, month, query])), supplied = parseCursor(p.cursor);
  requireThat(!supplied || supplied.signature === signature && typeof supplied.value === 'string' && Number.isFinite(Date.parse(supplied.value))
    && /^[A-Za-z0-9_.:-]{1,100}$/.test(supplied.id), 'INVALID_INPUT', '筛选条件已变化，请重新加载往期记录');
  let after = supplied, scanned = 0, more = false;
  const candidates: Activity[] = [], months = new Set<string>();
  while (candidates.length < PAGE_SIZE && scanned < SCAN_LIMIT) {
    const limit = Math.min(21, SCAN_LIMIT - scanned);
    const batch = await ctx.store.query<Activity>('activities', { clubId: ctx.clubId, state: 'settled' }, { orderBy: 'startAt', direction: 'desc', limit, after });
    more = batch.length === limit;
    for (let index = 0; index < batch.length; index++) {
      const activity = batch[index]; scanned++;
      requireThat(activity.clubId === ctx.clubId && activity.state === 'settled', 'STATE_CONFLICT', '往期记录查询范围异常');
      after = { value: activity.startAt, id: activity.id, signature };
      const archiveMonth = monthFor(activity); if (archiveMonth) months.add(archiveMonth);
      if (matches(activity, month, query)) candidates.push(activity);
      if (candidates.length === PAGE_SIZE) { more = more || index < batch.length - 1; break; }
    }
    if (!batch.length || !more) break;
  }
  const cards: (HistoryFeedCard | null)[] = new Array(candidates.length).fill(null); let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const index = next++, activity = candidates[index];
      const child = new Context(ctx.store, { ...ctx.options, now: () => ctx.now }, { ...ctx.request, action: 'history.detail', payload: { activityId: activity.id } }, ctx.identity, ctx.traceId);
      try {
        const detail = await historyDetail(child, 2);
        // The final live activity snapshot must still match the selected filter.
        if (!matches({ ...detail.activity, actualCompletedAt: detail.activity.actualCompletedAt ?? null }, month, query)) continue;
        cards[index] = { ...detail, reviews: { ...detail.reviews, total: detail.reviews.nextCursor ? null : detail.reviews.items.length } };
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'ACTIVITY_NOT_FOUND')) throw error;
      }
    }
  };
  const workers = await Promise.allSettled([worker(), worker()]);
  for (const result of workers) if (result.status === 'rejected') throw result.reason;
  return { items: cards.filter((value): value is HistoryFeedCard => value !== null), nextCursor: more && after ? encodeCursor(after) : null, months: [...months].sort().reverse() };
}
