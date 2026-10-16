import { MemoryStore } from './memory-store';
import { key, memberIdFor, userIdFor } from './models';
import type { Membership, StaffRole, User } from './models';
import type { Activity, Role, TrustedIdentity } from './types';
import type { StoreSnapshot } from './store';
import { memberNumberClaimId, memberSequenceId, readMemberNumber, validateMemberNumberClaim, validateMemberSequence } from './member-number';
import type { MemberNumberClaim, MemberNumberSequence } from './member-number';
import { requireThat } from './errors';

export const DEMO_IDENTITIES: Record<'member' | 'founder' | 'owner' | 'operator' | 'leader' | 'checkin', TrustedIdentity> = {
  member: { appId: 'demo-app', openId: 'fictional-member' },
  founder: { appId: 'demo-app', openId: 'fictional-founder' },
  owner: { appId: 'demo-app', openId: 'fictional-owner' },
  operator: { appId: 'demo-app', openId: 'fictional-operator' },
  leader: { appId: 'demo-app', openId: 'fictional-leader' },
  checkin: { appId: 'demo-app', openId: 'fictional-checkin' },
};

/** Pure local v3 migration only. Never import fixtures or this upgrader in cloud entries. */
export function upgradeDemoMemberNumbers(snapshot: StoreSnapshot): StoreSnapshot {
  const clubId = 'oradv', ownerId = memberIdFor(clubId, userIdFor(DEMO_IDENTITIES.owner));
  const members = Object.values(snapshot.memberships ?? {}) as Membership[];
  const clubMembers = members.filter(member => member.clubId === clubId);
  const owner = clubMembers.find(member => member.id === ownerId);
  requireThat(owner && owner.userId === userIdFor(DEMO_IDENTITIES.owner), 'STATE_CONFLICT', '本机演示主理人档案异常，未修改已保存数据');
  const clubs = { ...(snapshot.clubs ?? {}) }, memberships = { ...(snapshot.memberships ?? {}) };
  const sequenceId = memberSequenceId(clubId), priorSequence = clubs[sequenceId] as MemberNumberSequence | undefined;
  if (priorSequence) {
    validateMemberSequence(priorSequence, clubId);
    requireThat(!priorSequence.primaryOwnerMemberId || priorSequence.primaryOwnerMemberId === ownerId, 'STATE_CONFLICT', '本机演示零号关联异常，未修改已保存数据');
  }
  const claims = new Map<number, MemberNumberClaim>();
  let maximum = 0;
  for (const [id, value] of Object.entries(clubs)) {
    const claim = value as MemberNumberClaim;
    if (claim.clubId !== clubId || claim.kind !== 'member_number_claim') continue;
    validateMemberNumberClaim(claim, clubId);
    requireThat(id === claim.id, 'STATE_CONFLICT', '本机演示编号记录异常，未修改已保存数据');
    requireThat(claim.memberNumber !== 0 || claim.memberId === ownerId, 'STATE_CONFLICT', '本机演示零号归属异常，未修改已保存数据');
    claims.set(claim.memberNumber, claim);
    maximum = Math.max(maximum, claim.memberNumber);
  }
  const used = new Map<number, string>();
  for (const member of clubMembers) {
    requireThat(snapshot.memberships[member.id] === member && member.id === memberIdFor(clubId, member.userId), 'STATE_CONFLICT', '本机演示成员引用异常，未修改已保存数据');
    const number = readMemberNumber(member.memberNumber);
    if (number === undefined) continue;
    requireThat(!used.has(number) && (number !== 0 || member.id === ownerId), 'STATE_CONFLICT', '本机演示编号重复或零号归属异常，未修改已保存数据');
    requireThat(!claims.has(number) || claims.get(number)!.memberId === member.id, 'STATE_CONFLICT', '本机演示编号占用不一致，未修改已保存数据');
    used.set(number, member.id);
    maximum = Math.max(maximum, number);
  }
  requireThat(owner.memberNumber === undefined || owner.memberNumber === 0, 'STATE_CONFLICT', '本机演示主理人编号异常，未修改已保存数据');
  let nextNumber = Math.max(1, maximum + 1, priorSequence?.nextNumber ?? 1);
  requireThat(Number.isSafeInteger(nextNumber), 'STATE_CONFLICT', '本机演示编号已达上限，未修改已保存数据');
  function assign(member: Membership, number: number) {
    const claimId = memberNumberClaimId(clubId, number), prior = clubs[claimId] as MemberNumberClaim | undefined;
    if (prior) {
      validateMemberNumberClaim(prior, clubId);
      requireThat(prior.memberId === member.id, 'STATE_CONFLICT', '本机演示编号已被占用，未修改已保存数据');
    } else clubs[claimId] = { id: claimId, clubId, kind: 'member_number_claim', memberNumber: number, memberId: member.id };
    memberships[member.id] = member.memberNumber === number ? member : { ...member, memberNumber: number };
  }
  assign(owner, 0);
  const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
  const others = clubMembers.filter(member => member.id !== ownerId).sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
  for (const member of others) {
    if (member.memberNumber !== undefined) { assign(member, member.memberNumber); continue; }
    requireThat(nextNumber < Number.MAX_SAFE_INTEGER, 'STATE_CONFLICT', '本机演示编号已达上限，未修改已保存数据');
    assign(member, nextNumber++);
  }
  clubs[sequenceId] = { ...priorSequence, id: sequenceId, clubId, kind: 'member_sequence', nextNumber, primaryOwnerMemberId: ownerId };
  return { ...snapshot, clubs, memberships };
}

