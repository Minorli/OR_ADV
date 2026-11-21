import { activityCard } from './presentation';
import type { Activity } from '../../../shared/types';

const coverAliases: Record<string, string> = { 'v2-2': 'dunes', 'v2-5': 'dunes', 'v2-7': 'ridge' };
const covers = ['/assets/covers/dunes.jpg', '/assets/covers/forest.jpg', '/assets/covers/ridge.jpg'];
export function coverForKey(coverKey?: string | null, activityId = ''): string {
  if (coverKey && ['dunes', 'forest', 'ridge'].includes(coverKey)) return `/assets/covers/${coverKey}.jpg`;
  if (coverKey && /^v2-[1-8]$/.test(coverKey)) return `/assets/covers/${coverAliases[coverKey] || coverKey}.jpg`;
  return coverForActivity(activityId);
}
export function coverForActivity(activityId: string): string {
  const hash = Array.from(activityId).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
  return covers[hash % covers.length];
}
export function activityVisual(activity: Activity) {
  const card = activityCard(activity);
  const start = new Date(Date.parse(activity.startAt) + 8 * 3600000);
  const valid = Number.isFinite(start.getTime());
  const hours = (Date.parse(activity.endAt) - Date.parse(activity.startAt)) / 3600000;
  const durationText = !Number.isFinite(hours) || hours <= 0 ? '时长待定' : hours >= 24 ? `约${Math.ceil(hours / 24)}天` : `约${Number(hours.toFixed(1))}小时`;
  const difficulty = /进阶|高阶/.test(activity.difficulty) ? 3 : /基础|中级/.test(activity.difficulty) ? 2 : /入门|初级/.test(activity.difficulty) ? 1 : 0;
  const qualificationNames: Record<string, string> = { advanced_offroad: '进阶非铺装技能', basic_control: '基础控车技能', basic_offroad: '基础非铺装技能' };
  return { ...card, cover: activity.coverUrl || coverForKey(activity.coverKey, activity.id), durationText,
    distanceText: activity.distanceKm === undefined || activity.distanceKm === null ? '里程待确认' : `${activity.distanceKm}km`,
    monthText: valid ? String(start.getUTCMonth() + 1).padStart(2, '0') : '--',
    dayText: valid ? String(start.getUTCDate()).padStart(2, '0') : '--',
    weekdayText: valid ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][start.getUTCDay()] : '',
    difficultyBars: Array.from({ length: 3 }, (_, index) => ({ id: index, active: index < difficulty })),
    statusTone: activity.state === 'published' && card.canApply || activity.state === 'in_progress' ? 'active' : activity.state === 'settled' ? 'done' : 'muted',
    seatText: card.canApply ? card.slots > 0 ? `余 ${card.slots} / ${activity.capacity} 位` : '名额已满 · 可查看候补' : `本场 ${activity.capacity} 位`,
    qualificationLabels: activity.requiredQualifications.map(value => qualificationNames[value] || value),
  };
}

const previewCache = new Map<string, { value: ReturnType<typeof activityVisual>; expiresAt: number }>();
export function seedActivityPreview(activity: Activity | ReturnType<typeof activityVisual>) {
  if (!activity?.id || activity.state === 'draft') return;
  if (previewCache.size > 32) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
  }
  previewCache.set(`${activity.clubId || 'oradv'}:${activity.id}`, { value: activityVisual(activity), expiresAt: Date.now() + 30_000 });
}
export function readActivityPreview(activityId: string, clubId = 'oradv'): ReturnType<typeof activityVisual> | null {
  if (!activityId) return null;
  const entry = previewCache.get(`${clubId}:${activityId}`);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    previewCache.delete(`${clubId}:${activityId}`);
    return null;
  }
  return entry.value;
}
