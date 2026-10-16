const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(root, 'services/api.js');
const storeKey = 'oradv-beta-store-v3';
function reopenApi() { delete require.cache[require.resolve(apiPath)]; return require(apiPath); }
function page(name) {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages', name + '.js'); delete require.cache[require.resolve(file)]; require(file);
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
function environment(storage, options = {}) {
  let clipboard = '';
  global.wx = {
    env: { USER_DATA_PATH: '/user-data' },
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => { if (key === storeKey && options.failWrite?.()) throw new Error('disk full'); storage.set(key, structuredClone(value)); },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({ accessSync: target => assert(options.files?.has(target), 'saved avatar file still exists') }),
    setClipboardData: async ({ data }) => { clipboard = data; },
    showToast: () => {}, showModal: async () => ({ confirm: true, cancel: false }),
    navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
  };
  return { clipboard: () => clipboard };
}

test('native member numbers show and copy zero, and directory searches match complete numbers', async () => {
  const storage = new Map(), env = environment(storage);
  const api = reopenApi(); api.resetMock(); api.switchMockRole('owner');
  const profile = page('profile/index'); await profile.load();
  assert.equal(profile.data.error, '');
  assert.equal(profile.data.member.memberNumber, 0);
  assert.equal(profile.data.memberNumber, '0');
  await profile.copyMemberNumber(); assert.equal(env.clipboard(), '0');
  const members = page('staff-members/index'); await members.load();
  assert.equal(members.data.error, '');
  assert.equal(members.data.items[0].memberNumber, 0, 'directory order starts at zero');
  assert.equal(members.data.items[0].memberCode, '0');
  for (const number of [0, 1, 10, 20]) {
    members.setData({ query: String(number) }); await members.loadMembers();
    assert.equal(members.data.error, '');
    assert.equal(members.data.items.length, 1);
    assert.equal(members.data.items[0].memberNumber, number);
    assert.equal(members.data.items[0].memberCode, String(number));
  }
  members.setData({ query: '0' }); await members.loadMembers();
  await members.select({ currentTarget: { dataset: { id: members.data.items[0].id } } });
  assert.equal(members.data.selected.id, profile.data.member.id, 'numeric label does not replace the internal RPC identity');
  assert.equal(members.data.selected.memberCode, '0');
  const { memberNumberText } = require(path.join(root, 'services/member-number.js'));
  assert.equal(memberNumberText(undefined), '待分配');
  assert.equal(memberNumberText(0), '0');
  const staff = page('staff/index'); await staff.load();
  assert.equal(staff.data.error, '');
  assert(staff.data.displayedRegistrations.length > 0);
  assert(staff.data.displayedRegistrations.every(item => item.memberCode === String(item.memberNumber)));
  const target = staff.data.displayedRegistrations[0];
  staff.searchRoster({ detail: { value: String(target.memberNumber) } });
  assert.deepEqual(staff.data.displayedRegistrations.map(item => item.memberId), [target.memberId]);
});

test('restoring legacy v3 numbers preserves avatars and business records, and failed persistence never resets them', async () => {
  const storage = new Map(), files = new Set(); let failWrite = false;
  environment(storage, { files, failWrite: () => failWrite });
  let api = reopenApi(); api.resetMock(); api.switchMockRole('member');
  const original = await api.currentMember();
  const legacy = structuredClone(storage.get(storeKey));
  for (const member of Object.values(legacy.memberships)) delete member.memberNumber;
  for (const [id, row] of Object.entries(legacy.clubs)) {
    if (['member_sequence', 'member_number_claim'].includes(row.kind)) delete legacy.clubs[id];
  }
  const fileId = `oradv-mock-avatar-v3/${'a'.repeat(64)}/migration-existing.png`;
  const avatarPath = `/user-data/oradv-mock-avatars-v3/${'a'.repeat(64)}-migration-existing.png`;
  files.add(avatarPath);
  legacy.memberships[original.id] = { ...legacy.memberships[original.id], avatarFileId: fileId, nickname: '旧演示档案', unrecognizedField: { preserve: true } };
  storage.set(storeKey, structuredClone(legacy));
  storage.set('oradv-beta-avatar-files-v3', { [fileId]: true });
  storage.set('oradv-beta-checklist-v3-previous-1', ['0']);
  storage.set('oradv-beta-store-v2', { older: 'retained' });
  const oldMember = legacy.memberships[original.id];
  failWrite = true; api = reopenApi();
  await assert.rejects(() => api.currentMember(), error => error.code === 'LOCAL_DATA_UPGRADE_FAILED' && error.message.includes('不会被重置'));
  assert.deepEqual(storage.get(storeKey), legacy, 'failed upgrade leaves the original snapshot intact');
  assert.deepEqual(storage.get('oradv-beta-avatar-files-v3'), { [fileId]: true });
  assert(files.has(avatarPath));
  const failedPage = page('profile/index'); await failedPage.load();
  assert(failedPage.data.error.includes('不会被重置'), 'storage failure is visible in the product');
  assert.equal(failedPage.data.member, null);
  failWrite = false;
  const recovered = await api.currentMember();
  assert.equal(recovered.id, original.id);
  assert(Number.isSafeInteger(recovered.memberNumber) && recovered.memberNumber > 0);
  assert.equal(recovered.hasAvatar, true);
  const migrated = structuredClone(storage.get(storeKey));
  assert.deepEqual(migrated.registrations, legacy.registrations);
  assert.deepEqual(migrated.points_ledger, legacy.points_ledger);
  assert.deepEqual(migrated.member_stats, legacy.member_stats);
  assert.deepEqual(migrated.staff_roles, legacy.staff_roles);
  assert.equal(migrated.memberships[original.id].revision, oldMember.revision);
  assert.equal(migrated.memberships[original.id].avatarFileId, fileId);
  assert.deepEqual(migrated.memberships[original.id].unrecognizedField, oldMember.unrecognizedField);
  assert.deepEqual(storage.get('oradv-beta-checklist-v3-previous-1'), ['0']);
  assert.deepEqual(storage.get('oradv-beta-store-v2'), { older: 'retained' });
  const profile = page('profile/index'); await profile.load();
  assert.equal(profile.data.error, ''); assert.equal(profile.data.avatarUrl, avatarPath);
  assert.equal(profile.data.memberNumber, String(recovered.memberNumber));
  assert.deepEqual(storage.get('oradv-beta-avatar-files-v3'), { [fileId]: true });
  const once = structuredClone(storage.get(storeKey));
  api = reopenApi(); assert.equal((await api.currentMember()).memberNumber, recovered.memberNumber);
  assert.deepEqual(storage.get(storeKey), once, 'reopening an upgraded snapshot is idempotent');
  assert(files.has(avatarPath));
});
