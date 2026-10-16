export type ClubContentSection = 'handbook' | 'points' | 'core' | 'contacts' | 'business' | 'redemption' | 'partners';
export interface ClubTextBlock { heading: string; body: string }
export interface ClubCorePerson { name: string; duty: string; introduction: string; responsibilities: string[] }
export interface ClubContactItem { label: string; name: string; method: 'phone' | 'wechat' | 'address'; value: string; hours: string; note: string }
export interface ClubOffer { id: string; name: string; description: string }
export interface ClubContentDraft {
  title: string; introduction: string; blocks: ClubTextBlock[];
  people: ClubCorePerson[]; contacts: ClubContactItem[]; offers: ClubOffer[];
}
export interface ClubContentDocument extends ClubContentDraft {
  id: string; clubId: string; section: ClubContentSection; status: 'draft' | 'published';
  revision: number; updatedAt: string; publishedAt: string | null;
}
export interface ClubContentView extends ClubContentDraft {
  section: ClubContentSection; configured: boolean; revision: number;
  status: 'draft' | 'published' | 'unconfigured'; updatedAt: string;
}
export interface ClubInquiry {
  id: string; clubId: string; kind: 'business' | 'redemption' | 'partners'; memberId: string;
  nickname: string; contact: string; message: string; offerId: string; offerName: string;
  state: 'open' | 'closed' | 'withdrawn'; reply: string; revision: number;
  createdAt: string; updatedAt: string;
}
