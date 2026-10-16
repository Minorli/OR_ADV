import type { MemberSummary } from './types';

export interface WalletPolicy {
  id: string; clubId: string; kind: 'head' | 'version'; version: number; revision: number;
  enabled: boolean; defaultRewardMode: 'growth' | 'zero'; ruleText: string;
  reason: string; updatedBy: string; createdAt: string; updatedAt: string;
}
export interface PublicWalletPolicy {
  configured: boolean; enabled: boolean; version: number; defaultRewardMode: 'growth' | 'zero'; ruleText: string;
}
export interface WalletAccount {
  id: string; clubId: string; memberId: string; balance: number; held: number; revision: number;
  createdAt: string; updatedAt: string;
}
export interface WalletBalance {
  balance: number; held: number; available: number; deficit: number; reservedShortfall: number; restricted: boolean; revision: number;
}
export type WalletEntryKind = 'activity_credit' | 'activity_reversal' | 'hold' | 'release' | 'consume' | 'refund';
export interface WalletLedgerEntry {
  id: string; clubId: string; memberId: string; kind: WalletEntryKind;
  balanceDelta: number; heldDelta: number; policyVersion: number;
  activityId: string | null; sourceLedgerId: string | null; redemptionId: string | null; relatedEntryId: string | null;
  label: string; reason: string; actorId: string; occurredAt: string; recordedAt: string;
  fixtureOnly?: boolean;
}
export interface WalletLedgerView {
  id: string; kind: WalletEntryKind; balanceDelta: number; heldDelta: number; label: string; reason: string;
  activityId: string | null; redemptionId: string | null; occurredAt: string; recordedAt: string;
}
export interface WalletOverview extends WalletBalance {
  member: MemberSummary; policy: PublicWalletPolicy; items: WalletLedgerView[]; nextCursor: string | null;
}

export type RedemptionItemKind = 'goods' | 'service';
export type RedemptionItemStatus = 'draft' | 'published' | 'archived';
export interface RedemptionItem {
  id: string; clubId: string; kind: RedemptionItemKind; name: string; description: string; fulfillmentInstructions: string;
  pointsCost: number; totalStock: number; heldStock: number; fulfilledStock: number;
  sortOrder: number; status: RedemptionItemStatus; offerVersion: number; revision: number;
  creationDigest: string; updatedBy: string; createdAt: string; updatedAt: string;
}
export interface PublicRedemptionItem {
  id: string; kind: RedemptionItemKind; name: string; description: string; fulfillmentInstructions: string;
  pointsCost: number; stockAvailable: number; offerVersion: number; sortOrder: number;
}
export type RedemptionState = 'pending' | 'approved' | 'fulfilled' | 'rejected' | 'cancelled' | 'refunded';
export interface RedemptionRequest {
  id: string; clubId: string; memberId: string; userId: string; submissionId: string; intentDigest: string;
  itemId: string; itemName: string; itemDescription: string; itemKind: RedemptionItemKind; fulfillmentInstructions: string;
  offerVersion: number; policyVersion: number; pointsCost: number; quantity: 1; totalCost: number;
  state: RedemptionState; revision: number; holdId: string;
  reason: string; processedBy: string | null; approvedAt: string | null; fulfilledAt: string | null;
  closedAt: string | null; refundedAt: string | null; refundRestocked: boolean;
  createdAt: string; updatedAt: string;
}
export interface RedemptionView {
  id: string; memberId: string; itemId: string; itemName: string; itemDescription: string; itemKind: RedemptionItemKind;
  fulfillmentInstructions: string; offerVersion: number; policyVersion: number; pointsCost: number; quantity: 1; totalCost: number;
  state: RedemptionState; revision: number; reason: string; approvedAt: string | null; fulfilledAt: string | null;
  closedAt: string | null; refundedAt: string | null; refundRestocked: boolean; createdAt: string; updatedAt: string;
  nickname?: string; memberNumber?: number; memberActive?: boolean;
}
