import { requireThat } from './errors';
import { key } from './models';
import type { Transaction } from './store';

export interface MemberNumberSequence {
  id: string; clubId: string; kind: 'member_sequence'; nextNumber: number;
  primaryOwnerMemberId: string | null;
  reservedNumbers?: number[];
}
export interface MemberNumberClaim {
  id: string; clubId: string; kind: 'member_number_claim'; memberNumber: number; memberId: string;
}
export const memberSequenceId = (clubId: string) => key('member-sequence', clubId);
export const memberNumberClaimId = (clubId: string, number: number) => key('member-number', clubId, number);
export const validMemberNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function readMemberNumber(value: unknown): number | undefined {
  requireThat(value === undefined || validMemberNumber(value), 'STATE_CONFLICT', '成员编号异常，请联系主理人核对');
  return value as number | undefined;
}
export function validateMemberSequence(row: MemberNumberSequence, clubId: string): void {
  requireThat(row.id === memberSequenceId(clubId) && row.clubId === clubId && row.kind === 'member_sequence'
    && validMemberNumber(row.nextNumber) && row.nextNumber >= 1
    && (row.reservedNumbers === undefined || Array.isArray(row.reservedNumbers) && row.reservedNumbers.length <= 100
      && row.reservedNumbers.every(number => validMemberNumber(number) && number > 0 && number < Number.MAX_SAFE_INTEGER)
      && new Set(row.reservedNumbers).size === row.reservedNumbers.length)
    && (row.primaryOwnerMemberId === null || typeof row.primaryOwnerMemberId === 'string' && /^member_[a-f0-9]{64}$/.test(row.primaryOwnerMemberId)),
  'STATE_CONFLICT', '编号计数异常，请联系主理人处理');
}
export function validateMemberNumberClaim(row: MemberNumberClaim, clubId: string): void {
  requireThat(row.clubId === clubId && row.kind === 'member_number_claim' && validMemberNumber(row.memberNumber)
    && row.id === memberNumberClaimId(clubId, row.memberNumber) && typeof row.memberId === 'string' && /^member_[a-f0-9]{64}$/.test(row.memberId),
  'STATE_CONFLICT', '编号占用记录异常，请联系主理人处理');
}
async function sequence(tx: Transaction, clubId: string): Promise<MemberNumberSequence> {
  const row = await tx.get<MemberNumberSequence>('clubs', memberSequenceId(clubId));
  if (row) { validateMemberSequence(row, clubId); return row; }
  return { id: memberSequenceId(clubId), clubId, kind: 'member_sequence', nextNumber: 1, primaryOwnerMemberId: null };
}

/** Called inside the same transaction that creates the identity and membership. */
export async function allocateMemberNumber(tx: Transaction, clubId: string, memberId: string): Promise<number> {
  const current = await sequence(tx, clubId);
  let number = current.nextNumber;
  const reserved = new Set(current.reservedNumbers ?? []);
  while (reserved.has(number)) {
    const claim = await tx.get<MemberNumberClaim>('clubs', memberNumberClaimId(clubId, number));
    requireThat(claim, 'STATE_CONFLICT', '保留编号缺少占用记录，请联系主理人处理');
    validateMemberNumberClaim(claim, clubId);
    requireThat(claim.memberNumber === number, 'STATE_CONFLICT', '保留编号占用记录不一致');
    number++;
  }
  requireThat(number < Number.MAX_SAFE_INTEGER, 'STATE_CONFLICT', '成员编号已达上限，请联系主理人处理');
  requireThat(!await tx.get('clubs', memberNumberClaimId(clubId, number)), 'STATE_CONFLICT', '编号已被占用，请联系主理人核对计数');
  await tx.set<MemberNumberClaim>('clubs', memberNumberClaimId(clubId, number), { id: memberNumberClaimId(clubId, number), clubId, kind: 'member_number_claim', memberNumber: number, memberId });
  await tx.set<MemberNumberSequence>('clubs', current.id, { ...current, nextNumber: number + 1 });
  return number;
}

/** Deployment bootstrap only. No RPC action exposes zero reservation. */
export async function reserveOwnerNumber(tx: Transaction, clubId: string, memberId: string, previousNumber?: number): Promise<void> {
  const current = await sequence(tx, clubId);
  requireThat(!current.primaryOwnerMemberId || current.primaryOwnerMemberId === memberId, 'STATE_CONFLICT', '主理人零号已完成初始化');
  readMemberNumber(previousNumber);
  const zeroId = memberNumberClaimId(clubId, 0), zero = await tx.get<MemberNumberClaim>('clubs', zeroId);
  if (zero) {
    validateMemberNumberClaim(zero, clubId);
    requireThat(zero.memberId === memberId, 'STATE_CONFLICT', '主理人零号已被占用');
  }
  let nextNumber = current.nextNumber;
  if (previousNumber !== undefined && previousNumber > 0) {
    requireThat(previousNumber < Number.MAX_SAFE_INTEGER, 'STATE_CONFLICT', '成员编号计数已达上限');
    const oldId = memberNumberClaimId(clubId, previousNumber), oldClaim = await tx.get<MemberNumberClaim>('clubs', oldId);
    if (oldClaim) {
      validateMemberNumberClaim(oldClaim, clubId);
      requireThat(oldClaim.memberId === memberId, 'STATE_CONFLICT', '成员原编号占用记录不一致');
    } else await tx.set<MemberNumberClaim>('clubs', oldId, { id: oldId, clubId, kind: 'member_number_claim', memberNumber: previousNumber, memberId });
    nextNumber = Math.max(nextNumber, previousNumber + 1);
  }
  if (!zero) await tx.set<MemberNumberClaim>('clubs', zeroId, { id: zeroId, clubId, kind: 'member_number_claim', memberNumber: 0, memberId });
  await tx.set<MemberNumberSequence>('clubs', current.id, { ...current, nextNumber, primaryOwnerMemberId: memberId });
}
