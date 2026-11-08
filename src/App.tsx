/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BarChart3,
  CheckCircle2,
  Clock,
  Compass,
  History,
  Navigation,
  PauseCircle,
  Play,
  RefreshCw,
  Settings,
  ShieldAlert,
  SkipForward,
  Square,
  UserCheck,
  WifiOff,
} from 'lucide-react';
import {
  ApiQuotaStatus,
  CommuteAlert,
  CommuteDirection,
  DataEnvironment,
  DepartureOption,
  JourneyRecord,
  LocationPoint,
  MonitoringSession,
  TransportMode,
  UserProfile,
} from './types/commute';
import {
  getNowIstParts,
  resolveEffectiveSchedule,
} from './lib/commuteEngine';
import { SetupView } from './components/SetupView';
import { TripsAndAlertsView } from './components/TripsAndAlertsView';
import { PilotMetricsView } from './components/PilotMetricsView';
import { CommuteTrendMiniChart } from './components/CommuteTrendMiniChart';

type ActiveTab = 'today' | 'setup' | 'trips' | 'alerts' | 'metrics';
type SimulatedEdgeState =
  | 'NONE'
  | 'LOADING'
  | 'NO_ROUTE'
  | 'EXPIRED_PLAN'
  | 'OFFLINE'
  | 'STALE_DATA'
  | 'PROVIDER_ERROR'
  | 'NOTIFICATION_DENIED';

interface PilotRosterItem {
  id: string;
  employeeCode: string;
  name: string;
  role: string;
  corridorTag: string;
  defaultPinHint: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('today');
  const [gmpQuotaExceeded, setGmpQuotaExceeded] = useState(false);

  // Auth & Pilot Employee State
  const [roster, setRoster] = useState<PilotRosterItem[]>([]);
  const [token, setToken] = useState<string>('token_emp_01_pilot');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [selectedRosterId, setSelectedRosterId] = useState('emp_01');
  const [pinInput, setPinInput] = useState('1001');
  const [authError, setAuthError] = useState<string | null>(null);

  // User Server State
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [sessions, setSessions] = useState<MonitoringSession[]>([]);
  const [alerts, setAlerts] = useState<CommuteAlert[]>([]);
  const [journeys, setJourneys] = useState<JourneyRecord[]>([]);
  const [quota, setQuota] = useState<ApiQuotaStatus>({
    dateIst: '2026-11-08',
    dailyLimit: 500,
    requestsUsedToday: 0,
    routesRequests: 0,
    placesRequests: 0,
    geocodingRequests: 0,
    lastProviderStatus: 'OK',
    lastErrorMessage: null,
    liveApiConfigured: true,
  });

  // Today Dashboard Controls
  const [direction, setDirection] = useState<CommuteDirection>('HOME_TO_WORK');
  const [environment, setEnvironment] = useState<DataEnvironment>('DEMO');
  const [hasInitializedEnv, setHasInitializedEnv] = useState(false);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [edgeState, setEdgeState] = useState<SimulatedEdgeState>('NONE');
  const [istClock, setIstClock] = useState(() => getNowIstParts());
  const [latestToastAlert, setLatestToastAlert] = useState<CommuteAlert | null>(null);
  const [observedHistory, setObservedHistory] = useState<
    Array<{
      direction: CommuteDirection;
      mode: TransportMode;
      timeIst: string;
      durationMin: number;
      staticDurationMin?: number;
    }>
  >([]);

  // Quick Arrival Confirmation Modal on Today Dashboard
  const [arrivalHhmm, setArrivalHhmm] = useState(() => getNowIstParts().timeIst);
  const [arrivalChangedRoute, setArrivalChangedRoute] = useState(false);
  const [arrivalUseful, setArrivalUseful] = useState<'YES' | 'SOMEWHAT' | 'NO' | null>('YES');
  const [arrivalNote, setArrivalNote] = useState('');

