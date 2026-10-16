import type { ClubContentDraft, ClubContentSection } from './club-content-types';

/** Editable starting copy. No names, contacts, inventory or publication consent are fabricated. */
export function starterClubContent(section: ClubContentSection): ClubContentDraft {
  const copy: Record<ClubContentSection, Pick<ClubContentDraft, 'title' | 'introduction' | 'blocks'>> = {
    handbook: {
      title: '车队手册', introduction: '出发前把准备做好，路上彼此照应，回来留下记录。',
      blocks: [
        { heading: '选择适合自己的同行', body: '先看活动难度、成长门槛、技能资格和装备要求，再决定是否报名。积分只是参与经历的参考，不能代替技能判断。对路线或身体状况有疑问，提前联系负责人。' },
        { heading: '报名与确认', body: '报名后在「我的同行」查看进度。创始合伙人满足本场条件且有名额时可直接确认；其他成员按活动提示完成线下安排，等待管理员确认。候补不代表已有名额。' },
        { heading: '行前与现场', body: '确认参加后查看本场行前说明，核对集合时间、位置和联系人。按要求准备车辆与护具，完成出发、返回核验；途中变更计划或提前离队，及时与领队沟通。' },
        { heading: '回来以后', body: '完整核验后由负责人结算活动记录。积分明细可以查看来源；发现记录不符，请说明活动和具体情况。回顾中使用他人的照片或文字前，先取得同意。' },
      ],
    },
    points: {
      title: '积分说明', introduction: '每一次认真参加，都应有清楚的记录。',
      blocks: [
        { heading: '成长与年度', body: '成长积分累计有效完成记录，用于了解参与经历和活动门槛；年度积分按活动实际完成时间所属年度统计。每场奖励在活动发布前明确，报名本身不发完成分。' },
        { heading: '完成与更正', body: '完成规定的出发、返回核验后，负责人按本场规则结算。重复结算不会重复发分；有误的记录通过更正流水处理，原始记录保留。技能资格另行核验。' },
        { heading: '兑换积分', body: '可兑换积分单独记账。已发布活动以本场兑换奖励为准，过去的成长积分不会自动换算。兑换物品或服务前，查看项目所需积分、可用名额及领取办法。' },
        { heading: '预留与领取', body: '确认申请时预留积分和名额，实际交付后核销。交付前取消或被拒绝，会释放预留。兑换不减少成长和年度积分；处理进度和每笔变动均可在本人记录中查看。' },
        { heading: '成员展示', body: '推荐栏目介绍创始合伙人与活跃成员，由车队按已核实身份编排。成长、年度和完成次数榜分别按对应真实记录排序；是否公开展示由成员自己选择。' },
      ],
    },
    core: {
      title: '核心成员与职责', introduction: '把事情交给明确的人，让每次同行都有照应。',
      blocks: [
        { heading: '主理人', body: '负责车队方向、活动政策、成员身份与管理授权，统筹需要共同决定的事项。' },
        { heading: '车队经理', body: '统筹日常活动、成员协作和记录核对，协调报名、现场与活动结束后的工作。' },
        { heading: '创始合伙人', body: '参与车队建设与长期协作。公开介绍以本人同意和主理人核实的信息为准，具体分工在此栏目维护。' },
        { heading: '内容与现场协作', body: '内容管理员维护车队公开资料与活动回顾；领队和核验员按本场安排组织出发、返回与记录。职责介绍与实际管理授权分别维护。' },
      ],
    },
    contacts: {
      title: '联系我们', introduction: '报名安排、活动记录或合作事项，可以通过车队公布的联系方式沟通。',
      blocks: [{ heading: '活动联系', body: '已确认参加的成员，请优先查看该场行前说明中的负责人和集合安排。具体问题请同时说明活动名称，方便核对。' }],
    },
    business: {
      title: '商务合作', introduction: '欢迎围绕骑行体验、装备与车队活动交流合作。',
      blocks: [{ heading: '把想法说具体', body: '请说明合作方向、可以提供的支持、适用时间和联系办法。负责人会结合实际安排回复；提交意向后，可以在本人咨询记录中查看处理进度。' }],
    },
    redemption: {
      title: '积分兑换', introduction: '把参与留下的积累，用在下一次同行。',
      blocks: [{ heading: '选择物品或服务', body: '可兑换项目由车队核定后发布，项目页说明所需积分、名额和领取办法。申请后等待负责人审核，实际领取物品或完成服务时确认核销。具体以该项目说明为准。' }, { heading: '查看自己的记录', body: '本人可查看可用积分、预留积分和申请进度。交付前不再需要时可以取消；已经交付的项目如需更正，请联系负责人核对。' }],
    },
    partners: {
      title: '合作伙伴', introduction: '感谢与车队共同把每次同行做好的人。',
      blocks: [{ heading: '合作信息', body: '此处由车队维护已确认的合作方向、支持内容和适用范围。具体活动中的安排，请以当场发布的信息为准。' }],
    },
  };
  return { ...copy[section], people: [], contacts: [], offers: [] };
}
