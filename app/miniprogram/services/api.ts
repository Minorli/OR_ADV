import { createService } from '../../../shared/service';
import { createDemoStore, DEMO_IDENTITIES } from '../../../shared/demo';
import { MemoryStore } from '../../../shared/memory-store';
import type { RpcResponse, MemberSummary } from '../../../shared/types';

interface RuntimeConfig { mode: 'mock' | 'cloud'; envId: string; appId: string; version: string }
export const runtime = require('../runtime-config.json') as RuntimeConfig;
declare const __ORADV_MODE__: 'mock' | 'cloud';
export const isMock = __ORADV_MODE__ === 'mock';
export type MockRole = 'guest' | keyof typeof DEMO_IDENTITIES;
const STORE_KEY = 'oradv-beta-store-v1';
const IDENTITY_KEY = 'oradv-beta-identity-v1';
let store: ReturnType<typeof createDemoStore> | undefined;
let service: ReturnType<typeof createService> | undefined;
let selectedRole: MockRole = 'guest';
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
  selectedRole = role;
  wx.setStorageSync(IDENTITY_KEY, role);
}
export function resetMock(): void {
  if (!isMock) return;
  store = createDemoStore();
  service = createService(store);
  wx.setStorageSync(STORE_KEY, store.snapshot());
  switchMockRole('guest');
}
function getMockService(): ReturnType<typeof createService> {
  if (service) return service;
  const snapshot = wx.getStorageSync(STORE_KEY);
  store = snapshot && typeof snapshot === 'object' ? new MemoryStore(snapshot) : createDemoStore();
  service = createService(store);
  return service;
}
export async function call<T>(action: string, payload: Record<string, unknown> = {}, expectedRevision?: number): Promise<T> {
  const request = { action, payload, expectedRevision, clubId: 'oradv', requestId: `wx-${Date.now()}-${Math.random().toString(36).slice(2, 12)}` };
  let response: RpcResponse<T>;
  if (isMock) {
    const role = action === 'identity.ensure' && selectedRole === 'guest' ? 'member' : selectedRole;
    const identity = role === 'guest' ? null : DEMO_IDENTITIES[role];
    response = await getMockService().handle(request, identity) as RpcResponse<T>;
    if (response.ok && action === 'identity.ensure' && selectedRole === 'guest') switchMockRole('member');
    if (store) wx.setStorageSync(STORE_KEY, store.snapshot());
  } else {
    try {
      const result = await wx.cloud.callFunction({ name: 'oradv', data: request });
      response = result.result as RpcResponse<T>;
    } catch {
      throw new ApiError('NETWORK', '暂时连接不上，请检查网络后重试');
    }
  }
  if (!response || typeof response.ok !== 'boolean') throw new ApiError('INVALID_RESPONSE', '服务暂不可用，请稍后重试');
  if (!response.ok) throw new ApiError(response.error.code, response.error.message, response.traceId);
  return response.data;
}
export async function currentMember(): Promise<MemberSummary | null> {
  try { return await call<MemberSummary | null>('identity.me'); }
  catch (error) {
    if (error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) return null;
    throw error;
  }
}
export function errorMessage(error: unknown): string { return error instanceof ApiError ? error.message : '操作暂未完成，请稍后重试'; }
export function toast(message: string): void { wx.showToast({ title: message, icon: 'none', duration: 2400 }); }
export async function confirm(title: string, content: string): Promise<boolean> {
  const result = await wx.showModal({ title, content, confirmText: '确认', confirmColor: '#31543e' });
  return result.confirm;
}
