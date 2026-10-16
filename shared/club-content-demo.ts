import { key } from './models';
import { emptyClubContent } from './club-content';
import type { StoreSnapshot } from './store';
import type { ClubContentDraft, ClubContentSection } from './club-content-types';

/** Fictional examples are seeded only into local demonstrations; existing edits win. */
export function seedClubContentDemo(snapshot: StoreSnapshot): StoreSnapshot {
  const rows = { ...(snapshot.club_content ?? {}) };
  const examples: [ClubContentSection, Partial<ClubContentDraft>][] = [
    ['partners', { introduction: '本机内测示例，不对应真实合作品牌。', blocks: [{ heading: '装备支持 · 演示', body: '用于体验合作信息的展示和查看。' }, { heading: '训练场地 · 演示', body: '实际合作内容由组织方确认后发布。' }] }],
    ['handbook', { introduction: '把每次同行的准备、沟通和记录做好。以下内容用于本机内测。', blocks: [{ heading: '参加之前', body: '阅读本场活动说明，确认集合、资格与装备要求。有不清楚的地方先向负责人核实。' }, { heading: '同行途中', body: '按领队的实际安排参加，改变计划或需要退出时及时沟通，完成相应核验。' }, { heading: '记录与反馈', body: '报名、核验和结算分别记录。发现资料或积分有误，通过组织方渠道说明具体情况。' }] }],
    ['core', { introduction: '职责用于说明协作分工，不代表小程序后台权限。人物为虚构内测示例。', people: [{ name: '北山', duty: '活动协调', introduction: '负责本次演示活动的安排与沟通。', responsibilities: ['发布集合和准备要求', '核对活动名单与参与记录'] }, { name: '石桥', duty: '现场领队', introduction: '负责演示场次的人员沟通。', responsibilities: ['确认现场安排', '关注出发与返回记录'] }] }],
    ['contacts', { introduction: '联系信息由组织方核实后发布。演示环境不提供真实电话或救援承诺。', contacts: [{ label: '内测联络', name: '组织方', method: 'wechat', value: 'OR_ADV_DEMO_ONLY', hours: '演示信息', note: '虚构账号，仅供演练复制操作，请勿添加。' }] }],
    ['points', { introduction: '具体计分与兑换办法由主理人确认后发布。', blocks: [{ heading: '已有记录', body: '积分明细列出实际完成奖励及更正记录。新的计分、门槛和兑换办法尚待确认。' }] }],
    ['business', { introduction: '可以向组织方留下合作方向及联系办法，处理进度仅本人和有权限的负责人可见。', blocks: [{ heading: '提交合作意向', body: '说明希望合作的内容和联系办法。咨询记录不代表报价、合同或合作已获确认。' }] }],
    ['redemption', { introduction: '兑换政策和可提供项目待主理人确认。当前可以查看真实积分，并向组织方咨询。', offers: [] }],
  ];
  for (const [selected, content] of examples) {
    const id = key('club-content', 'oradv', selected);
    if (!rows[id]) rows[id] = { ...emptyClubContent(selected), ...content, id, clubId: 'oradv', section: selected, status: 'published', revision: 1, updatedAt: '2026-10-16T00:00:00.000Z', publishedAt: '2026-10-16T00:00:00.000Z', fixtureOnly: true };
  }
  return { ...snapshot, club_content: rows };
}
