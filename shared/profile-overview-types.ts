import { emptyDossierDraft } from './dossier-types';
import type { MemberDossier } from './dossier-types';
import type { ClubPublic, MemberSummary } from './types';

export interface ProfileDossierProgress {
  status: string; note: string; ready: number; total: number;
  parts: { name: string; ready: boolean }[];
}
export interface ProfileOverview {
  member: MemberSummary | null; contact: ClubPublic; contactError: string;
  dossier: ProfileDossierProgress | null; avatarUrl: string; avatarError: string;
}
/** Only progress is needed on the profile page; contacts and asset IDs stay out. */
export function profileDossierProgress(dossier: MemberDossier | null): ProfileDossierProgress {
  const draft = dossier?.draft ?? emptyDossierDraft(), bikes = draft.bikes;
  const ready = [draft.riderName, draft.ridingExperience, draft.contactValue, ...Object.values(draft.gear),
    ...bikes.flatMap(bike => [bike.brand, bike.model, bike.photoAssetId, bike.tireAssetId])].filter(Boolean).length;
  const statuses = { draft: '骑手资料待准备', pending: '骑手资料等待审核', approved: '本次骑手资料已通过', returned: '骑手资料需补充' };
  const state = dossier?.status ?? 'draft';
  return { status: statuses[state], ready, total: 7 + Math.max(1, bikes.length) * 4,
    note: state === 'returned' ? dossier?.review?.reason || '请查看主理人的补充说明。'
      : state === 'pending' ? `已提交第 ${dossier?.submission?.submissionRevision} 版，等待主理人核对。`
      : state === 'approved' ? '仅适用于本次提交资料；修改后需重新审核。' : '填写称呼与联络办法，准备护具、车辆及轮胎照片。',
    parts: [{ name: '头盔', ready: !!draft.gear.helmet }, { name: '护甲', ready: !!draft.gear.armor },
      { name: '护膝', ready: !!draft.gear.knee }, { name: '靴子', ready: !!draft.gear.boots },
      { name: `车辆 ${bikes.length}`, ready: bikes.length > 0 }, { name: '轮胎', ready: bikes.length > 0 && bikes.every(bike => !!bike.tireAssetId) }] };
}
