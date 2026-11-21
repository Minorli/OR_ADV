export type ReferencePanel = 'activity' | 'core' | 'rules' | 'contact' | 'handbook' | 'business' | 'partners' | 'dossier' | 'learning' | 'skills' | 'history-detail' | 'redemption';
interface ReferenceHost {
  data: { refPanel?: string; embedded?: boolean; referenceChanged?: boolean };
  setData(values: Record<string, unknown>): void;
  getTabBar?(): { setData(values: Record<string, unknown>): void } | null;
  triggerEvent?(name: string, detail?: unknown): void;
}
export function readReferenceChrome() {
  const info = typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : null;
  const menu = typeof wx !== 'undefined' && typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
  const width = info?.windowWidth && info.windowWidth >= 280 && info.windowWidth <= 1400 ? info.windowWidth : 390;
  const rawTop = info?.statusBarHeight;
  const top = typeof rawTop === 'number' && rawTop >= 0 && rawTop <= 80 ? rawTop : 44;
  const validCapsule = !!menu && menu.width >= 50 && menu.width <= 130 && menu.left >= width * 0.5 && menu.left < width;
  const rawRight = validCapsule ? Math.round(width - menu!.left + 8) : 104;
  const right = validCapsule ? Math.min(124, Math.max(88, rawRight)) : (menu ? 104 : 16);
  const bottom = info?.safeArea && info.screenHeight ? Math.max(0, Math.min(48, info.screenHeight - info.safeArea.bottom)) : 0;
  return { top, right, bottom };
}
export function syncReferenceTab(host: object, selected: number) {
  const page = host as ReferenceHost;
  page.setData({ v2Chrome: readReferenceChrome() });
  page.getTabBar?.()?.setData({ selected, hidden: !!page.data.refPanel });
  if (typeof wx !== 'undefined' && typeof wx.nextTick === 'function') {
    wx.nextTick(() => { page.setData({ v2Chrome: readReferenceChrome() }); });
  }
}
export function openReferencePanel(host: object, kind: ReferencePanel, params: Record<string, string> = {}) {
  const page = host as ReferenceHost;
  page.setData({ refPanel: kind, refParams: { ...params } });
  page.getTabBar?.()?.setData({ hidden: true });
}
export function closeReferencePanel(host: object) {
  const page = host as ReferenceHost;
  page.setData({ refPanel: '', refParams: {} });
  page.getTabBar?.()?.setData({ hidden: false });
}
export function closeReferenceLeaf(host: object) {
  const page = host as ReferenceHost;
  if (page.data.embedded && page.triggerEvent) page.triggerEvent('requestclose', { changed: !!page.data.referenceChanged });
  else if (typeof getCurrentPages === 'function' && getCurrentPages().length <= 1) wx.switchTab({ url: '/pages/activities/index' });
  else wx.navigateBack({ delta: 1 });
}
export function navigateToReferenceLogin(host: object) {
  const page = host as ReferenceHost;
  if (page.data.embedded && page.triggerEvent) page.triggerEvent('requestclose', { changed: !!page.data.referenceChanged, login: true });
  else { wx.setStorageSync('oradv-open-login', true); wx.switchTab({ url: '/pages/profile/index' }); }
}
export function markReferenceChanged(host: object) {
  const page = host as ReferenceHost;
  if (page.data.embedded) page.setData({ referenceChanged: true });
}
