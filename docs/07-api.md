# 云函数接口合同

推荐一组带 action 的领域云函数或独立函数，前端通过 wx.cloud.callFunction 调用。contracts/api-contract.json 是 RPC 合同，非已部署 HTTP API。SDK/事务语法由实施时官方兼容版本确定。

## 通用格式

请求：action、requestId、clubId（服务端仍校验）、payload、expectedRevision（更新时）。actor/userId/staffRole 不接受客户端作为授权依据。traceId 服务端生成。

成功：ok=true、data、traceId。失败：ok=false、error={code,message,retryable}、traceId。分页：items、nextCursor。时间用 ISO8601/时间戳单一约定，金额字段不存在。日志不回显原始请求体和秘密。

## 主要命令

| action | 请求要点 | 返回与规则 |
|---|---|---|
| identity.ensure | 同意版本/必要昵称，不传可信身份 | 用当前云函数上下文绑定本人，返回本人会员与角色摘要 |
| activity.list/get | 游标/筛选、activityId | 公开字段投影；草稿仅有权员工 |
| profile.update | 昵称、两类公开同意 | 本人字段白名单；头像另走专用保存接口 |
| profile.avatar.save | imageBase64、可选nickname、expectedRevision | 仅本人，校验图片后上传，事务关联头像与昵称 |
| profile.avatar.get | 空对象 | 仅本人，返回临时显示URL或null，不接受其他成员ID |
| registration.apply | activityId、必要回答、接受规则版本、requestId | 返回实际状态/座位；事务保证一人一场有效申请 |
| registration.cancel | registrationId、reason、expectedRevision | 仅本人允许阶段；只释放一次 |
| registration.mine | 游标 | 本人申请，无他人电话 |
| points.mine | 年份/游标 | 本人汇总与流水 |
| ranking.list | 维度/年份/游标 | 仅同意公开者，分页稳定 |
| staff.activity.save/publish/close | 变更和 expectedRevision | 运营/主理人；冻结发布规则 |
| staff.registration.review | registrationId、decision、reason | 检查角色与活动，记录审核 |
| staff.registration.confirm | registrationId、expectedRevision | 确认参加，非缴费确认 |
| staff.waitlist.promote | activityId、expectedRevision | 事务占位及资格再检查 |
| staff.checkin.record | registrationId、phase、day、result | 限现场角色和本场；重复不重复核验 |
| staff.settlement.preview/run | activityId、ruleVersion、taskId | 运营/主理人；逐人事务幂等 |
| staff.points.reverse | ledgerId、reason、expectedRevision | 主理人；防重复冲正 |
| staff.roles.assign | memberId、role、event scope、期限 | 主理人；不允许前端自授权 |
| staff.rewards.snapshot/record | 年份、规则版本/奖品发放 | 内部管理，有版本与审计 |

## 错误码和重试

UNAUTHENTICATED、FORBIDDEN、ACTIVITY_NOT_FOUND、REGISTRATION_CLOSED、SCORE_TOO_LOW、QUALIFICATION_REQUIRED、QUALIFICATION_EXPIRED、NO_CAPACITY、STATE_CONFLICT、CONFLICT_REFRESH、RULE_VERSION_CHANGED、ALREADY_SETTLED、INVALID_INPUT、RATE_LIMITED、TEMPORARY_FAILURE。

网络超时返回未知结果时，客户端沿用 requestId 重试或查询本人状态，不生成第二个申请。TEMPORARY_FAILURE 可退避重试；资格/门槛/权限类错误不自动循环。requestId 不得跨不同业务重复使用。

## 服务端验证顺序

校验参数与大小 → 取可信身份 → 查 club 会员与员工授权 → 读取真实资源/版本 → 校验动作状态与规则 → 事务写入 → 脱敏审计 → 返回明确结果。不要先读敏感名单再检查权限；错误信息也不能泄露其他人的身份、电话或隐藏活动。

## 0.2a新增命令

具体字段以 [RPC合同](../contracts/api-contract.json) 为准，均为已实现未部署：

| action | 作用与权限 |
|---|---|
| identity.memberKind.request | 本人申请核对身份，不自行生效 |
| staff.member.list / assign | 运营／主理人分页查成员；身份认定仅主理人，校验revision与原因 |
| staff.roles.list / assign | 主理人读取当前角色版本并授权，现场角色必须指定活动 |
| qualification.mine / staff.qualification.list / review | 本人读结果，有权员工核验；成员身份不代替资格 |
| recommendation.list / staff.recommendation.save | 公开推荐重核当前同意和身份；主理人编排不能代替本人同意 |
| club.public / staff.club.save | 公开白名单联系资料；主理人配置，未配置时不承诺可联系报名 |
| activity.briefing.get / staff.briefing.save | 已确认成员及限场员工读取；有权运营按版本编辑独立受限资料 |
| registration.timeline | 本人或限场员工查询实际已有核验记录，稳定分页 |

profile.update只允许昵称及两类公开同意，不接收成员身份或员工角色；推荐同意不自动公开积分。普通成员确认已将资格核验与管理员确认放进同一事务，旧review接口保留兼容。所有错误仍使用既有脱敏响应，不返回原始SDK堆栈。

数字成员编号由服务端分配，不接受客户端设置。本人摘要、授权员工目录和本场名单返回可选`memberNumber`；公开推荐与积分榜不返回。员工目录按数字升序、无号最后排列，每页20条、查询最多200名成员；纯数字查完整编号，其他文字查昵称。0必须作为有效数字处理，旧内部ID后缀不再作为查询条件。编号回填或查询结果变化后，旧分页游标要求刷新。

头像保存单独允许128KiB请求封包，解码图片最多64KiB；其他云入口请求仍限制16,384字节，领域服务仍为20,000字符。头像有独立低频限制，不能借此放大其他RPC。更换头像使用唯一新文件和两次账号／revision检查，不覆盖当前文件；发生不确定结果时先刷新本人资料再重试。查询返回前再次核对当前账号与头像版本。存储文件标识仅留本人服务端档案，不进入成员摘要、员工目录、推荐或积分榜。
