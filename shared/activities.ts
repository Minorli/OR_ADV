import { Context, collect, paginated, parseCursor, publicActivity } from './context';
import { integer, requireThat, text } from './errors';
import { key } from './models';
import type { Activity, Checkin, Registration, User } from './models';
import { BETA_MAX_CAPACITY } from './limits';
import { publicClub } from './club';
import { activityWalletReward, validateActivityWalletReward } from './points-wallet';
import { activityDisplayFields } from './activity-display';
import { normalizeQualificationType } from './ranking-board';
import { bindPublicActivityCover } from './member-media';
import type { MemberMediaAsset } from './member-media-types';
import { readFrom } from './store';

export const activityCoverBindingId = (clubId: string, activityId: string) => key('activity_cover', clubId, activityId);

async function resolveActivityCovers<T extends ReturnType<typeof publicActivity>>(ctx: Context, items: T[]): Promise<T[]> {
  const provider = ctx.options.memberMediaStorage;
  const targets = items.filter(item => typeof item.coverAssetId === 'string' && item.coverAssetId.length > 0);
  if (!provider || !targets.length) return items;
  const verifiedRows = await readFrom(ctx.store, async tx => {
    const assets = await Promise.all(targets.map(item => tx.get<MemberMediaAsset>('member_media', item.coverAssetId!)));
    const valid = targets.map((item, idx) => ({ item, asset: assets[idx] }))
      .filter((pair): pair is { item: T; asset: MemberMediaAsset } => Boolean(pair.asset?.clubId === ctx.clubId && pair.asset.status === 'ready'
        && pair.asset.kind === 'image' && pair.asset.purpose === 'club_public' && pair.asset.rightsAcknowledged
        && pair.asset.bindings.includes(activityCoverBindingId(ctx.clubId, pair.item.id)) && pair.asset.fileId));
    const users = await Promise.all(valid.map(pair => tx.get<User>('users', pair.asset.userId)));
    const out: { activityId: string; assetId: string; fileId: string }[] = [];
    for (let idx = 0; idx < valid.length; idx++) {
      if (users[idx]?.status === 'active') out.push({ activityId: valid[idx].item.id, assetId: valid[idx].asset.id, fileId: valid[idx].asset.fileId! });
    }
    return out;
  });
  if (!verifiedRows.length) return items;
  const verified = new Map(verifiedRows.map(row => [row.activityId, row]));
  const fileUrls = new Map<string, string>();
  await Promise.all([...new Set(verifiedRows.map(v => v.fileId))].map(async fileId => {
    try { fileUrls.set(fileId, await provider.url(fileId)); }
    catch { /* Keep card renderable with preset fallback if signing one cover fails transiently. */ }
  }));
  return items.map(item => {
    const info = verified.get(item.id);
    const url = info ? fileUrls.get(info.fileId) : undefined;
    return url ? { ...item, coverUrl: url } : item;
  });
}

const publicStates = ['published','closed','in_progress','ended','settled','cancelled'];
export async function listActivities(ctx: Context, staff = false) {
  let allowedIds: string[] | null = null;
  if (staff) {
    allowedIds = await readFrom(ctx.store, async (tx) => {
      await ctx.prefetchViewer(tx);
      const actor = await ctx.staff(tx, ['owner','operator','leader','checkin']);
      const roles = await ctx.roles(tx, actor);
      return roles.some((role) => role.activityIds === null) ? null : [...new Set(roles.flatMap((role) => role.activityIds ?? []))];
    });
  }
  const state = ctx.request.payload.state ?? (ctx.request.payload.filters as Record<string, unknown> | undefined)?.state;
  if (state !== undefined) requireThat(typeof state === 'string' && [...publicStates, ...(staff ? ['draft'] : [])].includes(state), 'INVALID_INPUT', '活动筛选不正确');
  const cursor = parseCursor(ctx.request.payload.cursor);
  // State-indexed queries keep drafts out of public reads before projection.
  const states = state ? [state as string] : [...publicStates, ...(staff ? ['draft'] : [])];
  const batches = allowedIds === null
    ? await Promise.all(states.map((value) => ctx.store.query<Activity>('activities', { clubId: ctx.clubId, state: value }, { orderBy: 'startAt', direction: 'asc', after: cursor, limit: 21 })))
    : [await readFrom(ctx.store, async (tx) => {
      const loaded = await Promise.all(allowedIds!.map(id => tx.get<Activity>('activities', id)));
      return loaded.filter((activity): activity is Activity => Boolean(activity?.clubId === ctx.clubId && states.includes(activity.state)
        && (!cursor || activity.startAt > String(cursor.value) || (activity.startAt === cursor.value && activity.id > cursor.id))));
    })];
  const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
  const rows = batches.flat().sort((a,b) => compare(a.startAt,b.startAt) || compare(a.id,b.id));
  const page = paginated(rows, 'startAt');
  return { ...page, items: await resolveActivityCovers(ctx, page.items.map(publicActivity)) };
}
export async function getActivity(ctx: Context) {
  const projected = await readFrom(ctx.store, async (tx) => {
    const activity = await ctx.activity(tx, ctx.request.payload.activityId);
    if (activity.state === 'draft') {
      try { await ctx.staff(tx, ['owner','operator','leader','checkin'], activity.id); }
      catch { requireThat(false, 'ACTIVITY_NOT_FOUND', '活动不存在或不可访问'); }
    }
    return publicActivity(activity);
  });
  const [resolved] = await resolveActivityCovers(ctx, [projected]);
  return resolved;
}

