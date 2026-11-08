/**
 * Identity-keyed plan form state.
 *
 * PlanScreen keeps editable drafts of the weekly schedules. Those drafts must
 * be bound to exactly one data owner: (mode, backend origin, profile id).
 * When any of those change — switching DEMO -> CONNECTED, another base URL,
 * another pilot user logging in — the drafts are re-initialized from the new
 * profile so stale demo/other-user values can never be saved over someone's
 * real schedule. Routine profile refreshes keep the same identity and must
 * NOT clobber unsaved edits.
 *
 * Pure functions so the isolation rules are unit-testable without React.
 */
import type { DirectionSchedule, UserProfile } from '../types/shared';
import type { ScheduleDraft } from '../validation/validate';

export type PlanDirection = 'HOME_TO_WORK' | 'WORK_TO_HOME';

export interface PlanFormSnapshot {
  drafts: Record<PlanDirection, ScheduleDraft>;
  enabled: Record<PlanDirection, boolean>;
  modes: Record<PlanDirection, 'CAR' | 'BIKE' | 'BMTC'>;
}

function scheduleToDraft(s: DirectionSchedule): ScheduleDraft {
  return {
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    preferredDeparture: s.preferredDeparture,
    arrivalDeadline: s.arrivalDeadline ?? '',
    safetyBufferMinutes: String(s.safetyBufferMinutes),
    days: [...s.days],
  };
}

/**
 * Stable identity of the data owner behind the form. Uses value fields (not
 * object identity) so a routine state refresh produces the same identity.
 */
export function formIdentity(
  mode: string,
  baseUrl: string,
  profile: Pick<UserProfile, 'id'> | null
): string {
  const owner = profile?.id ?? 'none';
  return `${mode}|${baseUrl.trim().replace(/\/+$/, '')}|${owner}`;
}

export function profileToFormSnapshot(
  profile: UserProfile | null,
  fallbackSchedules: { HOME_TO_WORK: DirectionSchedule; WORK_TO_HOME: DirectionSchedule }
): PlanFormSnapshot {
  const source = profile ?? { schedules: fallbackSchedules };
  const htw = source.schedules.HOME_TO_WORK;
  const wth = source.schedules.WORK_TO_HOME;
  return {
    drafts: {
      HOME_TO_WORK: scheduleToDraft(htw),
      WORK_TO_HOME: scheduleToDraft(wth),
    },
    enabled: {
      HOME_TO_WORK: htw.enabled,
      WORK_TO_HOME: wth.enabled,
    },
    modes: {
      HOME_TO_WORK: htw.mode,
      WORK_TO_HOME: wth.mode,
    },
  };
}

/**
 * Re-sync the form when the data owner changes; otherwise return the previous
 * state untouched (preserving unsaved edits through refreshes).
 */
export function syncFormToIdentity(
  prev: { identity: string; snapshot: PlanFormSnapshot },
  identity: string,
  profile: UserProfile | null,
  fallbackSchedules: { HOME_TO_WORK: DirectionSchedule; WORK_TO_HOME: DirectionSchedule }
): { identity: string; snapshot: PlanFormSnapshot } {
  if (prev.identity === identity) return prev;
  return { identity, snapshot: profileToFormSnapshot(profile, fallbackSchedules) };
}
