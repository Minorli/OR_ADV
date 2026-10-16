import { integer, requireThat, text } from './errors';

export const ACTIVITY_COVER_KEYS = ['dunes', 'forest', 'ridge', 'v2-1', 'v2-2', 'v2-3', 'v2-4', 'v2-5', 'v2-6', 'v2-7', 'v2-8'] as const;
export type ActivityCoverKey = typeof ACTIVITY_COVER_KEYS[number];
export interface ActivityItineraryStage { dayLabel: string; title: string; description: string }
export interface ActivityDisplayFields { coverKey?: ActivityCoverKey | null; distanceKm?: number | null; itinerary?: ActivityItineraryStage[] }

/** Display metadata cannot choose URLs, storage paths, identities or frozen rules. */
export function activityDisplayFields(value: Record<string, unknown>, prior: ActivityDisplayFields = {}): ActivityDisplayFields {
  const coverKey = value.coverKey === undefined ? prior.coverKey ?? null : value.coverKey;
  requireThat(coverKey === null || typeof coverKey === 'string' && (ACTIVITY_COVER_KEYS as readonly string[]).includes(coverKey), 'INVALID_INPUT', '请选择活动封面');
  const distance = value.distanceKm === undefined ? prior.distanceKm ?? null : value.distanceKm;
  const distanceKm = distance === null ? null : integer(distance, '活动路线里程', 1);
  requireThat(distanceKm === null || distanceKm <= 100000, 'INVALID_INPUT', '活动路线里程不正确');
  const raw = value.itinerary === undefined ? prior.itinerary ?? [] : value.itinerary;
  requireThat(Array.isArray(raw) && raw.length <= 30, 'INVALID_INPUT', '路线最多包含30个分段');
  const itinerary = raw.map(item => {
    requireThat(item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(name => ['dayLabel', 'title', 'description'].includes(name)), 'INVALID_INPUT', '路线分段格式不正确');
    return { dayLabel: text(item.dayLabel, '分段标记', 20), title: text(item.title, '路线分段', 100),
      description: item.description === undefined || item.description === '' ? '' : text(item.description, '分段说明', 400) };
  });
  return { coverKey: coverKey as ActivityCoverKey | null, distanceKm, itinerary };
}
