import { emptyDossierDraft } from './dossier-types';
import type { MemberDossier } from './dossier-types';
import type { ClubPublic, MemberSummary } from './types';

export interface ProfileDossierProgress {
  status: string; note: string; ready: number; total: number;
  parts: { name: string; ready: boolean }[];
}
export interface ProfileStatistics {
  joinedAt: string | null; rank: number | null; rankedMembers: number | null;
  /** Actual completed distance has no authoritative source yet. Never sum route estimates or odometers. */
  distanceKm: number | null; distanceStatus: 'unrecorded' | 'recorded';
}
export interface ProfileOverview {
  member: MemberSummary | null; contact: ClubPublic; contactError: string;
  dossier: ProfileDossierProgress | null; avatarUrl: string; avatarError: string;
  statistics: ProfileStatistics | null; statisticsError: string;
}
/** Only progress is needed on the profile page; contacts and asset IDs stay out. */
export function profileDossierProgress(dossier: MemberDossier | null): ProfileDossierProgress {
  const draft = dossier?.draft ?? emptyDossierDraft(), bikes = draft.bikes;
  const filled = (pick: (bike: typeof bikes[number]) => boolean) => bikes.length > 0 && bikes.every(pick);
  const parts = [
    { name: '称呼', ready: !!draft.riderName }, { name: '联系方式', ready: !!draft.contactValue }, { name: '骑行经历', ready: !!draft.ridingExperience },
    { name: '品牌', ready: filled(bike => !!bike.brand) }, { name: '车型', ready: filled(bike => !!bike.model) },
    { name: '年份', ready: filled(bike => !!bike.year) }, { name: '里程', ready: filled(bike => typeof bike.odometerKm === 'number') },
  ];
  const statuses = { draft: '骑手资料待准备', pending: '骑手资料等待审核', approved: '本次骑手资料已通过', returned: '骑手资料需补充' };
  const state = dossier?.status ?? 'draft';
  return { status: statuses[state], ready: parts.filter(part => part.ready).length, total: parts.length,
    note: state === 'returned' ? dossier?.review?.reason || '请查看审核补充说明。'
      : state === 'pending' ? `已提交第 ${dossier?.submission?.submissionRevision} 版，等待管理员核对。`
      : state === 'approved' ? '仅适用于本次提交资料；修改后需重新审核。' : '填写称呼、联系方式、骑行经历，以及车辆品牌、车型、年份和里程。照片选填。',
    parts };
}
