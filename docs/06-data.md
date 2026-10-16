# 数据模型与数据库部署

## 当前结构与验证范围

当前结构计划为 [database-plan.v3.json](../config/database-plan.v3.json)：**27个集合、31个项目普通复合索引**。保留v1/v2计划供追溯；v2的18集合与24索引定义没有被替换。

2026-10-16已对当前测试环境执行v3结构初始化并读回：27个集合均为空、31个计划索引的字段／顺序／非唯一属性匹配，所有集合及云存储均为`CUSTOM`规则`{"read":false,"write":false}`。系统自带索引另计。该次读回没有导入业务数据或演示资料，也没有部署函数或变更计费设置。具体交付状态见[交接记录](../HANDOFF.md)；结构读回不等于微信登录、真实事务、查询性能或真机验收通过。

## 数字成员编号

`memberships.memberNumber`为可选非负安全整数，用于本人展示和授权员工查找；内部成员ID及报名／积分关联保持不变。普通新身份在创建事务中从1递增分配，0由可信部署流程绑定经核实的首位主理人档案。新增owner授权不重新编号，编号不参与鉴权。

复用clubs集合的独立控制文档：`key('member-sequence',clubId)`保存下一编号及首位主理人引用；`key('member-number',clubId,n)`永久占用每个已分配号码。两者均与`clubs/oradv`公开配置分开，并沿用客户端禁止直连规则。创建用户、成员、计数、占号和审计在同一事务内完成，异常回滚或重复登录不产生第二个号。旧号不复用，首次主理人由正号改0时可留下空号。

真实旧档案若缺少编号，接口省略此字段、界面显示待分配；需可信回填并核对控制记录，不在普通读接口里扫描重排。本机演示可在恢复缓存v3快照时幂等补号，先校验并保存，再使用新快照；保留头像、报名、流水、清单、业务版本及其他字段。缓存v3与数据库结构版本3分别管理；本轮空库结构初始化不会回填或重排真实成员。

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
| rpc_limits | 可信微信身份的固定窗口计数 | 仅云入口读写，独立图片限频 |
| schema_migrations | 结构核对及一次性owner初始化关闭标记 | 受信部署操作，不提供用户初始化入口 |
| member_dossiers | 本人草稿、提交快照、submissionRevision、审核意见 | 本人读写草稿；仅owner读待审快照及审核 |
| member_media | 用途、所属人、实际文件、uploading/ready/cancelled、绑定记录 | 本人；owner仅读已绑定的资料／技能证据 |
| learning_catalog | 已核定题库、发布版本、技能示范资料 | 公开题库摘要；owner维护，完整答案不公开 |
| learning_attempts | 当前指针、冻结的20题、逐题答案、成绩 | 仅本人；不自动发积分或资格 |
| skill_submissions | 当前提交与不可覆盖的skill_revision归档 | 本人提交／撤回／查历史；owner复核 |
| club_content | 七类结构化栏目、草稿／发布状态及版本 | 公开已发布白名单；owner编辑与确认公开授权 |
| club_inquiries | 本人咨询、提交摘要、处理状态、日额度控制行 | 本人和owner；不形成收款、扣分或库存交易 |
| activity_stories | 已结算活动回顾、公开照片、影片与荣誉引用 | 公开已发布投影；owner编辑／发布 |
| activity_reviews | 完整参加者评价、三类同意、审核状态、独立公开标识 | 本人提交／撤回；owner审核后按当前状态公开 |

users 与 memberships 分开；平台成员、俱乐部车友、员工角色三套概念分开。DocumentID 可用服务端确定性编码/哈希，不将原始 OpenID 拼成对外 URL。

## 索引与有界读取

精确字段与方向以v3计划为准，禁止把`state`写成`status`，或将业务`id`误替换为`_id`。新增7个普通索引如下；其余24个沿用v2。未标方向的字段均升序。

| 集合／读取 | 字段顺序 |
|---|---|
| member_dossiers 待审 | clubId、kind、status、id |
| skill_submissions 待审 | clubId、state、updatedAt、id |
| club_inquiries 员工 | clubId、rowKind、updatedAt降序、id |
| club_inquiries 本人 | clubId、rowKind、memberId、updatedAt降序、id |
| activity_reviews 公开 | clubId、activityId、status、publishConsent、nicknameConsent、publicSort降序、id |
| activity_reviews 公开标识查找 | clubId、activityId、publicId、id |
| activity_reviews 员工 | clubId、activityId、id |

