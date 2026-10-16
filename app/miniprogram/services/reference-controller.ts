import { ApiError, confirm, errorMessage, toast } from './api';

/** Keep the same generic/ThisType contract as the native Page constructor. */
export function defineReferencePage<D extends WechatMiniprogram.Page.DataOption, C extends WechatMiniprogram.Page.CustomOption>(
  controller: WechatMiniprogram.Page.Options<D, C>,
): WechatMiniprogram.Page.Options<D, C> { return controller; }

interface ReferenceInstance {
  data: Record<string, any>; properties: { params?: Record<string, string> };
  setData(values: Record<string, unknown>, callback?: () => void): void;
  triggerEvent(name: string, detail?: unknown): void;
}
export interface ReferenceCloseResult { allowed: boolean; changed: boolean }
export interface ReferenceAdapterOptions {
  isBusy?: (data: Record<string, any>) => boolean;
  isDirty?: (data: Record<string, any>) => boolean;
}
interface State { attached: boolean; loaded: boolean; visible: boolean; wanted: boolean; disposed: boolean; visibility: number; close?: Promise<ReferenceCloseResult> }
const states = new WeakMap<object, State>();
const lifecycleNames = new Set(['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onPullDownRefresh', 'onReachBottom', 'onPageScroll', 'onResize', 'onShareAppMessage', 'onShareTimeline', 'onRouteDone']);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Reuse one native controller; do not create another API/service/session instance. */
export function referenceComponent<D extends WechatMiniprogram.Page.DataOption, C extends WechatMiniprogram.Page.CustomOption>(
  controller: WechatMiniprogram.Page.Options<D, C>, options: ReferenceAdapterOptions = {},
): WechatMiniprogram.Component.TrivialOption {
  const original = controller as Record<string, any>;
  const stateFor = (host: object) => {
    let state = states.get(host);
    if (!state) { state = { attached: false, loaded: false, visible: false, wanted: true, disposed: false, visibility: 0 }; states.set(host, state); }
    return state;
  };
  const report = (host: ReferenceInstance, error: unknown) => {
    if (error instanceof ApiError && error.code === 'REFERENCE_CLOSED') return;
    if (!stateFor(host).disposed) host.setData({ error: errorMessage(error) });
  };
  const observe = (host: ReferenceInstance, value: unknown) => {
    if (value && typeof (value as Promise<unknown>).then === 'function') void Promise.resolve(value).catch(error => report(host, error));
    return value;
  };
  const invoke = (host: ReferenceInstance, name: string, ...args: unknown[]) => {
    try { return typeof original[name] === 'function' ? observe(host, original[name].apply(host, args)) : undefined; }
    catch (error) { report(host, error); return undefined; }
  };
  const show = (host: ReferenceInstance) => {
    const state = stateFor(host); state.wanted = true;
    if (!state.attached || !state.loaded || state.visible || state.disposed) return;
    state.visible = true;
    return invoke(host, 'onShow');
  };
  const hide = (host: ReferenceInstance) => {
    const state = stateFor(host); state.wanted = false; state.visibility++;
    if (!state.visible || state.disposed) return;
    state.visible = false;
    return invoke(host, 'onHide');
  };
  const methods: Record<string, (...args: any[]) => any> = {};
  for (const [name, method] of Object.entries(original)) if (typeof method === 'function' && !lifecycleNames.has(name)) {
    methods[name] = function (this: ReferenceInstance, ...args: unknown[]) {
      if (stateFor(this).disposed) throw new ApiError('REFERENCE_CLOSED', '页面已关闭，请重新打开');
      // Preserve false/true and all other synchronous return values exactly.
      return observe(this, method.apply(this, args));
    };
  }
  methods.referenceRequestClose = function (this: ReferenceInstance): Promise<ReferenceCloseResult> {
    const state = stateFor(this);
    if (state.close) return state.close;
    const visibility = state.visibility;
    const result = (allowed: boolean) => ({ allowed, changed: this.data.referenceChanged === true });
    state.close = (async () => {
      if (state.disposed) return result(false);
      if (options.isBusy?.(this.data)) { toast('正在处理，请稍候再关闭'); return result(false); }
      if (options.isDirty?.(this.data) && !await confirm('关闭当前内容', '有尚未保存的修改，是否放弃并关闭？')) return result(false);
      return result(!state.disposed && state.visibility === visibility && !options.isBusy?.(this.data));
    })().catch(error => { report(this, error); return result(false); }).finally(() => { state.close = undefined; });
    return state.close;
  };
  return {
    options: { ...(controller.options ?? {}), styleIsolation: 'apply-shared' },
    properties: { params: { type: Object, value: {} } },
    data: { ...clone(controller.data ?? {}), embedded: true, referenceChanged: false },
    methods,
    lifetimes: {
      attached(this: ReferenceInstance) {
        const state = stateFor(this); state.attached = true;
        const setData = this.setData.bind(this);
        this.setData = (values, callback) => { if (!state.disposed) setData(values, callback); };
        const loaded = invoke(this, 'onLoad', { ...(this.properties.params ?? {}) });
        if (loaded && typeof (loaded as Promise<unknown>).then === 'function') return Promise.resolve(loaded).then(() => {
          state.loaded = true; if (!state.disposed && state.wanted) return show(this);
        }).catch(error => report(this, error));
        state.loaded = true; if (state.wanted) return show(this);
      },
      ready(this: ReferenceInstance) { if (!stateFor(this).disposed) return invoke(this, 'onReady'); },
      detached(this: ReferenceInstance) {
        const state = stateFor(this); if (state.disposed) return;
        hide(this); invoke(this, 'onUnload');
        state.disposed = true; state.attached = false; state.visibility++;
      },
    },
    pageLifetimes: { show(this: ReferenceInstance) { return show(this); }, hide(this: ReferenceInstance) { return hide(this); } },
  };
}
