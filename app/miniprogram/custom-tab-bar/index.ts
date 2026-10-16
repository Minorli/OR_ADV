const tabs = [
  { path: '/pages/activities/index', text: '首页', icon: 'home' },
  { path: '/pages/ranking/index', text: '排行', icon: 'rank' },
  { path: '/pages/history/index', text: '历史', icon: 'history' },
  { path: '/pages/profile/index', text: '我的', icon: 'profile' },
];
Component({
  data: { selected: 0, hidden: false, tabs },
  lifetimes: {
    attached() {
      const pages = getCurrentPages(), route = pages[pages.length - 1]?.route;
      const selected = tabs.findIndex(tab => tab.path === '/' + route);
      if (selected >= 0) this.setData({ selected });
    },
  },
  methods: {
    choose(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || !tabs[index] || this.data.hidden || index === this.data.selected) return;
      wx.switchTab({ url: tabs[index].path });
    },
  },
});
