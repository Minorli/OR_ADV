import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/errors';
import type { Store } from '../../shared/store';
import type { RpcRequest, RpcResponse, TrustedIdentity } from '../../shared/types';
import { AVATAR_REQUEST_LIMIT } from '../../shared/avatar-image';

export interface RuntimeConfig { envId?: string; appId?: string; runtimeEnvId?: string }
export interface WeChatContext { OPENID?: unknown; APPID?: unknown; ENV?: unknown }
export interface HandlerDependencies {
  config: () => RuntimeConfig;
  context: () => WeChatContext;
  store: () => Store;
  invoke: (request: RpcRequest, identity: TrustedIdentity, traceId: string) => Promise<RpcResponse>;
  now?: () => number;
  trace?: () => string;
  log?: (entry: { traceId: string; action: string; code: string }) => void;
}

function reject(code: string, message: string): never { throw new DomainError(code, message); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateRuntime(config: RuntimeConfig, context: WeChatContext): TrustedIdentity {
  if (!config.envId || !/^[a-zA-Z0-9_-]{5,100}$/.test(config.envId) || !/^wx[a-fA-F0-9]{16}$/.test(config.appId ?? '')) {
    reject('TEMPORARY_FAILURE', '服务尚未配置，请联系工作人员');
  }
  if (!config.runtimeEnvId || config.runtimeEnvId !== config.envId || context.ENV !== config.envId) {
    reject('TEMPORARY_FAILURE', '服务环境不匹配，请联系工作人员');
  }
  if (typeof context.OPENID !== 'string' || !context.OPENID || context.OPENID.length > 128 || context.APPID !== config.appId) {
    reject('UNAUTHENTICATED', '请通过本小程序访问');
  }
  return { appId: config.appId!, openId: context.OPENID };
}

export function validateEnvelope(value: unknown): RpcRequest {
  if (!object(value)) reject('INVALID_INPUT', '请求格式不正确');
  // Native wx.cloud.callFunction adds userInfo to the event. It is transport
  // metadata, never an identity source; validateRuntime still uses SDK context.
  const allowed = ['action', 'requestId', 'clubId', 'payload', 'expectedRevision', 'userInfo'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject('INVALID_INPUT', '请求包含不支持的字段');
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(value)); } catch { reject('INVALID_INPUT', '请求格式不正确'); }
  if (size! > (['profile.avatar.save','media.image.save'].includes(String(value.action)) ? AVATAR_REQUEST_LIMIT : value.action === 'staff.learning.catalog.save' ? 262144 : ['staff.club.content.save','staff.history.save'].includes(String(value.action)) ? 65536 : 16_384) || typeof value.action !== 'string' || !/^[a-z][a-zA-Z.]{1,79}$/.test(value.action)
    || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value.requestId)
    || value.clubId !== 'oradv' || !object(value.payload)
    || (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0))) {
    reject('INVALID_INPUT', '请求格式、俱乐部或版本不正确');
  }
  return {
    action: value.action,
    requestId: value.requestId,
    clubId: 'oradv',
    payload: value.payload,
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision as number }),
  };
}

async function rateLimit(store: Store, identity: TrustedIdentity, now: number, scope = '', maximum = 120): Promise<void> {
  const identityKey = scope ? JSON.stringify([identity.appId, identity.openId, scope]) : `${identity.appId}:${identity.openId}`;
  const id = createHash('sha256').update(identityKey).digest('hex');
  const window = Math.floor(now / 60_000);
  await store.transaction(async (transaction) => {
    const previous = await transaction.get<{ window: number; count: number }>('rpc_limits', id);
    if (previous && (!Number.isSafeInteger(previous.window) || !Number.isSafeInteger(previous.count) || previous.count < 0)) {
      throw new Error('Invalid rate limit state');
    }
    const count = previous?.window === window ? previous.count : 0;
    if (count >= maximum) reject('RATE_LIMITED', '操作过于频繁，请稍后重试');
    await transaction.set('rpc_limits', id, { id, clubId: 'oradv', window, count: count + 1, updatedAt: new Date(now).toISOString(), schemaVersion: 1 });
  });
}

export function createCloudHandler(dependencies: HandlerDependencies) {
  return async (event: unknown): Promise<RpcResponse> => {
    const traceId = (dependencies.trace ?? randomUUID)();
    let action = 'invalid';
    try {
      const request = validateEnvelope(event);
      action = request.action;
      const identity = validateRuntime(dependencies.config(), dependencies.context());
      await rateLimit(dependencies.store(), identity, (dependencies.now ?? Date.now)());
      if (request.action === 'profile.avatar.save') await rateLimit(dependencies.store(), identity, (dependencies.now ?? Date.now)(), ':avatar', 5);
      if (request.action === 'media.image.save') await rateLimit(dependencies.store(), identity, (dependencies.now ?? Date.now)(), ':member-media-image', 20);
      const result = await dependencies.invoke(request, identity, traceId);
      if (!result.ok) dependencies.log?.({ traceId: result.traceId, action, code: result.error.code });
      return result;
    } catch (error) {
      const known = error instanceof DomainError;
      const code = known ? error.code : 'TEMPORARY_FAILURE';
      dependencies.log?.({ traceId, action, code });
      return { ok: false, error: { code, message: known ? error.message : '服务暂时不可用，请稍后重试', retryable: known ? error.retryable || code === 'TEMPORARY_FAILURE' : true }, traceId };
    }
  };
}
