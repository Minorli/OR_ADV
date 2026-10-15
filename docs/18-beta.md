# 首个内测版本：开发、看效果、接测试云

更新时间：2026-10-15。目标版本 `0.1.0-test.1`。最新执行结果见 [交接记录](../HANDOFF.md)。

## 现在具备什么

开发负责人已确认微信账号是项目开发者，已提供 AppID，有 Mac 可以运行官方开发者工具；日常代码在 Linux 上迭代。测试云未开通，后台“审核中”具体事项未核实，不能据此判断备案或认证已完成。

当前先交付模拟模式：页面和业务逻辑使用同一套领域服务，数据保存在设备本地。不同手机的模拟数据互不共享；换设备不能期待看到同一份报名名单。真实多人内测需完成下面的测试云接入。

## Linux 构建，Mac 导入，手机扫码

Linux：

```sh
npm ci
npm ci --prefix cloudfunctions/oradv --ignore-scripts
cp config/local.example.json config/local.json
# 填写本项目 AppID，未知 EnvId 保持空白；不要覆盖已有 local.json。
npm run build
npm run pack:preview
```

如果已有 `config/local.json`，保留并编辑原文件。构建默认 `mock/test`；不会登录腾讯、创建环境、购买套餐或上传微信代码。生成的 `project.config.json`、`runtime-config.json`、JS 文件均不提交 Git。

Mac 两种用法：

1. 开发者工具预览包：将 `dist/OR_ADV-mock-preview.zip` 复制到 Mac，解压，导入其中 `OR_ADV-preview/`。导入时核对 AppID，再点击工具栏“预览”，用项目开发者本人微信扫码。
2. 持续开发：在 Mac 克隆同一仓库，安装依赖、填写本地配置、构建后导入 `app/miniprogram/`；也可把 Linux 构建后的整个 `app/miniprogram/` 同步到 Mac 的独立目录。保持目录完整，并保留 Mac 自己的工具私有设置。

手机适合体验页面和操作流程；开发者工具负责导入、预览和定位问题。预览不等于已发布，普通成员长期试用需要后台体验成员权限及体验版本。工具安装与角色权限以 [微信官方开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)、[发布流程](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.html) 为准。

## 模拟模式体验顺序

1. 以游客打开活动列表，查看入门活动、规则和装备。
2. 在身份页阅读规则并建立模拟新车友身份，确认成长积分从零开始。
3. 申请零门槛活动，查看“我的活动”中的真实模拟状态。
4. 在个人页切换模拟员工身份，进入员工工作台，审核并确认该申请。
5. 工作台开始活动，记录出发和结束核验，结束活动后预览、执行结算。
6. 切回原模拟车友，核对只增加一次积分与完成次数；主动加入／退出公开榜单。

所有模拟身份切换仅用于本地演示；真实云端从微信可信上下文取得身份，不接受客户端指定角色。初始积分、时间、人数和资格政策是虚构或 proposed，不代表已获主理人批准。具体按钮以当前页面为准。

## 开通测试云：一次性由有权人员办理

按 [CloudBase 官方创建环境指引](https://docs.cloudbase.net/quick-start/create-env)（2026-10-15 查阅）：

1. 在 Mac 微信开发者工具中登录开发者本人的微信，打开**公司小程序**项目，核对 AppID。
2. 点击顶部“云开发”。先检查有没有已有环境；首次开通按页面完成服务开通与必要授权。
3. 为本项目建立测试环境，例如名称 `oradv-test`；确认账户归属、实际套餐、到期、数据库能力和费用。若出现付费订单，由有权付款人确认，开发脚本不会代购。
4. 从环境设置复制实际 **EnvId**。名称 `oradv-test` 不能替代 EnvId。只需提供 EnvId、地域和到期信息，不要发登录会话或密钥。
5. 若提示主体、认证、绑定或授权不足，记录平台原文，交管理员完成对应步骤；继续本地开发。

优先从小程序工具创建关联环境；已有腾讯云环境需按官方指引核对绑定关系。开发者成员权限、云资源权限、产品内员工权限分别核验。

## 接入真实测试版

拿到测试 EnvId 后，依 [云环境部署](10-cloud.md) 核对集合、索引、安全规则与函数配置，先预检再对测试环境执行。敏感集合不开放客户端直读写，所有业务通过云函数。

```sh
# config/local.json 中设置真实 AppID 和 environments.test.envId
npm run build:cloud
node scripts/wechat-ci.cjs preview --env test --config config/local.json
```

构建只生成产物；上传预检只核对配置，不代表云端可用。缺少上传私钥时，用 Mac 官方工具预览即可。Linux 自动预览还需管理员生成上传私钥、设置公网出口白名单；私钥放仓库之外，路径写入本地配置。

真实云端需部署者初始化俱乐部和首位 owner，之后由 owner 授权运营及限场领队。首次注册用户不自动成为管理员。先跑一条“零积分新用户→申请→审核确认→出发结束→结算→本人流水”链路，再邀请其他体验成员。

真实测试必须记录微信身份、权限拒绝、末席并发、重复结算、退出榜单，以及 iOS/Android 结果。尚无证据的项目继续标待执行；[完整验收清单](12-acceptance.md) 不因本地自动化通过就全部打勾。

## Linux 直接生成模拟预览码（已有上传密钥时）

模拟预览不依赖测试云，但仍需要真实 AppID、有效上传密钥和出口 IP 白名单。辅助工具必须显式选择 `--mock`，仅允许测试预览，拒绝将模拟包当作云端版本上传。

```sh
npm install --prefix work/wechat-ci --save-exact --ignore-scripts miniprogram-ci@2.1.31
npm run build
node scripts/wechat-ci.cjs preview --env test --mock --config config/local.json
# 核对 AppID、版本、密钥路径与白名单后执行：
node scripts/wechat-ci.cjs preview --env test --mock --config config/local.json --execute
```

`work/` 中的工具依赖、预览码和本地配置都不进 GitHub。SDK 安装与本地预检不能证明上传权限；执行结果单独记入交接。预览码只交给项目成员，不能当公开发布二维码使用。

## 本轮内测限制

- 为控制 CloudBase 单事务操作数，每场最多30人，年度奖励快照最多30人；超过规模需先实现分批对账后再放开。
- 候补由运营在工作台主动提升；一次重核最早5名候补。若被无效资格等阻塞，先联系并处理对应候补，再重试。当前不提供自动提升或订阅消息。
- 活动发布后冻结关键字段；本轮不提供发布后改期及重新征求同意的完整工作流。
- 业务已有角色授权及年度快照接口，完整角色／审计和年度奖励管理页面留待下一轮。
- 隐私模板、内容安全接入、备份恢复和真实手机验收仍需结合实际环境完成；模拟通过不等于正式上线验收完成。

## 构建与预览一致性

监听模式方便日常开发，不生成可上传的最终元数据。停止监听后，先执行一次 `npm run build` 再预览或打包。成功构建的元数据绑定所有实际部署文件的SHA256；构建失败、文件变动、项目内出现秘密文件名或符号链接时，预览和打包会拒绝继续。Mac工具生成的 `project.private.config.json` 被排除。
