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
| profile.update | 允许的昵称、可选头像、榜单开关 | 字段白名单；公开缓存同步失效 |
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
