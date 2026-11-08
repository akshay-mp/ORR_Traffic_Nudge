import type { CommuteDirection, MonitoringSession } from '../types/shared';

export function selectCurrentSession(
  sessions: readonly MonitoringSession[],
  direction: CommuteDirection,
  dateIst: string
): MonitoringSession | null {
  return sessions
    .filter((session) => session.direction === direction && session.dateIst === dateIst)
    .sort((left, right) => {
      const leftStartedAt = Date.parse(left.startedAtIso);
      const rightStartedAt = Date.parse(right.startedAtIso);
      const leftTimestamp = Number.isFinite(leftStartedAt) ? leftStartedAt : Number.NEGATIVE_INFINITY;
      const rightTimestamp = Number.isFinite(rightStartedAt) ? rightStartedAt : Number.NEGATIVE_INFINITY;
      const timestampOrder = rightTimestamp - leftTimestamp;
      if (timestampOrder !== 0 && !Number.isNaN(timestampOrder)) return timestampOrder;
      return right.id === left.id ? 0 : right.id > left.id ? 1 : -1;
    })[0] ?? null;
}
