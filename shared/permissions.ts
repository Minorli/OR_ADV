import type { MemberSummary, Role } from './types';

export const STAFF_ROLES: readonly Role[] = ['owner', 'operator', 'leader', 'checkin', 'content_admin'];
export const PUBLIC_CONTENT_ROLES: Role[] = ['owner', 'content_admin'];
export const ACTIVITY_STAFF_ROLES: Role[] = ['owner', 'operator', 'leader', 'checkin'];
export const canManagePublicContent = (member: Pick<MemberSummary, 'roles'> | null | undefined): boolean => !!member?.roles.some(role => PUBLIC_CONTENT_ROLES.includes(role));
export const canOperateActivities = (member: Pick<MemberSummary, 'roles'> | null | undefined): boolean => !!member?.roles.some(role => ACTIVITY_STAFF_ROLES.includes(role));
export function businessAdminTitle(member: Pick<MemberSummary, 'roles' | 'adminDesignation'> | null | undefined): string {
  return member?.roles.includes('owner') ? member.adminDesignation === 'manager' ? '车队经理' : '主理人' : '';
}
