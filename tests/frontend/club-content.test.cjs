const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(root, 'services/api.js');
const event = (dataset, value) => ({ currentTarget: { dataset }, detail: { value } });
function page(name = 'club-content/index', options = {}) {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages', name + '.js'); freshPageModule(file);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (values, callback) => { Object.assign(instance.data, values); callback?.(); };
  instance.onLoad?.(options); return instance;
}
function environment() {
  const storage = new Map(), navigations = [], calls = []; let failOnceAfterInquiry = false, copied = '';
  global.wx = {
    getStorageSync: k => structuredClone(storage.get(k)), setStorageSync(k, v) {
      if (failOnceAfterInquiry && k === 'oradv-beta-store-v3' && Object.values(v.club_inquiries || {}).some(r => r.rowKind === 'inquiry')) {
        failOnceAfterInquiry = false; throw new Error('injected unknown response after commit');
      }
      storage.set(k, structuredClone(v));
    },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: k => storage.delete(k),
    showToast() {}, showModal: async () => ({ confirm: true, cancel: false }), pageScrollTo() {},
    navigateTo: ({ url }) => navigations.push(url), switchTab: ({ url }) => navigations.push(url),
    makePhoneCall: async ({ phoneNumber }) => calls.push(phoneNumber), setClipboardData: async ({ data }) => { copied = data; },
  };
  delete require.cache[require.resolve(apiPath)]; const api = require(apiPath); api.resetMock(); api.switchMockRole('owner');
  return { api, storage, navigations, calls, copied: () => copied, failCommitResponse: () => { failOnceAfterInquiry = true; } };
}

test('native club content publishes structured sections, contacts, people and offers with explicit rights', async () => {
  const env = environment(), p = page('club-content/index', { mode: 'manage', section: 'core' }); await p.load();
  assert.equal(p.data.error, ''); assert.equal(p.data.isOwner, true);
  p.field(event({ field: 'introduction' }, '活动协调与现场联络的分工'));
  p.addPerson(); const index = p.data.draft.people.length - 1;
  p.personField(event({ index, field: 'name' }, '内测领队')); p.personField(event({ index, field: 'duty' }, '现场联络'));
  p.personField(event({ index, field: 'introduction' }, '负责集合沟通')); p.addResponsibility(event({ index }));
  p.responsibilityField(event({ index, responsibility: 0 }, '核对出发与返回记录'));
  await p.publish(); assert(p.data.error.includes('确认'));
  p.publishRights(event({}, ['accepted'])); await p.publish(); assert.equal(p.data.error, '');
  env.api.switchMockRole('guest'); const publicCore = page('club-content/index', { section: 'core' }); await publicCore.load();
  assert(publicCore.data.content.people.some(x => x.name === '内测领队')); assert.equal(publicCore.data.isOwner, false);
  const forbidden = page('club-content/index', { mode: 'manage' }); await forbidden.load(); assert(forbidden.data.error);
  env.api.switchMockRole('owner'); await p.selectSection(event({}, '3'));
  p.addContact(); const contact = p.data.draft.contacts.length - 1;
  for (const [field, value] of Object.entries({ label: '内测服务', name: '组织方', value: '13800000000', hours: '活动期间联系', note: '虚构测试号码' })) p.contactField(event({ index: contact, field }, value));
  p.contactMethod(event({ index: contact }, '0')); p.publishRights(event({}, ['accepted'])); await p.publish(); assert.equal(p.data.error, '');
  env.api.switchMockRole('guest'); const contacts = page('club-content/index', { section: 'contacts' }); await contacts.load();
  const phoneIndex = contacts.data.contactRows.findIndex(x => x.value === '13800000000'); assert(phoneIndex >= 0);
  await contacts.contact(event({ index: phoneIndex })); assert.deepEqual(env.calls, ['13800000000']);
  const wechatIndex = contacts.data.contactRows.findIndex(x => x.method === 'wechat'); await contacts.contact(event({ index: wechatIndex })); assert(env.copied());
  env.api.switchMockRole('owner'); await p.selectSection(event({}, '5'));
  p.addOffer(); p.offerField(event({ index: 0, field: 'name' }, '内测队贴')); p.offerField(event({ index: 0, field: 'description' }, '供成员向组织方咨询，具体条件另行确认'));
  p.publishRights(event({}, ['accepted'])); await p.publish(); assert.equal(p.data.error, '');
  const id = p.data.draft.offers[0].id; assert(id);
  const published = await env.api.call('club.content.get', { section: 'redemption' }); assert.equal(published.offers[0].name, '内测队贴');
  await p.saveDraft(); assert.equal((await env.api.call('club.content.get', { section: 'redemption' })).configured, false, 'saving as draft pauses publication honestly');
  for (const sectionIndex of [0, 1, 4, 6]) {
    await p.selectSection(event({}, String(sectionIndex))); p.addBlock(); const index = p.data.draft.blocks.length - 1;
    p.blockField(event({ index, field: 'heading' }, '内测说明')); p.blockField(event({ index, field: 'body' }, '由组织方核实后公开的测试内容'));
    p.publishRights(event({}, ['accepted'])); await p.publish(); assert.equal(p.data.error, '');
    const visible = await env.api.call('club.content.get', { section: p.data.section });
    assert(visible.blocks.some(row => row.heading === '内测说明'), 'each text section has a functioning editor and public leaf');
  }
});

