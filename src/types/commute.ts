export type TransportMode = 'BIKE' | 'CAR' | 'BMTC';
export type CommuteDirection = 'HOME_TO_WORK' | 'WORK_TO_HOME';
export type DayOfWeek = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
export type EstimateBasis = 'CURRENT_TRAFFIC' | 'FUTURE_FORECAST' | 'TIMETABLE';
export type DataEnvironment = 'LIVE' | 'DEMO';

export type RecommendationRole =
  | 'LEAVE_NOW'
  | 'SHORTEST_PREDICTED'
  | 'LATEST_FOR_DEADLINE';

export interface LocationPoint {
  label: string;
  address: string;
  lat: number;
  lng: number;
  placeId?: string;
  confirmedAt: string;
}

export interface DirectionSchedule {
  direction: CommuteDirection;
  enabled: boolean;
  mode: TransportMode;
  days: DayOfWeek[];
  windowStart: string; // "HH:mm" in Asia/Kolkata
  windowEnd: string;   // "HH:mm" in Asia/Kolkata
  arrivalDeadline: string | null; // "HH:mm" in Asia/Kolkata or null
  preferredDeparture: string; // "HH:mm" in Asia/Kolkata
  safetyBufferMinutes: number; // User buffer kept separate from provider ETA
  leadTimeMinutes: number; // 0-30 minutes before preferred departure
  alertThresholdMinutes: number; // Default 5 min deterioration
}

export interface DayOverride {
  dateIst: string; // "YYYY-MM-DD" in Asia/Kolkata
  direction: CommuteDirection;
  skipped: boolean;
  overrideMode?: TransportMode;
  overrideWindowStart?: string;
  overrideWindowEnd?: string;
  overrideArrivalDeadline?: string | null;
  overridePreferredDeparture?: string;
}

export interface TransitStepDetail {
  stepType: 'WALK' | 'WAIT' | 'BUS';
  durationMin: number;
  instruction: string;
  busRouteNumber?: string;
  departureStop?: string;
  arrivalStop?: string;
  scheduledDepartureTime?: string;
  numStops?: number;
}

export interface DepartureOption {
  id: string;
  roles: RecommendationRole[];
  title: string;
  whyRecommended: string;
  departureTimeIst: string; // "HH:mm"
  departureIso: string;
  predictedDurationMin: number; // Raw provider duration
  staticDurationMin?: number;   // Historical baseline duration without live traffic
  durationRangeMin?: [number, number]; // Only when supported by provider or calibration
  userSafetyBufferMin: number;  // Explicitly separated from provider prediction
  predictedArrivalTimeIst: string; // "HH:mm" (raw provider arrival)
  predictedArrivalIso: string;
  bufferedArrivalTimeIst: string; // "HH:mm" (with user safety buffer)
  deadlineRelation: {
    hasDeadline: boolean;
    deadlineTimeIst: string | null;
    deltaMinutes: number | null; // negative = arrives early, positive = arrives late
    meetsRaw: boolean;
    meetsWithBuffer: boolean;
    summaryText: string;
  };
  transportMode: TransportMode;
  dataSource: string;
  environment: DataEnvironment;
  lastUpdatedIso: string;
  lastUpdatedIst: string;
  estimateBasis: EstimateBasis;
  betaNotice?: string;
  transitDetails?: {
    isLiveFeed: boolean;
    walkingMin: number;
    waitingMin: number;
    inVehicleMin: number;
    transfersCount: number;
    busLines: string[];
    steps: TransitStepDetail[];
    limitationNote: string;
  };
  distanceKm: number;
  corridorSummary: string;
}

export interface ImmutableEstimateSnapshot {
  snapshotType: 'SELECTED_OPTION' | 'AT_DEPARTURE';
  optionId: string;
  departureTimeIst: string;
  predictedDurationMin: number;
  predictedArrivalIso: string;
  predictedArrivalTimeIst: string;
  issuedAtIso: string;
  issuedAtIst: string;
  estimateBasis: EstimateBasis;
  dataSource: string;
  environment: DataEnvironment;
  userSafetyBufferMin: number;
}

