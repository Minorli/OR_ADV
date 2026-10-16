const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(app, 'services/api.js');
function box(type, body) { const bytes = Buffer.alloc(8 + body.length); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4); body.copy(bytes, 8); return bytes; }
const VIDEO = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', Buffer.from('decoder-fixture')), box('mdat', Buffer.from('selected-video-payload'))]);
function environment() {
  const storage = new Map(), files = new Map([['/temp/practice.mp4', VIDEO]]), dirs = new Set(['/user-data']);
  let choice = '/temp/practice.mp4', sequence = 0, notices = 0;
  const missing = () => new Error('ENOENT: file missing');
  const fs = {
    accessSync(file) { if (!files.has(file) && !dirs.has(file)) throw missing(); }, mkdirSync(dir) { dirs.add(dir); },
    statSync(file) { if (!files.has(file)) throw missing(); return { size: files.get(file).length }; },
    readFileSync(file, encoding) { if (!files.has(file)) throw missing(); const bytes = files.get(file); return encoding === 'base64' ? bytes.toString('base64') : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); },
    writeFileSync(file, data, encoding) { files.set(file, typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data)); },
    unlinkSync(file) { if (!files.delete(file)) throw missing(); },
    saveFile({ tempFilePath, success, fail }) { if (!files.has(tempFilePath)) return fail({ errMsg: 'saveFile:fail missing' }); const savedFilePath = `/user-data/saved-${++sequence}`; files.set(savedFilePath, Buffer.from(files.get(tempFilePath))); success({ savedFilePath }); },
    removeSavedFile({ filePath, success, fail }) { if (!files.delete(filePath)) return fail({ errMsg: 'removeSavedFile:fail missing' }); success({}); },
  };
  global.wx = {
    env: { USER_DATA_PATH: '/user-data' }, getFileSystemManager: () => fs,
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() { notices++; }, async showModal() { return { confirm: true }; },
    switchTab() {}, navigateTo() {},
    async chooseMedia() { if (!choice) throw { errMsg: 'chooseMedia:fail cancel' }; return { tempFiles: [{ tempFilePath: choice, size: files.get(choice)?.length }] }; },
    async getVideoInfo() { return { duration: 12, width: 1280, height: 720 }; },
    async saveFile({ tempFilePath }) { if (!files.has(tempFilePath)) throw missing(); const savedFilePath = `/user-data/saved-${++sequence}`; files.set(savedFilePath, Buffer.from(files.get(tempFilePath))); return { savedFilePath }; },
  };
  return { storage, files, choose: value => { choice = value; }, notices: () => notices };
}
function page(name) {
  let definition;
  global.Page = value => { definition = value; };
  const file = path.join(app, 'pages', name + '.js'); delete require.cache[require.resolve(file)]; require(file);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = values => {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.'); let target = instance.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
  };
  return instance;
}
function api() {
  delete require.cache[require.resolve(apiPath)];
  delete require.cache[require.resolve(path.join(app, 'services/member-media.js'))];
  return require(apiPath);
}

test('native knowledge practice publishes real structured questions, resumes and saves true results without a pass badge', async () => {
  environment(); const service = api(); service.resetMock('empty'); service.switchMockRole('owner');
  const editor = page('learning/index'); await editor.load(); await editor.toggleEditor();
  assert.equal(editor.data.bank.questions.length, 0);
  editor.setData({ draft: { id: 'process-01', prompt: '报名状态应在哪里核对？', option0: '本人报名记录', option1: '任意旧截图', option2: '只凭猜测', option3: '只看昵称', rightIndex: 0, explanation: '使用自己的最新报名记录核对。' }, reason: '指导人员核实练习内容' });
  await editor.saveQuestion(); assert.equal(editor.data.error, ''); assert.equal(editor.data.bank.questions.length, 1);
  let revision = editor.data.bank.revision;
  for (let number = 2; number <= 20; number++) {
    const bank = await service.call('staff.learning.catalog.save', { question: { id: `process-${number}`, prompt: `练习项目 ${number} 应怎样核对安排？`, options: ['向负责人核实', '随意猜测', '只看过期截图', '让陌生人代办'], rightIndex: 0, explanation: '先核实安排再行动。' }, reason: '指导人员核定' }, revision);
    revision = bank.revision;
  }
  await editor.loadBank(); editor.setData({ instructorConfirmed: true, reason: '指导人员已核定二十道练习题' }); await editor.publish();
  assert.equal(editor.data.error, ''); assert.equal(editor.data.catalog.configured, true);
  service.switchMockRole('member'); const learner = page('learning/index'); await learner.load(); await learner.start();
  assert.equal(learner.data.practice.total, 20); assert.equal(learner.data.practice.answeredCount, 0);
  assert(!('rightIndex' in learner.data.displayQuestion));
  await learner.answer(); assert.equal(learner.data.practice.answeredCount, 0);
  learner.select({ currentTarget: { dataset: { index: 0 } } }); await learner.answer();
  assert.equal(learner.data.feedback.correct, true); assert.equal(learner.data.practice.answeredCount, 1);
  await learner.answer(); assert.equal(learner.data.practice.answeredCount, 1, 'feedback cannot double-submit');
  const resumed = page('learning/index'); await resumed.load(); assert.equal(resumed.data.practice.id, learner.data.practice.id); assert.equal(resumed.data.practice.answeredCount, 1);
  const stale = page('learning/index'); await stale.load(); stale.select({ currentTarget: { dataset: { index: 0 } } });
  const pending = stale.answer(); service.switchMockRole('founder'); await stale.load(); await pending;
  assert.equal(stale.data.practice, null, 'late personal practice response cannot replace another identity');
  assert.equal(stale.data.busy, false);
  service.switchMockRole('member'); await resumed.load();
  while (resumed.data.practice.status !== 'completed') {
    resumed.select({ currentTarget: { dataset: { index: 0 } } }); await resumed.answer(); resumed.next();
  }
  assert.equal(resumed.data.practice.correctCount, 20); assert.equal(resumed.data.displayQuestion, null);
  assert.equal(resumed.data.practice.passed, undefined);
  assert.equal((await service.call('identity.me')).growthPoints, 0);
  assert.equal((await service.call('qualifications.mine')).items.length, 0);
});

