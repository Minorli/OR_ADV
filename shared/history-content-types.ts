import type { ActivityDisplayFields } from './activity-display';
export const HISTORY_REVIEW_CONSENT_VERSION = 1;
export interface HistoryHonor { reviewPublicId: string; label: string }
export interface ActivityStory {
  id: string; clubId: string; activityId: string; intro: string; photoAssetIds: string[];
  documentaryUrl: string; documentaryTitle: string; videoRightsAcknowledged: boolean;
  honors: HistoryHonor[]; published: boolean; revision: number; updatedBy: string; createdAt: string; updatedAt: string;
}
export interface ActivityReview {
  id: string; clubId: string; activityId: string; memberId: string; userId: string; publicId: string;
  stars: number; comment: string; publishConsent: boolean; nicknameConsent: boolean; honorConsent: boolean;
  consentVersion: number; status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  revision: number; reason: string; reviewedBy: string | null; reviewedAt: string | null;
  publicSort: string; createdAt: string; updatedAt: string;
}
export interface PublicActivityReview { publicId: string; nickname: string; stars: number; comment: string; createdAt: string }
export interface OwnHistoryReview { eligible: boolean; revision: number; review: ActivityReview | null }
export interface StaffHistoryReview { id: string; publicId: string; nickname: string; stars: number; comment: string; honorConsent: boolean; status: ActivityReview['status']; revision: number; reason: string }
export interface PublicHistoryDetail {
  activity: ActivityDisplayFields & { id: string; title: string; description: string; location: string; difficulty: string; startAt: string; endAt: string; actualCompletedAt?: string | null; fixtureOnly: boolean };
  story: { intro: string; photos: { url: string; label: string }[]; photoCount: number; documentary: { url: string; title: string } | null; honors: { nickname: string; label: string }[] } | null;
  reviews: { items: PublicActivityReview[]; nextCursor: string | null };
}
