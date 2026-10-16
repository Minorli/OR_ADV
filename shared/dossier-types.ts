export const DOSSIER_CONSENT_VERSION = 'dossier-purpose-v1';
export const DOSSIER_GEAR = ['helmet', 'armor', 'knee', 'boots'] as const;
export type DossierGear = typeof DOSSIER_GEAR[number];
export interface DossierBike {
  id: string; brand: string; model: string; year: string; plate: string; odometerKm: number | null;
  photoAssetId: string | null; tireAssetId: string | null;
}
export interface DossierDraft {
  riderName: string; ridingExperience: string; contactMethod: 'wechat' | 'phone'; contactValue: string;
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
}
export interface DossierQueueItem {
  memberId: string; nickname: string; memberNumber?: number; revision: number;
  submissionRevision: number; submittedAt: string;
}
export function emptyDossierDraft(): DossierDraft {
  return { riderName: '', ridingExperience: '', contactMethod: 'wechat', contactValue: '', emergencyContact: null,
    gear: { helmet: null, armor: null, knee: null, boots: null }, bikes: [] };
}
