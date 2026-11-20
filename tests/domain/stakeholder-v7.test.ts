import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { createMemberMediaStorage, type MemberMediaCloudSdk } from '../../cloudfunctions/oradv/member-media-storage';
import { resolveBadgeDetails } from '../../shared/member-badges';
import { SKILL_CATALOG } from '../../shared/learning-content';
import { memberIdFor, statsIdFor, userIdFor } from '../../shared/models';
import type { TrustedIdentity } from '../../shared/types';

const NOW = '2026-11-20T09:00:00.000Z';

function mp4Box(type: string, body: Buffer): Buffer {
  const bytes = Buffer.alloc(8 + body.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write(type, 4, 4, 'ascii');
  body.copy(bytes, 8);
  return bytes;
}

const SAMPLE_MP4 = Buffer.concat([
  mp4Box('ftyp', Buffer.from('isom\0\0\0\0isommp42', 'binary')),
  mp4Box('moov', Buffer.from('or-adv-demo-video-header')),
  mp4Box('mdat', Buffer.alloc(4096, 0x5a)),
]);

function createCloudHarness() {
  const store = createDemoStore(NOW);
  const objects = new Map<string, Buffer>();
  const sdk: MemberMediaCloudSdk = {
    async uploadFile(input) {
      objects.set(input.cloudPath, Buffer.from(input.fileContent));
      return { fileID: `cloud://test.bucket/${input.cloudPath}`, statusCode: 200 };
    },
    async downloadFile(input) {
      const cloudPath = input.fileID.replace(/^cloud:\/\/[^/]+\//, '');
      const buf = objects.get(cloudPath);
      if (!buf) throw new Error(`missing object ${cloudPath}`);
      return { fileContent: Buffer.from(buf), statusCode: 200 };
    },
    async createSignedUploadUrl(input) {
      return { fileID: `cloud://test.bucket/${input.cloudPath}`, uploadUrl: `https://upload.example.test/${input.cloudPath}?token=presigned` };
    },
    async getTempFileURL(input) {
      const fileID = input.fileList[0].fileID;
      const cloudPath = fileID.replace(/^cloud:\/\/[^/]+\//, '');
      if (!objects.has(cloudPath)) return { fileList: [{ fileID, status: -1, tempFileURL: '' }] };
      return { fileList: [{ fileID, status: 0, tempFileURL: `https://cdn.example.test/${cloudPath}?range=206` }] };
    },
    async deleteFile(input) {
      for (const fileID of input.fileList) {
        objects.delete(fileID.replace(/^cloud:\/\/[^/]+\//, ''));
      }
      return { fileList: input.fileList.map(fileID => ({ fileID, status: 0 })) };
    },
  };
  const mediaStorage = createMemberMediaStorage(sdk);
  let seq = 0;
  const service = createService(store, { now: () => NOW, memberMediaStorage: mediaStorage });
  const rpc = async <T = any>(
    action: string,
    payload: Record<string, unknown> = {},
    identity: TrustedIdentity | null = DEMO_IDENTITIES.member,
    expectedRevision?: number,
    requestId = `v7-req-${++seq}`,
  ): Promise<T> => {
    const res = await service.handle({ action, payload, clubId: 'oradv', requestId, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, identity);
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.data as T;
  };
  return { store, objects, rpc };
}

test('dossier accepts optional age, bloodType and jerseySize while rejecting forbidden ID, license and medical fields', async () => {
  const { rpc } = createCloudHarness();
  const initial = await rpc('dossier.mine', {}, DEMO_IDENTITIES.member);
  const validDraft = {
    ...initial.draft,
    riderName: '林野',
    age: '34',
    bloodType: 'O型',
    jerseySize: 'XL',
    contactMethod: 'wechat',
    contactValue: 'linye_adv',
    ridingExperience: '五年非铺装穿越经验',
    bikes: [{ id: 'bike-1', brand: 'KTM', model: '890 ADV R', year: '2024', plate: '', odometerKm: 12000, photoAssetId: null, tireAssetId: null }],
  };
  const saved = await rpc('dossier.save', { draft: validDraft }, DEMO_IDENTITIES.member, initial.revision);
  assert.equal(saved.draft.age, '34');
  assert.equal(saved.draft.bloodType, 'O型');
  assert.equal(saved.draft.jerseySize, 'XL');

  const submitted = await rpc('dossier.submit', { consent: true, consentVersion: 'dossier-purpose-v1' }, DEMO_IDENTITIES.member, saved.revision);
  assert.equal(submitted.submission.snapshot.age, '34');
  assert.equal(submitted.submission.snapshot.bloodType, 'O型');
  assert.equal(submitted.submission.snapshot.jerseySize, 'XL');

  await assert.rejects(rpc('dossier.save', { draft: { ...validDraft, age: '11' } }, DEMO_IDENTITIES.member, submitted.revision), { code: 'INVALID_INPUT' });
  await assert.rejects(rpc('dossier.save', { draft: { ...validDraft, bloodType: 'RH阴性' } }, DEMO_IDENTITIES.member, submitted.revision), { code: 'INVALID_INPUT' });
  await assert.rejects(rpc('dossier.save', { draft: { ...validDraft, jerseySize: '5XL' } }, DEMO_IDENTITIES.member, submitted.revision), { code: 'INVALID_INPUT' });
  for (const forbidden of ['idCard', 'driverLicense', 'vehicleLicense', 'medicalHistory']) {
    await assert.rejects(
      rpc('dossier.save', { draft: { ...validDraft, [forbidden]: 'forbidden' } }, DEMO_IDENTITIES.member, submitted.revision),
      { code: 'INVALID_INPUT' },
    );
  }
});

test('+V multi-badges enforce owner permission, priority tone ordering, certifiedRider sync and live ranking/profile projection', async () => {
  const { rpc } = createCloudHarness();
  const riderId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  await rpc('staff.qualification.review', { memberId: riderId, type: 'basic_control', decision: 'approved', reason: '基础控车通过' }, DEMO_IDENTITIES.owner, 0);

  await assert.rejects(
    rpc('staff.member.badges.save', { memberId: riderId, badges: ['official_team'], reason: '越权测试' }, DEMO_IDENTITIES.member, 1),
    { code: 'FORBIDDEN' },
  );

  const memberRow = (await rpc('staff.member.list', {}, DEMO_IDENTITIES.owner)).items.find((m: any) => m.id === riderId);
  const updated = await rpc(
    'staff.member.badges.save',
    { memberId: riderId, badges: ['media_partner', 'certified_rider', 'official_coach'], reason: '授予官方教官、认证车手与特约影像' },
    DEMO_IDENTITIES.owner,
    memberRow.revision,
  );
  assert.deepEqual(updated.badges, ['official_coach', 'certified_rider', 'media_partner']);

  const display = resolveBadgeDetails(updated.badges);
  assert.equal(display.primaryTone, 'orange');
  assert.deepEqual(display.items.map(i => i.label), ['官方教官', '认证车手', '特约影像']);

  const overview = await rpc('profile.overview', {}, DEMO_IDENTITIES.member);
  assert.deepEqual(overview.member.badges, ['official_coach', 'certified_rider', 'media_partner']);

  const board = await rpc('ranking.list', { metric: 'growth', year: 2026 }, DEMO_IDENTITIES.member);
  const onBoard = board.items.find((r: any) => r.nickname === overview.member.nickname);
  assert(onBoard);
  assert.equal(onBoard.certifiedRider, true);
  assert.deepEqual(onBoard.badges, ['official_coach', 'certified_rider', 'media_partner']);
});

test('unified leaderboard sorts strictly by 1. points desc -> 2. participation count desc -> 3. nickname initial (Pinyin/ASCII) asc', async () => {
  const { store, rpc } = createCloudHarness();
  const riders: { id: TrustedIdentity; nickname: string; points: number; count: number }[] = [
    { id: { appId: 'local', openId: 'rank-top' }, nickname: '周野', points: 150, count: 1 },
    { id: { appId: 'local', openId: 'rank-count-high' }, nickname: '张峰', points: 80, count: 5 },
    { id: { appId: 'local', openId: 'rank-tie-z' }, nickname: '赵雷', points: 80, count: 3 },
    { id: { appId: 'local', openId: 'rank-tie-c' }, nickname: '陈风', points: 80, count: 3 },
    { id: { appId: 'local', openId: 'rank-tie-b' }, nickname: 'Bravo', points: 80, count: 3 },
    { id: { appId: 'local', openId: 'rank-tie-a' }, nickname: '阿哲', points: 80, count: 3 },
  ];

  for (const r of riders) {
    const ensured = await rpc('identity.ensure', { consentVersions: { privacy: 1, terms: 1 } }, r.id);
    const updated = await rpc('profile.update', { nickname: r.nickname }, r.id, ensured.revision);
    const statId = statsIdFor('oradv', updated.id, null);
    await store.transaction(async tx => {
      await tx.set('member_stats', statId, {
        id: statId,
        clubId: 'oradv',
        memberId: updated.id,
        year: null,
        points: r.points,
        completedCount: r.count,
        updatedAt: NOW,
      });
    });
    await rpc('staff.qualification.review', { memberId: updated.id, type: 'basic_control', decision: 'approved', reason: '基础控车通过' }, DEMO_IDENTITIES.owner, 0);
  }

  const board = await rpc('ranking.list', { metric: 'growth', year: 2026, limit: 20 }, riders[0].id);
  const subset = board.items.filter((row: any) => riders.some(r => r.nickname === row.nickname));
  assert.deepEqual(
    subset.map((row: any) => `${row.nickname}:${row.score}:${row.completedCount}`),
    [
      '周野:150:1',
      '张峰:80:5',
      '阿哲:80:3',
      'Bravo:80:3',
      '陈风:80:3',
      '赵雷:80:3',
    ],
  );
});

test('cloud video upload supports both presigned PUT and chunked fallback, enforces high-privilege admin demo rules, and binds to basic & advanced skills', async () => {
  const { objects, rpc } = createCloudHarness();

  // 1. Ordinary member cannot upload public demonstration videos.
  await assert.rejects(
    rpc('media.video.begin', { purpose: 'club_public', label: '越权示范', bytes: SAMPLE_MP4.length, mimeType: 'video/mp4', rightsAcknowledged: true }, DEMO_IDENTITIES.member),
    { code: 'FORBIDDEN' },
  );

  // 2. Grant content_admin to founder and upload basic skill demo via presigned PUT simulation.
  const founderId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.founder));
  await rpc('staff.roles.assign', { memberId: founderId, role: 'content_admin', enabled: true, activityIds: null, expiresAt: null, reason: '授权维护考核示范视频' }, DEMO_IDENTITIES.owner);

  const demoSession = await rpc('media.video.begin', {
    purpose: 'club_public',
    label: '骑行姿态示范',
    bytes: SAMPLE_MP4.length,
    mimeType: 'video/mp4',
    rightsAcknowledged: true,
  }, DEMO_IDENTITIES.founder);
  assert(demoSession.uploadUrl?.startsWith('https://upload.example.test/club-public-assets/_staging/'));
  const stagedPath = demoSession.uploadUrl.replace('https://upload.example.test/', '').replace(/\?.*$/, '');
  objects.set(stagedPath, Buffer.from(SAMPLE_MP4));

  const demoAsset = await rpc('media.video.complete', { assetId: demoSession.assetId }, DEMO_IDENTITIES.founder);
  assert.equal(demoAsset.kind, 'video');
  assert.equal(demoAsset.purpose, 'club_public');
  assert.equal(objects.has(stagedPath), false, 'staging upload object must be cleaned after freezing canonical copy');

  const savedBasicRef = await rpc('staff.skills.reference.save', {
    skillId: 'basic-posture',
    title: '骑行姿态标准动作示范',
    url: '',
    assetId: demoAsset.id,
    verified: true,
    reason: '总教官实拍基础控车示范',
  }, DEMO_IDENTITIES.founder, 0);
  assert.equal(savedBasicRef.assetId, demoAsset.id);
  assert.match(savedBasicRef.url, /^https:\/\/cdn\.example\.test\/club-public-assets\/[a-f0-9-]{36}\.mp4\?range=206$/);

  // 3. Owner uploads advanced skill demo via multi-chunk fallback (`media.video.chunk`) and binds to an advanced skill.
  const advSkillId = SKILL_CATALOG.find(s => s.level === 'advanced')!.id;
  const advSession = await rpc('media.video.begin', {
    purpose: 'club_public',
    label: '陡坡下坡示范',
    bytes: SAMPLE_MP4.length,
    mimeType: 'video/mp4',
    rightsAcknowledged: true,
  }, DEMO_IDENTITIES.owner);
  const half = Math.ceil(SAMPLE_MP4.length / 2);
  await rpc('media.video.chunk', { assetId: advSession.assetId, index: 0, totalChunks: 2, chunkBase64: SAMPLE_MP4.subarray(0, half).toString('base64') }, DEMO_IDENTITIES.owner);
  await rpc('media.video.chunk', { assetId: advSession.assetId, index: 1, totalChunks: 2, chunkBase64: SAMPLE_MP4.subarray(half).toString('base64') }, DEMO_IDENTITIES.owner);
  const advAsset = await rpc('media.video.complete', { assetId: advSession.assetId, totalChunks: 2 }, DEMO_IDENTITIES.owner);
  await rpc('staff.skills.reference.save', {
    skillId: advSkillId,
    title: '进阶动作标准示范',
    url: '',
    assetId: advAsset.id,
    verified: true,
    reason: '总教官实拍进阶控车示范',
  }, DEMO_IDENTITIES.owner, 0);

  // 4. Ordinary member reads `skills.mine` and gets dynamically signed demo URLs for both basic & advanced skills, then uploads own practice video.
  const riderSkills = await rpc('skills.mine', {}, DEMO_IDENTITIES.member);
  const basicPosture = riderSkills.items.find((s: any) => s.id === 'basic-posture');
  const advSteep = riderSkills.items.find((s: any) => s.id === advSkillId);
  assert.match(basicPosture.reference.url, /^https:\/\/cdn\.example\.test\/club-public-assets\//);
  assert.match(advSteep.reference.url, /^https:\/\/cdn\.example\.test\/club-public-assets\//);

  const practiceBegin = await rpc('media.video.begin', {
    purpose: 'skill',
    label: '骑行姿态练习',
    bytes: SAMPLE_MP4.length,
    mimeType: 'video/mp4',
  }, DEMO_IDENTITIES.member);
  await rpc('media.video.chunk', { assetId: practiceBegin.assetId, index: 0, totalChunks: 1, chunkBase64: SAMPLE_MP4.toString('base64') }, DEMO_IDENTITIES.member);
  const practiceAsset = await rpc('media.video.complete', { assetId: practiceBegin.assetId, totalChunks: 1 }, DEMO_IDENTITIES.member);
  const submitted = await rpc('skills.submit', { skillId: 'basic-posture', assetId: practiceAsset.id, note: '场地练习通过' }, DEMO_IDENTITIES.member, 0);
  assert.equal(submitted.state, 'submitted');

  const ownerView = await rpc('media.get', { assetId: practiceAsset.id }, DEMO_IDENTITIES.owner);
  assert.match(ownerView.url, /^https:\/\/cdn\.example\.test\/member-evidence\//);

  // 5. Disguised non-video payload is rejected on complete.
  const fakeBegin = await rpc('media.video.begin', { purpose: 'skill', label: '伪造视频', bytes: 64, mimeType: 'video/mp4' }, DEMO_IDENTITIES.member);
  await rpc('media.video.chunk', { assetId: fakeBegin.assetId, index: 0, totalChunks: 1, chunkBase64: Buffer.alloc(64, 0x89).toString('base64') }, DEMO_IDENTITIES.member);
  await assert.rejects(rpc('media.video.complete', { assetId: fakeBegin.assetId, totalChunks: 1 }, DEMO_IDENTITIES.member), { code: 'INVALID_INPUT' });
});
