export const CLUB_ID = 'oradv';
export type ActivityState = 'draft' | 'published' | 'closed' | 'in_progress' | 'ended' | 'settled' | 'cancelled';
export type RegistrationState = 'pending_review' | 'waitlisted' | 'pending_confirmation' | 'confirmed' | 'checked_in' | 'pending_settlement' | 'completed' | 'safe_exit' | 'no_show' | 'cancelled' | 'rejected';
export type Role = 'owner' | 'operator' | 'leader' | 'checkin';
export type MemberKind = 'founder' | 'regular';
export type ContactMethod = 'phone' | 'wechat' | 'other';
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
  memberNumber?: number;
  state: RegistrationState; seatState: 'none' | 'held' | 'released';
  reviewDecision: 'pending' | 'not_required' | 'approved' | 'rejected';
  queueSeq: number; attempt: number; revision: number; acceptedRuleVersion: number;
  holdExpiresAt: null; settlementId: string | null; createdAt: string; updatedAt: string;
  activityTitle?: string; nickname?: string; reason?: string;
  lastDepartureDay?: string;
  lastReturnDay?: string;
  memberKindAtApplication?: MemberKind;
  memberKindVersionAtApplication?: number;
  memberKindAtConfirmation?: MemberKind;
  memberKindVersionAtConfirmation?: number;
  confirmationPath?: 'founder_direct' | 'staff_manual';
  confirmedAt?: string;
  confirmedBy?: string;
  memberKind?: MemberKind;
  activityStartAt?: string; activityEndAt?: string; activityLocation?: string; activityState?: ActivityState;
  completionVoided?: boolean;
  voidedAt?: string;
}
export interface MemberSummary {
  id: string; clubId: string; nickname: string; rankingOptIn: boolean;
  memberNumber?: number;
  hasAvatar?: boolean;
  rankingConsentVersion: number; growthPoints: number; annualPoints: number;
  completedCount: number; revision: number; roles: Role[];
  memberKind: MemberKind; memberKindVersion: number; memberKindExpiresAt: string | null;
  recommendationOptIn: boolean; recommendationConsentVersion: number;
  kindRequestStatus: 'pending' | 'resolved' | null; kindRequestedAt: string | null;
}
export interface ClubPublic {
  clubId: string; name: string; contactName: string; contactMethod: ContactMethod;
  contactValue: string; contactInstructions: string; revision: number; configured: boolean;
}
export interface ActivityBriefing {
  id: string; clubId: string; activityId: string; meetingPoint: string; meetingTime: string;
  contactName: string; contactMethod: ContactMethod; contactValue: string;
  checklist: string[]; notes: string; revision: number; updatedAt: string;
}
export interface RecommendationEntry {
  memberPublicId: string; nickname: string; memberKind: MemberKind;
  displayOrder: number; growthPoints?: number; completedCount?: number;
}
export interface StaffRoleSummary { role: Role; revision: number; activityIds: string[] | null; enabled: boolean; expiresAt: string | null }
export interface StaffMemberSummary {
  id: string; memberId: string; nickname: string; memberKind: MemberKind;
  memberNumber?: number;
  memberKindVersion: number; memberKindExpiresAt: string | null; revision: number;
  recommendationOptIn: boolean; recommendationPriority: number;
  kindRequestStatus: 'pending' | 'resolved' | null; kindRequestedAt: string | null;
  status: string; staffRoles: StaffRoleSummary[];
}
export interface LedgerEntry {
  id: string; clubId: string; memberId: string; activityId: string;
  awardType: 'completion' | 'reversal'; businessKey: string;
  growthDelta: number; annualDelta: number; completedCountDelta: number;
  year: number; effectiveAt: string; ruleVersion: number;
  relatedEntryId: string | null; actorId: string; reason: string;
  activityTitle?: string;
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
