# 验证记录

日期：2026-10-15；版本：`0.1.0-test.1`。

## 原始交接包

原始ZIP SHA256：`819da5110d9a40c34c62fa66d57554e6f6afe98094b45a7950ad8ee60a9e9205`。

解压前检查了绝对路径、目录穿越、符号链接、加密项和总解压大小，未覆盖既有AGENTS.md。解压后执行原始 `verify_bundle.py`、`doctor.sh`、`validate_package.py` 和7项工具测试，均通过。原始ZIP与解压目录留在本机且不提交Git；工作树的manifest差异是后续开发的预期结果。

## 本地实现

本机：Node.js26.11.1、npm11.20.0、Python3.15.0。GitHub CI配置Node.js24；云运行时与真实数据库版本仍须在开通环境时核对。

已执行 `npm run typecheck`、`npm test`、`npm run test:tools`、`python3 scripts/validate_package.py`。测试覆盖资格与角色、末席并发、幂等取消、报名重报、核验、事务失败回滚、结算／冲正、跨年、榜单撤回及年度快照并发变更。

原生页面集成测试加载实际构建JS，以微信API和Page注册桩执行页面处理函数，验证同意前不建身份、跨页角色及数据一致、员工到会员完整流程、重复结算和冲正。WXML组件与事件绑定另做静态核对；没有将这些结果写成开发者工具或真机通过。

构建配置测试拒绝模拟生产包、缺失AppID/EnvId与测试正式共用环境。上传辅助默认预检，模拟预览必须显式 `--mock`，禁止将模拟包作为云端版本上传。最终 `npm run check` 退出码0：41项TypeScript测试（领域25、云边界9、构建安全7）、2项构建后原生页面测试、14项Python工具测试，共57项，均通过，无跳过。类型、构建、文档／契约校验同时通过。

## 依赖与秘密

云函数锁定微信SDK4.0.2。已修复间接依赖漏洞，并通过实际数据库依赖解析测试、干净npm ci及官方registry审计。根包和云函数分别审计，不对腾讯镜像不支持的审计结果作成功推断。

私钥不在仓库内，secrets.txt与config/local.json被Git忽略。构建与打包不需要AppSecret。最终提交前另核对待提交文件、秘密特征、生成产物和预览包清单。

## 未验证范围

无测试EnvId，因此未创建资源、部署函数、应用数据库规则或索引、初始化真实owner、执行真实微信身份或云事务。未做真实手机、弱网、备份恢复、审核和正式发布。内测规模及其余功能限制见 [交接记录](HANDOFF.md) 和 [内测指南](docs/18-beta.md)。

## 最终命令结果

| 命令 | 实际结果 |
|---|---|
| `npm run check` | 通过：类型、57项测试、构建、文档契约 |
| `npm audit --registry=https://registry.npmjs.org --audit-level=high` | 根包0漏洞 |
| `npm audit --prefix cloudfunctions/oradv --registry=https://registry.npmjs.org --omit=dev --audit-level=high` | 云函数0漏洞 |
| `npm run pack:preview` | 成功生成本地模拟预览ZIP |
| 官方CI执行模拟预览 | 微信拒绝：-10008 invalid ip；未生成码，待上传白名单 |

最终构建元数据绑定全部可部署文件的SHA256。秘密文件、符号链接、产物修改及输出目录越界均有拒绝测试；SDK定时器不会阻止CLI退出。私钥正文与secrets.txt未提交，上传原始日志保存在忽略的work目录。
