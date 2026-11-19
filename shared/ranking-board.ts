import { key } from './models';
import type { Qualification } from './models';
import type { Transaction } from './store';

/** 基础控车考核：五项目全部复核通过，或由管理员记录的 basic_control 资格。 */
export const BASIC_QUALIFICATION = 'basic_control';
export const BASIC_SKILL_IDS = ['basic-posture', 'basic-forward', 'basic-braking', 'basic-turning', 'basic-slopes'] as const;
export const isBasicSkill = (skillId: string) => (BASIC_SKILL_IDS as readonly string[]).includes(skillId);

export interface BasicAssessmentStatus {
  passed: boolean;
  /** When the pass only rests on a dated qualification, the board hides the row after this instant. */
  visibleUntil: string | null;
}
/** Rows written earlier in the same transaction are supplied so visibility never depends on read-your-writes. */
export interface SkillStateOverride { skillId?: string; state?: string; qualification?: Qualification }

export async function basicAssessmentStatus(tx: Transaction, clubId: string, memberId: string, now: string,
  override?: SkillStateOverride): Promise<BasicAssessmentStatus> {
  const qualification = override?.qualification?.type === BASIC_QUALIFICATION ? override.qualification
    : await tx.get<Qualification>('qualifications', key('qualification', clubId, memberId, BASIC_QUALIFICATION));
  const qualified = qualification?.decision === 'approved' && (!qualification.expiresAt || qualification.expiresAt > now);
  if (qualified && !qualification.expiresAt) return { passed: true, visibleUntil: null };
  let skillsPassed = true;
  for (const skillId of BASIC_SKILL_IDS) {
    const state = override?.skillId === skillId && override.state !== undefined ? override.state
      : (await tx.get<{ state?: string }>('skill_submissions', key('skill-submission', clubId, memberId, skillId)))?.state;
    if (state !== 'approved') { skillsPassed = false; break; }
  }
  if (skillsPassed) return { passed: true, visibleUntil: null };
  if (qualified) return { passed: true, visibleUntil: qualification!.expiresAt ?? null };
  return { passed: false, visibleUntil: null };
}

export async function passedBasicAssessment(tx: Transaction, clubId: string, memberId: string, now: string): Promise<boolean> {
  return (await basicAssessmentStatus(tx, clubId, memberId, now)).passed;
}
