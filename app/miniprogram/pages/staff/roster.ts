import type { Registration } from '../../../../shared/types';
import { memberNumberText } from '../../services/member-number';

export type StaffRegistration = Registration & {
  memberKind?: 'founder' | 'regular';
  confirmationMode?: string;
  confirmationPath?: string;
  lastReturnDay?: string;
  memberNumber?: number;
};
export function rosterPresentation<T extends StaffRegistration>(items: T[], today: string, filter = 'all', query = '') {
  const cards = items.map((item) => {
    const unreturned = item.state === 'checked_in' && (!item.lastDepartureDay || item.lastDepartureDay !== item.lastReturnDay);
    const departedToday = item.lastDepartureDay === today;
    const returnedToday = item.lastReturnDay === today || (departedToday && ['pending_settlement', 'completed', 'safe_exit'].includes(item.state));
    return { ...item, unreturned, departedToday, returnedToday,
      memberCode: memberNumberText(item.memberNumber),
      memberKindText: item.memberKind === 'founder' ? '创始成员' : item.memberKind === 'regular' ? '普通成员' : '身份待核对',
      confirmationText: item.state === 'waitlisted' ? '候补中，尚未占位' : item.confirmationPath === 'founder_direct' ? '创始身份自动确认' : item.state === 'pending_confirmation' ? '待线下安排 · 人工确认' : item.confirmationPath === 'staff_manual' ? '运营人工确认路径' : '按本场确认记录',
      checkinText: unreturned ? item.lastDepartureDay === today ? '今日已出发，待回场核验' : '出发记录待复核'
        : item.state === 'safe_exit' ? '已记录安全退出' : item.state === 'no_show' ? '已登记未到'
          : item.state === 'cancelled' ? '申请已取消' : item.state === 'rejected' ? '审核未通过'
            : returnedToday ? '今日结束已核验' : ['completed', 'pending_settlement'].includes(item.state) ? '本场结束已核验' : '尚未进行今日出发核验',
    };
  });
  const needle = query.trim().toLocaleLowerCase();
  const numericQuery = /^\d+$/.test(needle);
  const visible = cards.filter((item) => (!needle || (numericQuery
    ? Number.isSafeInteger(Number(needle)) && item.memberNumber === Number(needle)
    : (item.nickname || '').toLocaleLowerCase().includes(needle)))
    && (filter === 'all' || filter === 'unreturned' && item.unreturned
      || filter === 'pending' && ['pending_review', 'pending_confirmation'].includes(item.state)
      || filter === 'today' && (item.departedToday || item.returnedToday)
      || filter === item.state));
  // Safety order is independent of member kind and recommendation priority.
  visible.sort((left, right) => Number(right.unreturned) - Number(left.unreturned) || left.queueSeq - right.queueSeq);
  return { visible, unreturnedCount: cards.filter((item) => item.unreturned).length,
    todayDepartureCount: cards.filter((item) => item.departedToday).length,
    todayReturnCount: cards.filter((item) => item.returnedToday).length };
}