31个项目索引均非唯一；身份、报名、积分业务键和编号占号由确定性文档ID及事务保证唯一。素材、题库、练习指针、资料快照和技能归档通过固定ID读取，不为它们添加猜测性的全表索引。公开评价每页最多12条，员工队列20条；同时复核12张照片及2个荣誉时仍控制在100次文档事务操作以内。

## 初始化步骤

1. 明确测试 EnvId；保存 config 私有配置并记录环境。
2. 用版本化迁移程序创建集合、索引和访问规则，先输出计划，再对测试环境执行。
3. 27个集合均拒绝客户端直接读写，公开内容也经云函数白名单投影；存储规则维持相同限制。
4. 初始化 club 公共资料；首次 owner 通过可信部署身份一次性授予真实 userId，记录审计。禁止“第一个注册用户自动当管理员”。
5. 虚构成员、题库、角色、联系方式和积分仅存在本机mock，**不得导入任何真实云环境，包括测试云**。真实环境从空库和经核实的公开资料开始。
6. 记录迁移版本和结果；再部署函数并跑真实身份、权限和事务验证。

## 事务与维护

名额占位、释放、候补提升；积分流水/汇总/结算；角色关键变更分别设计原子边界。不得在长事务内发送消息、请求第三方或跑整个活动。消息失败写可重试任务，不撤销已经正确提交的报名。

所有管理变更采用 expectedRevision 防覆盖，冲突返回 CONFLICT_REFRESH；事务失败不能使用最后写入覆盖掩盖。迁移采用先加新字段/兼容读取、再逐步切换；删除字段和数据需独立计划与备份。

`cloud-setup.cjs apply`只初始化专用空测试环境：检查真实文档计数，拒绝已有函数、无关集合、非空集合及冲突索引；现有空v2结构只补9个集合和7个索引。每步读回禁止直连规则和索引定义，不执行删除、业务导入、自动部署或账单操作。开始有真实记录后，不可绕过空库保护重跑；后续变更需单独的增量迁移与备份方案。

公开榜单用独立投影集合或接口白名单字段。文档读取权限不自动等于字段脱敏，不能给整个会员记录开放读权限后只靠页面隐藏电话。

## 资料、媒体和归档边界

骑手资料可分次保存；提交时按`dossier-purpose-v1`确认用途，并保存独立`dossier_submission`快照。修改草稿会使当前审核失效，但不改写旧快照。审核绑定当前资料revision及submissionRevision；护具和每辆车的轮胎图片分别核对，不收身份证或医疗原件。

私有图片最多64KiB，素材必须先保存为本人、正确用途的`ready`资产再绑定。用途分`dossier`、`skill`、`club_public`；后者仅owner确认公开使用权后创建，不能复用私有证据。云公开图使用独立随机路径，不携带内部成员或素材ID。提交后保留绑定，不能通过取消素材破坏历史记录；未知提交结果保留私有文件待重试确认。

短片本机演示校验实际文件、MP4/MOV容器、8MiB与60秒上限，持久保存后才形成local资产；**云端返回可重试的`MEDIA_VIDEO_UNAVAILABLE`**，保留本机草稿，不发放未经验证的上传授权。学习／技能归档冻结每次提交、复核、退回和撤回，复核通过不自动授予`qualifications`或积分。

往期回顾仅用于已结算场次。评价需完整参加且未冲正，分别同意公开内容、昵称和荣誉，并由owner审核；公开读取重核当前账号状态、同意和参加记录。公开照片数量来自实际获准且成功解析的图片，影片为空时不生成播放结果，荣誉只显示仍符合条件的作者昵称与核定标签。

没有身份字段的旧成员仍按regular处理，不自动升级创始身份；已确认报名与积分流水不因资料或学习变化静默改写。

成员目录和推荐在已确认的200人以内规模做服务端有界处理，权限／资料读取按10或20行小事务重新核对。推荐使用当前有效身份排序并校验游标签名，真实积分仍来自独立流水／汇总。当前200人验证是本地适配器证据，不是云端性能结论。