export interface MonitoringSession {
  id: string;
  userId: string;
  dateIst: string;
  direction: CommuteDirection;
  transportMode: TransportMode;
  status: 'SCHEDULED' | 'ACTIVE' | 'SNOOZED' | 'LEFT' | 'SKIPPED' | 'STOPPED' | 'EXPIRED';
  watchMode: 'ALL_OPTIONS' | 'SELECTED_OPTION';
  selectedOptionId: string | null;
  selectedEstimateSnapshot: ImmutableEstimateSnapshot | null;
  departureEstimateSnapshot: ImmutableEstimateSnapshot | null;
  lastNotifiedArrivalIso: string | null;
  lastNotifiedArrivalTimeIst: string | null;
  snoozedUntilIso: string | null;
  startedAtIso: string;
  lastRefreshedAtIso: string | null;
  nextRefreshDueIso: string | null;
  expiresAtIso: string;
  refreshCount: number;
  suppressedDuplicatesCount: number;
  latestOptions: DepartureOption[];
  unsupportedModeReason?: string | null;
  dataEnvironment: DataEnvironment;
}

export interface CommuteAlert {
  id: string;
  userId: string;
  sessionId: string;
  createdAtIso: string;
  createdAtIst: string;
  type:
    | 'DEPARTURE_REMINDER'
    | 'ARRIVAL_DETERIORATION'
    | 'DEADLINE_THREAT'
    | 'SESSION_EXPIRED'
    | 'SYSTEM_NOTICE';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  previousEtaIst?: string;
  newEtaIst?: string;
  deadlineIst?: string | null;
  deteriorationMinutes?: number;
  deliveredChannels: Array<'IN_APP' | 'BROWSER_NOTIFICATION'>;
  acknowledged: boolean;
}

export interface JourneyMetrics {
  isCompleted: boolean;
  actualDurationMin: number | null;
  errorVsDepartureMin: number | null;
  absErrorVsDepartureMin: number | null;
  lateOver5MinVsDeparture: boolean | null;
  errorVsSelectedMin: number | null;
  absErrorVsSelectedMin: number | null;
  lateOver5MinVsSelected: boolean | null;
}

export interface JourneyRecord {
  id: string;
  userId: string;
  dateIst: string;
  direction: CommuteDirection;
  transportMode: TransportMode;
  environment: DataEnvironment;
  originLabel: string;
  destinationLabel: string;
  selectedEstimate: ImmutableEstimateSnapshot | null; // Strictly immutable
  departureEstimate: ImmutableEstimateSnapshot;       // Strictly immutable
  actualDepartureIso: string;
  actualDepartureTimeIst: string;
  actualArrivalIso: string | null;
  actualArrivalTimeIst: string | null;
  changedPlanOrRoute: boolean;
  usefulRating?: 'YES' | 'SOMEWHAT' | 'NO' | null;
  feedbackNote?: string;
  correctedAtIso?: string | null;
  correctionHistoryCount: number;
  metrics: JourneyMetrics;
}

export interface UserProfile {
  id: string;
  employeeCode: string;
  name: string;
  role: string;
  corridorTag: string;
  onboardingComplete: boolean;
  telemetryConsent: boolean;
  pushOptIn: boolean;
  homeLocation: LocationPoint | null;
  workLocation: LocationPoint;
  schedules: {
    HOME_TO_WORK: DirectionSchedule;
    WORK_TO_HOME: DirectionSchedule;
  };
  dayOverrides: DayOverride[];
}

export interface ModePilotSummary {
  mode: TransportMode;
  completedCount: number;
  missingMeasurementsCount: number;
  changedPlanCount: number;
  sampleStatus: 'MEASURED' | 'UNMEASURED';
  medianAbsErrorVsSelectedMin: number | null;
  medianAbsErrorVsDepartureMin: number | null;
  lateOver5MinVsSelectedPct: number | null;
  lateOver5MinVsDeparturePct: number | null;
  lateOver5MinVsDepartureCount: number;
  usefulYesCount: number;
  usefulTotalCount: number;
}

export interface PilotMetricsReport {
  environment: DataEnvironment;
  generatedAtIst: string;
  totalCompletedJourneys: number;
  totalMissingMeasurements: number;
  overallSampleStatus: 'MEASURED' | 'UNMEASURED';
  overallMedianAbsErrorVsSelectedMin: number | null;
  overallMedianAbsErrorVsDepartureMin: number | null;
  overallLateOver5MinVsSelectedPct: number | null;
  overallLateOver5MinVsDeparturePct: number | null;
  meetsFiveMinuteTargetStatus: string;
  byMode: Record<TransportMode, ModePilotSummary>;
}

export interface ApiQuotaStatus {
  dateIst: string;
  dailyLimit: number;
  requestsUsedToday: number;
  routesRequests: number;
  placesRequests: number;
  geocodingRequests: number;
  lastProviderStatus: 'OK' | 'QUOTA_EXCEEDED' | 'PROVIDER_ERROR' | 'UNCONFIGURED';
  lastErrorMessage: string | null;
  liveApiConfigured: boolean;
}
