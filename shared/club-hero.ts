import { Context } from './context';
import { requireThat, text } from './errors';
import { key } from './models';
import type { User } from './models';
import { PUBLIC_CONTENT_ROLES } from './permissions';
import { bindPublicHeroMedia } from './member-media';
import type { MemberMediaAsset } from './member-media-types';
import { readFrom } from './store';

export interface ClubHeroSlideInput {
  id: string; assetId: string; kicker: string; title: string; caption: string;
}
export interface ClubHeroSlideView extends ClubHeroSlideInput { cover: string }
export interface ClubHeroDocument {
  id: string; clubId: string; kind: 'club_hero'; slides: ClubHeroSlideInput[];
  revision: number; updatedAt: string; updatedBy: string;
}
export interface ClubHeroView {
  configured: boolean; revision: number; slides: ClubHeroSlideView[];
}

export const heroDocId = (clubId: string) => key('club_hero', clubId);
const optional = (value: unknown, label: string, max: number) => value === undefined || value === '' ? '' : text(value, label, max);

function validateSlides(value: unknown): ClubHeroSlideInput[] {
  requireThat(Array.isArray(value) && value.length <= 6, 'INVALID_INPUT', '轮播图最多保存6张');
  const slides = value.map(item => {
    requireThat(item && typeof item === 'object' && !Array.isArray(item), 'INVALID_INPUT', '轮播条目格式不正确');
    const row = item as Record<string, unknown>;
    requireThat(Object.keys(row).every(name => ['id', 'assetId', 'kicker', 'title', 'caption'].includes(name)), 'INVALID_INPUT', '轮播条目包含不支持的字段');
    const id = text(row.id, '轮播标识', 50);
    requireThat(/^[a-zA-Z0-9_-]+$/.test(id), 'INVALID_INPUT', '轮播标识不正确');
    const assetId = text(row.assetId, '轮播图片', 100);
    requireThat(/^media_[a-f0-9]{64}$/.test(assetId), 'INVALID_INPUT', '请先上传轮播图片');
    return {
      id, assetId,
      kicker: optional(row.kicker, '上标文字', 40) || 'ORIGINAL RALLY',
      title: text(row.title, '主标题', 80),
      caption: optional(row.caption, '副标题', 120),
    };
  });
  requireThat(new Set(slides.map(item => item.id)).size === slides.length, 'INVALID_INPUT', '轮播标识不能重复');
  return slides;
}

export async function getClubHero(ctx: Context, staff = false): Promise<ClubHeroView> {
  requireThat(Object.keys(ctx.request.payload).length === 0, 'INVALID_INPUT', '轮播读取包含不支持的字段');
  const docId = heroDocId(ctx.clubId);
  const initial = await readFrom(ctx.store, async tx => {
    if (staff) await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
    const doc = await tx.get<ClubHeroDocument>('club_content', docId);
    requireThat(!doc || doc.clubId === ctx.clubId, 'FORBIDDEN', '轮播设置不可访问');
    if (!doc?.slides?.length) return { doc, assets: [] as MemberMediaAsset[] };
    const uniqueIds = [...new Set(doc.slides.map(slide => slide.assetId))];
    const rawAssets = await Promise.all(uniqueIds.map(assetId => tx.get<MemberMediaAsset>('member_media', assetId)));
    const validCandidates = rawAssets.filter((asset): asset is MemberMediaAsset => Boolean(asset?.clubId === ctx.clubId && asset.status === 'ready'
      && asset.kind === 'image' && asset.purpose === 'club_public' && asset.rightsAcknowledged && asset.bindings.includes(docId) && asset.fileId));
    const users = await Promise.all(validCandidates.map(asset => tx.get<User>('users', asset.userId)));
    const assets = validCandidates.filter((_, idx) => users[idx]?.status === 'active');
    return { doc, assets };
  });
  if (!initial.doc) return { configured: false, revision: 0, slides: [] };
  if (!initial.doc.slides.length) return { configured: false, revision: initial.doc.revision, slides: [] };
  const provider = ctx.options.memberMediaStorage;
  const resolved = new Map<string, { fileId: string; url: string }>();
  await Promise.all(initial.assets.map(async asset => {
    if (!provider || provider.mode !== asset.storageMode || !asset.fileId) return;
    try { resolved.set(asset.id, { fileId: asset.fileId, url: await provider.url(asset.fileId) }); }
    catch { /* Skip unavailable image rather than failing homepage load. */ }
  }));
  return readFrom(ctx.store, async tx => {
    if (staff) await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
    const current = await tx.get<ClubHeroDocument>('club_content', docId);
    if (!current || current.revision !== initial.doc!.revision || !current.slides.length) {
      return { configured: false, revision: current?.revision ?? 0, slides: [] };
    }
    const checked = await Promise.all(current.slides.map(async slide => {
      const urlInfo = resolved.get(slide.assetId);
      if (!urlInfo) return null;
      const asset = await tx.get<MemberMediaAsset>('member_media', slide.assetId);
      if (!(asset?.status === 'ready' && asset.fileId === urlInfo.fileId && asset.purpose === 'club_public'
        && asset.rightsAcknowledged && asset.bindings.includes(docId))) return null;
      const user = await tx.get<User>('users', asset.userId);
      return user?.status === 'active' ? { ...slide, cover: urlInfo.url } : null;
    }));
    const slides = checked.filter((item): item is ClubHeroSlideView => item !== null);
    return { configured: slides.length > 0, revision: current.revision, slides };
  });
}

export async function saveClubHero(ctx: Context): Promise<ClubHeroView> {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every(name => ['slides', 'rightsAcknowledged'].includes(name)), 'INVALID_INPUT', '轮播保存包含不支持的字段');
  const slides = validateSlides(p.slides);
  if (slides.length > 0) requireThat(p.rightsAcknowledged === true, 'CONSENT_REQUIRED', '请确认轮播图片已取得公开展示授权');
  const docId = heroDocId(ctx.clubId);
  await ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
    const prior = await tx.get<ClubHeroDocument>('club_content', docId);
    requireThat(!prior || prior.clubId === ctx.clubId, 'FORBIDDEN', '轮播设置不可访问');
    ctx.revision(prior ?? { revision: 0 });
    const uniqueAssetIds = [...new Set(slides.map(slide => slide.assetId))];
    const previousAssetIds = [...new Set((prior?.slides ?? []).map(slide => slide.assetId))];
    if (uniqueAssetIds.length > 0) await bindPublicHeroMedia(tx, ctx.clubId, actor.member.id, uniqueAssetIds, docId, previousAssetIds);
    const next: ClubHeroDocument = { id: docId, clubId: ctx.clubId, kind: 'club_hero', slides, revision: (prior?.revision ?? 0) + 1, updatedAt: ctx.now, updatedBy: actor.user.id };
    await tx.set('club_content', docId, next);
    await ctx.audit(tx, actor, 'club_content', docId, { section: 'hero', slideCount: slides.length, revision: next.revision, rightsAcknowledged: slides.length > 0 });
  });
  return getClubHero(new Context(ctx.store, ctx.options, { ...ctx.request, action: 'staff.club.hero.get', payload: {} }, ctx.identity, ctx.traceId), true);
}