test('native inquiries keep retry identity across unknown outcomes and support owner reply plus own withdrawal', async () => {
  const env = environment(); env.api.switchMockRole('member');
  let p = page('club-content/index', { section: 'business' }); await p.load();
  p.inquiryContact(event({}, 'fictional-contact')); p.inquiryMessage(event({}, '希望沟通内测活动的装备支持')); await p.submitInquiry(); assert(p.data.error.includes('同意'));
  p.inquiryConsent(event({}, ['accepted'])); env.failCommitResponse(); await p.submitInquiry(); assert.equal(p.data.formLocked, true);
  const originalId = p.data.submissionId, originalMessage = p.data.inquiryMessage;
  p.inquiryMessage(event({}, '不能改写未知结果的请求')); assert.equal(p.data.inquiryMessage, originalMessage);
  p = page('club-content/index', { section: 'business' }); await p.load(); assert.equal(p.data.submissionId, originalId); assert.equal(p.data.formLocked, true);
  p.inquiryConsent(event({}, ['accepted'])); await p.submitInquiry(); assert.equal(p.data.error, '');
  assert.equal(p.data.inquiries.length, 1); const inquiry = p.data.inquiries[0];
  assert.equal(p.data.formLocked, false);
  env.api.switchMockRole('owner'); const manager = page('club-content/index', { mode: 'manage', section: 'business' }); await manager.load();
  manager.inquiryReply(event({ id: inquiry.id }, '已收到，组织方会按预留联系方式沟通')); await manager.reviewInquiry(event({ id: inquiry.id }));
  assert.equal(manager.data.error, ''); assert.equal(manager.data.inquiries.find(x => x.id === inquiry.id).state, 'closed');
  env.api.switchMockRole('member'); await p.load(); assert(p.data.inquiries[0].reply.includes('已收到'));
  p.inquiryContact(event({}, 'fictional-contact')); p.inquiryMessage(event({}, '补充一条可撤回的意向')); p.inquiryConsent(event({}, ['accepted'])); await p.submitInquiry();
  const open = p.data.inquiries.find(x => x.state === 'open'); await p.withdrawInquiry(event({ id: open.id })); assert.equal(p.data.inquiries.find(x => x.id === open.id).state, 'withdrawn');
  env.api.switchMockRole('founder'); await p.load(); assert.equal(p.data.inquiries.length, 0); assert.equal(p.data.inquiryContact, '', 'private contact form does not follow a changed identity');
});

