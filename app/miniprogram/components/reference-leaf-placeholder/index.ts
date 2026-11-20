Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { params: { type: Object, value: {} } },
  methods: {
    closePlaceholder() {
      this.triggerEvent('requestclose', {});
    },
  },
});
