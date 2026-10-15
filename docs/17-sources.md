# 官方来源与核对说明

整理日期 2026-10-15。平台界面、套餐、能力、认证路径和命令随版本变化，实施时记录当前页面与账号结果。技术只以官方资料为依据；公司资料以真实有效执照为准，用户截图不是官方核验。

| 主题 | 官方来源 | 本包使用范围 |
|---|---|---|
| 成员角色、与公众号绑定区别 | [腾讯客服成员管理](https://kf.qq.com/faq/170302zeQryI170302beuEVn.html) | 项目成员、体验者、角色与公众号额度独立 |
| 开发、体验、审核与发布 | [微信发布流程](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.html) | 上传/体验/提审/发布分开 |
| 微信认证 | [认证指引](https://developers.weixin.qq.com/miniprogram/product/renzheng.html) | 企业非普遍提审前提；材料、订单、年审 |
| 类目 | [非个人主体类目表](https://developers.weixin.qq.com/miniprogram/product/material/) | 候选类目，实际功能和账号准入再核对 |
| 备案 | [微信备案指南](https://developers.weixin.qq.com/miniprogram/product/record/guidelines) | 正式上线前备案与资料 |
| 运营规则 | [微信运营规范](https://developers.weixin.qq.com/miniprogram/product/) | 内容、真实服务、资质与审核一致 |
| Linux 上传 | [miniprogram-ci](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html) | 上传私钥、白名单、preview/upload |
| CI 源码说明 | [微信官方 CI 仓库](https://github.com/wechat-miniprogram/miniprogram-ci-dist/blob/master/README.md) | 安装版本和参数接入时核对 |
| 成员自动化 | [miniprogram-mp-ci](https://developers.weixin.qq.com/miniprogram/dev/devtools/miniprogram-mp-ci.html) | 批量成员管理，不扩大为全后台 |
| 调试工具 | [官方开发者工具下载](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) | 日常电脑与手机调试 |
| CLI 登录 | [CloudBase CLI 安装](https://docs.cloudbase.net/cli-v1/install) | 设备码和 TCB_NO_BROWSER |
| 云函数部署 | [CLI functions](https://docs.cloudbase.net/cli-v1/functions/quick-start) | 环境显式指定，运行时另查 |
| 云账号 | [CloudBase 账号FAQ](https://docs.cloudbase.net/faq/account) | 先核对绑定与已有账号 |
| 套餐与免费到期 | [腾讯云资源点价格](https://cloud.tencent.com/document/product/876/127357) | 适用套餐、额度、发布后15天到期等 |
| 云开发价格 | [官方购买页](https://buy.cloud.tencent.cn/price/tcb) | 实际订单和续费价优先 |
| 事务 | [CloudBase 事务](https://docs.cloudbase.net/database/transaction) | 事务一致性与分批结算 |
| 备份 | [CloudBase 备份](https://docs.cloudbase.net/database/backup) | 不同恢复能力与保留期限分别核对 |
| 隐私 | [微信用户隐私保护](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/) | 隐私声明、同意和实际调用一致 |
| Node 支持期 | [Node.js Release](https://github.com/nodejs/Release) | 本地 Node 24/22 与云运行时分开 |
| 云平台接入示例 | [腾讯云小程序接入文档](https://cloud.tencent.com/document/product/1301/86886) | 该文为微搭场景，不强迫本项目购买微搭；企业云能力的认证要求需核对实际原生入口 |

不要从微搭托管文档推断本项目必须把 AppSecret/私钥上传给低代码产品；本项目使用原生方案。不要从“认证不是普遍提审前提”推断特定云能力、手机号或支付无需认证。

线下训练、旅游边界和活动场地/保险的官方材料及具体咨询建议，随附主理人 HTML 已列；按实际活动向适用主管部门核对。资料包不是已取得的行政许可或腾讯预审结论。

## 首次实现追加核对（2026-10-15）

[CloudBase 创建环境指引](https://docs.cloudbase.net/quick-start/create-env) 说明：微信小程序可在开发者工具顶部“云开发”入口创建自动关联的环境；已有腾讯云环境需核对账号绑定。免费资格、套餐与到期仍以实际账号为准，本次未创建或购买环境。

[微信官方 SDK 源码](https://github.com/wechat-miniprogram/wx-server-sdk) 与 [CloudBase 事务文档](https://docs.cloudbase.net/database/transaction) 用于核对可信上下文和事务边界。实际 SDK 安装版本见函数 package-lock.json；本地适配器测试不替代真实云端事务验证。微信文档部分页面在本机抓取失败，相关后台操作须以官方工具当前界面再次核对。
