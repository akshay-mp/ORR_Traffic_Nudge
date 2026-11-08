/**
 * Type bridge to the repo's shared domain contract.
 *
 * These are TYPE-ONLY re-exports of `src/types/commute.ts`. Because every
 * import/export below uses TypeScript's `import type` / `export type` syntax,
 * babel-preset-expo erases them completely before Metro module resolution, so
 * the mobile bundle never loads any file outside `mobile/` at runtime and no
 * pilot seed data (e.g. PINs in `src/lib/pilotSeed.ts`) can end up in the app
 * bundle. `tsc --noEmit` still typechecks against the single source of truth.
 *
 * Mobile runtime logic (demo engine) is ported into `services/demoEngine.ts`
 * on purpose: see docs/mobile-implementation.md for the rationale.
 */
export type {
  ApiQuotaStatus,
  CommuteAlert,
  CommuteDirection,
  DataEnvironment,
  DayOverride,
  DayOfWeek,
  DepartureOption,
  DirectionSchedule,
  EstimateBasis,
  ImmutableEstimateSnapshot,
  JourneyMetrics,
  JourneyRecord,
  LocationPoint,
  MonitoringSession,
  RecommendationRole,
  TransitStepDetail,
  TransportMode,
  UserProfile,
} from '../../../src/types/commute';
