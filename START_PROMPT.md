# 续作入口

先阅读 README.md、HANDOFF.md、PROJECT_STATUS.json、docs/development-rules.md、docs/15-decisions.md 和 docs/18-beta.md，再检查现有源代码与 Git 状态。不要覆盖根目录 AGENTS.md，也不要重建已有实现。

用户已授权正常开发并明确仓库公开，已确认开发者身份、提供 AppID 和 Mac 调试条件；测试云尚未开通，审核具体事项待核实。先运行 npm ci 和 npm run check，对照交接中的真实结果接着工作。

重点保持名额事务、服务端身份权限、幂等结算与不可覆盖积分流水。没有实际 EnvId/云授权时继续独立的代码与测试，不能伪造云部署、微信登录或真机成功。未决业务规则仍标 proposed，不替主理人承诺。

每阶段更新实际命令、结果、模拟边界和下一条具体任务。真实发布、付费、正式数据修改遵循已有授权与项目边界。
