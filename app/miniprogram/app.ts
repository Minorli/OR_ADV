import { runtime } from './services/api';
App({
  onLaunch() {
    if (runtime.mode === 'cloud') {
      if (!wx.cloud) { wx.showModal({ title: '微信版本较低', content: '请更新微信后重试。', showCancel: false }); return; }
      wx.cloud.init({ env: runtime.envId, traceUser: true });
    }
  },
});