test('profile preserves numbered identity and exposes every new module through native navigation', async () => {
  const env = environment(), p = page('profile/index'); await p.load(); assert.equal(p.data.memberNumber, '0');
  assert(p.data.dossierStatus); assert.equal(p.data.error, '');
  for (const [method, panel, level] of [['dossier', 'dossier'], ['safety', 'learning'], ['basicSkills', 'skills', 'basic'], ['advancedSkills', 'skills', 'advanced'], ['handbook', 'handbook'], ['core', 'core'], ['rules', 'rules'], ['contacts', 'contact'], ['business', 'business']]) { p[method](); assert.equal(p.data.refPanel, panel, method); if (level) assert.equal(p.data.refParams.level, level); }
  for (const method of ['practice', 'redemption', 'dossierQueue', 'clubManagement']) p[method]();
  assert(env.navigations.some(x => x.includes('/pages/dossier/index')));
  assert(env.navigations.some(x => x === '/pages/redemption/index'));
  assert(env.navigations.some(x => x.includes('mode=manage')));
  assert.equal(p.data.member.growthPoints, (await env.api.currentMember()).growthPoints);
});

test('dirty profile drafts stay with the same identity and stale profile writes never target a different member', async () => {
  const env = environment(); env.api.switchMockRole('member');
  const same = page('profile/index'); await same.load(); same.setData({ showEdit: true, nickname: '仍在编辑的称呼', avatarDraftUrl: '/temp/unsaved.png', avatarBase64: 'unsaved-local-draft' });
  await same.resume(); assert.equal(same.data.nickname, '仍在编辑的称呼'); assert.equal(same.data.avatarBase64, 'unsaved-local-draft');
  for (const method of ['save', 'recommendation', 'rankingConsent', 'requestKind', 'deletion']) {
    env.api.switchMockRole('member'); const p = page('profile/index'); await p.load();
    p.setData({ showEdit: true, nickname: '前一个人的私有草稿', nicknameStatus: 'passed', kindReason: '前一个人的私有核对线索', avatarBase64: 'private-unsaved-image' });
    env.api.switchMockRole('founder'); const before = await env.api.currentMember();
    await p[method]();
    assert.deepEqual(await env.api.currentMember(), before, method + ' must not write old fields into the new member');
    assert.equal(p.data.member.id, before.id); assert.equal(p.data.nickname, before.nickname); assert.equal(p.data.kindReason, ''); assert.equal(p.data.avatarBase64, '');
  }
});

test('dirty club forms are scoped on resume and before write even when the account changed without onShow', async () => {
  const env = environment(); env.api.switchMockRole('member');
  const p = page('club-content/index', { section: 'business' }); await p.load();
  p.inquiryContact(event({}, 'member-a-private-contact')); p.inquiryMessage(event({}, 'member-a-private-message'));
  await p.resume(); assert.equal(p.data.inquiryMessage, 'member-a-private-message', 'same identity keeps unsent form');
  p.inquiryConsent(event({}, ['accepted'])); env.api.switchMockRole('founder'); await p.submitInquiry();
  assert.equal(p.data.inquiryContact, ''); assert.equal(p.data.inquiryMessage, '');
  assert.equal((await env.api.call('club.inquiry.mine')).items.length, 0);
  env.api.switchMockRole('owner'); const manager = page('club-content/index', { mode: 'manage', section: 'business' }); await manager.load();
  manager.field(event({ field: 'introduction' }, '未保存的栏目修改')); assert.equal(manager.data.editorDirty, true);
  manager.publishRights(event({}, ['accepted'])); env.api.switchMockRole('member'); await manager.publish();
  assert.equal(manager.data.isOwner, false); assert.equal(manager.data.content, null); assert.equal(manager.data.inquiries.length, 0);
  assert.equal(manager.data.draft.introduction, ''); assert(manager.data.error.includes('权限'));
});