function timestamp(value: unknown, name: string) {
  const result = text(value, name, 40);
  requireThat(Number.isFinite(Date.parse(result)) && /Z$|[+-]\d\d:\d\d$/.test(result), 'INVALID_INPUT', `${name}须包含时区`);
  return new Date(result).toISOString();
}
export async function saveActivity(ctx: Context) {
  const p = (ctx.request.payload.activity ?? ctx.request.payload) as Record<string, unknown>;
  requireThat(p && typeof p === 'object' && !Array.isArray(p), 'INVALID_INPUT', '活动资料不正确');
  const allowed = ['id','title','description','location','difficulty','startAt','endAt','applicationClosesAt','capacity','minGrowthPoints','requiredQualifications','requiresReview','pointsRule','safetyNotice','equipment','revision','expectedRevision','coverKey','coverAssetId','distanceKm','itinerary'];
  requireThat(Object.keys(p).every((field) => allowed.includes(field)), 'INVALID_INPUT', '含不允许编辑的活动字段');
  const saved = await ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner','operator']);
    const existing = p.id ? await ctx.activity(tx, p.id) : null;
    if (existing) {
      await ctx.staff(tx, ['owner','operator'], existing.id);
      ctx.revision(existing, ctx.request.expectedRevision ?? p.expectedRevision ?? p.revision);
      requireThat(existing.state === 'draft', 'STATE_CONFLICT', '已发布规则已冻结，请新建活动或联系主理人处理变更');
    }
    const value = { ...existing, ...p };
    const capacity = integer(value.capacity, '名额', 1);
    requireThat(capacity <= BETA_MAX_CAPACITY, 'INVALID_INPUT', `测试版每场最多${BETA_MAX_CAPACITY}人`);
    const qualifications = value.requiredQualifications ?? [];
    requireThat(Array.isArray(qualifications) && qualifications.length <= 10 && qualifications.every((item) => typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 60), 'INVALID_INPUT', '资格条件不正确');
    const normalizedQualifications = [...new Set((qualifications as string[]).map(normalizeQualificationType))];
    const points = value.pointsRule as Record<string, unknown>;
    requireThat(points && typeof points === 'object' && !Array.isArray(points), 'INVALID_INPUT', '请设置活动积分草案');
    requireThat(Object.keys(points).every(field => ['growth', 'annual', 'redeemable', 'walletPolicyVersion'].includes(field)), 'INVALID_INPUT', '积分规则包含不支持的字段');
    const growth = integer(points.growth, '成长奖励'), annual = integer(points.annual, '年度奖励');
    const walletRule = await activityWalletReward(ctx, tx, points.redeemable, growth);
    const startAt = timestamp(value.startAt, '开始时间'), endAt = timestamp(value.endAt, '结束时间'), deadline = timestamp(value.applicationClosesAt, '报名截止时间');
    requireThat(deadline <= startAt && startAt < endAt, 'INVALID_INPUT', '活动时间顺序不正确');
    const id = existing?.id ?? ctx.id();
    const display = activityDisplayFields(value, existing ?? {});
    if (display.coverAssetId) {
      await bindPublicActivityCover(tx, ctx.clubId, actor.member.id, display.coverAssetId, activityCoverBindingId(ctx.clubId, id), existing?.coverAssetId);
    }
    const activity: Activity = { id, clubId: ctx.clubId, title: text(value.title, '标题', 80), description: text(value.description, '活动介绍', 4000),
      location: text(value.location, '公开区域', 100), difficulty: text(value.difficulty ?? '入门', '难度', 30), state: 'draft',
      startAt, endAt, applicationClosesAt: deadline, capacity, reservedSeats: 0,
      minGrowthPoints: integer(value.minGrowthPoints ?? 0, '成长门槛'), requiredQualifications: normalizedQualifications, requiresReview: value.requiresReview !== false,
      ruleVersion: existing?.ruleVersion ?? 1, revision: (existing?.revision ?? 0) + 1,
      pointsRule: { growth, annual, ...walletRule },
      nextQueueSeq: 0, actualCompletedAt: null, safetyNotice: text(value.safetyNotice, '风险说明', 2000), equipment: text(value.equipment, '装备要求', 1000),
      ...display };
    await tx.set('activities', id, activity);
    await ctx.audit(tx, actor, 'activity', id, { state: activity.state, revision: activity.revision });
    return publicActivity(activity);
  });
  const [resolved] = await resolveActivityCovers(ctx, [saved]);
  return resolved;
}

