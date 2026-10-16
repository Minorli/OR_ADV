import { activityCard } from './presentation';
import type { Activity } from '../../../shared/types';

const covers = ['/assets/covers/dunes.jpg', '/assets/covers/forest.jpg', '/assets/covers/ridge.jpg'];
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
  return { ...card, cover: coverForActivity(activity.id), durationText,
    monthText: valid ? String(start.getUTCMonth() + 1).padStart(2, '0') : '--',
    dayText: valid ? String(start.getUTCDate()).padStart(2, '0') : '--',
    weekdayText: valid ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][start.getUTCDay()] : '',
    difficultyBars: Array.from({ length: 3 }, (_, index) => ({ id: index, active: index < difficulty })),
    statusTone: activity.state === 'published' && card.canApply || activity.state === 'in_progress' ? 'active' : activity.state === 'settled' ? 'done' : 'muted',
    seatText: card.canApply ? card.slots > 0 ? `余 ${card.slots} / ${activity.capacity} 位` : '名额已满 · 可查看候补' : `本场 ${activity.capacity} 位`,
    qualificationLabels: activity.requiredQualifications.map(value => qualificationNames[value] || value),
  };
}
