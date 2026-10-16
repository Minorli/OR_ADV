/** Member numbers are display labels; internal IDs remain the RPC keys. */
export function memberNumberText(value: number | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '待分配';
}
