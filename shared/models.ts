import type { Activity, LedgerEntry, Registration, Role, TrustedIdentity } from './types';
import { sha256 } from './hash';

export interface User {
  id: string; clubId: string; appId: string; wxOpenId: string;
  status: 'active' | 'disabled' | 'deletion_requested' | 'deleted';
  consentVersions: Record<string, unknown>; createdAt: string; updatedAt: string;
}
export interface Membership {
  id: string; clubId: string; userId: string; nickname: string;
  publicId: string; rankingOptIn: boolean; rankingConsentVersion: number;
  revision: number; createdAt: string; updatedAt: string;
}
export interface StaffRole {
  id: string; clubId: string; userId: string; role: Role;
  activityIds: string[] | null; enabled: boolean; expiresAt: string | null;
  grantedBy: string; revision: number;
}
export interface Qualification {
  id: string; clubId: string; memberId: string; type: string;
  decision: 'pending' | 'approved' | 'rejected'; expiresAt: string | null;
}
export interface MemberStats {
  id: string; clubId: string; memberId: string; scope: 'growth' | 'year';
  year: number | null; points: number; completedCount: number; revision: number;
}
export interface YearRevision { id: string; clubId: string; kind: 'year_guard'; year: number; revision: number }
export interface Checkin {
  id: string; clubId: string; activityId: string; memberId: string;
  phase: 'departure' | 'return'; day: string; result: string;
  verifiedBy: string; verifiedAt: string; reason: string;
}
export interface PublicRanking {
  id: string; clubId: string; memberId: string; memberPublicId: string;
  nickname: string; metric: string; year: number | null; score: number;
  completedCount: number; consentVersion: number;
}
export interface Audit {
  id: string; clubId: string; actorId: string; action: string;
  targetType: string; targetId: string; requestId: string; traceId: string;
  summary: Record<string, unknown>; reason: string; createdAt: string;
}
export interface SettlementJob {
  id: string; clubId: string; activityId: string; ruleVersion: number;
  status: 'running' | 'partial_failure' | 'completed';
  successCount: number; failureCount: number; failures: { registrationId: string; code: string }[];
}
export interface Actor { user: User; member: Membership }
export interface ServiceOptions { clubId?: string; now?: () => string; id?: () => string }
export const key = (...parts: (string | number)[]) => `${String(parts[0]).replace(/[^a-z0-9]/gi, '_').slice(0, 20)}_${sha256(JSON.stringify(parts))}`;
/** Private identity key; never returned in a public projection. */
export const userIdFor = (identity: TrustedIdentity) => key('user', identity.appId, identity.openId);
export const memberIdFor = (clubId: string, userId: string) => key('member', clubId, userId);
export const registrationIdFor = (clubId: string, activityId: string, memberId: string) => key('registration', clubId, activityId, memberId);
export const statsIdFor = (clubId: string, memberId: string, year: number | null) => key('stats', clubId, memberId, year ?? 'growth');
export const yearRevisionIdFor = (clubId: string, year: number) => key('year_guard', clubId, year);
export const completionIdFor = (activity: Activity, registration: Registration) => key(activity.clubId, activity.id, registration.memberId, 'completion');
export const shanghaiYear = (timestamp: string) => new Date(Date.parse(timestamp) + 8 * 60 * 60 * 1000).getUTCFullYear();
export const shanghaiDay = (timestamp: string) => new Date(Date.parse(timestamp) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
export type { Activity, LedgerEntry, Registration };
