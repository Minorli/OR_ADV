import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES, upgradeDemoMemberNumbers } from '../../shared/demo';
import { createService } from '../../shared/service';
import { createCloudHandler } from '../../cloudfunctions/oradv/handler';
import { createMemberMediaStorage, type MemberMediaCloudSdk } from '../../cloudfunctions/oradv/member-media-storage';
import { CLOUD_VIDEO_CHUNK_BYTES } from '../../shared/member-media-types';
import { DOSSIER_CONSENT_VERSION } from '../../shared/dossier-types';
import { starterSafetyQuestions } from '../../shared/learning-content';
import type { TrustedIdentity } from '../../shared/types';

function mp4Box(type: string, body: Buffer): Buffer {
  const bytes = Buffer.alloc(8 + body.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write(type, 4, 4, 'ascii');
  body.copy(bytes, 8);
  return bytes;
}

test('512 KiB chunked video fallback succeeds under 1MB WeChat client cap even when presigning fails, with isolated rate-limit bucket', async () => {
  assert.equal(CLOUD_VIDEO_CHUNK_BYTES, 512 * 1024, 'chunk size must stay <= 512 KiB so Base64 JSON stays < 1 MB');
  const now = '2026-11-20T09:00:00.000Z';
  const store = createDemoStore(now);
  const objects = new Map<string, Buffer>();
  const sdkWithoutPresign: MemberMediaCloudSdk = {
    async uploadFile(input) {
      objects.set(input.cloudPath, Buffer.from(input.fileContent));
      return { fileID: `cloud://test-env/${input.cloudPath}`, statusCode: 200 };
    },
    async downloadFile(input) {
      const rel = input.fileID.replace(/^cloud:\/\/[^/]+\//, '');
      const found = objects.get(rel);
      if (!found) throw new Error(`missing ${rel}`);
      return { fileContent: Buffer.from(found), statusCode: 200 };
    },
    async createSignedUploadUrl() {
      throw new Error('gateway presign temporarily unavailable');
    },
    async getTempFileURL(input) {
      const fileID = input.fileList[0].fileID;
      return { fileList: [{ fileID, status: 0, tempFileURL: `https://cdn.example.test/${fileID.replace(/^cloud:\/\/[^/]+\//, '')}` }] };
    },
    async deleteFile(input) {
      for (const id of input.fileList) objects.delete(id.replace(/^cloud:\/\/[^/]+\//, ''));
      return { fileList: input.fileList.map(fileID => ({ fileID, status: 0 })) };
    },
  };

  const mediaStorage = createMemberMediaStorage(sdkWithoutPresign, 'test-env');
  const service = createService(store, { now: () => now, memberMediaStorage: mediaStorage });
  const realStyleOwner: TrustedIdentity = { appId: 'wx0123456789abcdef', openId: 'qa-v8-chunk-owner' };
  await service.handle({ action: 'identity.ensure', clubId: 'oradv', requestId: 'v8-init-owner', payload: { nickname: '测试管理', consentVersions: { privacy: 1, terms: 1 } } }, realStyleOwner);
  const ownerRow = await service.handle({ action: 'identity.me', clubId: 'oradv', requestId: 'v8-init-me', payload: {} }, realStyleOwner);
  assert(ownerRow.ok);
  await service.handle({ action: 'staff.roles.assign', clubId: 'oradv', requestId: 'v8-init-grant', payload: { memberId: (ownerRow as any).data.id, role: 'owner', enabled: true, activityIds: null, expiresAt: null, reason: '测试授权' } }, DEMO_IDENTITIES.owner);
  const handler = createCloudHandler({
    config: () => ({ envId: 'test-env', appId: realStyleOwner.appId, runtimeEnvId: 'test-env' }),
    context: () => ({ OPENID: realStyleOwner.openId, APPID: realStyleOwner.appId, ENV: 'test-env' }),
    store: () => store,
    now: () => Date.parse(now),
    invoke: (req, id, trace) => service.handle(req, id, trace),
  });

  // Build a 700 KB valid MP4 (> 512 KiB -> 2 chunks)
  const videoBytes = Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom\0\0\0\0isommp42', 'binary')),
    mp4Box('moov', Buffer.from('qa-v8-chunked-video')),
    mp4Box('mdat', Buffer.alloc(700 * 1024, 0x3c)),
  ]);

  let seq = 0;
  const invoke = async (action: string, payload: Record<string, unknown>, expectedRevision?: number) => {
    const event = { action, clubId: 'oradv', requestId: `v8-vid-${++seq}`, payload, ...(expectedRevision !== undefined ? { expectedRevision } : {}) };
    const rawSize = Buffer.byteLength(JSON.stringify(event));
    if (action === 'media.video.chunk') {
      assert(rawSize < 900 * 1024, `chunk envelope (${rawSize} bytes) must stay safely below WeChat 1 MB callFunction limit`);
    }
    const res = await handler(event);
    assert.equal(res.ok, true, JSON.stringify(res));
    return (res as any).data;
  };

  const session = await invoke('media.video.begin', {
    purpose: 'club_public',
    label: '桩桶8字示范',
    bytes: videoBytes.length,
    mimeType: 'video/mp4',
    rightsAcknowledged: true,
  });
  assert.equal(session.uploadUrl, undefined, 'gracefully omits uploadUrl when presign fails');
  assert.equal(session.maxChunkBytes, 512 * 1024);

  const totalChunks = Math.ceil(videoBytes.length / session.maxChunkBytes);
  assert.equal(totalChunks, 2);
  for (let i = 0; i < totalChunks; i++) {
    const slice = videoBytes.subarray(i * session.maxChunkBytes, Math.min(videoBytes.length, (i + 1) * session.maxChunkBytes));
    await invoke('media.video.chunk', {
      assetId: session.assetId,
      index: i,
      totalChunks,
      chunkBase64: slice.toString('base64'),
    });
  }
  const completed = await invoke('media.video.complete', { assetId: session.assetId, totalChunks });
  assert.equal(completed.bytes, videoBytes.length);

  // Verify 130 chunk calls in the same minute do NOT exhaust the 120/min general RPC limit
  const session2 = await invoke('media.video.begin', {
    purpose: 'club_public',
    label: '百片并发压测',
    bytes: 1024,
    mimeType: 'video/mp4',
    rightsAcknowledged: true,
  });
  const tinyChunk = Buffer.alloc(16, 1).toString('base64');
  for (let i = 0; i < 130; i++) {
    await invoke('media.video.chunk', { assetId: session2.assetId, index: i % 10, totalChunks: 10, chunkBase64: tinyChunk });
  }
  // General RPC still succeeds!
  const me = await invoke('identity.me', {});
  assert.equal(me.roles.includes('owner'), true);
});

test('post-midnight return check-in unlocks open departure day and settles cleanly without deadlocking', async () => {
  let currentNow = '2026-10-18T01:30:00.000Z'; // 2026-10-18 09:30 Beijing (activity day)
  const store = createDemoStore('2026-10-15T09:00:00.000Z');
  let seq = 0;
  const service = createService(store, { now: () => currentNow });
  const rpc = async <T = any>(action: string, payload: Record<string, unknown> = {}, id: TrustedIdentity = DEMO_IDENTITIES.owner, rev?: number): Promise<T> => {
    const res = await service.handle({ action, clubId: 'oradv', requestId: `v8-mid-${++seq}`, payload, ...(rev !== undefined ? { expectedRevision: rev } : {}) }, id);
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.data as T;
  };

  // Apply on 2026-10-15 before deadline
  currentNow = '2026-10-15T10:00:00.000Z';
  const actBefore = await rpc('activity.get', { activityId: 'intro-ride' }, DEMO_IDENTITIES.member);
  let reg = await rpc('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: actBefore.ruleVersion }, DEMO_IDENTITIES.member);
  reg = await rpc('staff.registration.review', { registrationId: reg.id, decision: 'approved' }, DEMO_IDENTITIES.owner, reg.revision);
  reg = await rpc('staff.registration.confirm', { registrationId: reg.id }, DEMO_IDENTITIES.owner, reg.revision);

  // Activity starts on 2026-10-18 -> departure recorded -> staff forget return before midnight!
  currentNow = '2026-10-18T02:00:00.000Z';
  const actFresh = await rpc('activity.get', { activityId: 'intro-ride' });
  const started = await rpc('staff.activity.start', { activityId: 'intro-ride' }, DEMO_IDENTITIES.owner, actFresh.revision);
  reg = await rpc('staff.checkin.record', { registrationId: reg.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader, reg.revision);
  assert.equal(reg.state, 'checked_in');
  assert.equal(reg.lastDepartureDay, '2026-10-18');

  // Next morning (2026-10-19 Beijing): staff end activity and close out the open return check-in!
  currentNow = '2026-10-19T02:00:00.000Z';
  const ended = await rpc('staff.activity.end', { activityId: 'intro-ride' }, DEMO_IDENTITIES.owner, started.revision);
  reg = await rpc('staff.checkin.record', { registrationId: reg.id, phase: 'return', result: 'present' }, DEMO_IDENTITIES.leader, reg.revision);
  assert.equal(reg.state, 'pending_settlement');
  assert.equal(reg.lastReturnDay, '2026-10-18');

  const job = await rpc('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: ended.ruleVersion }, DEMO_IDENTITIES.owner, ended.revision);
  assert.equal(job.status, 'completed');
  assert.equal(job.successCount, 1);
  assert.equal((await rpc('activity.get', { activityId: 'intro-ride' })).state, 'settled');
});

test('team manager (#1) views approved/returned rider dossiers, searches #0/#1, and imports starter safety bank', async () => {
  const now = '2026-11-20T09:00:00.000Z';
  const store = createDemoStore(now);
  let seq = 0;
  const service = createService(store, { now: () => now });
  const rpc = async <T = any>(action: string, payload: Record<string, unknown> = {}, id: TrustedIdentity = DEMO_IDENTITIES.owner, rev?: number): Promise<T> => {
    const res = await service.handle({ action, clubId: 'oradv', requestId: `v8-mgr-${++seq}`, payload, ...(rev !== undefined ? { expectedRevision: rev } : {}) }, id);
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.data as T;
  };

  // Register Team Manager and have Primary Owner grant 'owner' + designation 'manager'
  const managerIdentity: TrustedIdentity = { appId: DEMO_IDENTITIES.owner.appId, openId: 'qa-team-manager-1' };
  const mgrMember = await rpc('identity.ensure', { nickname: '车队经理阿凯', consentVersions: { privacy: 1, terms: 1 } }, managerIdentity);
  await rpc('staff.roles.assign', {
    memberId: mgrMember.id,
    role: 'owner',
    designation: 'manager',
    enabled: true,
    activityIds: null,
    expiresAt: null,
    reason: '主理人任命车队经理',
  }, DEMO_IDENTITIES.owner);

  // Search member by #<number> and No.<number>
  const targetNum = mgrMember.memberNumber;
  const foundHash = await rpc('staff.member.list', { query: `#${targetNum}` }, managerIdentity);
  assert.equal(foundHash.items.length, 1);
  assert.equal(foundHash.items[0].memberNumber, targetNum);
  const foundNo = await rpc('staff.member.list', { query: `No. ${targetNum}` }, managerIdentity);
  assert.equal(foundNo.items.length, 1);

  // Ordinary member submits dossier -> Team Manager (#1) approves -> Team Manager (#1) later views approved dossier!
  const initialDossier = await rpc('dossier.mine', {}, DEMO_IDENTITIES.member);
  const savedDossier = await rpc('dossier.save', {
    draft: {
      ...initialDossier.draft,
      riderName: '小李',
      age: '29',
      bloodType: 'O型',
      jerseySize: 'L',
      contactMethod: 'phone',
      contactValue: '13900001234',
      ridingExperience: '3年林道与非铺装经验',
      emergencyContact: { name: '李姐', phone: '13900005678', relationship: '姐姐' },
      bikes: [{ id: 'bike-1', brand: 'KTM', model: '790 ADV R', year: '2025', plate: '', odometerKm: 8200, photoAssetId: null, tireAssetId: null }],
    },
  }, DEMO_IDENTITIES.member, initialDossier.revision);
  const submittedDossier = await rpc('dossier.submit', { consent: true, consentVersion: DOSSIER_CONSENT_VERSION }, DEMO_IDENTITIES.member, savedDossier.revision);
  await rpc('staff.dossier.review', {
    memberId: submittedDossier.memberId,
    decision: 'approved',
    reason: '核实通过',
    submissionRevision: submittedDossier.submission.submissionRevision,
  }, managerIdentity, submittedDossier.revision);

  // Default staff.dossier.get (without includeReviewed) still enforces pending-only guard
  await assert.rejects(rpc('staff.dossier.get', { memberId: submittedDossier.memberId }, managerIdentity), { code: 'STATE_CONFLICT' });
  // Explicit status filter + includeReviewed lets Manager view approved dossier & emergency contact!
  const approvedList = await rpc('staff.dossier.list', { status: 'approved' }, managerIdentity);
  assert.equal(approvedList.items.length, 1);
  assert.equal(approvedList.items[0].memberId, submittedDossier.memberId);
  const reviewedSnapshot = await rpc('staff.dossier.get', { memberId: submittedDossier.memberId, includeReviewed: true }, managerIdentity);
  assert.equal(reviewedSnapshot.status, 'approved');
  assert.equal(reviewedSnapshot.draft.bloodType, 'O型');
  assert.equal(reviewedSnapshot.draft.jerseySize, 'L');
  assert.equal(reviewedSnapshot.draft.emergencyContact?.phone, '13900005678');
  assert(reviewedSnapshot.memberNickname);

  // Team Manager (#1) submits their own dossier: #1 cannot self-approve, Primary Owner (#0) reviews & approves!
  const mgrInitDossier = await rpc('dossier.mine', {}, managerIdentity);
  const mgrSavedDossier = await rpc('dossier.save', {
    draft: {
      ...mgrInitDossier.draft,
      riderName: '经理阿凯',
      contactMethod: 'wechat',
      contactValue: 'akai_adv',
      ridingExperience: '8年拉力领队经验',
      bikes: [{ id: 'mgr-bike-1', brand: 'BMW', model: 'R1250GS ADV', year: '2024', plate: '', odometerKm: 26000, photoAssetId: null, tireAssetId: null }],
    },
  }, managerIdentity, mgrInitDossier.revision);
  const mgrSubmitted = await rpc('dossier.submit', { consent: true, consentVersion: DOSSIER_CONSENT_VERSION }, managerIdentity, mgrSavedDossier.revision);
  await assert.rejects(rpc('staff.dossier.review', {
    memberId: mgrMember.id,
    decision: 'approved',
    reason: '经理尝试自审应被拦截',
    submissionRevision: mgrSubmitted.submission.submissionRevision,
  }, managerIdentity, mgrSubmitted.revision), { code: 'FORBIDDEN' });
  await assert.rejects(rpc('staff.qualification.review', {
    memberId: mgrMember.id,
    type: 'basic_control',
    decision: 'approved',
    expiresAt: null,
    reason: '经理尝试自批资格应被拦截',
  }, managerIdentity, 0), { code: 'FORBIDDEN' });

  // #0 Primary Owner approves #1 Team Manager's dossier & qualification!
  const mgrApprovedByOwner = await rpc('staff.dossier.review', {
    memberId: mgrMember.id,
    decision: 'approved',
    reason: '0号主理人核实1号车队经理资料通过',
    submissionRevision: mgrSubmitted.submission.submissionRevision,
  }, DEMO_IDENTITIES.owner, mgrSubmitted.revision);
  assert.equal(mgrApprovedByOwner.status, 'approved');
  await rpc('staff.qualification.review', {
    memberId: mgrMember.id,
    type: 'basic_control',
    decision: 'approved',
    expiresAt: null,
    reason: '0号主理人核验1号基础控车通过',
  }, DEMO_IDENTITIES.owner, 0);

  // Future new member registers & submits dossier -> visible to BOTH #0 and #1, and #0 or #1 can review!
  const futureIdentity: TrustedIdentity = { appId: DEMO_IDENTITIES.owner.appId, openId: 'qa-future-rider-10' };
  const futureMember = await rpc('identity.ensure', { nickname: '新车友小周', consentVersions: { privacy: 1, terms: 1 } }, futureIdentity);
  const futInit = await rpc('dossier.mine', {}, futureIdentity);
  const futSaved = await rpc('dossier.save', {
    draft: {
      ...futInit.draft,
      riderName: '小周',
      contactMethod: 'wechat',
      contactValue: 'zhou_rally',
      ridingExperience: '1年非铺装入门',
      bikes: [{ id: 'fut-bike-1', brand: 'Honda', model: 'CRF300 Rally', year: '2025', plate: '', odometerKm: 3100, photoAssetId: null, tireAssetId: null }],
    },
  }, futureIdentity, futInit.revision);
  const futSubmitted = await rpc('dossier.submit', { consent: true, consentVersion: DOSSIER_CONSENT_VERSION }, futureIdentity, futSaved.revision);
  const pendingForOwner = await rpc('staff.dossier.list', {}, DEMO_IDENTITIES.owner);
  const pendingForManager = await rpc('staff.dossier.list', {}, managerIdentity);
  assert(pendingForOwner.items.some((r: { memberId: string }) => r.memberId === futureMember.id));
  assert(pendingForManager.items.some((r: { memberId: string }) => r.memberId === futureMember.id));
  const futApproved = await rpc('staff.dossier.review', {
    memberId: futureMember.id,
    decision: 'approved',
    reason: '0号主理人审核新车友资料通过',
    submissionRevision: futSubmitted.submission.submissionRevision,
  }, DEMO_IDENTITIES.owner, futSubmitted.revision);
  assert.equal(futApproved.status, 'approved');

  // Team Manager imports 25 starter safety questions in 1 batch call & publishes -> Ordinary Member takes quiz!
  const bank0 = await rpc('staff.learning.catalog.get', {}, managerIdentity);
  const imported = await rpc('staff.learning.catalog.save', {
    title: '安全穿越知识考核',
    questions: starterSafetyQuestions(),
    published: false,
    reason: '车队经理导入标准参考题草稿',
  }, managerIdentity, bank0.revision);
  assert.equal(imported.questions.length >= 25, true);
  const publishedBank = await rpc('staff.learning.catalog.save', {
    published: true,
    instructorConfirmed: true,
    reason: '总教官核定发布',
  }, managerIdentity, imported.revision);
  assert.equal(publishedBank.published, true);

  const attempt = await rpc('learning.start', {}, DEMO_IDENTITIES.member);
  assert.equal(attempt.total, 20);
});
