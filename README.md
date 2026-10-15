# OR ADV · 原始拉力

原始拉力摩托车俱乐部的微信小程序。首版面向单俱乐部，将活动招募、报名、人员核验和成长记录放在一起，帮助车友找到适合自己的活动，也让领队清楚每位参加者的状态。

活动包括非铺装越野、技能训练和多日穿越，不包含比赛。线下服务有真实收费；小程序不标价、不支付、不记录缴退款。食宿和交通由参加者自行安排。积分是准入参考，不能代替技能与安全核验。

## 当前版本

首个内测开发版 `0.1.0-test.1`，已实现**本地模拟闭环**。微信开发者身份、AppID 和 Mac 调试条件已由开发负责人提供；测试云尚未开通。“审核中”具体对应的主体、备案或其他事项待后台核对。

本地模拟数据仅存在于当前设备，不能用于真实招募；云函数部署、微信身份、云数据库事务和真机验收单独记录。完整进度见 [HANDOFF.md](HANDOFF.md) 和 [PROJECT_STATUS.json](PROJECT_STATUS.json)。

## 快速开始

需要 Node.js 22+、npm、Python 3；Mac 上安装官方微信开发者工具。

```sh
git clone git@github.com:Minorli/OR_ADV.git
cd OR_ADV
npm ci
npm ci --prefix cloudfunctions/oradv --ignore-scripts
cp config/local.example.json config/local.json
# 在 local.json 填入本项目 AppID；模拟模式暂不需要 EnvId 或私钥。
npm run build
```

在微信开发者工具导入 **`app/miniprogram/`**，选择该小程序账号。模拟版不依赖云服务；点击工具栏“预览”，由已授权的微信扫码查看。代码继续在 Linux 修改并构建，同步生成的目录到 Mac 即可。监听开发结束后，先执行一次 `npm run build`，再生成预览或打包。[内测上手指南](docs/18-beta.md) 包含同步、模拟角色、首条体验流程和开通测试云的步骤。

```sh
npm run dev           # 监听 TypeScript 修改并重建
npm run typecheck     # 严格类型检查
npm test              # 业务、权限、适配器和构建隔离测试
npm run test:tools    # 交接工具与上传预检测试
npm run check         # 类型、测试、构建与文档校验
npm run pack:preview  # 打包已构建的模拟版，供 Mac 导入
```

## 业务流程

浏览活动 → 建立本人身份 → 提交申请 → 审核／候补 → 联系确认参加 → 出发核验 → 结束核验 → 完成结算 → 查看积分流水。

报名不扣成长积分；签到不自动发分。名额、结算与冲正由服务端事务处理，一人一场最多一笔正常完成奖励。年度积分按实际完成时间的北京时间年份归属；公开榜单默认关闭，由本人选择加入。

## 工程结构

| 路径 | 内容 |
|---|---|
| `app/miniprogram/` | 原生 TypeScript、WXML、WXSS 页面和员工工作台 |
| `shared/` | 领域规则、类型、事务接口、本地模拟适配器 |
| `cloudfunctions/oradv/` | 微信可信身份入口、CloudBase 持久化适配器 |
| `tests/` | 领域、云边界、页面交互及工具测试 |
| `docs/`、`contracts/` | 需求、流程、权限、验收和数据／接口合同 |
| `scripts/`、`config/` | 构建、预检、初始化工具与配置模板 |
| `references/` | 原始浏览器原型和历史参考资料 |

根目录 `AGENTS.md` 按最初要求保留；具体工程规则见 [开发约定](docs/development-rules.md)，最新实现与未完成项以当前交接记录为准。原始 HTML 只作设计参考，不能作为原生小程序或真实云联调的证明。

## 开发与内测资料

- [内测上手与测试云开通](docs/18-beta.md)
- [员工操作手册](docs/19-staff.md)
- [需求](docs/02-requirements.md)、[状态与名额](docs/03-flows.md)、[积分规则](docs/04-points.md)
- [权限与隐私](docs/08-security.md)、[验收清单](docs/12-acceptance.md)
- [待确认决策](docs/15-decisions.md)、[完整资料索引](docs/00-index.md)

## 配置与贡献

`config/local.json`、上传私钥、云凭据和真实名单均不进 Git。AppID 是公开应用标识；AppSecret 和私钥属于秘密。云端与模拟模式明确分开，测试与正式 EnvId 必须不同。初始化员工需要可信部署者操作，微信平台开发者身份不会自动获得产品内员工权限。

提交采用 `feat:`、`fix:`、`docs:`、`test:` 等 Conventional Commit 前缀。PR 说明行为变化、关联需求与实际验证结果；界面变更附截图，未执行的云端或真机检查明确列出。积分、名额、权限和隐私变更必须补充相关回归测试。