test('redemption consultation snapshots the published offer and never spends points', async () => {
  const env = environment(), manager = page('club-content/index', { mode: 'manage', section: 'redemption' }); await manager.load();
  manager.addOffer(); manager.offerField(event({ index: 0, field: 'name' }, '测试队贴')); manager.offerField(event({ index: 0, field: 'description' }, '先咨询组织方，条件确认后再安排'));
  manager.publishRights(event({}, ['accepted'])); await manager.publish(); assert.equal(manager.data.error, '');
  env.api.switchMockRole('member'); const p = page('club-content/index', { section: 'redemption' }); await p.load();
  const before = await env.api.currentMember(), offer = p.data.content.offers[0];
  p.selectOffer(event({ id: offer.id })); p.inquiryContact(event({}, 'fictional-contact')); p.inquiryMessage(event({}, '想了解队贴的具体安排')); p.inquiryConsent(event({}, ['accepted'])); await p.submitInquiry();
  assert.equal(p.data.error, ''); assert.equal(p.data.inquiries[0].offerId, offer.id); assert.equal(p.data.inquiries[0].offerName, offer.name);
  assert.deepEqual(await env.api.currentMember(), before, 'a consultation does not change earned points or member authority');
});

test('retrying private profile reads under another account clears old identity before displaying results', async () => {
  const env = environment();
  for (const method of ['loadAvatar', 'loadDossier']) {
    env.api.switchMockRole('member'); const p = page('profile/index'); await p.load();
    p.setData({ member: { ...p.data.member, hasAvatar: true }, avatarUrl: 'old-member-private-photo', dossierNote: '旧成员的核对说明' });
    env.api.switchMockRole('founder'); const current = await env.api.currentMember(); await p[method]();
    assert.equal(p.data.member.id, current.id); assert.equal(p.data.avatarUrl, ''); assert.notEqual(p.data.dossierNote, '旧成员的核对说明');
  }
  env.api.switchMockRole('member'); const inquiries = page('club-content/index', { section: 'business' }); await inquiries.load();
  inquiries.inquiryContact(event({}, 'private-member-a-contact')); inquiries.inquiryMessage(event({}, 'private-member-a-message'));
  env.api.switchMockRole('founder'); const founder = await env.api.currentMember(); await inquiries.loadInquiries();
  assert.equal(inquiries.data.member.id, founder.id); assert.equal(inquiries.data.inquiryContact, '');
  assert(inquiries.data.inquiries.every(item => item.memberId === founder.id));
});

