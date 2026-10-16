# 云函数接口合同

当前使用`oradv`领域云函数，前端通过`wx.cloud.callFunction`调用。[api-contract.json](../contracts/api-contract.json)是RPC合同，不是HTTP API。v3的27集合、31项目索引及禁止客户端直连规则已完成结构读回；函数部署、真实微信身份和真机业务验收分别记录，不能据此宣称全部接口已经线上验证。

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
| ranking.list / ranking.mine | 维度/年份/游标 | 公开榜单；本人名次取同一真实公开榜单，不另算或抬高 |
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

常用错误：UNAUTHENTICATED、FORBIDDEN、ACTIVITY_NOT_FOUND、REGISTRATION_CLOSED、SCORE_TOO_LOW、QUALIFICATION_REQUIRED、QUALIFICATION_EXPIRED、NO_CAPACITY、STATE_CONFLICT、CONFLICT_REFRESH、RULE_VERSION_CHANGED、ALREADY_SETTLED、INVALID_INPUT、RATE_LIMITED、TEMPORARY_FAILURE。资料、内容和媒体还使用CONSENT_REQUIRED、REQUEST_REUSED、LEARNING_NOT_READY、MEDIA_VIDEO_UNAVAILABLE等明确业务错误。

网络超时返回未知结果时，先查询本人状态；支持幂等的操作沿用原标识及原内容，不生成第二个申请。咨询的`submissionId`与内容摘要独立于每次RPC的`requestId`；未知结果时锁定内容并保留原编号，不能修改正文后复用。TEMPORARY_FAILURE可退避重试，资格／权限／冲突类错误不自动循环。

## 服务端验证顺序

校验参数与大小 → 取可信身份 → 查 club 会员与员工授权 → 读取真实资源/版本 → 校验动作状态与规则 → 事务写入 → 脱敏审计 → 返回明确结果。不要先读敏感名单再检查权限；错误信息也不能泄露其他人的身份、电话或隐藏活动。

## 0.2a新增命令

具体字段以[RPC合同](../contracts/api-contract.json)为准，以下为代码行为；远端执行证据以[验证记录](../VALIDATION.md)为准：

| action | 作用与权限 |
|---|---|
| identity.memberKind.request | 本人申请核对身份，不自行生效 |
| staff.member.list / assign | 运营／主理人分页查成员；身份认定仅主理人，校验revision与原因 |
| staff.roles.list / assign | 主理人读取当前角色版本并授权，现场角色必须指定活动 |
| qualifications.mine / staff.qualification.list / review | 本人读结果，有权员工核验；成员身份不代替资格 |
| recommendation.list / staff.recommendation.save | 公开推荐重核当前同意和身份；主理人编排不能代替本人同意 |
| club.public / staff.club.save | 公开白名单联系资料；主理人配置，未配置时不承诺可联系报名 |
| activity.briefing.get / staff.briefing.save | 已确认成员及限场员工读取；有权运营按版本编辑独立受限资料 |
| registration.timeline | 本人或限场员工查询实际已有核验记录，稳定分页 |

profile.update只允许昵称及两类公开同意，不接收成员身份或员工角色；推荐同意不自动公开积分。普通成员确认已将资格核验与管理员确认放进同一事务，旧review接口保留兼容。所有错误仍使用既有脱敏响应，不返回原始SDK堆栈。

数字成员编号由服务端分配，不接受客户端设置。本人摘要、授权员工目录和本场名单返回可选`memberNumber`；公开推荐与积分榜不返回。员工目录按数字升序、无号最后排列，每页20条、查询最多200名成员；纯数字查完整编号，其他文字查昵称。0必须作为有效数字处理，旧内部ID后缀不再作为查询条件。编号回填或查询结果变化后，旧分页游标要求刷新。

## v3资料、媒体与学习

| action | 请求与边界 |
|---|---|
| media.image.save / get / cancel | 保存用途与实际图片，不接收客户端fileID；get返回获准的短期URL，cancel仅本人未绑定资产 |
| media.video.save | 仅本机mock接收真实持久文件；云端返回MEDIA_VIDEO_UNAVAILABLE，不伪造完成 |
| dossier.mine / save / submit | 本人部分草稿、revision、明确用途同意；提交冻结快照并绑定照片 |
| staff.dossier.list / get / review | 仅owner待审队列；读取提交快照，审核绑定revision与submissionRevision，不能审核旧草稿 |
| learning.catalog / mine / start / answer | 公共题库摘要；本人服务端抽20题、逐题锁定答案与成绩，不提前返回答案库 |
| staff.learning.catalog.get / save | owner维护题库，发布须至少20题及指导人员核定确认 |
| skills.mine / submit / cancel / history | 本人实际视频资产、当前状态与有界版本归档，不接受外部文件链接冒充提交 |
| staff.skills.queue / review / history / reference.save | owner人工复核与来源核实的示范影片；通过不自动发资格或积分 |

媒体用途只允许`dossier`、`skill`、`club_public`。`club_public`图片仅owner在确认公开使用权后保存；其他用途不能转成公开图片。普通`media.get`不提供游客入口，owner读取他人材料也限已绑定的资料或技能证据；公开历史相册另从已发布回顾解析获准图片。

## v3公开栏目与往期记录

| action | 请求与边界 |
|---|---|
| club.content.get / staff.club.content.get / save | 七类纯文本结构化栏目；访客只读已发布白名单，owner按版本编辑并确认公开授权 |
| club.inquiry.submit / mine / withdraw | 本人商务或兑换咨询，明确同意提供联系方式；稳定submissionId及摘要保证重试一致 |
| staff.club.inquiry.list / review | 仅owner读取私人咨询并回复；不代表报价、合同、收款、库存或积分扣减 |
| history.detail | 已结算活动、实际获准相册、确认来源的影片、当前可见评价与荣誉；公开评价每页最多12条 |
| history.review.mine / save / withdraw | 完整参加且未冲正者，分别确认内容、昵称和荣誉展示；新增或编辑均待审核，可撤回 |
| staff.history.get / save / reviews / review | owner编辑与发布回顾、核对评价；图片最多12张、荣誉最多2个，审核必须携带当前revision和说明 |

公开回顾不返回内部成员ID、成员编号、头像或素材fileID；评价使用独立公开标识。作者停用／注销、撤回同意、完成记录冲正或评价不再获准后，后续公开读取会过滤其评价及荣誉。影片仅接受经确认的公开HTTPS直连MP4地址，拒绝凭据、IP主机及查询参数；播放器失败不能改报成功。

## 请求上限与临时链接

| action | 云入口JSON字节上限 | 领域服务JSON字符串长度上限 |
|---|---:|---:|
| profile.avatar.save、media.image.save | 131072 | 131072 |
| staff.learning.catalog.save | 262144 | 262144 |
| staff.club.content.save、staff.history.save | 65536 | 65536 |
| 其他RPC | 16384 | 20000 |

头像和资料图片解码后均最多64KiB，独立校验JPEG/PNG及尺寸；云入口另限头像5次／分钟、资料图片20次／分钟，并保留每个可信身份120次／分钟的总限制。新文件与事务关联分开，保存前后复核账号及版本；未知结果不得删除可能已绑定的文件。

数据库不保存base64或短期URL。头像与证据按300秒请求签发临时链接，实际到期以存储服务返回结果为准；停止后续签发不等于已发链接即时失效，也不能撤回已保存的图片副本。本机私人媒体草稿和咨询草稿分别绑定当前身份与云环境；未知环境的旧云草稿保留，不自动归属或发送。
