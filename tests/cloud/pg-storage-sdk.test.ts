import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAvatarStorage } from '../../cloudfunctions/oradv/avatar-storage';
import { createMemberMediaStorage } from '../../cloudfunctions/oradv/member-media-storage';
import { createPgCompatibleStorageSdk, parseCloudFileId, splitBucketPath } from '../../cloudfunctions/oradv/pg-storage-sdk';
import { MemoryStore } from '../../shared/memory-store';
import { createService } from '../../shared/service';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { memberIdFor, userIdFor } from '../../shared/models';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const BYTES = Buffer.from(PNG, 'base64');
const MEMBER = `member_${'a'.repeat(64)}`;
const ASSET = `media_${'b'.repeat(64)}`;

test('pg-compatible storage sdk falls back from SDK_UPGRADE_REQUIRED, caches clientCredential tokens, and refreshes on 401', async () => {
  const objects = new Map<string, Buffer>();
  let tokenCount = 0;
  let force401Once = false;
  let classicCalls = 0;

  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.pathname === '/auth/v1/token/clientCredential') {
      tokenCount++;
      const auth = String((init?.headers as Record<string, string>)?.Authorization || '');
      assert.match(auth, /^TC3-HMAC-SHA256 Credential=sid-test\//);
      return new Response(JSON.stringify({ access_token: `pg-token-${tokenCount}`, expires_in: 3600 }), { status: 200 });
    }
    const auth = String((init?.headers as Record<string, string>)?.Authorization || '');
    if (force401Once) {
      force401Once = false;
      return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
    }
    assert.equal(auth, `Bearer pg-token-${tokenCount}`);

    if (init?.method === 'PUT' && url.pathname.startsWith('/v1/storages/object/')) {
      const key = decodeURIComponent(url.pathname.slice('/v1/storages/object/'.length));
      objects.set(key, Buffer.from(init.body as Uint8Array));
      return new Response(JSON.stringify({ Id: 'obj-1', Key: key }), { status: 200 });
    }
    if (init?.method === 'POST' && url.pathname.startsWith('/v1/storages/object/sign/')) {
      const key = decodeURIComponent(url.pathname.slice('/v1/storages/object/sign/'.length));
      assert(objects.has(key));
      return new Response(JSON.stringify({
        fullSignedURL: `https://test-env-123.api.tcloudbasegateway.com/v1/storages/object/sign/${key}?token=signed`,
      }), { status: 200 });
    }
    if (init?.method === 'GET' && url.pathname.startsWith('/v1/storages/object/')) {
      const key = decodeURIComponent(url.pathname.slice('/v1/storages/object/'.length));
      const found = objects.get(key);
      return found ? new Response(new Uint8Array(found), { status: 200 }) : new Response('missing', { status: 404 });
    }
    if (init?.method === 'DELETE' && url.pathname.startsWith('/v1/storages/object/')) {
      const bucket = decodeURIComponent(url.pathname.slice('/v1/storages/object/'.length));
      const body = JSON.parse(String(init.body)) as { prefixes: string[] };
      for (const prefix of body.prefixes) objects.delete(`${bucket}/${prefix}`);
      return new Response(JSON.stringify(body.prefixes.map(name => ({ name, bucket_id: bucket }))), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${init?.method} ${url.pathname}`);
  };

  const sdk = createPgCompatibleStorageSdk({
    envId: () => 'test-env-123',
    credentials: () => ({ secretId: 'sid-test', secretKey: 'skey-test', sessionToken: 'sts-test' }),
    fetchImpl: fetchMock,
    classicSdk: {
      async uploadFile() {
        classicCalls++;
        throw Object.assign(new Error('uploadFile:fail This operation is not supported in PostgreSQL environments. Please upgrade your SDK.'), { code: 'SDK_UPGRADE_REQUIRED' });
      },
    },
  });

  const avatarStorage = createAvatarStorage(sdk);
  const mediaStorage = createMemberMediaStorage(sdk);

  const avatarFileId = await avatarStorage.save(MEMBER, PNG);
  assert.equal(classicCalls, 1, 'latches onto PG storage after first SDK_UPGRADE_REQUIRED');
  assert.equal(tokenCount, 1);
  assert.match(avatarFileId, /^cloud:\/\/test-env-123\/member-avatars\//);

  const signedAvatarUrl = await avatarStorage.url(avatarFileId);
  assert.match(signedAvatarUrl, /^https:\/\/test-env-123\.api\.tcloudbasegateway\.com\/v1\/storages\/object\/sign\/member-avatars\//);
  assert.equal(tokenCount, 1, 'reuses cached client_credentials token');

  force401Once = true;
  const downloaded = await sdk.downloadFile({ fileID: avatarFileId });
  assert(downloaded);
  assert.equal(downloaded.statusCode, 200);
  assert.deepEqual(downloaded.fileContent, BYTES);
  assert.equal(tokenCount, 2, 'refreshes token automatically on 401');

  await avatarStorage.remove(avatarFileId);
  assert.equal(objects.size, 0);

  const pub = await mediaStorage.saveImage(MEMBER, ASSET, PNG, 'club_public');
  assert.match(pub.fileId, /^cloud:\/\/test-env-123\/club-public-assets\//);
  await mediaStorage.remove(pub.fileId);
  assert.equal(objects.size, 0);

  assert.throws(() => splitBucketPath('unknown-bucket/file.png'));
  assert.throws(() => splitBucketPath('member-avatars/../escape.png'));
  assert.throws(() => parseCloudFileId('https://evil.example/member-avatars/a.png'));
});

test('Chinese basic control qualification labels normalize to basic_control and early-ended multi-day activities transition returned riders to pending_settlement', async () => {
  let currentNow = '2026-11-20T01:00:00.000Z';
  const store: MemoryStore = createDemoStore(currentNow);
  const service = createService(store, { clubId: 'oradv', now: () => currentNow });
  const callAs = async (identity: typeof DEMO_IDENTITIES.owner, action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) => {
    const res = await service.handle({ action, requestId: `req-${Math.random()}`, clubId: 'oradv', payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) }, identity, 'trace');
    assert.equal(res.ok, true, !res.ok ? `${action}: ${res.error.code} ${res.error.message}` : '');
    return (res as { ok: true; data: any }).data;
  };

  const club = await callAs(DEMO_IDENTITIES.owner, 'club.public');
  await callAs(DEMO_IDENTITIES.owner, 'staff.club.save', {
    name: '原始拉力', contactName: '主理人', contactMethod: 'wechat', contactValue: 'oradv_club', contactInstructions: '工作日联系',
  }, club.revision);
  const walletPolicy = await callAs(DEMO_IDENTITIES.owner, 'staff.points.policy.get');
  await callAs(DEMO_IDENTITIES.owner, 'staff.points.policy.save', {
    enabled: true, defaultRewardMode: 'growth', ruleText: '完成核验结算后发放', reason: '初始化测试规则',
  }, walletPolicy.revision);

  const newRiderIdentity = { appId: DEMO_IDENTITIES.member.appId, openId: 'fresh-rider-openid-999' };
  const rider = await callAs(newRiderIdentity, 'identity.ensure', { consentVersions: { privacy: 1, terms: 1 } });
  const riderMemberId = memberIdFor('oradv', userIdFor(newRiderIdentity));
  assert.equal(rider.id, riderMemberId);

  // Grant qualification using Chinese label "基础控车考核" -> normalized to basic_control.
  await callAs(DEMO_IDENTITIES.owner, 'staff.qualification.review', {
    memberId: riderMemberId, type: '基础控车考核', decision: 'approved', reason: '场地实测通过',
  }, 0);

  // Create a 2-day activity requiring "基础控车" -> normalized to basic_control.
  const draft = await callAs(DEMO_IDENTITIES.owner, 'staff.activity.save', {
    title: '两日穿越测试', description: '测试提前收队结算', location: '京北', difficulty: '进阶',
    startAt: '2026-11-21T01:00:00.000Z', endAt: '2026-11-22T10:00:00.000Z', applicationClosesAt: '2026-11-20T12:00:00.000Z',
    capacity: 10, minGrowthPoints: 0, requiredQualifications: ['基础控车'], requiresReview: false,
    pointsRule: { growth: 10, annual: 10, redeemable: 10 }, safetyNotice: '注意安全', equipment: '全套护具',
  });
  assert.deepEqual(draft.requiredQualifications, ['basic_control']);
  const published = await callAs(DEMO_IDENTITIES.owner, 'staff.activity.publish', { activityId: draft.id }, draft.revision);

  const reg = await callAs(newRiderIdentity, 'registration.apply', { activityId: published.id, acceptedRuleVersion: published.ruleVersion });
  const confirmed = await callAs(DEMO_IDENTITIES.owner, 'staff.registration.confirm', { registrationId: reg.id }, reg.revision);
  assert.equal(confirmed.state, 'confirmed');

  // Day 1 start, departure & return check-in, then early end on Day 1!
  currentNow = '2026-11-21T02:00:00.000Z';
  const started = await callAs(DEMO_IDENTITIES.owner, 'staff.activity.start', { activityId: published.id }, published.revision + 1);
  await callAs(DEMO_IDENTITIES.owner, 'staff.checkin.record', { registrationId: reg.id, phase: 'departure', result: 'present' });
  currentNow = '2026-11-21T08:00:00.000Z';
  const afterReturn = await callAs(DEMO_IDENTITIES.owner, 'staff.checkin.record', { registrationId: reg.id, phase: 'return', result: 'present' });
  assert.equal(afterReturn.state, 'checked_in', 'still Day 1 of 2 while activity is in_progress');

  const endedEarly = await callAs(DEMO_IDENTITIES.owner, 'staff.activity.end', { activityId: published.id }, started.revision);
  assert.equal(endedEarly.state, 'ended');

  const preview = await callAs(DEMO_IDENTITIES.owner, 'staff.settlement.preview', { activityId: published.id, ruleVersion: endedEarly.ruleVersion });
  assert.equal(preview.eligibleCount, 1, 'early end promotes Day-1 returned rider to pending_settlement');
  assert.equal(preview.unresolvedCount, 0);

  const settled = await callAs(DEMO_IDENTITIES.owner, 'staff.settlement.run', { activityId: published.id, ruleVersion: endedEarly.ruleVersion });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.successCount, 1);
});
