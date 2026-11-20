export const DOSSIER_CONSENT_VERSION = 'dossier-purpose-v1';
export const DOSSIER_GEAR = ['helmet', 'armor', 'knee', 'boots'] as const;
export const DOSSIER_BLOOD_TYPES = ['', 'A型', 'B型', 'AB型', 'O型', '其他'] as const;
export const DOSSIER_JERSEY_SIZES = ['', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'] as const;
export type DossierGear = typeof DOSSIER_GEAR[number];
export interface DossierBike {
  id: string; brand: string; model: string; year: string; plate: string; odometerKm: number | null;
  photoAssetId: string | null; tireAssetId: string | null;
}
export interface DossierDraft {
  riderName: string; age?: string; bloodType?: string; jerseySize?: string;
  ridingExperience: string; contactMethod: 'wechat' | 'phone'; contactValue: string;
  emergencyContact: { name: string; phone: string; relationship: string } | null;
  gear: Record<DossierGear, string | null>; bikes: DossierBike[];
}
export interface DossierSubmission {
  id: string; submissionRevision: number; submittedAt: string; snapshot: DossierDraft;
  consentVersion: string; attested: true;
}
export interface DossierReview {
  decision: 'approved' | 'returned'; reason: string; reviewedAt: string; submissionRevision: number;
}
export interface MemberDossier {
  id: string; clubId: string; memberId: string; kind: 'dossier'; revision: number;
  status: 'draft' | 'pending' | 'approved' | 'returned'; draft: DossierDraft;
  submission: DossierSubmission | null; review: DossierReview | null;
  createdAt: string; updatedAt: string;
  memberNickname?: string; memberNumber?: number;
}
export interface DossierQueueItem {
  memberId: string; nickname: string; memberNumber?: number; revision: number;
  submissionRevision: number; submittedAt: string; status?: 'pending' | 'approved' | 'returned';
}
export function emptyDossierDraft(): DossierDraft {
  return { riderName: '', age: '', bloodType: '', jerseySize: '', ridingExperience: '', contactMethod: 'wechat', contactValue: '', emergencyContact: null,
    gear: { helmet: null, armor: null, knee: null, boots: null }, bikes: [] };
}
