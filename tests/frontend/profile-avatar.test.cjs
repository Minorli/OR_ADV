const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('native profile keeps optional avatars private, durable and scoped to the current identity', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
  const storage = new Map(), files = new Map([['/temp/choice.png', png]]), directories = new Set(['/user-data']);
  const calls = [], notices = [];
  let compressFailure = false, writeFailure = false, readFailure = false, deferImage, compressedContent = png;
  const absent = () => new Error('ENOENT: file does not exist');
  const fs = {
    accessSync(target) { if (!files.has(target) && !directories.has(target)) throw absent(); },
    mkdirSync(target) { directories.add(target); },
    statSync(target) { if (!files.has(target)) throw absent(); return { size: Buffer.from(files.get(target), 'base64').length }; },
    readFile({ filePath, success, fail }) { if (readFailure || !files.has(filePath)) fail({ errMsg: 'readFile:fail' }); else success({ data: files.get(filePath) }); },
    writeFileSync(target, data, encoding) { assert.equal(encoding, 'base64'); if (writeFailure) throw new Error('disk full'); files.set(target, data); },
    unlinkSync(target) { if (!files.delete(target)) throw absent(); },
  };
  global.wx = {
    env: { USER_DATA_PATH: '/user-data' }, getFileSystemManager: () => fs,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast: ({ title }) => notices.push(title), showModal: async () => ({ confirm: true, cancel: false }),
    navigateTo: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
    async getImageInfo({ src }) {
      if (deferImage) { const pending = deferImage; deferImage = undefined; await pending.promise; }
      return { width: src.startsWith('/temp/compressed') ? 256 : 512, height: src.startsWith('/temp/compressed') ? 256 : 512, type: 'png', path: src };
    },
    async compressImage(options) {
      calls.push(options);
      if (compressFailure) throw new Error('compress failed');
      const tempFilePath = `/temp/compressed-${calls.length}.png`; files.set(tempFilePath, compressedContent);
      return { tempFilePath };
    },
  };
  const root = path.resolve(__dirname, '../../app/miniprogram');
  const apiPath = path.join(root, 'services/api.js'), pagePath = path.join(root, 'pages/profile/index.js');
  const openPage = () => {
    let definition; global.Page = value => { definition = value; };
    delete require.cache[require.resolve(pagePath)]; require(pagePath);
    const instance = { ...definition, data: structuredClone(definition.data) };
    instance.setData = values => Object.assign(instance.data, values);
    return instance;
  };
  let api = require(apiPath); api.resetMock('empty');
  let page = openPage(); await page.load(); await page.save();
  assert.equal(await api.currentMember(), null, 'login requires explicit agreement');
  page.consent({ detail: { value: ['accepted'] } }); await page.save();
  assert(page.data.member, 'agreement establishes the mock identity');
  assert.equal(page.data.avatarUrl, '');
  assert.equal(!!page.data.member.hasAvatar, false, 'avatar is optional at login');
  const memberId = page.data.member.id;
  assert.equal(page.data.showEdit, true, 'first login immediately offers the native nickname and avatar editor');
  assert.equal(page.data.nickname, '', 'the default club label does not occupy the WeChat nickname input');
  page.nicknameBlur({ detail: { value: '微信填写的昵称' } });
  assert.equal(page.data.nickname, '微信填写的昵称', 'nickname blur reads the native fill-in value');
  await page.save();
  assert.notEqual((await api.currentMember()).nickname, '微信填写的昵称', 'unreviewed nickname is not sent');
  page.nicknameReview({ detail: { pass: false, timeout: false } });
  page.nicknameBlur({ detail: { value: '' } });
  await page.save();
  assert(page.data.nicknameError, 'native rejection survives the native clearing the input');
  assert.equal(page.data.showEdit, true);
  page.nickname({ detail: { value: '检测超时的称呼' } }); page.nicknameReview({ detail: { pass: true, timeout: true } });
  await page.save(); assert(page.data.nicknameError); assert.notEqual((await api.currentMember()).nickname, '检测超时的称呼');
  page.nickname({ detail: { value: '内测小周' } }); page.nicknameBlur({ detail: { value: '内测小周' } });
  page.nicknameReview({ detail: { pass: true, timeout: false } });
  page.setData({ showEdit: false });
  await page.chooseAvatar({ detail: { avatarUrl: '/temp/choice.png' } });
  assert.equal(page.data.showEdit, true, 'choosing from the header opens the save controls');
  assert.equal(calls[0].compressedWidth, 256); assert.equal(calls[0].compressedHeight, 256);
  const draft = page.data.avatarBase64;
  assert(draft); assert.equal(!!(await api.currentMember()).hasAvatar, false, 'selection alone does not save');
  await page.chooseAvatar({ detail: {} }); page.avatarChoiceFailed({ detail: { errMsg: 'chooseAvatar:fail cancel' } });
  assert.equal(page.data.avatarBase64, draft, 'cancelling keeps the earlier unsaved choice');
  const beforeRevision = page.data.member.revision;
  await page.save();
  assert.equal(page.data.error, '');
  assert.equal(page.data.member.hasAvatar, true);
  assert.equal(page.data.member.nickname, '内测小周');
  assert.equal(page.data.member.revision, beforeRevision + 1, 'nickname and avatar commit together');
  const firstUrl = page.data.avatarUrl;
  assert(firstUrl.startsWith('/user-data/oradv-mock-avatars-v3/'));
  assert(files.has(firstUrl)); assert.equal(page.data.avatarBase64, '');
  page.avatarFailed({ currentTarget: { dataset: { scope: 'saved', src: firstUrl } } });
  assert.equal(page.data.avatarUrl, ''); assert.equal(page.data.member.hasAvatar, true, 'render failure does not erase the saved state');
  await page.loadAvatar(); assert.equal(page.data.avatarUrl, firstUrl);

  delete require.cache[require.resolve(apiPath)]; api = require(apiPath);
  page = openPage(); await page.load();
  assert.equal(page.data.member.id, memberId); assert.equal(page.data.avatarUrl, firstUrl, 'saved file survives reopening');
  await page.role({ detail: { value: '2' } });
  assert.equal(page.data.member.memberKind, 'founder'); assert.equal(page.data.avatarUrl, '', 'another identity does not inherit the picture');
  await page.role({ detail: { value: '1' } });
  assert.equal(page.data.avatarUrl, firstUrl);

  page.edit(); compressFailure = true;
  await page.chooseAvatar({ detail: { avatarUrl: '/temp/choice.png' } });
  assert(page.data.avatarError); assert.equal(page.data.avatarUrl, firstUrl); assert.equal(page.data.avatarBase64, '');
  compressFailure = false; readFailure = true;
  await page.chooseAvatar({ detail: { avatarUrl: '/temp/choice.png' } });
  assert(page.data.avatarError); assert.equal(page.data.avatarBase64, ''); readFailure = false;
  compressedContent = 'A'.repeat(100000);
  await page.chooseAvatar({ detail: { avatarUrl: '/temp/choice.png' } });
  assert(page.data.avatarError); assert.equal(page.data.avatarBase64, '', 'oversized compressed files are never sent');
  compressedContent = png;
  await page.chooseAvatar({ detail: { avatarUrl: '/temp/choice.png' } });
  writeFailure = true; await page.save();
  assert(page.data.error, 'storage failure is visible and keeps the previous saved profile');
  assert.equal((await api.currentMember()).nickname, '内测小周');
  assert.equal((await api.call('profile.avatar.get')).url, firstUrl);
  assert(page.data.avatarBase64, 'failed save keeps the draft available to retry');
  writeFailure = false; await page.save();
  assert.equal(page.data.error, ''); assert.notEqual(page.data.avatarUrl, firstUrl);
  assert(!files.has(firstUrl), 'replacement cleans the previous private mock file');

  // Delay the RPC response after the real service commits, as a slow network would.
  let delayedAction, responseReady, releaseResponse;
  const delayedApi = { ...api, async call(action, ...args) {
    const result = await api.call(action, ...args);
    if (action === delayedAction) {
      responseReady(); await new Promise(resolve => { releaseResponse = resolve; });
    }
    return result;
  } };
  require.cache[require.resolve(apiPath)].exports = delayedApi;
  const latePage = openPage(); require.cache[require.resolve(apiPath)].exports = api;
  await latePage.load();
  for (const method of ['recommendation', 'rankingConsent', 'save']) {
    await latePage.role({ detail: { value: '1' } });
    if (method === 'save') await latePage.chooseAvatar({ detail: { avatarUrl: '/temp/choice.png' } });
    delayedAction = method === 'save' ? 'profile.avatar.save' : 'profile.update';
    const started = new Promise(resolve => { responseReady = resolve; });
    const pending = latePage[method](); await started;
    await latePage.role({ detail: { value: '2' } });
    releaseResponse(); await pending;
    assert.equal(latePage.data.member.memberKind, 'founder', `late ${method} response cannot replace the active identity`);
    assert.equal(latePage.data.avatarUrl, ''); assert.equal(latePage.data.saving, false);
  }
  await page.role({ detail: { value: '1' } });

  let release; deferImage = { promise: new Promise(resolve => { release = resolve; }) };
  const preparing = page.chooseAvatar({ detail: { avatarUrl: '/temp/choice.png' } });
  await page.role({ detail: { value: '2' } }); release(); await preparing;
  assert.equal(page.data.member.memberKind, 'founder'); assert.equal(page.data.avatarBase64, '', 'late preparation cannot populate another identity');
  assert.equal(page.data.avatarUrl, '');
  files.set('/user-data/unrelated-avatar.png', png);
  await page.reset();
  assert.equal(page.data.member, null); assert(files.has('/user-data/unrelated-avatar.png'));
  assert(![...files.keys()].some(file => file.startsWith('/user-data/oradv-mock-avatars-v3/')), 'reset only deletes owned mock avatar files');
  api.switchMockRole('member'); await page.load();
  assert.equal(!!page.data.member.hasAvatar, false); assert.equal(page.data.avatarUrl, '');
  assert(notices.includes('本地身份已建立'));
});
