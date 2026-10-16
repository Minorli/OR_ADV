export type ReferencePanel = 'activity' | 'core' | 'rules' | 'contact' | 'handbook' | 'business' | 'partners' | 'dossier' | 'learning' | 'skills';
interface ReferenceHost {
  data: { refPanel?: string; embedded?: boolean; referenceChanged?: boolean };
  setData(values: Record<string, unknown>): void;
  getTabBar?(): { setData(values: Record<string, unknown>): void } | null;
  triggerEvent?(name: string, detail?: unknown): void;
}
export function readReferenceChrome() {
  const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : null;
  const menu = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
  const width = info?.windowWidth || 390;
  return { top: info?.statusBarHeight ?? 44, right: menu && menu.left > 0 ? Math.max(0, width - menu.left + 8) : 16,
    bottom: info?.safeArea ? Math.max(0, info.screenHeight - info.safeArea.bottom) : 0 };
}
export function syncReferenceTab(host: object, selected: number) {
  const page = host as ReferenceHost;
  page.setData({ v2Chrome: readReferenceChrome() });
  page.getTabBar?.()?.setData({ selected, hidden: !!page.data.refPanel });
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
  else wx.navigateBack({ delta: 1 });
}
export function markReferenceChanged(host: object) {
  const page = host as ReferenceHost;
  if (page.data.embedded) page.setData({ referenceChanged: true });
}