/** Fictitious local fixtures only. Never import this module in a cloud entry. */
export function demoSnapshot(referenceNow = new Date().toISOString()): StoreSnapshot {
  const now = referenceNow;
  const scheduledStart = new Date(Date.parse(now) + 7 * 86400000);
  scheduledStart.setUTCHours(2, 0, 0, 0);
  const startAt = scheduledStart.toISOString();
  const endAt = new Date(Date.parse(startAt) + 4 * 3600000).toISOString();
  const deadline = new Date(Date.parse(startAt) - 86400000).toISOString();
  const seed: StoreSnapshot = { users: {}, memberships: {}, staff_roles: {}, activities: {}, clubs: {} };
  seed.clubs.oradv = { id: 'oradv', clubId: 'oradv', name: '原始拉力 · 本机演示', contactName: '演示组织方', contactMethod: 'wechat',
    contactValue: '仅为演示，不是真实联系方式', contactInstructions: '本机演示不接受真实报名；真实使用前须由主理人配置有效联系入口。', revision: 1, fixtureOnly: true };
  const labels = { member: '模拟车友', founder: '模拟创始成员', owner: '模拟主理人', operator: '模拟运营', leader: '模拟领队', checkin: '模拟核验员' };
  for (const [name, identity] of Object.entries(DEMO_IDENTITIES)) {
    const userId = userIdFor(identity), memberId = memberIdFor('oradv', userId);
    const user: User = { id: userId, clubId: 'oradv', appId: identity.appId, wxOpenId: identity.openId, status: 'active', consentVersions: { privacy: 1, terms: 1 }, createdAt: now, updatedAt: now };
    const member: Membership = { id: memberId, clubId: 'oradv', userId, nickname: labels[name as keyof typeof labels], publicId: key('public', name),
      rankingOptIn: false, rankingConsentVersion: 0, memberKind: name === 'founder' ? 'founder' : 'regular',
      memberKindVersion: name === 'founder' ? 1 : 0, memberKindExpiresAt: null, recommendationOptIn: false,
      recommendationConsentVersion: 0, recommendationPriority: 0, revision: 1, createdAt: now, updatedAt: now };
    seed.users[userId] = user; seed.memberships[memberId] = member;
    if (name !== 'member' && name !== 'founder') {
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
  return upgradeDemoMemberNumbers(seed);
}

export function createDemoStore(referenceNow?: string): MemoryStore {
  return new MemoryStore(demoSnapshot(referenceNow), referenceNow ? () => referenceNow : undefined);
}
