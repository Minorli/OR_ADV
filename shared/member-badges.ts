import { requireThat } from './errors';

export type MemberBadgeTone = 'orange' | 'gold' | 'blue';
export type MemberBadgeId =
  | 'official_team'
  | 'official_coach'
  | 'champion_rider'
  | 'certified_rider'
  | 'pioneer_rider'
  | 'media_partner'
  | 'brand_partner';

export interface MemberBadgeSpec {
  id: MemberBadgeId;
  label: string;
  tone: MemberBadgeTone;
  priority: number;
  description: string;
}

export const MEMBER_BADGES: readonly MemberBadgeSpec[] = [
  { id: 'official_team', label: '工作组', tone: 'orange', priority: 100, description: '橙V · 领队/技师/运营保障' },
  { id: 'official_coach', label: '官方教官', tone: 'orange', priority: 95, description: '橙V · 控车与安全考核指导' },
  { id: 'champion_rider', label: '冠军车手', tone: 'gold', priority: 90, description: '金V · 赛事荣誉车手' },
  { id: 'certified_rider', label: '认证车手', tone: 'gold', priority: 85, description: '金V · 俱乐部实力认证车手' },
  { id: 'pioneer_rider', label: '开荒先锋', tone: 'gold', priority: 80, description: '金V · 首发探路核心车手' },
  { id: 'media_partner', label: '特约影像', tone: 'blue', priority: 70, description: '蓝V · 随队摄影与纪录片创作' },
  { id: 'brand_partner', label: '合作嘉宾', tone: 'blue', priority: 65, description: '蓝V · 官方合作品牌与特邀代表' },
] as const;

const BADGE_MAP = new Map<string, MemberBadgeSpec>(MEMBER_BADGES.map(item => [item.id, item]));

export function normalizeMemberBadges(raw: unknown, legacyCertified?: boolean): MemberBadgeId[] {
  const collected = new Set<MemberBadgeId>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && BADGE_MAP.has(item)) collected.add(item as MemberBadgeId);
    }
  } else if (legacyCertified === true) {
    collected.add('certified_rider');
  }
  return [...collected].sort((a, b) => (BADGE_MAP.get(b)?.priority ?? 0) - (BADGE_MAP.get(a)?.priority ?? 0));
}

export function validateMemberBadgesInput(value: unknown): MemberBadgeId[] {
  requireThat(Array.isArray(value) && value.length <= MEMBER_BADGES.length, 'INVALID_INPUT', '认证挂件格式不正确');
  const seen = new Set<MemberBadgeId>();
  for (const item of value) {
    requireThat(typeof item === 'string' && BADGE_MAP.has(item), 'INVALID_INPUT', '包含不支持的认证挂件');
    seen.add(item as MemberBadgeId);
  }
  return [...seen].sort((a, b) => (BADGE_MAP.get(b)?.priority ?? 0) - (BADGE_MAP.get(a)?.priority ?? 0));
}

export interface MemberBadgeDisplay {
  primaryTone: MemberBadgeTone | '';
  items: { id: MemberBadgeId; label: string; tone: MemberBadgeTone }[];
}

export function resolveBadgeDetails(raw?: unknown, legacyCertified?: boolean): MemberBadgeDisplay {
  const ids = normalizeMemberBadges(raw, legacyCertified);
  const items = ids.map(id => {
    const spec = BADGE_MAP.get(id)!;
    return { id: spec.id, label: spec.label, tone: spec.tone };
  });
  return { primaryTone: items[0]?.tone ?? '', items };
}
