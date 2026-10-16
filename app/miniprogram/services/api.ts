import { seedClubContentDemo } from '../../../shared/club-content-demo';
import { createService } from '../../../shared/service';
import { createDemoStore, DEMO_IDENTITIES, upgradeDemoMemberNumbers } from '../../../shared/demo';
import { createShowcaseStore } from '../../../shared/demo-showcase';
import { MemoryStore } from '../../../shared/memory-store';
import type { RpcResponse, MemberSummary } from '../../../shared/types';
import type { StoreSnapshot } from '../../../shared/store';
import { clearMockAvatarFiles, createMockAvatarStorage } from './profile-avatar';
import { clearMockMemberMediaFiles, createLocalMemberMediaStorage, MemberMediaError } from './member-media';
import { seedLearningDemo } from '../../../shared/learning-content';

interface RuntimeConfig { mode: 'mock' | 'cloud'; envId: string; appId: string; version: string }
export const runtime = require('../runtime-config.json') as RuntimeConfig;
declare const __ORADV_MODE__: 'mock' | 'cloud';
export const isMock = __ORADV_MODE__ === 'mock';
export type MockRole = 'guest' | keyof typeof DEMO_IDENTITIES;
const STORE_KEY = 'oradv-beta-store-v3';
const IDENTITY_KEY = 'oradv-beta-identity-v3';
export const MOCK_CHECKLIST_PREFIX = 'oradv-beta-checklist-v3-';
let store: MemoryStore | undefined;
let service: ReturnType<typeof createService> | undefined;
let selectedRole: MockRole = 'guest';
let sessionEpoch = 0;
const pausedScopes = new Set<string>();
const sessionScope = () => JSON.stringify([runtime.mode, runtime.appId, runtime.envId]);
const pausedKey = (scope: string) => `oradv-viewer-paused-v1:${scope}`;
function isPaused(scope: string): boolean { return pausedScopes.has(scope) || wx.getStorageSync(pausedKey(scope)) === true; }
function assertSession(epoch: number, scope: string): void {
  if (sessionEpoch !== epoch || sessionScope() !== scope) throw new ApiError('SESSION_CHANGED', '登录状态已变化，请重新打开当前页面');
}
if (isMock) {
  const savedRole = wx.getStorageSync(IDENTITY_KEY) as MockRole;
  if (savedRole === 'guest' || Object.prototype.hasOwnProperty.call(DEMO_IDENTITIES, savedRole)) selectedRole = savedRole;
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public traceId = '') { super(message); }
}
export function mockRole(): MockRole { return selectedRole; }
export function switchMockRole(role: MockRole): void {
  if (!isMock) throw new ApiError('FORBIDDEN', '真实环境不可切换身份');
  sessionEpoch++;
  selectedRole = role;
  wx.setStorageSync(IDENTITY_KEY, role);
}
/** Pause this device's private view; keep account records and other environments intact. */
export function signOut(): void {
  if (isMock) { switchMockRole('guest'); return; }
  const scope = sessionScope();
  sessionEpoch++;
  pausedScopes.add(scope);
  wx.setStorageSync(pausedKey(scope), true);
}
export function resetMock(dataset: 'showcase' | 'empty' = 'showcase'): void {
  if (!isMock) return;
  clearMockAvatarFiles();
  clearMockMemberMediaFiles();
  store = dataset === 'empty' ? createDemoStore() : createShowcaseStore();
  service = createService(store, { avatarStorage: createMockAvatarStorage(), memberMediaStorage: createLocalMemberMediaStorage() });
  wx.setStorageSync(STORE_KEY, store.snapshot());
  for (const key of wx.getStorageInfoSync().keys) {
    if (key.startsWith(MOCK_CHECKLIST_PREFIX)) wx.removeStorageSync(key);
  }
  switchMockRole('guest');
}
function getMockService(): ReturnType<typeof createService> {
  if (service) return service;
  const snapshot = wx.getStorageSync(STORE_KEY);
  if (snapshot !== undefined && snapshot !== '') {
    try {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid local snapshot');
      const upgraded = seedClubContentDemo(seedLearningDemo(upgradeDemoMemberNumbers(snapshot as StoreSnapshot)));
      const restored = new MemoryStore(upgraded);
      wx.setStorageSync(STORE_KEY, upgraded);
      store = restored;
    } catch {
      throw new ApiError('LOCAL_DATA_UPGRADE_FAILED', '本地数据未能完成编号更新，请检查本机存储后重试。原有数据不会被重置。');
    }
  } else store = createShowcaseStore();
  service = createService(store, { avatarStorage: createMockAvatarStorage(), memberMediaStorage: createLocalMemberMediaStorage() });
  return service;
}
export async function call<T>(action: string, payload: Record<string, unknown> = {}, expectedRevision?: number): Promise<T> {
  const epoch = sessionEpoch, scope = sessionScope();
  const guestView = !isMock && action !== 'identity.ensure' && isPaused(scope);
  const request = { action, payload, expectedRevision, clubId: 'oradv', requestId: `wx-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`, ...(guestView ? { viewerMode: 'guest' as const } : {}) };
  let response: RpcResponse<T>;
  if (isMock) {
    const role = action === 'identity.ensure' && selectedRole === 'guest' ? 'member' : selectedRole;
    const identity = role === 'guest' ? null : DEMO_IDENTITIES[role];
    response = await getMockService().handle(request, identity) as RpcResponse<T>;
    if (store) wx.setStorageSync(STORE_KEY, store.snapshot());
  } else {
    try {
      const result = await wx.cloud.callFunction({ name: 'oradv', data: request });
      response = result.result as RpcResponse<T>;
    } catch {
      throw new ApiError('NETWORK', '暂时连接不上，请检查网络后重试');
    }
  }
  assertSession(epoch, scope);
  if (!response || typeof response.ok !== 'boolean') throw new ApiError('INVALID_RESPONSE', '服务暂不可用，请稍后重试');
  if (!response.ok) throw new ApiError(response.error.code, response.error.message, response.traceId);
  if (action === 'identity.ensure') {
    if (isMock && selectedRole === 'guest') switchMockRole('member');
    else if (!isMock) {
      // Only a successful explicit login can restore this scope's private view.
      wx.removeStorageSync(pausedKey(scope));
      pausedScopes.delete(scope);
      sessionEpoch++;
    }
  }
  return response.data;
}
export async function currentMember(): Promise<MemberSummary | null> {
  try { return await call<MemberSummary | null>('identity.me'); }
  catch (error) {
    if (error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) return null;
    throw error;
  }
}
export function errorMessage(error: unknown): string { return error instanceof ApiError || error instanceof MemberMediaError ? error.message : '操作暂未完成，请稍后重试'; }
export function toast(message: string): void { wx.showToast({ title: message, icon: 'none', duration: 2400 }); }
export async function confirm(title: string, content: string): Promise<boolean> {
  const result = await wx.showModal({ title, content, confirmText: '确认', confirmColor: '#b54700' });
  return result.confirm;
}
