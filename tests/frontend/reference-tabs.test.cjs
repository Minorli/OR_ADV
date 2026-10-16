const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const app = path.resolve(__dirname, '../../app/miniprogram');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const member = (id = 'rider-a') => ({ id, nickname: id, clubId: 'oradv', memberNumber: 7, rankingOptIn: true, rankingConsentVersion: 1, growthPoints: 62, annualPoints: 20, completedCount: 19, revision: 1, roles: [], memberKind: 'regular', memberKindVersion: 1, memberKindExpiresAt: null, recommendationOptIn: false, recommendationConsentVersion: 0, kindRequestStatus: null, kindRequestedAt: null });
const overview = (who = member(), rank = 3) => ({ member: who, contact: { configured: false }, contactError: '', avatarUrl: '', avatarError: '', dossier: { status: '骑手资料待准备', note: '等待补齐', ready: 5, total: 10, parts: [{ name: '头盔', ready: true }] }, statistics: { joinedAt: '2026-10-01T00:00:00.000Z', rank, rankedMembers: 23, distanceKm: null, distanceStatus: 'unrecorded' }, statisticsError: '' });
function environment() {
  const calls = [], timers = new Map(), intervals = new Map(), storage = new Map(); let role = 'member', timerId = 0, responder = async () => { throw Error('unexpected RPC'); }, who = member();
  const api = { isMock: true, runtime: { mode: 'mock', appId: 'local-only', envId: 'local-env', version: 'test' }, mockRole: () => role,
    async currentMember() { calls.push({ action: 'identity.me', payload: {} }); return who; },
    async call(action, payload = {}) { calls.push({ action, payload: structuredClone(payload) }); return responder(action, payload); },
    errorMessage: error => error.message, confirm: async () => true, toast() {}, signOut() { role = 'guest'; who = null; },
  };
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), navigateTo() {}, switchTab() {}, pageScrollTo() {}, stopPullDownRefresh() {}, previewImage() {} };
  function page(name) {
    let definition; const modules = new Map();
    function load(file) {
      if (file === path.join(app, 'services/api.ts')) return api;
      if (modules.has(file)) return modules.get(file).exports;
      const module = { exports: {} }; modules.set(file, module);
      const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      vm.runInNewContext(code, { module, exports: module.exports, wx, Page: value => { definition = value; }, console,
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
        setInterval: (callback, delay) => { intervals.set(++timerId, { callback, delay }); return timerId; }, clearInterval: id => intervals.delete(id),
        require(specifier) {
          if (!specifier.startsWith('.')) return require(specifier);
          const base = path.resolve(path.dirname(file), specifier); const resolved = [base, base + '.ts', base + '.json'].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
          assert(resolved, specifier); return resolved.endsWith('.json') ? JSON.parse(fs.readFileSync(resolved, 'utf8')) : load(resolved);
        },
      }, { filename: file }); return module.exports;
    }
    load(path.join(app, 'pages', name, 'index.ts')); assert(definition);
    const p = { ...definition, data: structuredClone(definition.data) }; p.setData = (values, callback) => { Object.assign(p.data, values); callback?.(); }; return p;
  }
  return { api, calls, page, timers, intervals, respond(fn) { responder = fn; }, switchTo(nextRole, nextMember) { role = nextRole; who = nextMember; }, async fireTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await flush(); } };
}
function card(id, total = null) {
  return { activity: { id, title: '活动' + id, description: '真实回顾', location: '营地', difficulty: '入门', startAt: '2026-10-05T00:00:00.000Z', endAt: '2026-10-06T00:00:00.000Z', actualCompletedAt: '2026-10-06T00:00:00.000Z', coverKey: 'v2-3', distanceKm: null, itinerary: [], fixtureOnly: true },
    story: { intro: '', photos: [1, 2, 3, 4].map(i => ({ url: 'https://public.example/photo-' + id + '-' + i, label: '相册' })), documentary: null, honors: [] },
    reviews: { total, items: [{ publicId: 'review-' + id, nickname: '车友', stars: 4, comment: '记得这段路' }], nextCursor: 'reviews-more' } };
}
test('four tabs retain canonical block order, six separate entries and all reference overlays', () => {
  const markup = name => fs.readFileSync(path.join(app, 'pages', name, 'index.wxml'), 'utf8');
  for (const name of ['activities', 'ranking', 'history', 'profile']) { assert.match(markup(name), /class="page reference-v2/); assert.match(markup(name), /<reference-overlay /); }
  const profile = markup('profile'); assert(profile.indexOf('class="verify-card"') < profile.indexOf('class="stats"')); assert(profile.indexOf('class="stats"') < profile.indexOf('class="grid"')); assert.equal((profile.match(/class="gi"/g) || []).length, 6); assert.equal((profile.slice(0, profile.indexOf('class="logout"')).match(/class="li"/g) || []).length, 5);
  const home = markup('activities'); assert.equal((home.match(/class="mini"/g) || []).length, 4); assert(home.indexOf('class="sponsor-band"') < home.indexOf('class="reference-home-extra"'));
  const history = markup('history'); for (const block of ['honor', 'photo-row', 'video-card', 'review']) assert(history.includes('class="' + block), block);
});
test('history loads five full cards in one RPC, previews only three photos and never invents a review total or distance', async () => {
  const env = environment(); env.respond(async action => { assert.equal(action, 'history.feed'); return { items: [1, 2, 3, 4, 5].map(id => card(String(id))), months: ['2026-10'], nextCursor: 'page-2' }; });
  const p = env.page('history'); await p.load(); assert.deepEqual(env.calls.map(call => call.action), ['history.feed']); assert.equal(p.data.items.length, 5); assert.equal(p.data.error, '');
  const first = p.data.items[0]; assert.equal(first.reviewCountText, '查看评价 ›'); assert.equal(first.distanceText, '里程未记录'); assert.equal(first.photoPreviews.length, 3); assert.equal(first.photos.length, 4); assert.equal(first.photoPreviews[2].albumLabel, '+1'); assert.equal(first.reviewPreviews[0].starsText, '★★★★☆');
});
test('month and keyword requests discard cursors, debounce repeated keystrokes and keep known public months', async () => {
  const env = environment(); env.respond(async () => ({ items: [card('one', 1)], months: ['2026-10'], nextCursor: 'page-2' })); const p = env.page('history'); await p.load();
  p.selectMonth({ currentTarget: { dataset: { month: '2026-10' } } }); await flush(); assert.deepEqual(env.calls.at(-1).payload, { month: '2026-10' });
  p.search({ detail: { value: '沙' } }); p.search({ detail: { value: '沙漠' } }); assert.equal(env.timers.size, 1); const count = env.calls.length; await env.fireTimers(); assert.equal(env.calls.length, count + 1); assert.deepEqual(env.calls.at(-1).payload, { month: '2026-10', query: '沙漠' });
  await p.load(true); assert.deepEqual(env.calls.at(-1).payload, { month: '2026-10', query: '沙漠', cursor: 'page-2' }); assert(p.data.months.some(month => month.value === '2026-10'));
});
test('a delayed previous history filter cannot replace newer cards and unloading cancels queued searches', async () => {
  const env = environment(), held = gate(); let first = true; env.respond(async () => { if (first) { first = false; await held.promise; return { items: [card('old')], months: ['2026-09'], nextCursor: 'old-cursor' }; } return { items: [card('new')], months: ['2026-10'], nextCursor: null }; });
  const p = env.page('history'), old = p.load(); p.setData({ month: '2026-10' }); await p.load(); held.release(); await old; assert.equal(p.data.items[0].id, 'new'); assert.equal(p.data.nextCursor, null);
  p.search({ detail: { value: '取消' } }); p.onUnload(); assert.equal(env.timers.size, 0);
});
test('profile uses one overview and clears new private statistics on identity changes or failures', async () => {
  const env = environment(); env.respond(async action => { assert.equal(action, 'profile.overview'); return overview(); }); const p = env.page('profile'); await p.onShow();
  assert.deepEqual(env.calls.map(call => call.action), ['profile.overview']); assert.equal(p.data.statistics.rank, 3); assert.equal(p.data.statistics.distanceKm, null); assert.equal(p.data.dossierPercent, 50); assert.equal(p.data.dossierApproved, false);
  const held = gate(); let old = true; env.respond(async () => { if (old) { old = false; await held.promise; return overview(member(), 1); } return overview(member('rider-b'), 9); });
  const pending = p.load(); env.switchTo('founder', member('rider-b')); await p.resume(); held.release(); await pending; assert.equal(p.data.member.id, 'rider-b'); assert.equal(p.data.statistics.rank, 9);
  p.clearIdentity(); assert.equal(p.data.statistics, null); assert.equal(p.data.joinedDays, null); assert.equal(p.data.dossierPercent, 0);
});
test('reference entry buttons open their actual panels and a read-only close does not issue another overview', async () => {
  const env = environment(); env.respond(async () => overview()); const p = env.page('profile'); await p.load();
  for (const [handler, kind, level] of [['dossier', 'dossier'], ['safety', 'learning'], ['basicSkills', 'skills', 'basic'], ['advancedSkills', 'skills', 'advanced'], ['core', 'core'], ['rules', 'rules'], ['contacts', 'contact'], ['handbook', 'handbook'], ['business', 'business']]) { p[handler](); assert.equal(p.data.refPanel, kind); if (level) assert.equal(p.data.refParams.level, level); p.closeReference({ detail: { changed: false } }); }
  assert.equal(env.calls.length, 1); p.closeReference({ detail: { changed: true } }); await flush(); assert.equal(env.calls.length, 2);
});

test('logout clears all private profile state even when saving the device restriction fails, and offers a working retry', async () => {
  const env = environment(); let signedOut = false, failed = true;
  env.respond(async () => signedOut ? { ...overview(null), dossier: null, statistics: null } : overview());
  const original = env.api.signOut; env.api.signOut = () => { original(); signedOut = true; if (failed) throw Error('device storage unavailable'); };
  const p = env.page('profile'); await p.load(); p.setData({ avatarUrl: '/private-avatar', avatarBase64: 'private-draft' }); await p.logout();
  assert.equal(p.data.member, null); assert.equal(p.data.avatarUrl, ''); assert.equal(p.data.avatarBase64, ''); assert.equal(p.data.statistics, null); assert(p.data.logoutError.includes('未能保存退出设置'));
  failed = false; p.retryLogout(); await flush(); assert.equal(p.data.logoutError, ''); assert.equal(p.data.member, null);
});

test('home and ranking open the correct public panels without replacing their tab routes', () => {
  const env = environment(), home = env.page('activities'), ranking = env.page('ranking');
  home.open({ currentTarget: { dataset: { id: 'published-ride' } } }); assert.equal(home.data.refPanel, 'activity'); assert.equal(home.data.refParams.id, 'published-ride');
  home.partners(); assert.equal(home.data.refPanel, 'partners'); home.learning(); assert.equal(home.data.refPanel, 'learning'); home.closeReference(); assert.equal(home.data.refPanel, '');
  ranking.duties(); assert.equal(ranking.data.refPanel, 'core'); ranking.rules(); assert.equal(ranking.data.refPanel, 'rules'); ranking.closeReference(); assert.equal(ranking.data.refPanel, ''); assert.equal(env.calls.length, 0);
});

test('hero uses the canonical 4200ms opacity cycle once per visible page and cleans hidden timers without RPCs', async () => {
  const env = environment(); env.respond(async action => action === 'club.content.get' ? { configured: false, status: 'unconfigured', blocks: [] } : { items: [], nextCursor: null });
  const p = env.page('activities'); p.onShow(); await flush(); p.startHero(); assert.equal(env.intervals.size, 1);
  const tick = [...env.intervals.values()][0]; assert.equal(tick.delay, 4200); const callCount = env.calls.length;
  for (let i = 1; i <= 4; i++) { tick.callback(); assert.equal(p.data.heroCurrent, i % 4); } assert.equal(env.calls.length, callCount);
  p.onHide(); assert.equal(env.intervals.size, 0); tick.callback(); assert.equal(p.data.heroCurrent, 0);
  p.onShow(); await flush(); assert.equal(env.intervals.size, 1); const current = p.data.heroCurrent; tick.callback(); assert.equal(p.data.heroCurrent, current, 'a queued tick from the old timer cannot advance a newly visible page');
  p.heroChange({ detail: { current: 2 } }); assert.equal(p.data.heroCurrent, 2); p.onUnload(); assert.equal(env.intervals.size, 0);
  const markup = fs.readFileSync(path.join(app, 'pages/activities/index.wxml'), 'utf8'); assert.doesNotMatch(markup, /<swiper/); assert.match(markup, /class="slide \{\{heroCurrent === index/);
});
