export const CLUB_ID = 'oradv';
export type ActivityState = 'draft' | 'published' | 'closed' | 'in_progress' | 'ended' | 'settled' | 'cancelled';
export type RegistrationState = 'pending_review' | 'waitlisted' | 'pending_confirmation' | 'confirmed' | 'checked_in' | 'pending_settlement' | 'completed' | 'safe_exit' | 'no_show' | 'cancelled' | 'rejected';
export type Role = 'owner' | 'operator' | 'leader' | 'checkin';
export interface Activity {
  id: string; clubId: string; title: string; description: string; location: string;
  difficulty: string; state: ActivityState; startAt: string; endAt: string;
  applicationClosesAt: string; capacity: number; reservedSeats: number;
  minGrowthPoints: number; requiredQualifications: string[]; requiresReview: boolean;
  ruleVersion: number; revision: number; pointsRule: { growth: number; annual: number };
  nextQueueSeq: number; actualCompletedAt: string | null; fixtureOnly?: boolean;
  safetyNotice: string; equipment: string;
  waitlistCount?: number;
  actualStartedAt?: string | null;
}
export interface Registration {
  id: string; clubId: string; activityId: string; memberId: string;
  state: RegistrationState; seatState: 'none' | 'held' | 'released';
  reviewDecision: 'pending' | 'not_required' | 'approved' | 'rejected';
  queueSeq: number; attempt: number; revision: number; acceptedRuleVersion: number;
  holdExpiresAt: null; settlementId: string | null; createdAt: string; updatedAt: string;
  activityTitle?: string; nickname?: string; reason?: string;
  lastDepartureDay?: string;
  completionVoided?: boolean;
  voidedAt?: string;
}
export interface MemberSummary {
  id: string; clubId: string; nickname: string; rankingOptIn: boolean;
  rankingConsentVersion: number; growthPoints: number; annualPoints: number;
  completedCount: number; revision: number; roles: Role[];
}
export interface LedgerEntry {
  id: string; clubId: string; memberId: string; activityId: string;
  awardType: 'completion' | 'reversal'; businessKey: string;
  growthDelta: number; annualDelta: number; completedCountDelta: number;
  year: number; effectiveAt: string; ruleVersion: number;
  relatedEntryId: string | null; actorId: string; reason: string;
}
export interface RankingEntry {
  memberPublicId: string; nickname: string; score: number; rank: number;
  completedCount: number;
}
export interface PageResult<T> { items: T[]; nextCursor: string | null }
export interface PointsResult {
  growthPoints: number; annualPoints: number; completedCount: number;
  year: number; items: LedgerEntry[]; nextCursor: string | null;
}
export interface RpcRequest {
  action: string; requestId: string; clubId: string;
  payload: Record<string, unknown>; expectedRevision?: number;
}
export type RpcResponse<T = unknown> =
  | { ok: true; data: T; traceId: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean }; traceId: string };
export interface TrustedIdentity { appId: string; openId: string }
