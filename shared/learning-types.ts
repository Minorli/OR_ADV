export type SkillLevel = 'basic' | 'advanced';
export interface SafetyQuestion {
  id: string; prompt: string; options: string[]; rightIndex: number; explanation: string;
}
export interface LearningBank {
  id: string; clubId: string; title: string; questions: SafetyQuestion[];
  published: boolean; fixtureOnly: boolean; revision: number;
}
export interface PracticeFeedback {
  questionId: string; prompt: string; selectedIndex: number; rightIndex: number;
  correct: boolean; explanation: string;
}
export interface PracticeView {
  id: string; bankTitle: string; bankRevision: number; fixtureOnly: boolean;
  status: 'in_progress' | 'completed'; revision: number; total: number;
  answeredCount: number; correctCount: number; completedAt: string | null;
  question: { id: string; prompt: string; options: string[] } | null;
  feedback: PracticeFeedback | null;
}
export interface SkillDefinition {
  id: string; level: SkillLevel; title: string; description: string;
}
export interface SkillSubmission {
  id: string; clubId: string; memberId: string; skillId: string; assetId: string;
  note: string; state: 'submitted' | 'approved' | 'changes_requested' | 'withdrawn';
  revision: number; submittedAt: string; updatedAt: string;
  reviewedAt: string | null; reviewedBy: string | null; reviewReason: string;
}
export interface SkillReference {
  id: string; clubId: string; skillId: string; title: string; url: string; revision: number;
}
export interface SkillView extends SkillDefinition {
  submission: Omit<SkillSubmission, 'clubId' | 'memberId' | 'reviewedBy'> | null;
  reference: Pick<SkillReference, 'title' | 'url' | 'revision'> | null;
}
export interface SkillQueueRow extends Omit<SkillSubmission, 'reviewedBy'> {
  nickname: string; memberNumber?: number; skillTitle: string;
}
export interface SkillHistoryEntry extends Omit<SkillSubmission, 'clubId' | 'memberId' | 'reviewedBy'> {
  historyId: string; recordedAt: string;
}
