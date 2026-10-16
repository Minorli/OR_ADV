interface Mount { key: string; kind: string; params: Record<string, string> }
interface HostState { attached: boolean; serial: number; signature: string; closing: boolean }
const states = new WeakMap<object, HostState>();
const kinds = ['activity', 'core', 'rules', 'contact', 'handbook', 'business', 'partners', 'dossier', 'learning', 'skills', 'history-detail', 'redemption'];
const sections: Record<string, string> = { core: 'core', rules: 'points', contact: 'contacts', handbook: 'handbook', business: 'business', partners: 'partners' };
function parameters(kind: string, value: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) {
    if (['id', 'activityId', 'memberId', 'mode', 'section', 'level'].includes(key) && typeof item === 'string' && item.length <= 200) params[key] = item;
  }
  if (sections[kind]) params.section = sections[kind];
  if (kind === 'activity' && !params.id && params.activityId) params.id = params.activityId;
  if (kind === 'skills') params.level = params.level === 'advanced' ? 'advanced' : 'basic';
  return params;
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { kind: { type: String, value: '' }, params: { type: Object, value: {} } },
  data: { mounts: [] as Mount[], isSheet: false },
  observers: {
    'kind, params'() { if (states.get(this)?.attached) this.syncPanel(); },
  },
  lifetimes: {
    attached() { states.set(this, { attached: true, serial: 0, signature: '', closing: false }); this.syncPanel(); },
    detached() { const state = states.get(this); if (state) { state.attached = false; state.serial++; } },
  },
  methods: {
    syncPanel() {
      const state = states.get(this); if (!state?.attached) return;
      const kind = kinds.includes(this.properties.kind) ? this.properties.kind : '';
      const params = parameters(kind, this.properties.params), signature = JSON.stringify([kind, Object.entries(params).sort()]);
      if (state.signature === signature) return;
      state.signature = signature; state.serial++;
      // A different route gets a different native component instance. Old async
      // work remains attached to its disposed controller, never the new route.
      this.setData({ mounts: kind ? [{ key: `reference-${state.serial}`, kind, params }] : [], isSheet: kind === 'activity' || kind === 'core' });
    },
    stop() {},
    async requestClose() {
      const state = states.get(this), mount = this.data.mounts[0];
      if (!state?.attached || state.closing || !mount) return;
      const child = this.selectComponent('#reference-leaf') as { referenceRequestClose?: () => Promise<{ allowed: boolean; changed: boolean }> } | null;
      if (!child?.referenceRequestClose) return;
      state.closing = true;
      try {
        const result = await child.referenceRequestClose();
        if (result.allowed && state.attached && this.data.mounts[0]?.key === mount.key) this.triggerEvent('close', { changed: result.changed === true });
      } finally { state.closing = false; }
    },
  },
});
