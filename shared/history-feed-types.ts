import type { PublicHistoryDetail } from './history-content-types';

export interface HistoryFeedCard extends PublicHistoryDetail {
  /** Total is exact only if every candidate was checked; two previews are never presented as a total. */
  reviews: PublicHistoryDetail['reviews'] & { total: number | null };
}
export interface HistoryFeed {
  items: HistoryFeedCard[]; nextCursor: string | null;
  /** Actual public archive months observed while paging, YYYY-MM, newest first. */
  months: string[];
}
