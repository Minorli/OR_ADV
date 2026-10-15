# 从当前状态开始

先读 [项目首页](README.md)、[最新交接](HANDOFF.md) 和 [内测上手指南](docs/18-beta.md)。

2026-10-15 最新用户信息：开发者身份已确认，AppID 已提供，有 Mac 和手机；日常代码在 Linux 上迭代。测试云尚未开通，后台审核事项待核实。GitHub 仓库按用户明确要求为公开。

先在 Linux 执行 `npm ci` 和 `npm ci --prefix cloudfunctions/oradv --ignore-scripts`，保留或创建本地 `config/local.json`，填入 AppID，然后运行 `npm run build`。在 Mac 微信开发者工具导入 `app/miniprogram/`，手机扫码预览。默认使用设备本地虚构数据，不能据此声称微信登录和云端多人业务已验收。

测试云开通步骤、操作人员和真实接入依赖详见 [内测指南](docs/18-beta.md)。不需要先买独立服务器。代码、模拟测试和页面工作可以继续推进，缺少云账号信息只阻塞真实联调。
