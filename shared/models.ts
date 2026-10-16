import type { MemberMediaStorage } from './member-media-types';
import type { Activity, LedgerEntry, MemberKind, Registration, Role, TrustedIdentity } from './types';
import { sha256 } from './hash';

export interface User {
  id: string; clubId: string; appId: string; wxOpenId: string;
  status: 'active' | 'disabled' | 'deletion_requested' | 'deleted';
  consentVersions: Record<string, unknown>; createdAt: string; updatedAt: string;
}
export interface Membership {
  id: string; clubId: string; userId: string; nickname: string;
  memberNumber?: number;
  avatarFileId?: string;
  publicId: string; rankingOptIn: boolean; rankingConsentVersion: number;
  revision: number; createdAt: string; updatedAt: string;
  memberKind?: MemberKind; memberKindVersion?: number; memberKindExpiresAt?: string | null;
  recommendationOptIn?: boolean; recommendationConsentVersion?: number; recommendationPriority?: number;
  kindRequestStatus?: 'pending' | 'resolved'; kindRequestedAt?: string; kindRequestReason?: string;
}
export interface StaffRole {
  id: string; clubId: string; userId: string; role: Role;
  designation?: 'manager';
  activityIds: string[] | null; enabled: boolean; expiresAt: string | null;
  grantedBy: string; revision: number;
}
export interface Qualification {
  id: string; clubId: string; memberId: string; type: string;
  decision: 'pending' | 'approved' | 'rejected'; expiresAt: string | null;
  revision?: number; reviewedAt?: string; reviewedBy?: string; reason?: string;
}
export interface RecommendationProjection {
  id: string; clubId: string; memberId: string; sortKey: string; visible: boolean;
  consentVersion: number;
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
/** Implementations return a unique, private new file on every save. */
export interface AvatarStorage {
  save(memberId: string, imageBase64: string): Promise<string>;
  url(fileId: string): Promise<string>;
  remove(fileId: string): Promise<void>;
}
export interface ServiceOptions {
  clubId?: string; now?: () => string; id?: () => string;
  avatarStorage?: AvatarStorage;
  memberMediaStorage?: MemberMediaStorage;
  log?: (entry: { action: string; code: string }) => void;
}
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
