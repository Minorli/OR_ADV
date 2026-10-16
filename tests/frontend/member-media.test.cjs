const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const app = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(app, 'services/api.js'), mediaPath = path.join(app, 'services/member-media.js');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=', 'base64');
function box(type, body) { const bytes = Buffer.alloc(8 + body.length); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4); body.copy(bytes, 8); return bytes; }
const VIDEO = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', Buffer.from('native-decoder-fixture')), box('mdat', Buffer.from('actual-selected-file-payload'))]);
function environment() {
  const storage = new Map(), files = new Map([['/temp/image.png', PNG], ['/temp/video.mp4', VIDEO]]), dirs = new Set(['/user-data']);
  let selection = '/temp/image.png', sequence = 0, failedWrite = false, failedDelete = false, holdInfo, compressOversized = 0;
  const compressionAttempts = [];
  const missing = () => new Error('ENOENT: file does not exist');
  const fs = {
    accessSync(file) { if (!files.has(file) && !dirs.has(file)) throw missing(); }, mkdirSync(dir) { dirs.add(dir); },
    statSync(file) { if (!files.has(file)) throw missing(); return { size: files.get(file).length }; },
    readFileSync(file, encoding) { if (!files.has(file)) throw missing(); const b = files.get(file); return encoding === 'base64' ? b.toString('base64') : b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
    writeFileSync(file, data, encoding) { if (failedWrite) throw new Error('disk full'); files.set(file, typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data)); },
    unlinkSync(file) { if (!files.delete(file)) throw missing(); },
    saveFile({ tempFilePath, success, fail }) { if (!files.has(tempFilePath) || failedWrite) return fail({ errMsg: 'saveFile:fail' }); const savedFilePath = `/user-data/saved-${++sequence}`; files.set(savedFilePath, Buffer.from(files.get(tempFilePath))); success({ savedFilePath }); },
    removeSavedFile({ filePath, success, fail }) { if (failedDelete || !files.has(filePath)) return fail({ errMsg: 'removeSavedFile:fail' }); files.delete(filePath); success({}); },
  };
  global.wx = {
    env: { USER_DATA_PATH: '/user-data' }, getFileSystemManager: () => fs,
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() {}, async showModal() { return { confirm: true }; },
    async chooseMedia() { if (!selection) throw { errMsg: 'chooseMedia:fail cancel' }; return { tempFiles: [{ tempFilePath: selection, size: files.get(selection)?.length }] }; },
    async getImageInfo({ src }) { if (holdInfo) { const pending = holdInfo; holdInfo = null; await pending; } return { width: 4000, height: 2000, type: 'png', path: src }; },
    async compressImage(options) { compressionAttempts.push(options); const tempFilePath = `/temp/compressed-${++sequence}.png`; files.set(tempFilePath, compressOversized-- > 0 ? Buffer.alloc(70000) : Buffer.from(files.get(options.src))); return { tempFilePath }; },
    async getVideoInfo() { return { duration: 8, width: 720, height: 1280 }; },
  };
  return { storage, files, compressionAttempts, bloatCompression: count => { compressOversized = count; }, select: value => { selection = value; }, setWriteFailure: value => { failedWrite = value; }, setDeleteFailure: value => { failedDelete = value; }, holdImage: value => { holdInfo = value; } };
}
function reopen() {
  delete require.cache[require.resolve(apiPath)]; delete require.cache[require.resolve(mediaPath)];
  return { api: require(apiPath), media: require(mediaPath) };
}

test('actual selected image and short video persist as immutable app-owned mock evidence across reopen', async () => {
  const env = environment(); let { api, media } = reopen(); api.resetMock('empty'); api.switchMockRole('member');
  env.bloatCompression(2);
  const image = await media.chooseAndUploadMemberImage('dossier', '头盔照片');
  assert.deepEqual(env.compressionAttempts.map(item => [item.compressedWidth, item.compressedHeight]), [[1024, 512], [768, 384], [512, 256]]);
  assert(image.previewUrl.startsWith('/user-data/oradv-member-media-v1/')); assert.deepEqual(env.files.get(image.previewUrl), PNG);
  env.files.set('/temp/image.png', Buffer.from('overwritten original')); assert.deepEqual(env.files.get(image.previewUrl), PNG);
  env.select('/temp/video.mp4'); const video = await media.chooseAndUploadMemberVideo('skill', '绕桩练习');
  assert.deepEqual(env.files.get(video.previewUrl), VIDEO);
  env.files.set('/temp/video.mp4', Buffer.from('later overwrite')); assert.deepEqual(env.files.get(video.previewUrl), VIDEO);
  ({ api, media } = reopen());
  assert.equal((await media.resolveMemberMedia(image.assetId)).url, image.previewUrl);
  const resolved = await media.resolveMemberMedia(video.assetId); assert.equal(resolved.asset.storageMode, 'local'); assert.equal(resolved.asset.kind, 'video');
  assert.equal(resolved.asset.fileId, undefined); assert.equal((await media.memberMediaDrafts()).length, 0);
  api.switchMockRole('founder'); await assert.rejects(media.resolveMemberMedia(image.assetId), error => error.code === 'FORBIDDEN');
});

