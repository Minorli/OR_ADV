export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}
export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
export function text(value: unknown, name: string, max = 200): string {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_INPUT', `${name}格式不正确`);
  return value.trim();
}
export function integer(value: unknown, name: string, min = 0): number {
  requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value >= min, 'INVALID_INPUT', `${name}格式不正确`);
  return value;
}