test('native skill flow requires an actual chosen video, persists it, and owner reviews the saved revision', async () => {
  const env = environment(); const service = api(); service.resetMock('empty'); service.switchMockRole('member');
  const skills = page('skills/index'); skills.onLoad({ level: 'basic' }); await skills.load();
  assert.equal(skills.data.visibleItems.length, 5); assert.equal(skills.data.approvedCount, 0);
  skills.level({ currentTarget: { dataset: { level: 'advanced' } } }); assert.equal(skills.data.visibleItems.length, 7);
  skills.level({ currentTarget: { dataset: { level: 'basic' } } }); skills.open({ currentTarget: { dataset: { id: 'basic-posture' } } });
  await skills.submit(); assert.equal(skills.data.selected.submission, null); assert(env.notices() > 0);
  skills.setData({ mediaConsent: true }); env.choose(''); await skills.upload(); assert.equal(skills.data.assetId, '');
  env.choose('/temp/practice.mp4'); await skills.upload();
  assert.equal(skills.data.error, ''); assert(skills.data.assetId); assert.deepEqual(env.files.get(skills.data.previewUrl), VIDEO);
  skills.setData({ note: '本人在指导人员陪同下完成的练习记录' }); await skills.submit();
  assert.equal(skills.data.error, ''); assert.equal(skills.data.selected.submission.state, 'submitted');
  const submission = skills.data.selected.submission;
  const reopened = page('skills/index'); await reopened.load(); assert.equal(reopened.data.items[0].submission.id, submission.id);
  service.switchMockRole('owner'); const owner = page('skills/index'); owner.onLoad({ mode: 'review' }); await owner.load();
  assert.equal(owner.data.queue.length, 1);
  const pendingReview = owner.reviewOpen({ currentTarget: { dataset: { id: submission.id } } });
  service.switchMockRole('founder'); await owner.load(); await pendingReview;
  assert.equal(owner.data.reviewVideoUrl, '', 'late privileged media URL is discarded after identity change');
  assert.equal(owner.data.queue.length, 0); assert.equal(owner.data.busy, false);
  service.switchMockRole('owner'); await owner.load(); await owner.toggleReview();
  await owner.reviewOpen({ currentTarget: { dataset: { id: submission.id } } });
  assert.deepEqual(env.files.get(owner.data.reviewVideoUrl), VIDEO);
  owner.setData({ reviewReason: '已核对本人练习片段，后续现场资格另行确认' }); await owner.review({ currentTarget: { dataset: { decision: 'approved' } } });
  assert.equal(owner.data.error, ''); assert.equal(owner.data.queue.length, 0);
  service.switchMockRole('member'); await reopened.load(); assert.equal(reopened.data.approvedCount, 1);
  reopened.open({ currentTarget: { dataset: { id: 'basic-posture' } } }); await reopened.history();
  assert.deepEqual(reopened.data.historyItems.map(item => item.revision), [2, 1]);
  assert.equal(reopened.data.historyItems[0].reviewReason, '已核对本人练习片段，后续现场资格另行确认');
  await reopened.historyVideo({ currentTarget: { dataset: { id: reopened.data.historyItems[1].historyId } } });
  assert.deepEqual(env.files.get(reopened.data.historyVideoUrl), VIDEO);
  assert.equal((await service.call('qualifications.mine')).items.length, 0);
  assert.equal((await service.call('identity.me')).growthPoints, 0);
  service.switchMockRole('founder'); await reopened.load(); assert(reopened.data.items.every(item => item.submission === null));
});

async function submitPractice(service, role) {
  service.switchMockRole(role); const skills = page('skills/index'); await skills.load();
  skills.open({ currentTarget: { dataset: { id: 'basic-posture' } } });
  skills.setData({ mediaConsent: true }); await skills.upload(); await skills.submit();
  assert.equal(skills.data.error, ''); assert.equal(skills.data.selected.submission.state, 'submitted');
  return skills;
}