test('failed image save keeps its actual draft for retry, current-member isolation and explicit deletion', async () => {
  const env = environment(); let { api, media } = reopen(); api.resetMock('empty'); api.switchMockRole('member');
  const apiModule = require.cache[require.resolve(apiPath)], real = apiModule.exports;
  apiModule.exports = { ...real, async call(action, ...args) { if (action === 'media.image.save') throw Object.assign(new Error('连接中断，请重试'), { code: 'NETWORK' }); return real.call(action, ...args); } };
  delete require.cache[require.resolve(mediaPath)]; media = require(mediaPath);
  let draftId;
  await assert.rejects(media.chooseAndUploadMemberImage('dossier', '护具照片'), error => { draftId = error.draftId; return error.code === 'NETWORK' && !!draftId; });
  let drafts = await media.memberMediaDrafts(); assert.equal(drafts.length, 1); assert.deepEqual(env.files.get(drafts[0].localPath), PNG);
  const savedPath = drafts[0].localPath;
  api.switchMockRole('founder'); assert.deepEqual(await media.memberMediaDrafts(), []);
  await assert.rejects(media.retryMemberMediaDraft(draftId), error => error.code === 'FORBIDDEN');
  await assert.rejects(media.discardMemberMediaDraft(draftId), error => error.code === 'FORBIDDEN'); assert(env.files.has(savedPath));
  api.switchMockRole('member'); apiModule.exports = real; delete require.cache[require.resolve(mediaPath)]; media = require(mediaPath);
  const retried = await media.retryMemberMediaDraft(draftId); assert(retried.assetId); assert.deepEqual(await media.memberMediaDrafts(), []);
  // Make another retained draft; failed deletion must leave both file and metadata.
  apiModule.exports = { ...real, async call(action, ...args) { if (action === 'media.image.save') throw Object.assign(new Error('连接中断'), { code: 'NETWORK' }); return real.call(action, ...args); } };
  delete require.cache[require.resolve(mediaPath)]; media = require(mediaPath);
  await assert.rejects(media.chooseAndUploadMemberImage('dossier', '车靴'), error => { draftId = error.draftId; return !!draftId; });
  env.setDeleteFailure(true); await assert.rejects(media.discardMemberMediaDraft(draftId), error => error.code === 'LOCAL_DRAFT_DELETE_FAILED');
  drafts = await media.memberMediaDrafts(); assert.equal(drafts.length, 1); assert(env.files.has(drafts[0].localPath));
  env.setDeleteFailure(false); await media.discardMemberMediaDraft(draftId); assert.deepEqual(await media.memberMediaDrafts(), []);
  apiModule.exports = real;
});

test('cancelled choice, oversized or missing local videos and stale selection never claim an upload', async () => {
  const env = environment(); const { api, media } = reopen(); api.resetMock('empty'); api.switchMockRole('member');
  env.select(''); await assert.rejects(media.chooseAndUploadMemberImage('dossier', '未选择'));
  assert.deepEqual(await media.memberMediaDrafts(), []);
  env.files.set('/temp/large.mp4', Buffer.alloc(8 * 1024 * 1024 + 1)); env.select('/temp/large.mp4');
  await assert.rejects(media.chooseAndUploadMemberVideo('skill', '过大短片'), error => error.code === 'INVALID_INPUT');
  const provider = media.createLocalMemberMediaStorage();
  await assert.rejects(provider.saveVideo(`member_${'a'.repeat(64)}`, `media_${'b'.repeat(64)}`, '/not-found.mp4'));
  env.files.set('/temp/fake.mp4', PNG); await assert.rejects(provider.saveVideo(`member_${'a'.repeat(64)}`, `media_${'b'.repeat(64)}`, '/temp/fake.mp4'));
  let release; const pending = new Promise(resolve => { release = resolve; }); env.holdImage(pending); env.select('/temp/image.png');
  const selecting = media.chooseAndUploadMemberImage('dossier', '身份切换前');
  await new Promise(resolve => setImmediate(resolve)); api.switchMockRole('founder'); release();
  await assert.rejects(selecting, error => error.code === 'STALE_IDENTITY');
  assert.deepEqual(await media.memberMediaDrafts(), []);
  assert.equal(Object.keys(env.storage.get('oradv-beta-store-v3').member_media ?? {}).length, 0);
});

