const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(root, 'services/api.js');
function page(mode = 'own', memberId = '') {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages/dossier/index.js'); delete require.cache[require.resolve(file)]; require(file);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = values => Object.assign(instance.data, values);
  instance.onLoad({ mode, memberId });
  return instance;
}
function environment() {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
  const storage = new Map(), files = new Map([['/temp/choice.png', png]]), dirs = new Set(['/user-data']);
  let cancel = false, failWrite = false, failAssetWrite = false, confirmRemove = true, count = 0, deferChoice, preview = '';
  const absent = () => new Error('ENOENT: file does not exist');
  const fs = {
    accessSync(p) { if (!files.has(p) && !dirs.has(p)) throw absent(); }, mkdirSync(p) { dirs.add(p); },
    statSync(p) { if (!files.has(p)) throw absent(); return { size: Buffer.from(files.get(p), 'base64').length }; },
    readFileSync(p, encoding) { if (!files.has(p)) throw absent(); assert.equal(encoding, 'base64'); return files.get(p); },
    writeFileSync(p, value, encoding) { if (failWrite || failAssetWrite) throw new Error('disk full'); assert.equal(encoding, 'base64'); files.set(p, value); },
    unlinkSync(p) { if (!files.delete(p)) throw absent(); },
    removeSavedFile({ filePath, success, fail }) { if (files.delete(filePath)) success({}); else fail({ errMsg: 'ENOENT' }); },
    saveFile({ tempFilePath, success, fail }) { if (failWrite) return fail({ errMsg: 'saveFile:fail disk full' }); const savedFilePath = `/saved/choice-${++count}.png`; files.set(savedFilePath, files.get(tempFilePath)); success({ savedFilePath }); },
  };
  global.wx = {
    env: { USER_DATA_PATH: '/user-data' }, getFileSystemManager: () => fs,
    getStorageSync: k => structuredClone(storage.get(k)), setStorageSync: (k, v) => storage.set(k, structuredClone(v)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: k => storage.delete(k),
    showToast() {}, showModal: async () => ({ confirm: confirmRemove, cancel: !confirmRemove }), navigateTo() {},
    async chooseMedia() { if (deferChoice) { const pending = deferChoice; deferChoice = null; await pending; } if (cancel) throw { errMsg: 'chooseMedia:fail cancel' }; return { tempFiles: [{ tempFilePath: '/temp/choice.png' }] }; },
    getImageInfo: async () => ({ width: 1, height: 1, type: 'png' }), compressImage: async () => ({ tempFilePath: '/temp/choice.png' }),
    previewImage: async ({ current }) => { preview = current; },
  };
  delete require.cache[require.resolve(path.join(root, 'services/member-media.js'))];
  delete require.cache[require.resolve(apiPath)]; const api = require(apiPath); api.resetMock(); api.switchMockRole('member');
  return { api, storage, files, cancel: v => { cancel = v; }, failWrite: v => { failWrite = v; }, failAssetWrite: v => { failAssetWrite = v; }, confirmRemove: v => { confirmRemove = v; },
    defer: p => { deferChoice = p; }, preview: () => preview };
}
const event = (dataset, value) => ({ currentTarget: { dataset }, detail: { value } });
async function fill(p) {
  for (const [field, value] of Object.entries({ riderName: '内测骑手', ridingExperience: '三年铺装，半年非铺装', contactValue: 'fictional-rider' })) p.field(event({ field }, value));
  p.addBike(); const id = p.data.draft.bikes[0].id;
  for (const [field, value] of Object.entries({ brand: '测试品牌', model: 'ADV', year: '2023', plate: '', odometerKm: '1200' })) p.bikeField(event({ id, field }, value));
  for (const gear of ['helmet', 'armor', 'knee', 'boots']) await p.upload(event({ gear }));
  await p.upload(event({ bikeId: id, part: 'photoAssetId' })); await p.upload(event({ bikeId: id, part: 'tireAssetId' }));
  assert.equal(p.data.error, ''); return id;
}

test('native dossier edits real draft fields, reopens photos, submits a snapshot and receives owner review', async () => {
  const env = environment(); let p = page(); await p.load(); assert.equal(p.data.error, '');
  const id = await fill(p);
  p.emergency(event({}, true));
  for (const [field, value] of Object.entries({ name: '联系人', phone: '13800000000', relationship: '朋友' })) p.emergencyField(event({ field }, value));
  p.contactMethod(event({}, '1')); p.field(event({ field: 'contactValue' }, '13800000001'));
  p.addBike(); const second = p.data.draft.bikes[1].id;
  assert.equal(p.data.draft.bikes[1].tireAssetId, null, 'one bike tyre photo never certifies a different bike');
  env.confirmRemove(false); await p.removeBike(event({ id: second })); assert.equal(p.data.draft.bikes.length, 2);
  env.confirmRemove(true); await p.removeBike(event({ id: second })); assert.equal(p.data.draft.bikes.length, 1);
  await p.save(); assert.equal(p.data.error, ''); assert.equal(p.data.dirty, false);
  const memberId = p.data.dossier.memberId, snapshot = structuredClone(p.data.draft), photo = p.data.draft.gear.helmet;
  p = page(); await p.load(); assert.deepEqual(p.data.draft, snapshot); assert(p.data.urls[photo].startsWith('/user-data/'));
  await p.preview(event({ assetId: photo })); assert.equal(env.preview(), p.data.urls[photo]);
  await p.submit(); assert(p.data.error.includes('勾选')); assert.equal(p.data.dossier.status, 'draft');
  p.consent(event({}, ['accepted'])); await p.submit(); assert.equal(p.data.error, ''); assert.equal(p.data.dossier.status, 'pending');
  assert.deepEqual(p.data.dossier.submission.snapshot, snapshot);
  env.api.switchMockRole('owner'); const queue = page('queue'); await queue.load(); assert(queue.data.queue.some(x => x.memberId === memberId));
  const reviewer = page('review', memberId); await reviewer.load(); assert.equal(reviewer.data.error, '');
  assert.deepEqual(reviewer.data.draft, snapshot);
  reviewer.reviewReason(event({}, '核对装备与本人提交的车辆资料')); await reviewer.review(event({ decision: 'approved' }));
  assert.equal(reviewer.data.dossier.status, 'approved');
  env.api.switchMockRole('member'); p = page(); await p.load(); assert.equal(p.data.dossier.status, 'approved');
  p.bikeField(event({ id, field: 'odometerKm' }, '1500')); await p.save(); assert.equal(p.data.dossier.status, 'draft');
  assert.deepEqual(p.data.dossier.submission.snapshot, snapshot, 'editing cannot silently change approved evidence');
  p.consent(event({}, ['accepted'])); await p.submit();
  env.api.switchMockRole('owner'); const returned = page('review', memberId); await returned.load();
  await returned.review(event({ decision: 'returned' })); assert(returned.data.error.includes('说明'));
  returned.reviewReason(event({}, '请补充清晰轮胎照片')); await returned.review(event({ decision: 'returned' }));
  env.api.switchMockRole('member'); p = page(); await p.load(); assert.equal(p.data.dossier.status, 'returned');
  assert.equal(p.data.dossier.review.reason, '请补充清晰轮胎照片');
});

test('native dossier preserves choices on cancel or failure, rejects stale identity and cannot read another draft', async () => {
  const env = environment(), p = page(); await p.load();
  await p.upload(event({ gear: 'helmet' })); const first = p.data.draft.gear.helmet;
  env.cancel(true); await p.upload(event({ gear: 'helmet' })); assert.equal(p.data.draft.gear.helmet, first); assert.equal(p.data.error, '');
  env.cancel(false); env.failWrite(true); await p.upload(event({ gear: 'armor' })); assert.equal(p.data.draft.gear.armor, null); assert(p.data.error);
  env.failWrite(false); await p.save();
  env.failAssetWrite(true); await p.upload(event({ gear: 'armor' })); assert.equal(p.data.draft.gear.armor, null); assert.equal(p.data.pendingUploads.length, 1);
  const recovery = page(); await recovery.load(); assert.equal(recovery.data.pendingUploads.length, 1, 'retained selection and its slot survive reopening');
  env.failAssetWrite(false); await recovery.retryUpload(event({ id: recovery.data.pendingUploads[0].draftId }));
  assert(recovery.data.draft.gear.armor); assert.equal(recovery.data.pendingUploads.length, 0); await recovery.save();
  await p.load();
  p.photoFailed(event({ assetId: first })); assert(p.data.photoErrors[first]); assert.equal(p.data.draft.gear.helmet, first);
  await p.loadPhotos(); assert.equal(p.data.photoErrors[first], '');
  let release; env.defer(new Promise(resolve => { release = resolve; })); const pending = p.upload(event({ gear: 'boots' }));
  await new Promise(resolve => setImmediate(resolve)); env.api.switchMockRole('founder'); release(); await pending;
  await p.load(); assert.equal(p.data.draft.gear.helmet, null); assert.equal(p.data.draft.gear.boots, null);
  const ordinaryReview = page('review', p.data.dossier.memberId); await ordinaryReview.load(); assert(ordinaryReview.data.error.includes('主理人'));
  env.api.switchMockRole('member'); await p.load(); assert.equal(p.data.draft.gear.helmet, first, 'original member draft survives account changes');
});

test('dirty dossier foregrounding preserves same-member edits but clears private state when identity changes', async () => {
  const env = environment(), p = page(); await p.load(); const originalId = p.data.viewerId;
  p.field(event({ field: 'riderName' }, '尚未保存的私人称呼'));
  p.field(event({ field: 'contactValue' }, 'private-contact-not-shared'));
  await p.onShow();
  assert.equal(p.data.viewerId, originalId); assert.equal(p.data.dirty, true);
  assert.equal(p.data.draft.riderName, '尚未保存的私人称呼', 'normal foregrounding must preserve unsaved edits');
  env.api.switchMockRole('founder'); await p.onShow();
  assert.notEqual(p.data.viewerId, originalId); assert.equal(p.data.draft.riderName, ''); assert.equal(p.data.draft.contactValue, '');
  assert.deepEqual(p.data.urls, {}); assert.deepEqual(p.data.pendingUploads, []);
  assert.equal(p.data.dirty, false); assert.equal(p.data.saving, false); assert.equal(p.data.uploading, false);
});

test('save before foreground validation never writes the previous member draft into the new identity', async () => {
  const env = environment(), p = page(); await p.load();
  p.field(event({ field: 'riderName' }, '上一身份的私人称呼'));
  p.field(event({ field: 'contactValue' }, 'previous-private-contact'));
  env.api.switchMockRole('founder');
  await p.save();
  const other = await env.api.call('dossier.mine');
  assert.equal(other.revision, 0); assert.equal(other.draft.riderName, ''); assert.equal(other.draft.contactValue, '');
  assert.equal(p.data.viewerId, other.memberId); assert.equal(p.data.draft.riderName, '');
  assert.equal(p.data.saving, false); assert(p.data.error.includes('身份已变化'));
});

test('identity change during a selected-photo operation clears private controls and discards its late response', async () => {
  const env = environment(), p = page(); await p.load();
  p.field(event({ field: 'riderName' }, '选择照片中的私人称呼'));
  let release; env.defer(new Promise(resolve => { release = resolve; }));
  const pending = p.upload(event({ gear: 'helmet' })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.data.uploading, true);
  env.api.switchMockRole('founder'); await p.onShow(); release(); await pending;
  assert.equal(p.data.draft.riderName, ''); assert.equal(p.data.draft.gear.helmet, null);
  assert.equal(p.data.uploading, false); assert.equal(p.data.saving, false); assert.deepEqual(p.data.urls, {});
});