export async function saveActivityContent(ctx: Context) {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every(field => ['activityId', 'title', 'description', 'reason', 'coverKey', 'coverAssetId', 'distanceKm', 'itinerary'].includes(field)), 'INVALID_INPUT', '只可修改活动公开介绍与路线展示');
  const title = text(p.title, '标题', 80), description = text(p.description, '活动介绍', 4000), reason = text(p.reason, '修改原因', 500);
  const saved = await ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, ['owner', 'operator'], text(p.activityId, 'activityId', 100));
    const activity = await ctx.activity(tx, p.activityId);
    ctx.revision(activity);
    requireThat(publicStates.includes(activity.state), 'STATE_CONFLICT', '草稿请使用完整活动编辑');
    const display = activityDisplayFields(p, activity);
    if (p.coverAssetId !== undefined && display.coverAssetId) {
      await bindPublicActivityCover(tx, ctx.clubId, actor.member.id, display.coverAssetId, activityCoverBindingId(ctx.clubId, activity.id), activity.coverAssetId);
    }
    const patch = Object.fromEntries(Object.entries(display).filter(([name]) => p[name] !== undefined));
    const next: Activity = { ...activity, title, description, ...patch, revision: activity.revision + 1 };
    await tx.set('activities', next.id, next);
    await ctx.audit(tx, actor, 'activity', next.id, {
      state: next.state, ruleVersion: next.ruleVersion, revision: next.revision, contentOnly: true,
      before: { title: activity.title.slice(0, 80), description: activity.description.slice(0, 4000) },
      after: { title, description },
      ...(Object.keys(patch).length ? { displayBefore: { coverKey: activity.coverKey ?? null, ...(activity.coverAssetId !== undefined ? { coverAssetId: activity.coverAssetId } : {}), distanceKm: activity.distanceKm ?? null, itinerary: activity.itinerary ?? [] }, displayAfter: display } : {}),
    }, reason);
    return publicActivity(next);
  });
  const [resolved] = await resolveActivityCovers(ctx, [saved]);
  return resolved;
}

export async function changeActivity(ctx: Context, operation: string) {
  const activityId = text(ctx.request.payload.activityId, 'activityId', 100);
  const checkedIn = operation === 'end'
    ? await collect<Registration>(ctx.store, 'registrations', { clubId: ctx.clubId, activityId, state: 'checked_in' })
    : [];
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner','operator'], activityId);
    const activity = await ctx.activity(tx, activityId);
    ctx.revision(activity);
    const transitions: Record<string, { from: string[]; to: Activity['state'] }> = {
      publish: { from: ['draft'], to: 'published' }, close: { from: ['published'], to: 'closed' },
      start: { from: ['published','closed'], to: 'in_progress' }, end: { from: ['in_progress'], to: 'ended' },
      cancel: { from: ['draft','published','closed'], to: 'cancelled' },
    };
    const transition = transitions[operation];
    requireThat(transition?.from.includes(activity.state), 'STATE_CONFLICT', '当前活动状态不允许此操作');
    if (operation === 'publish') {
      await validateActivityWalletReward(ctx, tx, activity);
      requireThat(activity.applicationClosesAt > ctx.now, 'REGISTRATION_CLOSED', '报名截止时间已经过去');
      requireThat((await publicClub(ctx, tx)).configured, 'INVALID_INPUT', '请先由主理人配置有效的组织方联系方式');
    }
    let completedAt = activity.actualCompletedAt;
    if (operation === 'end') {
      completedAt = ctx.request.payload.actualCompletedAt ? timestamp(ctx.request.payload.actualCompletedAt, '实际结束时间') : ctx.now;
      requireThat(completedAt >= (activity.actualStartedAt ?? activity.startAt) && completedAt <= ctx.now, 'INVALID_INPUT', '实际结束时间须在实际出发与当前时间之间');
    }
    if (operation === 'cancel') text(ctx.request.payload.reason, '取消原因', 500);
    const next: Activity = { ...activity, state: transition.to, actualCompletedAt: completedAt, revision: activity.revision + 1,
      ...(operation === 'start' ? { actualStartedAt: ctx.now } : {}) };
    await tx.set('activities', next.id, next);
    if (operation === 'end') {
      for (const candidate of checkedIn) {
        const current = await tx.get<Registration>('registrations', candidate.id);
        if (!current || current.state !== 'checked_in' || !current.lastDepartureDay) continue;
        const returnCheckin = await tx.get<Checkin>('checkins', key('checkin', ctx.clubId, next.id, current.memberId, 'return', current.lastDepartureDay));
        if (returnCheckin?.result === 'present') {
          await tx.set('registrations', current.id, { ...current, state: 'pending_settlement', lastReturnDay: current.lastDepartureDay, revision: current.revision + 1, updatedAt: ctx.now });
        }
      }
    }
    await ctx.audit(tx, actor, 'activity', next.id, { from: activity.state, to: next.state, revision: next.revision,
      ...(operation === 'start' ? { actualStartedAt: ctx.now, earlyStart: ctx.now < activity.startAt } : {}) }, String(ctx.request.payload.reason ?? ''));
    return publicActivity(next);
  }).then(async projected => {
    const [resolved] = await resolveActivityCovers(ctx, [projected]);
    return resolved;
  });
}