test('unavailable cloud video keeps a real persistent draft and explicit mock reset preserves cloud drafts', async () => {
  const env = environment(); const { api } = reopen(); api.resetMock('empty'); api.switchMockRole('member');
  const apiModule = require.cache[require.resolve(apiPath)], real = apiModule.exports;
  apiModule.exports = { ...real, isMock: false, runtime: { ...real.runtime, appId: 'wx1111111111111111', envId: 'cloud-review-a' } };
  delete require.cache[require.resolve(mediaPath)]; let media = require(mediaPath);
  env.select('/temp/video.mp4'); let draftId;
  await assert.rejects(media.chooseAndUploadMemberVideo('skill', '尚未提交的原片'), error => {
    draftId = error.draftId; return error.code === 'MEDIA_VIDEO_UNAVAILABLE' && error.message.includes('尚未提交审核') && !!draftId;
  });
  const draft = (await media.memberMediaDrafts())[0]; assert.equal(draft.id, draftId); assert.equal(draft.scope, 'cloud');
  assert.deepEqual(env.files.get(draft.localPath), VIDEO);
  delete require.cache[require.resolve(mediaPath)]; media = require(mediaPath);
  await assert.rejects(media.retryMemberMediaDraft(draftId), error => error.code === 'MEDIA_VIDEO_UNAVAILABLE');
  assert.equal((await media.memberMediaDrafts()).length, 1);
  apiModule.exports = real; delete require.cache[require.resolve(mediaPath)]; media = require(mediaPath);
  assert.deepEqual(await media.memberMediaDrafts(), []);
  media.clearMockMemberMediaFiles(); assert(env.files.has(draft.localPath));
  assert.equal(env.storage.get('oradv-member-media-drafts-v1')[0].scope, 'cloud');
  assert.equal(Object.keys(env.storage.get('oradv-beta-store-v3').member_media ?? {}).length, 0);
});

test('cloud image and video drafts bind to exact AppID and EnvId; other and legacy environments remain private and untouched', async () => {
  const env = environment(); const { api } = reopen(); api.resetMock('empty'); api.switchMockRole('member');
  const apiModule = require.cache[require.resolve(apiPath)], real = apiModule.exports;
  function cloud(appId, envId) {
    apiModule.exports = { ...real, isMock: false, runtime: { ...real.runtime, appId, envId },
      async call(action, ...args) { if (action === 'media.image.save') throw Object.assign(new Error('测试连接中断'), { code: 'NETWORK' }); return real.call(action, ...args); } };
    delete require.cache[require.resolve(mediaPath)]; return require(mediaPath);
  }
  const appId = 'wx1111111111111111'; let media = cloud(appId, 'cloud-review-a');
  env.select('/temp/image.png'); await assert.rejects(media.chooseAndUploadMemberImage('dossier', '环境 A 的私人照片'), error => error.code === 'NETWORK');
  env.select('/temp/video.mp4');
  for (let number = 0; number < 7; number++) {
    await assert.rejects(media.chooseAndUploadMemberVideo('skill', `环境 A 的短片 ${number}`), error => error.code === 'MEDIA_VIDEO_UNAVAILABLE');
  }
  const original = await media.memberMediaDrafts(); assert.equal(original.length, 8);
  assert(original.some(row => row.kind === 'image')); assert(original.some(row => row.kind === 'video'));
  assert(original.every(row => row.appId === appId && row.envId === 'cloud-review-a'));
  await assert.rejects(media.chooseAndUploadMemberVideo('skill', '超过当前环境额度'), error => error.code === 'LOCAL_DRAFT_LIMIT');
  const legacy = { ...original[0], id: 'legacy-cloud-unscoped', localPath: '/user-data/legacy-cloud' };
  delete legacy.appId; delete legacy.envId; env.files.set(legacy.localPath, Buffer.from(PNG));
  env.storage.set('oradv-member-media-drafts-v1', [...env.storage.get('oradv-member-media-drafts-v1'), legacy]);
  media = cloud(appId, 'cloud-review-b');
  assert.deepEqual(await media.memberMediaDrafts(), []);
  for (const draft of [...original, legacy]) {
    await assert.rejects(media.retryMemberMediaDraft(draft.id), error => error.code === 'FORBIDDEN');
    await assert.rejects(media.discardMemberMediaDraft(draft.id), error => error.code === 'FORBIDDEN');
    assert(env.files.has(draft.localPath));
  }
  await assert.rejects(media.chooseAndUploadMemberVideo('skill', '环境 B 的短片'), error => error.code === 'MEDIA_VIDEO_UNAVAILABLE', 'environment A quota must not block B');
  const inB = await media.memberMediaDrafts(); assert.equal(inB.length, 1); assert.equal(inB[0].envId, 'cloud-review-b');
  media = cloud('wx2222222222222222', 'cloud-review-b'); assert.deepEqual(await media.memberMediaDrafts(), []);
  await assert.rejects(media.discardMemberMediaDraft(inB[0].id), error => error.code === 'FORBIDDEN');
  media = cloud(appId, 'cloud-review-a'); assert.equal((await media.memberMediaDrafts()).length, 8);
  assert(!((await media.memberMediaDrafts()).some(row => row.id === legacy.id)), 'legacy cloud drafts are never auto-adopted');
  apiModule.exports = real; delete require.cache[require.resolve(mediaPath)]; media = require(mediaPath);
  media.clearMockMemberMediaFiles();
  const preserved = env.storage.get('oradv-member-media-drafts-v1'); assert.equal(preserved.length, 10);
  for (const draft of preserved) assert(env.files.has(draft.localPath));
});