test('private inquiry drafts and unknown-outcome nonces remain bound to exact mode, AppID and EnvId', async () => {
  const env = environment(); env.api.switchMockRole('member');
  const apiModule = require.cache[require.resolve(apiPath)], real = apiModule.exports, member = await real.currentMember();
  const targetA = { mode: 'cloud', appId: 'wx0123456789abcdef', envId: 'cloud-test-aaaa', version: 'review' };
  let unknownA = true;
  const facadeA = { ...real, isMock: false, runtime: targetA, currentMember: async () => member,
    async call(action, ...args) { const result = await real.call(action, ...args); if (action === 'club.inquiry.submit' && unknownA) { unknownA = false; throw new real.ApiError('NETWORK', '提交结果暂未确认'); } return result; } };
  apiModule.exports = facadeA;
  let original = page('club-content/index', { section: 'business' }); await original.load();
  original.inquiryContact(event({}, 'fictional-environment-A-contact')); original.inquiryMessage(event({}, '环境A的私有咨询')); original.inquiryConsent(event({}, ['accepted'])); await original.submitInquiry();
  const originalNonce = original.data.submissionId; assert(original.data.formLocked);
  const legacyKey = `oradv-club-inquiry-draft-v1-${member.id}-business`, legacy = { contact: '旧版未绑定云环境的联系方法', message: '不能自动归属', offerId: '', submissionId: 'legacy-stable-unknown', locked: true };
  env.storage.set(legacyKey, structuredClone(legacy));
  const otherKeys = [];
  for (const [index, target] of [
    { ...targetA, envId: 'cloud-production-bbbb' }, { ...targetA, appId: 'wxfedcba9876543210' }, { ...targetA, mode: 'mock' },
  ].entries()) {
    let submitted;
    apiModule.exports = { ...real, isMock: target.mode === 'mock', runtime: target, currentMember: async () => member,
      async call(action, ...args) { if (action === 'club.inquiry.mine') return { items: [], nextCursor: null }; if (action === 'club.inquiry.submit') { submitted = args[0]; throw new real.ApiError('NETWORK', '本次探测不发送到远端'); } return real.call(action, ...args); } };
    const other = page('club-content/index', { section: 'business' }); await other.load();
    assert.equal(other.data.inquiryContact, ''); assert.equal(other.data.inquiryMessage, ''); assert.equal(other.data.submissionId, ''); assert.equal(other.data.formLocked, false);
    other.inquiryContact(event({}, `fictional-other-contact-${index}`)); other.inquiryMessage(event({}, `另一环境的新咨询${index}`)); other.inquiryConsent(event({}, ['accepted'])); await other.submitInquiry();
    assert.equal(submitted.contact, `fictional-other-contact-${index}`); assert.notEqual(submitted.submissionId, originalNonce);
    const stored = [...env.storage.entries()].find(([key, value]) => key.startsWith('oradv-club-inquiry-draft-v2-') && value.scope?.mode === target.mode && value.scope?.appId === target.appId && value.scope?.envId === target.envId);
    assert(stored); otherKeys.push(stored[0]);
  }
  apiModule.exports = facadeA; original = page('club-content/index', { section: 'business' }); await original.load();
  assert.equal(original.data.inquiryContact, 'fictional-environment-A-contact'); assert.equal(original.data.submissionId, originalNonce); assert(original.data.formLocked);
  await original.resume(); assert.equal(original.data.submissionId, originalNonce, 'same-environment foreground preserves the unknown submission');
  original.inquiryConsent(event({}, ['accepted'])); await original.submitInquiry(); assert.equal(original.data.error, '');
  assert.equal((await real.call('club.inquiry.mine')).items.length, 1, 'retry against original environment resolves the original record');
  for (const key of otherKeys) assert(env.storage.has(key), 'successful A retry cannot delete another environment draft');
  assert.deepEqual(env.storage.get(legacyKey), legacy, 'unscoped legacy cloud draft remains untouched');
  apiModule.exports = real;
});

test('changing a live environment invalidates private forms before writes and leaves the original locked draft intact', async () => {
  const env = environment(); env.api.switchMockRole('member');
  const apiModule = require.cache[require.resolve(apiPath)], real = apiModule.exports, member = await real.currentMember();
  const target = { mode: 'cloud', appId: 'wx0123456789abcdef', envId: 'cloud-test-aaaa', version: 'review' };
  let submitCalls = 0;
  apiModule.exports = { ...real, isMock: false, runtime: target, currentMember: async () => member,
    async call(action, ...args) { if (action === 'club.inquiry.mine') return { items: [], nextCursor: null }; if (action === 'club.inquiry.submit') { submitCalls++; throw new real.ApiError('NETWORK', '未知提交结果'); } return real.call(action, ...args); } };
  const p = page('club-content/index', { section: 'business' }); await p.load();
  p.inquiryContact(event({}, 'fictional-A-contact')); p.inquiryMessage(event({}, 'A的私有咨询')); p.inquiryConsent(event({}, ['accepted'])); await p.submitInquiry();
  assert.equal(submitCalls, 1); const [keyA, recordA] = [...env.storage.entries()].find(([key]) => key.startsWith('oradv-club-inquiry-draft-v2-'));
  target.envId = 'cloud-production-bbbb';
  await p.submitInquiry(); assert.equal(submitCalls, 1, 'old environment payload must not be submitted after a live target change');
  assert.equal(p.data.inquiryContact, ''); assert.equal(p.data.inquiryMessage, ''); assert.equal(p.data.submissionId, ''); assert.equal(p.data.formLocked, false);
  assert.deepEqual(env.storage.get(keyA), recordA); apiModule.exports = real;
});
