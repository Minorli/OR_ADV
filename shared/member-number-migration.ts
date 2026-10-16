import { requireThat } from './errors';
import { key, memberIdFor, userIdFor } from './models';
import type { Audit, Membership, User } from './models';
import { memberNumberClaimId, memberSequenceId, validateMemberNumberClaim, validateMemberSequence } from './member-number';
import type { MemberNumberClaim, MemberNumberSequence } from './member-number';
import type { Transaction } from './store';

export interface MemberNumberMigrationOptions {
  clubId: string; appId: string; developerMemberId: string; employeeMemberId: string;
  expectedDeveloperNumber: number; expectedEmployeeNumber: number;
  expectedDeveloperRevision: number; expectedEmployeeRevision: number;
  actorId: string; traceId: string; now: string;
}
interface MigrationMarker {
  id: string; clubId: string; appId: string; kind: 'member_number_migration'; status: 'closed'; version: 1;
  developerMemberId: string; employeeMemberId: string; expectedDeveloperRevision: number; expectedEmployeeRevision: number;
  previousDeveloperNumber: 1; previousEmployeeNumber: 3; developerMemberNumber: 1024; employeeMemberNumber: 1;
  actorId: string; traceId: string; createdAt: string;
}
export const memberNumberMigrationId = (clubId: string) => key('member-renumber', clubId, 'developer-1024-employee-1');

async function trustedMember(tx: Transaction, options: MemberNumberMigrationOptions, id: string): Promise<Membership> {
  const member = await tx.get<Membership>('memberships', id);
  requireThat(member && member.id === id && member.clubId === options.clubId && member.id === memberIdFor(options.clubId, member.userId)
    && Number.isSafeInteger(member.revision) && member.revision >= 1, 'STATE_CONFLICT', 'Existing bound club member required');
  const user = await tx.get<User>('users', member.userId);
  requireThat(user && user.id === member.userId && user.clubId === options.clubId && user.appId === options.appId && user.status === 'active'
    && typeof user.wxOpenId === 'string' && user.wxOpenId.length > 0 && user.id === userIdFor({ appId: options.appId, openId: user.wxOpenId }),
  'STATE_CONFLICT', 'Member must bind to an active trusted user in the deployment AppID');
  return member;
}
async function claimed(tx: Transaction, clubId: string, number: number): Promise<MemberNumberClaim | null> {
  const row = await tx.get<MemberNumberClaim>('clubs', memberNumberClaimId(clubId, number));
  if (row) { validateMemberNumberClaim(row, clubId); requireThat(row.memberNumber === number, 'STATE_CONFLICT', 'Claim number does not match its document'); }
  return row;
}