  // Browser Notification Permission
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
    return Notification.permission;
  });

  // Listen to Google Maps Platform Tier 1 & Tier 2 quota exceeded custom event
  useEffect(() => {
    const handleQuotaExceeded = () => setGmpQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
  }, []);

  // Live Asia/Kolkata clock ticker
  useEffect(() => {
    const timer = setInterval(() => {
      setIstClock(getNowIstParts());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Load Pilot Roster
  useEffect(() => {
    fetch('/api/auth/pilot-roster')
      .then((r) => r.json())
      .then((data) => {
        if (data.roster) setRoster(data.roster);
        if (!hasInitializedEnv) {
          setEnvironment(data.liveApiConfigured ? 'LIVE' : 'DEMO');
          setHasInitializedEnv(true);
        }
      })
      .catch(() => {});
  }, [hasInitializedEnv]);

  // Fetch Authenticated User State
  const fetchUserState = useCallback(async (activeToken: string) => {
    try {
      const res = await fetch('/api/me/state', {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setProfile(data.profile);
      setSessions(data.sessions || []);
      setAlerts(data.alerts || []);
      setJourneys(data.journeys || []);
      if (data.quota) setQuota(data.quota);
    } catch (err) {
      console.error('Failed to load user state:', err);
    }
  }, []);

  useEffect(() => {
    fetchUserState(token);
  }, [token, fetchUserState]);

  const triggerBrowserNotification = useCallback(
    (alert: CommuteAlert) => {
      setLatestToastAlert(alert);
      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        try {
          new Notification(`ORR Pulse: ${alert.title}`, {
            body: alert.message,
          });
        } catch {
          // Ignore in restricted iframe contexts
        }
      }
    },
    []
  );

  // Start or Refresh Monitoring Session
  const handleStartOrRefreshMonitoring = useCallback(
    async (opts?: {
      targetDirection?: CommuteDirection;
      targetEnv?: DataEnvironment;
      startMode?: 'IMMEDIATE' | 'SCHEDULED_LEAD';
      simulateTrafficSpikeMin?: number;
    }) => {
      const dir = opts?.targetDirection ?? direction;
      const env = opts?.targetEnv ?? environment;
      setLoadingRoutes(true);
      setRouteError(null);
      setEdgeState('NONE');

      try {
        const res = await fetch('/api/monitoring/start-or-refresh', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            direction: dir,
            environment: env,
            startMode: opts?.startMode ?? 'IMMEDIATE',
            simulateTrafficSpikeMin: opts?.simulateTrafficSpikeMin ?? 0,
          }),
        });

        const data = await res.json();

        if (res.status === 429 || data?.quotaExceeded) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          setRouteError(
            data?.message ||
              'Google Maps Platform quota reached. Switch to Labeled Demo Mode or update your API budget cap.'
          );
          if (data?.quota) setQuota(data.quota);
          return;
        }

        if (!res.ok) {
          setRouteError(
            data?.message ||
              'Unable to compute live route predictions. Verify connectivity or switch to Labeled Demo Mode.'
          );
          return;
        }

        if (data.newAlerts && data.newAlerts.length > 0) {
          triggerBrowserNotification(data.newAlerts[0]);
        }

        const primaryOpt = data.session?.latestOptions?.[0];
        if (primaryOpt) {
          const nowHhmm = getNowIstParts().timeIst;
          setObservedHistory((prev) => [
            ...prev.filter(
              (p) =>
                !(
                  p.direction === dir &&
                  p.mode === primaryOpt.transportMode &&
                  p.timeIst === nowHhmm
                )
            ),
            {
              direction: dir,
              mode: primaryOpt.transportMode,
              timeIst: nowHhmm,
              durationMin: primaryOpt.predictedDurationMin,
              staticDurationMin: primaryOpt.staticDurationMin,
            },
          ]);
        }

        await fetchUserState(token);
      } catch (err: any) {
        setRouteError(err?.message || 'Network error refreshing route predictions.');
      } finally {
        setLoadingRoutes(false);
      }
    },
    [direction, environment, token, fetchUserState, triggerBrowserNotification]
  );

  // Auto-initialize today's session when profile loads if no session exists for current direction
  const activeSession = sessions.find(
    (s) => s.direction === direction && s.dateIst === istClock.dateIst
  );

  useEffect(() => {
    if (profile && !activeSession && !loadingRoutes && !routeError) {
      handleStartOrRefreshMonitoring({
        targetDirection: direction,
        targetEnv: environment,
      });
    }
  }, [profile?.id, direction]);

  // 5-Minute Client Poll Sync while Monitoring is ACTIVE or SNOOZED
  useEffect(() => {
    if (
      !activeSession ||
      (activeSession.status !== 'ACTIVE' && activeSession.status !== 'SNOOZED')
    ) {
      return;
    }
    const interval = setInterval(() => {
      handleStartOrRefreshMonitoring({
        targetDirection: direction,
        targetEnv: environment,
      });
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [activeSession?.id, activeSession?.status, direction, environment, handleStartOrRefreshMonitoring]);

  const handleSelectOption = async (option: DepartureOption, watchMode: 'SELECTED_OPTION' | 'ALL_OPTIONS') => {
    if (!activeSession) return;
    const res = await fetch('/api/monitoring/select-option', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sessionId: activeSession.id,
        optionId: watchMode === 'ALL_OPTIONS' ? null : option.id,
        watchMode,
      }),
    });
    if (res.ok) {
      await fetchUserState(token);
    }
  };

  const handleMonitoringAction = async (
    action: 'IVE_LEFT' | 'SNOOZE_10M' | 'SKIP_TODAY' | 'STOP_MONITORING'
  ) => {
    if (!activeSession) return;
    const res = await fetch('/api/monitoring/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sessionId: activeSession.id,
        action,
      }),
    });
    if (res.ok) {
      setArrivalHhmm(getNowIstParts().timeIst);
      await fetchUserState(token);
    }
  };

  const handleQuickModeChange = async (newMode: TransportMode) => {
    if (!profile) return;
    const updatedSchedules = {
      ...profile.schedules,
      [direction]: {
        ...profile.schedules[direction],
        mode: newMode,
      },
    };
    await fetch('/api/me/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ schedules: updatedSchedules }),
    });
    await fetchUserState(token);
    await handleStartOrRefreshMonitoring({
      targetDirection: direction,
      targetEnv: environment,
    });
  };

  const handleDayOverride = async (skipped: boolean) => {
    await fetch('/api/me/day-override', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dateIst: istClock.dateIst,
        direction,
        skipped,
      }),
    });
    await fetchUserState(token);
    if (!skipped) {
      await handleStartOrRefreshMonitoring({
        targetDirection: direction,
        targetEnv: environment,
      });
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: selectedRosterId, pin: pinInput }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthError(data.message || 'Authentication failed');
      return;
    }
    setToken(data.token);
    setShowAuthModal(false);
    setRouteError(null);
  };

  const handleRequestNotificationPermission = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationPermission('unsupported');
      return;
    }
    const perm = await Notification.requestPermission();
    setNotificationPermission(perm);
    if (perm === 'granted') {
      await fetch('/api/me/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pushOptIn: true }),
      });
      await fetchUserState(token);
    }
  };

  const effectiveSchedule = profile
    ? resolveEffectiveSchedule(
        profile.schedules[direction],
        profile.dayOverrides,
        istClock.dateIst
      )
    : null;

  const activeInProgressJourney = journeys.find(
    (j) => !j.metrics.isCompleted && j.dateIst === istClock.dateIst
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Mandatory Google Maps Platform Quota Banner (Demo Key Specialization) */}
      {gmpQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Bar Contract: Strictly 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 h-14 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#today"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('today');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
        >
          ORR Pulse
        </a>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400">
          <a
            href="#today"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('today');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'today'
                ? 'text-slate-900 dark:text-slate-100 underline underline-offset-8 decoration-2 decoration-teal-600'
                : ''
            }`}
          >
            Today
          </a>
          <a
            href="#setup"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('setup');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'setup'
                ? 'text-slate-900 dark:text-slate-100 underline underline-offset-8 decoration-2 decoration-teal-600'
                : ''
            }`}
          >
            Commute Setup
          </a>
          <a
            href="#trips"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('trips');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'trips'
                ? 'text-slate-900 dark:text-slate-100 underline underline-offset-8 decoration-2 decoration-teal-600'
                : ''
            }`}
          >
            Trip History
          </a>
          <a
            href="#alerts"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('alerts');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'alerts'
                ? 'text-slate-900 dark:text-slate-100 underline underline-offset-8 decoration-2 decoration-teal-600'
                : ''
            }`}
          >
            Notifications
          </a>
          <a
            href="#metrics"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('metrics');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'metrics'
                ? 'text-slate-900 dark:text-slate-100 underline underline-offset-8 decoration-2 decoration-teal-600'
                : ''
            }`}
          >
            Pilot Metrics
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => setShowAuthModal(true)}
            className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-xl hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            {profile ? `${profile.employeeCode}: ${profile.name}` : 'Switch Pilot User'}
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-20">
        {/* Live In-App Alert Banner when a new reminder or deterioration alert fires */}
        {latestToastAlert && (
          <div className="mb-5 bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-700 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="text-xs font-bold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                <Bell className="w-4 h-4 shrink-0" />
                <span>{latestToastAlert.title}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{latestToastAlert.createdAtIst}</span>
              </div>
              <p className="text-sm font-medium text-amber-950 dark:text-amber-100">
                {latestToastAlert.message}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  handleMonitoringAction('IVE_LEFT');
                  setLatestToastAlert(null);
                }}
                className="min-h-[40px] px-3.5 py-1.5 bg-teal-700 text-white text-xs font-semibold rounded-xl whitespace-nowrap"
              >
                I&rsquo;ve Left
              </button>
              <button
                type="button"
                onClick={() => {
                  handleMonitoringAction('SNOOZE_10M');
                  setLatestToastAlert(null);
                }}
                className="min-h-[40px] px-3 py-1.5 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-amber-300 dark:border-amber-700 text-xs font-semibold rounded-xl whitespace-nowrap"
              >
                Snooze 10m
              </button>
              <button
                type="button"
                onClick={() => setLatestToastAlert(null)}
                className="min-h-[40px] px-2.5 py-1.5 text-xs text-amber-900 dark:text-amber-300 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {activeTab === 'setup' && profile && (
          <SetupView
            profile={profile}
            environment={environment}
            onSaveProfile={async (updated) => {
              await fetch('/api/me/profile', {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(updated),
              });
              await fetchUserState(token);
            }}
            onSearchPlaces={async (query) => {
              const res = await fetch('/api/places/search', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ query, environment }),
              });
              const data = await res.json();
              if (res.status === 429 || data?.quotaExceeded) {
                window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
                throw new Error(data.message || 'Places API quota exceeded');
              }
              if (!res.ok) {
                throw new Error(data.message || 'Places search error');
              }
              return data.places || [];
            }}
            onDeleteLocations={async () => {
              await fetch('/api/me/locations', {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
              });
              await fetchUserState(token);
            }}
            onDeleteJourneys={async () => {
              await fetch('/api/me/journeys', {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
              });
              await fetchUserState(token);
            }}
            notificationPermission={notificationPermission}
            onRequestNotificationPermission={handleRequestNotificationPermission}
          />
        )}

        {(activeTab === 'trips' || activeTab === 'alerts') && (
          <TripsAndAlertsView
            mode={activeTab === 'trips' ? 'TRIPS' : 'ALERTS'}
            journeys={journeys}
            alerts={alerts}
            sessions={sessions}
            onUpdateJourney={async (id, payload) => {
              await fetch(`/api/journeys/${id}`, {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(payload),
              });
              await fetchUserState(token);
            }}
            notificationPermission={notificationPermission}
            onRequestNotificationPermission={handleRequestNotificationPermission}
          />
        )}

        {activeTab === 'metrics' && (
          <PilotMetricsView
            token={token}
            quota={quota}
            onUpdateQuotaLimit={async (newLimit) => {
              await fetch('/api/pilot/quota-limit', {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ dailyLimit: newLimit }),
              });
              await fetchUserState(token);
            }}
          />
        )}

        {/* TODAY DASHBOARD VIEW */}
        {activeTab === 'today' && profile && effectiveSchedule && (
          <div className="space-y-6 pb-20">
            {/* Workspace Context & Mode Toolbar */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>Prestige Tech Park Pilot</span>
                    <span aria-hidden="true"> · </span>
                    <span>{istClock.dayOfWeek}, {istClock.dateIst}</span>
                    <span aria-hidden="true"> · </span>
                    <span>Current Time: {istClock.timeWithSecIst}</span>
                  </div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                    {direction === 'HOME_TO_WORK'
                      ? `${profile.homeLocation?.label.split(',')[0] || 'Home (Unset)'} → ${profile.workLocation.label.split('(')[0].trim()}`
                      : `${profile.workLocation.label.split('(')[0].trim()} → ${profile.homeLocation?.label.split(',')[0] || 'Home (Unset)'}`}
                  </h1>
                </div>

                {/* Direction & Environment Switchers */}
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
                    <button
                      type="button"
                      onClick={() => setDirection('HOME_TO_WORK')}
                      className={`min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                        direction === 'HOME_TO_WORK'
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                      }`}
                    >
                      Home → Work
                    </button>
                    <button
                      type="button"
                      onClick={() => setDirection('WORK_TO_HOME')}
                      className={`min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                        direction === 'WORK_TO_HOME'
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                      }`}
                    >
                      Work → Home
                    </button>
                  </div>

                  <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
                    <button
                      type="button"
                      onClick={() => {
                        setEnvironment('LIVE');
                        handleStartOrRefreshMonitoring({
                          targetDirection: direction,
                          targetEnv: 'LIVE',
                        });
                      }}
                      className={`min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                        environment === 'LIVE'
                          ? 'bg-teal-700 text-white shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                      }`}
                    >
                      Live Google Maps API
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEnvironment('DEMO');
                        handleStartOrRefreshMonitoring({
                          targetDirection: direction,
                          targetEnv: 'DEMO',
                        });
                      }}
                      className={`min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                        environment === 'DEMO'
                          ? 'bg-amber-600 text-white shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                      }`}
                    >
                      Labeled Demo Mode
                    </button>
                  </div>
                </div>
              </div>

              {/* Explicit Labeled Demo Mode Banner when in DEMO */}
              {environment === 'DEMO' && (
                <div className="p-3 rounded-xl bg-amber-50/90 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold">Explicitly Labeled Demo Mode Active:</span>{' '}
                    Showing deterministic ORR synthetic commute predictions. Demo trips are isolated from real Live Pilot Metrics.
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      handleStartOrRefreshMonitoring({
                        targetDirection: direction,
                        targetEnv: 'DEMO',
                        simulateTrafficSpikeMin: 8,
                      })
                    }
                    className="min-h-[36px] px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold rounded-lg whitespace-nowrap shrink-0"
                  >
                    Simulate +8m Traffic Deterioration Alert
                  </button>
                </div>
              )}

              {/* Quick Mode Switcher & Window Metadata Row */}
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-400 font-mono tabular-nums">
                  <span>Window: {effectiveSchedule.windowStart}–{effectiveSchedule.windowEnd} IST</span>
                  <span aria-hidden="true">·</span>
                  <span>Preferred: {effectiveSchedule.preferredDeparture} IST</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Deadline:{' '}
                    {effectiveSchedule.arrivalDeadline
                      ? `${effectiveSchedule.arrivalDeadline} IST`
                      : 'None'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>User Buffer: +{effectiveSchedule.safetyBufferMinutes}m</span>
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl self-start sm:self-auto">
                  {(['BIKE', 'CAR', 'BMTC'] as TransportMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleQuickModeChange(m)}
                      className={`min-h-[38px] px-3 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                        effectiveSchedule.mode === m
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                      }`}
                    >
                      {m === 'BIKE'
                        ? 'Bike (2W)'
                        : m === 'CAR'
                        ? 'Car'
                        : 'BMTC Bus'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 3-Hour Commute Duration Trend Mini Chart */}
            <CommuteTrendMiniChart
              origin={
                direction === 'HOME_TO_WORK'
                  ? profile.homeLocation
                  : profile.workLocation
              }
              destination={
                direction === 'HOME_TO_WORK'
                  ? profile.workLocation
                  : profile.homeLocation || profile.workLocation
              }
              direction={direction}
              mode={effectiveSchedule.mode}
              environment={environment}
              currentIstHhmm={istClock.timeIst}
              dateIst={istClock.dateIst}
              selectedOption={
                activeSession?.latestOptions.find(
                  (o) => o.id === activeSession.selectedOptionId
                ) ||
                activeSession?.latestOptions[0] ||
                null
              }
              observedHistory={observedHistory.filter(
                (h) =>
                  h.direction === direction && h.mode === effectiveSchedule.mode
              )}
            />

            {/* Active Journey In-Progress Banner (when user pressed "I've left") */}
            {activeInProgressJourney && (
              <section className="bg-teal-950 text-white rounded-2xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="text-xs text-teal-300 font-mono tabular-nums">
                      Active Commute In Progress · Left at {activeInProgressJourney.actualDepartureTimeIst} IST · Communicated ETA: {activeInProgressJourney.departureEstimate.predictedArrivalTimeIst} IST
                    </div>
                    <h2 className="text-base font-bold mt-0.5">
                      Confirm Your Arrival at {activeInProgressJourney.destinationLabel}
                    </h2>
                  </div>
                  <span className="text-xs text-teal-200 font-mono">
                    Departure alerts stopped
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end pt-2 border-t border-teal-800/80">
                  <div>
                    <label className="block text-xs text-teal-200 mb-1">
                      Actual Arrival Time (IST)
                    </label>
                    <input
                      type="time"
                      value={arrivalHhmm}
                      onChange={(e) => setArrivalHhmm(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 text-sm font-mono tabular-nums bg-teal-900 border border-teal-700 rounded-xl text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-teal-200 mb-1">
                      Was this useful?
                    </label>
                    <div className="flex gap-1.5">
                      {(['YES', 'SOMEWHAT', 'NO'] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setArrivalUseful(r)}
                          className={`flex-1 min-h-[44px] px-2 py-1.5 text-xs font-semibold rounded-xl ${
                            arrivalUseful === r
                              ? 'bg-white text-teal-950'
                              : 'bg-teal-900 text-teal-200 border border-teal-700'
                          }`}
                        >
                          {r === 'YES' ? 'Yes' : r === 'SOMEWHAT' ? 'Somewhat' : 'No'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-teal-100 min-h-[44px]">
                      <input
                        type="checkbox"
                        checked={arrivalChangedRoute}
                        onChange={(e) => setArrivalChangedRoute(e.target.checked)}
                        className="w-4 h-4 accent-teal-400 rounded"
                      />
                      <span>Changed plan or route</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    onClick={async () => {
                      await fetch(`/api/journeys/${activeInProgressJourney.id}`, {
                        method: 'PUT',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${token}`,
                        },
                        body: JSON.stringify({
                          actualArrivalHhmm: arrivalHhmm,
                          changedPlanOrRoute: arrivalChangedRoute,
                          usefulRating: arrivalUseful,
                          feedbackNote: arrivalNote,
                        }),
                      });
                      await fetchUserState(token);
                      setActiveTab('trips');
                    }}
                    className="min-h-[44px] px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold rounded-xl transition-colors whitespace-nowrap"
                  >
                    Confirm Arrival &amp; Log ETA
                  </button>
                </div>
              </section>
            )}

            {/* Monitoring Control Bar */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-400 font-mono tabular-nums">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      Monitoring Status: {activeSession?.status || 'IDLE'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Watch Mode:{' '}
                      {activeSession?.watchMode === 'SELECTED_OPTION'
                        ? 'Tracking Selected Option'
                        : 'Watching All Options'}
                    </span>
                    {activeSession?.lastRefreshedAtIso && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          Updated:{' '}
                          {new Date(activeSession.lastRefreshedAtIso).toLocaleTimeString(
                            'en-IN',
                            { timeZone: 'Asia/Kolkata', hour12: false }
                          )}{' '}
                          IST
                        </span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>Auto-refresh: Every 5 min</span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Alert threshold: +{effectiveSchedule.alertThresholdMinutes} min arrival deterioration vs last notified ETA ({activeSession?.lastNotifiedArrivalTimeIst || 'none yet'}). Duplicates suppressed: {activeSession?.suppressedDuplicatesCount || 0}.
                  </p>
                </div>

                {/* Primary Monitoring Action Buttons (Minimum 44px touch targets) */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleStartOrRefreshMonitoring({
                        targetDirection: direction,
                        targetEnv: environment,
                        startMode: 'IMMEDIATE',
                      })
                    }
                    disabled={loadingRoutes}
                    className="min-h-[44px] px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-900 dark:text-slate-100 text-xs font-semibold rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingRoutes ? 'animate-spin' : ''}`} />
                    <span>{loadingRoutes ? 'Refreshing...' : 'Refresh (5m Poll)'}</span>
                  </button>

                  {activeSession &&
                    (activeSession.status === 'ACTIVE' ||
                      activeSession.status === 'SNOOZED' ||
                      activeSession.status === 'SCHEDULED') && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleMonitoringAction('IVE_LEFT')}
                          className="min-h-[44px] px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0"
                        >
                          <Navigation className="w-4 h-4" />
                          <span>I&rsquo;ve Left</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleMonitoringAction('SNOOZE_10M')}
                          className="min-h-[44px] px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-800 dark:text-slate-200 text-xs font-semibold rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0"
                        >
                          <PauseCircle className="w-4 h-4" />
                          <span>Snooze 10 min</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleMonitoringAction('SKIP_TODAY')}
                          className="min-h-[44px] px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-800 dark:text-slate-200 text-xs font-semibold rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0"
                        >
                          <SkipForward className="w-4 h-4" />
                          <span>Skip Today</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleMonitoringAction('STOP_MONITORING')}
                          className="min-h-[44px] px-3.5 py-2 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 text-rose-700 dark:text-rose-400 text-xs font-semibold rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0"
                        >
                          <Square className="w-3.5 h-3.5" />
                          <span>Stop Monitoring</span>
                        </button>
                      </>
                    )}

                  {activeSession &&
                    (activeSession.status === 'STOPPED' ||
                      activeSession.status === 'SKIPPED' ||
                      activeSession.status === 'EXPIRED') && (
                      <button
                        type="button"
                        onClick={() => {
                          handleDayOverride(false);
                        }}
                        className="min-h-[44px] px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <Play className="w-4 h-4" />
                        <span>Resume Monitoring Today</span>
                      </button>
                    )}
                </div>
              </div>
            </section>

            {/* Edge State & Resilient UI State Handling */}
            {(edgeState !== 'NONE' ||
              routeError ||
              loadingRoutes ||
              effectiveSchedule.skippedToday ||
              activeSession?.status === 'EXPIRED' ||
              activeSession?.unsupportedModeReason) && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3">
                {(loadingRoutes || edgeState === 'LOADING') && (
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-teal-600" />
                      <span>Computing traffic-aware departure slots across your window...</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {[1, 2, 3].map((n) => (
                        <div
                          key={n}
                          className="h-44 rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse p-4"
                        />
                      ))}
                    </div>
                  </div>
                )}

                {effectiveSchedule.skippedToday && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Commute Skipped for Today ({istClock.dateIst})
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Departure monitoring and alerts are paused for this commute leg today.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDayOverride(false)}
                      className="min-h-[44px] px-4 py-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-semibold rounded-xl whitespace-nowrap shrink-0"
                    >
                      Re-Enable Today&rsquo;s Commute
                    </button>
                  </div>
                )}

                {(edgeState === 'EXPIRED_PLAN' || activeSession?.status === 'EXPIRED') && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Departure Window Expired ({effectiveSchedule.windowStart}–{effectiveSchedule.windowEnd} IST)
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                        Monitoring automatically expired at the end of your configured departure window. You can extend your window in Commute Setup or start an immediate on-demand check.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('setup')}
                      className="min-h-[44px] px-4 py-2 bg-slate-900 text-white text-xs font-semibold rounded-xl whitespace-nowrap shrink-0"
                    >
                      Adjust Departure Window
                    </button>
                  </div>
                )}

                {(edgeState === 'NO_ROUTE' || activeSession?.unsupportedModeReason) && (
                  <div className="space-y-1">
                    <h3 className="text-base font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                      <span>Mode or Route Coverage Limitation</span>
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      {activeSession?.unsupportedModeReason ||
                        'No supported route or scheduled transit service was returned for this origin–destination pair and mode. Unsupported recommendations are disabled rather than fabricated.'}
                    </p>
                  </div>
                )}

                {edgeState === 'OFFLINE' && (
                  <div className="flex items-start gap-3 text-amber-900 dark:text-amber-200">
                    <WifiOff className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="text-xs space-y-1">
                      <div className="font-semibold text-sm">Device Offline — Live Traffic Refresh Paused</div>
                      <p>
                        Cannot reach routing provider. Showing last cached recommendation with explicit timestamp. Do not rely on stale traffic estimates for tight arrival deadlines.
                      </p>
                    </div>
                  </div>
                )}

                {edgeState === 'STALE_DATA' && (
                  <div className="flex items-start justify-between gap-4 text-amber-900 dark:text-amber-200">
                    <div className="text-xs space-y-1">
                      <div className="font-semibold text-sm">Stale Route Prediction Data (&gt;10 min old)</div>
                      <p>
                        The displayed estimates were fetched over 10 minutes ago. Outer Ring Road traffic conditions may have shifted significantly.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleStartOrRefreshMonitoring()}
                      className="min-h-[40px] px-3.5 py-1.5 bg-amber-800 text-white text-xs font-semibold rounded-xl whitespace-nowrap shrink-0"
                    >
                      Refresh Now
                    </button>
                  </div>
                )}

                {(edgeState === 'PROVIDER_ERROR' || routeError) && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-rose-800 dark:text-rose-300">
                    <div className="text-xs space-y-1">
                      <div className="font-semibold text-sm">Routing Provider Error (No Silent Fallback)</div>
                      <p>
                        {routeError ||
                          'The live traffic routing API returned an error or timed out. ORR Pulse never silently falls back to synthetic numbers when Live mode fails.'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleStartOrRefreshMonitoring()}
                        className="min-h-[40px] px-3.5 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-xl whitespace-nowrap"
                      >
                        Retry Live API
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEnvironment('DEMO');
                          handleStartOrRefreshMonitoring({ targetEnv: 'DEMO' });
                        }}
                        className="min-h-[40px] px-3.5 py-1.5 bg-amber-600 text-white text-xs font-semibold rounded-xl whitespace-nowrap"
                      >
                        Switch to Labeled Demo
                      </button>
                    </div>
                  </div>
                )}

                {edgeState === 'NOTIFICATION_DENIED' && (
                  <div className="text-xs text-slate-700 dark:text-slate-300 space-y-1">
                    <div className="font-semibold text-sm text-slate-900 dark:text-slate-100">
                      Browser Notification Permission Denied — In-App Monitoring Only
                    </div>
                    <p>
                      Browser push alerts are blocked by your browser site settings. In-app departure reminders and deterioration banners remain active while this tab is open.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Departure Recommendations Section */}
            {!effectiveSchedule.skippedToday &&
              edgeState !== 'LOADING' &&
              edgeState !== 'NO_ROUTE' &&
              activeSession &&
              activeSession.latestOptions.length > 0 && (
                <section className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Departure Recommendations ({activeSession.latestOptions.length} Distinct{' '}
                        {activeSession.latestOptions.length === 1 ? 'Option' : 'Options'})
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Coinciding options are combined automatically. Select one option to track or keep watching all options.
                      </p>
                    </div>

                    {activeSession.selectedOptionId && (
                      <button
                        type="button"
                        onClick={() =>
                          handleSelectOption(activeSession.latestOptions[0], 'ALL_OPTIONS')
                        }
                        className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline self-start sm:self-auto"
                      >
                        Reset to Watch All Options
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch">
                    {activeSession.latestOptions.map((opt) => {
                      const isTracked = activeSession.selectedOptionId === opt.id;
                      const basisLabel =
                        opt.estimateBasis === 'CURRENT_TRAFFIC'
                          ? 'Current Live Traffic'
                          : opt.estimateBasis === 'FUTURE_FORECAST'
                          ? 'Future Traffic Forecast'
                          : 'Scheduled Timetable (No Live GPS)';

                      return (
                        <div
                          key={opt.id}
                          className={`bg-white dark:bg-slate-900 rounded-2xl p-5 flex flex-col justify-between space-y-5 border transition-colors ${
                            isTracked
                              ? 'border-teal-600 ring-1 ring-teal-600'
                              : 'border-slate-200 dark:border-slate-800'
                          }`}
                        >
                          <div className="space-y-4">
                            {/* Unboxed Kicker & Title */}
                            <div className="space-y-1">
                              <div className="text-xs text-teal-700 dark:text-teal-400 font-semibold">
                                {opt.title}
                              </div>
                              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                                {opt.whyRecommended}
                              </p>
                            </div>

                            {/* Primary Departure -> Duration -> Arrival Numbers */}
                            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 flex items-center justify-between gap-2">
                              <div>
                                <div className="text-[11px] text-slate-500">Leave At</div>
                                <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                                  {opt.departureTimeIst}
                                </div>
                              </div>

                              <div className="text-center px-2">
                                <div className="text-xs font-mono tabular-nums font-semibold text-teal-700 dark:text-teal-400">
                                  {opt.predictedDurationMin} min
                                </div>
                                <ArrowRight className="w-4 h-4 text-slate-400 mx-auto my-0.5" />
                                {opt.durationRangeMin ? (
                                  <div className="text-[11px] font-mono tabular-nums text-slate-500">
                                    Range {opt.durationRangeMin[0]}–{opt.durationRangeMin[1]}m
                                  </div>
                                ) : (
                                  <div className="text-[11px] font-mono tabular-nums text-slate-500">
                                    {opt.distanceKm} km
                                  </div>
                                )}
                              </div>

                              <div className="text-right">
                                <div className="text-[11px] text-slate-500">
                                  Predicted Arrival
                                </div>
                                <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                                  {opt.predictedArrivalTimeIst}
                                </div>
                              </div>
                            </div>

                            {/* Deadline Relationship & Separate Safety Buffer */}
                            <div className="space-y-1.5 text-xs">
                              <div
                                className={`font-semibold flex items-center gap-1.5 ${
                                  opt.deadlineRelation.meetsRaw
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-rose-700 dark:text-rose-400'
                                }`}
                              >
                                {opt.deadlineRelation.meetsRaw ? (
                                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                                ) : (
                                  <AlertTriangle className="w-4 h-4 shrink-0" />
                                )}
                                <span>{opt.deadlineRelation.summaryText}</span>
                              </div>

                              {opt.userSafetyBufferMin > 0 && (
                                <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                                  Provider raw ETA: {opt.predictedArrivalTimeIst} · With your +{opt.userSafetyBufferMin}m safety buffer: {opt.bufferedArrivalTimeIst}
                                </div>
                              )}
                            </div>

                            {/* Mode, Basis, Corridor, and Source Metadata (Unboxed with separators) */}
                            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
                              <div>
                                <span className="font-semibold text-slate-800 dark:text-slate-200">
                                  Mode: {opt.transportMode === 'BIKE' ? 'Bike (Motorized Two-Wheeler)' : opt.transportMode === 'CAR' ? 'Car' : 'BMTC Bus'}
                                </span>
                                <span aria-hidden="true"> · </span>
                                <span>Basis: {basisLabel}</span>
                              </div>
                              <div className="truncate" title={opt.corridorSummary}>
                                Route: {opt.corridorSummary}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                                <span>{opt.dataSource}</span>
                                <span aria-hidden="true"> · </span>
                                <span>Updated {opt.lastUpdatedIst}</span>
                              </div>
                            </div>

                            {/* BMTC Step-by-Step Breakdown when mode === BMTC */}
                            {opt.transitDetails && (
                              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2 text-xs">
                                <div className="font-semibold text-slate-800 dark:text-slate-200 font-mono tabular-nums">
                                  Walk {opt.transitDetails.walkingMin}m · Wait {opt.transitDetails.waitingMin}m · In-Bus {opt.transitDetails.inVehicleMin}m · Transfers: {opt.transitDetails.transfersCount}
                                </div>
                                <div className="space-y-1 text-slate-600 dark:text-slate-400">
                                  {opt.transitDetails.steps.map((st, idx) => (
                                    <div key={idx} className="flex items-start gap-2">
                                      <span className="font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
                                        {st.durationMin}m
                                      </span>
                                      <span>{st.instruction}</span>
                                    </div>
                                  ))}
                                </div>
                                <p className="text-[11px] text-amber-800 dark:text-amber-300">
                                  {opt.transitDetails.limitationNote}
                                </p>
                              </div>
                            )}

                            {/* Two-Wheeler Mandatory Beta Notice */}
                            {opt.betaNotice && (
                              <p className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-amber-800 dark:text-amber-300">
                                {opt.betaNotice}
                              </p>
                            )}
                          </div>

                          {/* Card Action Footer */}
                          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleSelectOption(opt, 'SELECTED_OPTION')}
                              className={`flex-1 min-h-[44px] px-4 py-2 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap ${
                                isTracked
                                  ? 'bg-teal-700 text-white'
                                  : 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800'
                              }`}
                            >
                              {isTracked ? 'Tracking This Plan' : 'Select & Track Plan'}
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                await handleSelectOption(opt, 'SELECTED_OPTION');
                                await handleMonitoringAction('IVE_LEFT');
                              }}
                              className="min-h-[44px] px-3.5 py-2 text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-900 dark:text-slate-100 rounded-xl whitespace-nowrap shrink-0"
                            >
                              I&rsquo;ve Left
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

            {/* Required UI States Inspector Toolbar (for verifying loading, no-route, expired, offline, stale, provider-error, notification-denied) */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Resilience &amp; Edge-State Verification Inspector
                </span>
                <span className="text-[11px] text-slate-500">
                  Preview required operational states
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: 'NONE', label: 'Normal Active' },
                    { id: 'LOADING', label: 'Loading Skeleton' },
                    { id: 'NO_ROUTE', label: 'No Route / Unsupported Mode' },
                    { id: 'EXPIRED_PLAN', label: 'Expired Window' },
                    { id: 'OFFLINE', label: 'Offline' },
                    { id: 'STALE_DATA', label: 'Stale Data' },
                    { id: 'PROVIDER_ERROR', label: 'Provider Error' },
                    { id: 'NOTIFICATION_DENIED', label: 'Notification Denied' },
                  ] as Array<{ id: SimulatedEdgeState; label: string }>
                ).map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setEdgeState(st.id)}
                    className={`min-h-[36px] px-3 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      edgeState === st.id
                        ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900'
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Mobile Fixed Bottom Navigation Bar (44x44px touch hitboxes, <15% viewport height) */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 grid grid-cols-5 items-center h-16"
      >
        {(
          [
            { id: 'today', label: 'Today', Icon: Compass },
            { id: 'setup', label: 'Setup', Icon: Settings },
            { id: 'trips', label: 'Trips', Icon: History },
            { id: 'alerts', label: 'Alerts', Icon: Bell },
            { id: 'metrics', label: 'Metrics', Icon: BarChart3 },
          ] as const
        ).map(({ id, label, Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`min-h-[44px] min-w-[44px] flex flex-col items-center justify-center py-1 transition-colors ${
                active
                  ? 'text-teal-700 dark:text-teal-400 font-semibold'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] tracking-tight mt-0.5 whitespace-nowrap">
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Pilot Employee Authentication / Switcher Modal */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-t-3xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-5 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Pilot Employee Authentication (10-Employee Cohort)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Server enforces per-user Bearer token isolation. Home addresses and trips are private to each employee.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAuthModal(false)}
                className="min-h-[40px] px-3 py-1 text-xs font-medium text-slate-500 hover:text-slate-900"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {roster.map((emp) => {
                  const selected = selectedRosterId === emp.id;
                  return (
                    <button
                      key={emp.id}
                      type="button"
                      onClick={() => {
                        setSelectedRosterId(emp.id);
                        setPinInput(emp.defaultPinHint);
                      }}
                      className={`w-full text-left p-3 rounded-xl border transition-colors flex items-center justify-between gap-3 ${
                        selected
                          ? 'border-teal-600 bg-teal-50/50 dark:bg-teal-950/30'
                          : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          {emp.employeeCode} · {emp.name} ({emp.role})
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          Corridor: {emp.corridorTag}
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-slate-400 shrink-0">
                        PIN: {emp.defaultPinHint}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  4-Digit Pilot Access PIN
                </label>
                <input
                  type="password"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                />
              </div>

              {authError && (
                <p className="text-xs text-rose-600 font-medium">{authError}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAuthModal(false)}
                  className="min-h-[44px] px-4 py-2 text-xs font-medium text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="min-h-[44px] px-5 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5"
                >
                  <UserCheck className="w-4 h-4" />
                  <span>Sign In as Employee</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
