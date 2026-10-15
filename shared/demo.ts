import { MemoryStore } from './memory-store';
import { key, memberIdFor, userIdFor } from './models';
import type { Membership, StaffRole, User } from './models';
import type { Activity, Role, TrustedIdentity } from './types';
import type { StoreSnapshot } from './store';

export const DEMO_IDENTITIES: Record<'member' | 'owner' | 'operator' | 'leader' | 'checkin', TrustedIdentity> = {
  member: { appId: 'demo-app', openId: 'fictional-member' },
  owner: { appId: 'demo-app', openId: 'fictional-owner' },
  operator: { appId: 'demo-app', openId: 'fictional-operator' },
  leader: { appId: 'demo-app', openId: 'fictional-leader' },
  checkin: { appId: 'demo-app', openId: 'fictional-checkin' },
};

/** Fictitious local fixtures only. Never import this module in a cloud entry. */
export function demoSnapshot(referenceNow = new Date().toISOString()): StoreSnapshot {
  const now = referenceNow;
  const scheduledStart = new Date(Date.parse(now) + 7 * 86400000);
  scheduledStart.setUTCHours(2, 0, 0, 0);
  const startAt = scheduledStart.toISOString();
  const endAt = new Date(Date.parse(startAt) + 4 * 3600000).toISOString();
  const deadline = new Date(Date.parse(startAt) - 86400000).toISOString();
  const seed: StoreSnapshot = { users: {}, memberships: {}, staff_roles: {}, activities: {} };
  const labels = { member: '模拟车友', owner: '模拟主理人', operator: '模拟运营', leader: '模拟领队', checkin: '模拟核验员' };
  for (const [name, identity] of Object.entries(DEMO_IDENTITIES)) {
    const userId = userIdFor(identity), memberId = memberIdFor('oradv', userId);
    const user: User = { id: userId, clubId: 'oradv', appId: identity.appId, wxOpenId: identity.openId, status: 'active', consentVersions: { privacy: 1, terms: 1 }, createdAt: now, updatedAt: now };
    const member: Membership = { id: memberId, clubId: 'oradv', userId, nickname: labels[name as keyof typeof labels], publicId: key('public', name),
      rankingOptIn: false, rankingConsentVersion: 0, revision: 1, createdAt: now, updatedAt: now };
    seed.users[userId] = user; seed.memberships[memberId] = member;
    if (name !== 'member') {
      const id = key('role', 'oradv', userId, name);
      const role: StaffRole = { id, clubId: 'oradv', userId, role: name as Role, enabled: true,
        activityIds: ['leader','checkin'].includes(name) ? ['intro-ride'] : null, expiresAt: null,
        grantedBy: 'local-fixture', revision: 1 };
      seed.staff_roles[id] = role;
    }
  }
  const base: Activity = { id: 'intro-ride', clubId: 'oradv', title: '非铺装入门体验 · 模拟活动',
    description: '虚构测试活动：基础控车与非铺装路线练习。真实活动线下收费，具体安排由组织方线下说明；食宿交通自行安排。',
    location: '北京周边公开区域（模拟）', difficulty: '入门', state: 'published',
    startAt, endAt, applicationClosesAt: deadline,
    capacity: 8, reservedSeats: 0, minGrowthPoints: 0, requiredQualifications: [], requiresReview: true,
    ruleVersion: 1, revision: 1, pointsRule: { growth: 100, annual: 100 }, nextQueueSeq: 0, waitlistCount: 0, actualCompletedAt: null,
    fixtureOnly: true, safetyNotice: '积分不能代替技能与现场安全核验；遇险停止并听从领队安排。', equipment: '合规车辆、头盔、护具和必要补给。' };
  seed.activities[base.id] = base;
  seed.activities['advanced-ride'] = { ...base, id: 'advanced-ride', title: '进阶技能训练 · 模拟活动', minGrowthPoints: 10000, requiredQualifications: ['advanced_offroad'], difficulty: '进阶' };
  seed.activities['draft-ride'] = { ...base, id: 'draft-ride', title: '内部草稿 · 模拟活动', state: 'draft' };
  return seed;
}

export function createDemoStore(referenceNow?: string): MemoryStore {
  return new MemoryStore(demoSnapshot(referenceNow), referenceNow ? () => referenceNow : undefined);
}
