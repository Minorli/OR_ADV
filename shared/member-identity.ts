import type { Membership } from './models';
import type { MemberKind } from './types';

export function effectiveMemberKind(member: Membership, now: string): MemberKind {
  return member.memberKind === 'founder' && (!member.memberKindExpiresAt || member.memberKindExpiresAt > now) ? 'founder' : 'regular';
}
export function memberIdentityFields(member: Membership, now: string) {
  return { memberKind: effectiveMemberKind(member, now), memberKindVersion: member.memberKindVersion ?? 0,
    memberKindExpiresAt: member.memberKindExpiresAt ?? null, recommendationOptIn: member.recommendationOptIn ?? false,
    recommendationConsentVersion: member.recommendationConsentVersion ?? 0,
    kindRequestStatus: member.kindRequestStatus ?? null, kindRequestedAt: member.kindRequestedAt ?? null };
}
export const recommendationSortKey = (member: Membership, now: string) => `${effectiveMemberKind(member, now) === 'founder' ? '0' : '1'}:${String(999 - (member.recommendationPriority ?? 0)).padStart(3, '0')}`;