/** One explicitly authorized deployment migration. Never expose through RPC. */
export async function migrateMemberNumbers(tx: Transaction, options: MemberNumberMigrationOptions) {
  const { clubId, appId, developerMemberId, employeeMemberId, expectedDeveloperRevision, expectedEmployeeRevision, actorId, traceId, now } = options;
  requireThat(/^[a-zA-Z0-9_-]{1,60}$/.test(clubId) && /^wx[a-fA-F0-9]{16}$/.test(appId)
    && /^member_[a-f0-9]{64}$/.test(developerMemberId) && /^member_[a-f0-9]{64}$/.test(employeeMemberId) && developerMemberId !== employeeMemberId
    && options.expectedDeveloperNumber === 1 && options.expectedEmployeeNumber === 3
    && [expectedDeveloperRevision, expectedEmployeeRevision].every(value => Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER)
    && /^deployment:[A-Za-z0-9_.:-]{1,100}$/.test(actorId) && /^[A-Za-z0-9_.:-]{1,120}$/.test(traceId)
    && typeof now === 'string' && Number.isFinite(Date.parse(now)), 'INVALID_INPUT', 'Explicit trusted migration parameters required');
  const markerId = memberNumberMigrationId(clubId), marker = await tx.get<MigrationMarker>('schema_migrations', markerId);
  const developer = await trustedMember(tx, options, developerMemberId), employee = await trustedMember(tx, options, employeeMemberId);
  const sequence = await tx.get<MemberNumberSequence>('clubs', memberSequenceId(clubId));
  requireThat(sequence, 'STATE_CONFLICT', 'Existing member sequence required'); validateMemberSequence(sequence, clubId);
  requireThat(sequence.nextNumber >= 4, 'STATE_CONFLICT', 'Member counter has been rolled back');
  const one = await claimed(tx, clubId, 1), three = await claimed(tx, clubId, 3), high = await claimed(tx, clubId, 1024);
  // Zero stays under the separate owner bootstrap; this operation never writes it.
  await claimed(tx, clubId, 0);
  requireThat(three?.memberId === employeeMemberId, 'STATE_CONFLICT', 'Employee original number must remain claimed');
  const auditId = key('member-renumber-audit', clubId), audit = await tx.get<Audit>('audit_logs', auditId);
  if (marker) {
    requireThat(marker.id === markerId && marker.clubId === clubId && marker.appId === appId && marker.kind === 'member_number_migration'
      && marker.status === 'closed' && marker.version === 1 && marker.developerMemberId === developerMemberId && marker.employeeMemberId === employeeMemberId
      && marker.expectedDeveloperRevision === expectedDeveloperRevision && marker.expectedEmployeeRevision === expectedEmployeeRevision
      && marker.previousDeveloperNumber === 1 && marker.previousEmployeeNumber === 3 && marker.developerMemberNumber === 1024 && marker.employeeMemberNumber === 1
      && developer.memberNumber === 1024 && employee.memberNumber === 1 && developer.revision > expectedDeveloperRevision && employee.revision > expectedEmployeeRevision
      && one?.memberId === employeeMemberId && high?.memberId === developerMemberId && sequence.reservedNumbers?.includes(1024)
      && audit?.id === auditId && audit.clubId === clubId && audit.action === 'deployment.member_numbers.migrate' && audit.targetId === markerId
      && audit.actorId === marker.actorId && audit.traceId === marker.traceId
      && audit.summary.developerMemberId === developerMemberId && audit.summary.employeeMemberId === employeeMemberId,
    'STATE_CONFLICT', 'Migration marker or applied state does not match this request');
    return { applied: false, developerMemberNumber: 1024, employeeMemberNumber: 1 };
  }
  requireThat(developer.memberNumber === 1 && employee.memberNumber === 3
    && developer.revision === expectedDeveloperRevision && employee.revision === expectedEmployeeRevision
    && one?.memberId === developerMemberId && !high && !sequence.reservedNumbers?.includes(1024) && (sequence.reservedNumbers?.length ?? 0) < 100,
  'STATE_CONFLICT', 'Current member revisions, numbers or claims differ from the authorized migration');
  requireThat(!audit, 'STATE_CONFLICT', 'Existing migration audit must not be overwritten');
  await tx.set<Membership>('memberships', developerMemberId, { ...developer, memberNumber: 1024, revision: developer.revision + 1, updatedAt: now });
  await tx.set<Membership>('memberships', employeeMemberId, { ...employee, memberNumber: 1, revision: employee.revision + 1, updatedAt: now });
  await tx.set<MemberNumberClaim>('clubs', memberNumberClaimId(clubId, 1024), { id: memberNumberClaimId(clubId, 1024), clubId, kind: 'member_number_claim', memberNumber: 1024, memberId: developerMemberId });
  await tx.set<MemberNumberClaim>('clubs', one!.id, { ...one!, memberId: employeeMemberId });
  await tx.set<MemberNumberSequence>('clubs', sequence.id, { ...sequence, reservedNumbers: [...(sequence.reservedNumbers ?? []), 1024].sort((a, b) => a - b) });
  await tx.set<Audit>('audit_logs', auditId, { id: auditId, clubId, actorId, action: 'deployment.member_numbers.migrate', targetType: 'membership_numbers', targetId: markerId,
    requestId: traceId, traceId, summary: { developerMemberId, employeeMemberId, developerBefore: 1, developerAfter: 1024, employeeBefore: 3, employeeAfter: 1, nextNumber: sequence.nextNumber },
    reason: 'User-authorized developer number reservation and employee number transfer; owner zero and retired three remain reserved', createdAt: now });
  const closed: MigrationMarker = { id: markerId, clubId, appId, kind: 'member_number_migration', status: 'closed', version: 1, developerMemberId, employeeMemberId,
    expectedDeveloperRevision, expectedEmployeeRevision, previousDeveloperNumber: 1, previousEmployeeNumber: 3, developerMemberNumber: 1024, employeeMemberNumber: 1, actorId, traceId, createdAt: now };
  await tx.set('schema_migrations', markerId, closed);
  return { applied: true, developerMemberNumber: 1024, employeeMemberNumber: 1 };
}
