const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram'), apiPath = path.join(root, 'services/api.js');
const event = (dataset, value) => ({ currentTarget: { dataset }, detail: { value } });
function page(mode = '') {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages/history-detail/index.js'); delete require.cache[require.resolve(file)]; require(file);
  const p = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  p.onLoad({ activityId: 'history-ride', mode }); return p;
}
function environment() {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=';
  const storage = new Map(), files = new Map([['/temp/image.png', PNG]]), dirs = new Set(['/user-data']); let saved = 0, preview = '', notice = '';
  const absent = () => new Error('ENOENT');
  const fs = {
    accessSync(p) { if (!files.has(p) && !dirs.has(p)) throw absent(); }, mkdirSync(p) { dirs.add(p); },
    statSync(p) { if (!files.has(p)) throw absent(); return { size: Buffer.from(files.get(p), 'base64').length }; },
    readFileSync(p, encoding) { assert.equal(encoding, 'base64'); if (!files.has(p)) throw absent(); return files.get(p); },
    writeFileSync(p, value, encoding) { assert.equal(encoding, 'base64'); files.set(p, value); }, unlinkSync(p) { if (!files.delete(p)) throw absent(); },
    saveFile({ tempFilePath, success }) { const savedFilePath = `/user-data/saved-${++saved}.png`; files.set(savedFilePath, files.get(tempFilePath)); success({ savedFilePath }); },
  };
  global.wx = { env: { USER_DATA_PATH: '/user-data' }, getFileSystemManager: () => fs,
    getStorageSync: k => structuredClone(storage.get(k)), setStorageSync: (k, value) => storage.set(k, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: k => storage.delete(k),
    showModal: async () => ({ confirm: true }), showToast: ({ title }) => { notice = title; }, navigateTo() {}, switchTab() {}, stopPullDownRefresh() {},
    chooseMedia: async () => ({ tempFiles: [{ tempFilePath: '/temp/image.png' }] }), getImageInfo: async () => ({ width: 1, height: 1, type: 'png' }), compressImage: async () => ({ tempFilePath: '/temp/image.png' }),
    previewImage: async ({ current }) => { preview = current; },
  };
  delete require.cache[require.resolve(path.join(root, 'services/member-media.js'))]; delete require.cache[require.resolve(apiPath)];
  const api = require(apiPath); api.resetMock(); api.switchMockRole('member');
  return { api, storage, files, preview: () => preview, notice: () => notice };
}

test('native history publishes actual owner photos and documentary URL, moderates real stars, and withdraws consent', async () => {
  const env = environment(); let p = page(); await p.load(); assert.equal(p.data.error, ''); assert.equal(p.data.own.eligible, true);
  p.field(event({ field: 'comment' }, '集合安排很清楚，希望下次增加休息点。')); p.chooseStars(event({ stars: 2 }));
  await p.saveReview(); assert(p.data.error.includes('确认')); assert.equal(p.data.own.revision, 0);
  p.consent(event({}, ['publish', 'nickname', 'honor'])); await p.saveReview(); assert.equal(p.data.error, ''); assert.equal(p.data.own.review.status, 'pending'); assert.equal(p.data.busy, false);
  env.api.switchMockRole('guest'); let publicPage = page(); await publicPage.load(); assert.deepEqual(publicPage.data.reviews, []);
  env.api.switchMockRole('owner'); p = page('manage'); await p.load(); assert.equal(p.data.error, ''); assert.equal(p.data.queue.length, 1);
  const review = p.data.queue[0]; await p.moderate(event({ id: review.id, decision: 'approved' })); assert(p.data.error.includes('说明'));
  p.reviewReason(event({ id: review.id }, '核对参加记录，尊重车友的实际感受。')); await p.moderate(event({ id: review.id, decision: 'approved' })); assert.equal(p.data.error, ''); assert.equal(p.data.queue[0].status, 'approved');
  await p.uploadPhoto(); assert(env.notice().includes('使用权')); assert.equal(p.data.photoAssetIds.length, 0);
  p.rights(event({}, ['photos', 'film'])); await p.uploadPhoto(); assert.equal(p.data.error, ''); assert.equal(p.data.photoAssetIds.length, 1);
  const photoId = p.data.photoAssetIds[0]; assert(env.files.has(p.data.photoUrls[photoId]));
  for (const [field, value] of Object.entries({ intro: '本场按计划完成基础练习，并逐一核对回场。', documentaryInput: 'https://films.example.com/ride.mp4?token=private', documentaryTitle: '本场纪录', reason: '核对本场照片与车友公开意愿' })) p.field(event({ field }, value));
  p.visibility(event({}, true)); await p.saveStory(); assert(p.data.error.includes('MP4')); assert.equal(p.data.photoAssetIds[0], photoId, 'invalid URL keeps selected images and draft text');
  p.field(event({ field: 'documentaryInput' }, 'https://films.example.com/ride.mp4'));
  p.honor(event({ slot: 0 }, String(p.data.honorChoices.findIndex(row => row.value === review.publicId)))); p.field(event({ field: 'honor0Label' }, '本场协作'));
  await p.saveStory(); assert.equal(p.data.error, ''); assert.equal(p.data.busy, false);
  env.api.switchMockRole('guest'); publicPage = page(); await publicPage.load(); assert.equal(publicPage.data.error, '');
  assert.equal(publicPage.data.photos.length, 1); assert.equal(publicPage.data.documentaryUrl, 'https://films.example.com/ride.mp4');
  assert.equal(publicPage.data.reviews[0].starText, '★★☆☆☆'); assert.equal(publicPage.data.reviews[0].stars, 2); assert.equal(publicPage.data.detail.story.honors[0].label, '本场协作');
  publicPage.preview(event({ url: publicPage.data.photos[0].url })); assert.equal(env.preview(), publicPage.data.photos[0].url);
  publicPage.videoPlaying(); assert.equal(publicPage.data.playing, true); publicPage.videoFailed(); assert.equal(publicPage.data.playing, false); assert.equal(publicPage.data.documentaryUrl, ''); assert(publicPage.data.videoError.includes('暂时无法播放'));
  publicPage.photoFailed(event({ url: publicPage.data.photos[0].url })); assert.equal(publicPage.data.photos.length, 0);
  await publicPage.load(); assert.equal(publicPage.data.photos.length, 1, 'refresh resolves actual server-authorized gallery again');
  env.api.switchMockRole('member'); p = page(); await p.load(); await p.withdraw(); assert.equal(p.data.error, ''); assert.equal(p.data.own.review.status, 'withdrawn');
  env.api.switchMockRole('guest'); publicPage = page(); await publicPage.load(); assert.deepEqual(publicPage.data.reviews, []); assert.deepEqual(publicPage.data.detail.story.honors, []);
});

test('native history clears private editor state and ignores late responses after identity changes', async () => {
  const env = environment(); env.api.switchMockRole('owner');
  const apiModule = require.cache[require.resolve(apiPath)], real = apiModule.exports; let release, started;
  const began = new Promise(resolve => { started = resolve; });
  apiModule.exports = { ...real, async call(action, ...args) {
    const result = await real.call(action, ...args);
    if (action === 'staff.history.get') { started(); await new Promise(resolve => { release = resolve; }); }
    return result;
  } };
  const p = page('manage'); apiModule.exports = real; const loading = p.load(); await began;
  env.api.switchMockRole('founder'); release(); await loading; assert.equal(p.data.story, null); assert.deepEqual(p.data.queue, []); assert.deepEqual(p.data.photoUrls, {});
  await p.load(); assert(p.data.error.includes('权限')); assert.equal(p.data.isOwner, false); assert.equal(p.data.story, null);
  p.onUnload(); assert.equal(p.data.member, null); assert.equal(p.data.documentaryUrl, '');
});

test('foreground identity checks preserve own dirty form and prevent stale review writes without relying on mock-role changes', async () => {
  const env = environment(); let p = page(); await p.load(); const originalMember = p.data.member.id;
  p.field(event({ field: 'comment' }, '尚未提交的私人草稿')); p.setData({ busy: true });
  await p.onShow(); assert.equal(p.data.comment, '尚未提交的私人草稿'); assert.equal(p.data.busy, true);
  env.api.switchMockRole('founder'); await p.onShow(); assert.equal(p.data.comment, ''); assert.notEqual(p.data.member.id, originalMember);
  env.api.switchMockRole('member');
  const apiModule = require.cache[require.resolve(apiPath)], real = apiModule.exports; let changed = false, writes = 0;
  apiModule.exports = { ...real, async currentMember() { const member = await real.currentMember(); return changed && member ? { ...member, id: `member_${'f'.repeat(64)}` } : member; },
    async call(action, ...args) { if (action === 'history.review.save') writes++; return real.call(action, ...args); } };
  p = page(); apiModule.exports = real; await p.load();
  p.field(event({ field: 'comment' }, '不得写入另一身份的内容')); p.consent(event({}, ['publish', 'nickname']));
  changed = true; await p.saveReview();
  assert.equal(writes, 0); assert.equal(p.data.member, null); assert.equal(p.data.comment, ''); assert(p.data.error.includes('身份已变化'));
  assert.deepEqual(env.storage.get('oradv-beta-store-v3').activity_reviews ?? {}, {});
});