test('a previous identity cannot cancel the new member record before foregrounding or after confirmation', async () => {
  environment(); const service = api(); service.resetMock('empty');
  await submitPractice(service, 'member'); await submitPractice(service, 'founder');
  service.switchMockRole('member'); let old = page('skills/index'); await old.load(); old.open({ currentTarget: { dataset: { id: 'basic-posture' } } });
  assert.equal(old.data.selected.submission.revision, 1);
  service.switchMockRole('founder'); await old.cancel();
  assert.equal((await service.call('skills.mine')).items[0].submission.state, 'submitted');
  assert.equal((await service.call('skills.mine')).items[0].submission.revision, 1);
  assert.equal(old.data.selected, null); assert.equal(old.data.previewUrl, '');
  service.switchMockRole('member'); old = page('skills/index'); await old.load(); old.open({ currentTarget: { dataset: { id: 'basic-posture' } } });
  global.wx.showModal = async () => { service.switchMockRole('founder'); return { confirm: true }; };
  await old.cancel();
  assert.equal((await service.call('skills.mine')).items[0].submission.state, 'submitted', 'identity is rechecked after modal confirmation');
  service.switchMockRole('member'); assert.equal((await service.call('skills.mine')).items[0].submission.state, 'submitted');
});

test('foreground validation always clears privileged bank and review state on identity change, including busy pages', async () => {
  environment(); const service = api(); service.resetMock(); service.switchMockRole('owner');
  const learning = page('learning/index'); await learning.load(); await learning.toggleEditor();
  assert.equal(learning.data.bank.questions.length, 50);
  learning.setData({ draft: { ...learning.data.draft, prompt: '主理人未保存的私人题目草稿' }, busy: true });
  await learning.onShow(); assert.equal(learning.data.draft.prompt, '主理人未保存的私人题目草稿'); assert.equal(learning.data.busy, true);
  service.switchMockRole('founder'); await learning.onShow();
  assert.equal(learning.data.bank, null); assert.equal(learning.data.editor, false); assert.equal(learning.data.isOwner, false);
  assert.equal(learning.data.draft.prompt, ''); assert.equal(learning.data.busy, false);
  await submitPractice(service, 'member'); service.switchMockRole('owner');
  const skills = page('skills/index'); skills.onLoad({ mode: 'review' }); await skills.load();
  assert(skills.data.queue.length); await skills.reviewOpen({ currentTarget: { dataset: { id: skills.data.queue[0].id } } });
  assert(skills.data.reviewVideoUrl);
  skills.setData({ busy: true, note: '未提交说明', referenceReason: '私人来源核对说明', referenceEditor: true });
  await skills.onShow(); assert.equal(skills.data.note, '未提交说明'); assert.equal(skills.data.busy, true);
  service.switchMockRole('founder'); await skills.onShow();
  assert.equal(skills.data.isOwner, false); assert.equal(skills.data.queue.length, 0); assert.equal(skills.data.reviewTarget, null);
  assert.equal(skills.data.reviewVideoUrl, ''); assert.equal(skills.data.previewUrl, ''); assert.equal(skills.data.referenceReason, '');
  assert.equal(skills.data.historyVideoUrl, ''); assert.deepEqual(skills.data.historyItems, []);
  assert.equal(skills.data.selected, null); assert.equal(skills.data.note, ''); assert.equal(skills.data.busy, false);
});

test('privileged bank retries and personal video reads verify the loaded identity before RPC, and late bank responses are discarded', async () => {
  environment(); const service = api(); service.resetMock(); service.switchMockRole('owner');
  const module = require.cache[require.resolve(apiPath)], real = module.exports;
  let privateBankCalls = 0, hold = false, entered, release;
  module.exports = { ...real, async call(action, ...args) {
    if (action === 'staff.learning.catalog.get') privateBankCalls++;
    const result = await real.call(action, ...args);
    if (action === 'staff.learning.catalog.get' && hold) { entered(); await new Promise(resolve => { release = resolve; }); }
    return result;
  } };
  try {
    const owner = page('learning/index'); await owner.load(); await owner.toggleEditor();
    const before = privateBankCalls; service.switchMockRole('founder'); await owner.loadBank();
    assert.equal(privateBankCalls, before, 'old private retry must stop before requesting another identity'); assert.equal(owner.data.bank, null);
    service.switchMockRole('owner'); const pendingPage = page('learning/index'); await pendingPage.load(); hold = true;
    const reached = new Promise(resolve => { entered = resolve; }); const pending = pendingPage.toggleEditor(); await reached;
    service.switchMockRole('founder'); await pendingPage.onShow(); release(); await pending;
    assert.equal(pendingPage.data.bank, null); assert.equal(pendingPage.data.isOwner, false);
  } finally { module.exports = real; }
  service.resetMock('empty'); const own = await submitPractice(service, 'member');
  service.switchMockRole('founder'); await own.viewOwnVideo();
  assert.equal(own.data.previewUrl, ''); assert.equal(own.data.selected, null);
  assert.equal((await service.call('skills.mine')).items[0].submission, null);
});
