# 数据模型与数据库部署

contracts/data-model.json 是集合与字段合同；不代表资源已创建。时间服务端生成 UTC 时间戳，界面按 Asia/Shanghai 展示。所有业务记录含 clubId、createdAt、updatedAt、schemaVersion；身份字段从可信上下文建立，不信任前端自填。

## 集合与职责

| 集合 | 关键字段与唯一性 | 访问 |
|---|---|---|
| clubs | 固定 clubId、公开介绍、设置版本 | 公开字段由接口投影 |
| users | 内部 userId、wxOpenId、AppID、同意版本、注销状态 | 仅服务端映射；不公开 |
| memberships | clubId/userId、昵称、成员身份及版本、身份请求、两类公开同意 | 本人修改白名单；服务端写 |
| staff_roles | clubId/userId、角色、活动范围、有效期、授予人 | 主理人授权；服务端写 |
| activities | 状态、名额/计数、时间、资格、冻结积分规则、版本 | 公开投影 + 员工操作 |
| registrations | 固定 activityId/memberId 文档ID、状态、seatState、reviewDecision、revision、规则同意版本 | 本人读本人、员工限场 |
| qualifications | memberId、类别、等级、有效期、审核人、结果 | 仅必要审核角色 |
| checkins | 固定 activity/member/阶段/日期键、现场操作人、结果 | 员工限场，成员读自己 |
| points_ledger | 固定业务键、增量、年份、原记录引用、原因 | 不可覆盖流水 |
| member_stats | memberId、scope growth/year、积分、有效完成次数、version | 服务端事务更新 |
| public_rankings | 获准公开昵称、分数、次数、年份、同意版本 | 仅公开字段，无私密字段 |
| activity_briefings | 固定club/activity键、集合与负责人资料、准备清单、revision | 仅已确认者及限场员工接口 |
| public_recommendations | 成员投影、公开同意版本、可见性与排序键 | 接口重核身份／同意／有效期，积分公开独立 |
| annual_rewards | 年度快照版本、规则、内部成员与奖品状态 | 有权员工 |
| audit_logs | actor、动作、对象、请求/任务、前后摘要、原因 | 受限查询；避免原始敏感材料 |
| settlement_jobs | 活动/规则版本、批次、成功失败、重试状态 | 服务端任务与运营 |

users 与 memberships 分开；平台成员、俱乐部车友、员工角色三套概念分开。DocumentID 可用服务端确定性编码/哈希，不将原始 OpenID 拼成对外 URL。

## 推荐索引

activities: (clubId,status,startAt,_id)；registrations: (clubId,activityId,state,queueSeq)、(clubId,memberId,updatedAt)；staff_roles: (clubId,userId,enabled)；qualifications: (clubId,memberId,type,expiresAt)；ledger: (clubId,memberId,effectiveAt)、(clubId,activityId,awardType)；rankings: (clubId,metric,year,score,_id)；audit: (clubId,targetType,targetId,createdAt)。

优先使用确定性文档 ID 保证核心唯一性；数据库若支持所需唯一索引，再按当前控制台能力创建。不得把普通复合索引当作唯一约束。分页使用稳定游标和复合排序，不能每次全表读取再前端排序。

## 初始化步骤

1. 明确测试 EnvId；保存 config 私有配置并记录环境。
2. 用版本化迁移程序创建集合、索引和访问规则，先输出计划，再对测试环境执行。
3. 敏感集合关闭客户端直写，业务都经云函数；前端可只调用函数，不开放数据库直连。
4. 初始化 club 公共资料；首次 owner 通过可信部署身份一次性授予真实 userId，记录审计。禁止“第一个注册用户自动当管理员”。
5. 虚构数据仅导入测试环境，带 fixture 标记，导入脚本拒绝 production。
6. 记录迁移版本和结果；再部署函数并跑真实身份、权限和事务验证。

## 事务与维护

名额占位、释放、候补提升；积分流水/汇总/结算；角色关键变更分别设计原子边界。不得在长事务内发送消息、请求第三方或跑整个活动。消息失败写可重试任务，不撤销已经正确提交的报名。

所有管理变更采用 expectedRevision 防覆盖，冲突返回 CONFLICT_REFRESH；事务失败不能使用最后写入覆盖掩盖。迁移采用先加新字段/兼容读取、再逐步切换；删除字段和数据需独立计划与备份。

公开榜单用独立投影集合或接口白名单字段。文档读取权限不自动等于字段脱敏，不能给整个会员记录开放读权限后只靠页面隐藏电话。

## 0.2a的实际边界

最新离线结构为 `config/database-plan.v2.json`，尚未应用远端。新增集合与成员／资格／核验索引，直接客户端读写全部拒绝。没有身份字段的旧成员按regular处理，不自动升级创始身份；已确认报名与积分流水不因身份变化静默改写。

成员目录和推荐在已确认的200人以内规模做服务端有界处理，权限／资料读取按10或20行小事务重新核对。推荐使用当前有效身份排序并校验游标签名，真实积分仍来自独立流水／汇总。当前200人验证是本地适配器证据，不是云端性能结论。
