/**
 * Today — decision-first: the next departure timeline and its actions sit at
 * the top; schedule details and today-only overrides live in a collapsible
 * "Change today's plan" section below. On non-workdays the hero explains
 * there is no commute today and shows the next scheduled day instead of
 * controls. Never claims GPS tracking or push delivery.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutAnimation, Text, View } from 'react-native';
import type { CommuteDirection, DataEnvironment, DepartureOption, MonitoringSession } from '../types/shared';
import { useApp } from '../state/appStore';
import { addDaysToIstDate, getNowIstParts, hhmmToMinutes, resolveEffectiveSchedule } from '../services/demoEngine';
import { isValidHhmm, validateJourneyChronology } from '../validation/validate';
import { spacing, usePalette } from '../theme';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  IconButton,
  LoadingView,
  ScreenScroll,
  SegmentedControl,
  ThemedText,
} from '../components/ui';
import { ModeBanner, OptionCard } from '../components/domain';
import { DepartureTimeline } from '../components/Timeline';
import { AlertsModal } from './AlertsModal';
import { selectCurrentSession } from '../services/sessionSelection';

const DIRECTION_LABEL: Record<CommuteDirection, string> = {
  HOME_TO_WORK: 'To work (inbound)',
  WORK_TO_HOME: 'To home (outbound)',
};

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const DAY_ORDER: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function istDateToDayCode(dateIst: string): (typeof DAY_LABELS)[number] {
  const d = new Date(`${dateIst}T12:00:00Z`);
  const idx = d.getUTCDay();
  return DAY_LABELS[(idx + 6) % 7];
}

function statusTone(status: MonitoringSession['status']): 'ok' | 'risk' | 'neutral' | 'primary' | 'demo' {
  switch (status) {
    case 'ACTIVE':
      return 'ok';
    case 'SNOOZED':
      return 'neutral';
    case 'LEFT':
      return 'primary';
    case 'SKIPPED':
    case 'STOPPED':
    case 'EXPIRED':
      return 'risk';
    default:
      return 'neutral';
  }
}

const STATUS_EXPLAIN: Record<MonitoringSession['status'], string> = {
  SCHEDULED: 'Monitoring will activate before your preferred departure.',
  ACTIVE: 'Watching estimates while the app is open.',
  SNOOZED: 'Reminders paused; monitoring continues.',
  LEFT: 'Departure recorded. Prompts stopped.',
  SKIPPED: 'Skipped for today.',
  STOPPED: 'Stopped for today.',
  EXPIRED: 'The departure window ended.',
};

function nextWorkdayInfo(
  dateIst: string,
  days: readonly string[]
): { dayName: string; dateIst: string } | null {
  for (let i = 1; i <= 7; i++) {
    const d = addDaysToIstDate(dateIst, i);
    if (days.includes(istDateToDayCode(d))) {
      const name = istDateToDayCode(d);
      const pretty = name.charAt(0) + name.slice(1).toLowerCase();
      return { dayName: pretty, dateIst: d };
    }
  }
  return null;
}

function pickPrimaryOption(session: MonitoringSession): DepartureOption | null {
  return (
    session.latestOptions.find((o) => o.id === session.selectedOptionId) ??
    session.latestOptions.find((o) => o.roles.includes('LEAVE_NOW')) ??
    session.latestOptions[0] ??
    null
  );
}

export function TodayScreen() {
  const p = usePalette();
  const { state, demoDispatch, refreshLiveState, startLiveMonitoring, liveSelectOption, liveMonitoringAction, liveCorrectJourney, setLiveDataEnvironment, liveDayOverride } = useApp();
  const [direction, setDirection] = useState<CommuteDirection>('HOME_TO_WORK');
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [now, setNow] = useState(() => getNowIstParts());
  const [arrivalInput, setArrivalInput] = useState('');
  const [arrivalError, setArrivalError] = useState<string | null>(null);
  const [planExpanded, setPlanExpanded] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(getNowIstParts()), 30_000);
    return () => clearInterval(id);
  }, []);

  const demo = state.mode === 'DEMO';
  const profile = demo ? state.demo.profile : state.live.profile;
  const sessions = demo ? state.demo.sessions : state.live.sessions;
  const alerts = demo ? state.demo.alerts : state.live.alerts;
  const journeys = demo ? state.demo.journeys : state.live.journeys;

  const session = useMemo(() => {
    return selectCurrentSession(sessions, direction, now.dateIst);
  }, [sessions, direction, now.dateIst]);

  const schedule = useMemo(
    () =>
      profile
        ? resolveEffectiveSchedule(profile.schedules[direction], profile.dayOverrides, now.dateIst)
        : null,
    [profile, direction, now.dateIst]
  );

  const unacknowledged = alerts.filter((a) => !a.acknowledged).length;
  const isWorkday = schedule ? schedule.days.includes(now.dayOfWeek) : false;
  const skippedToday = schedule?.skippedToday ?? false;
  const nextWorkday = schedule ? nextWorkdayInfo(now.dateIst, schedule.days) : null;

  const journey = useMemo(() => {
    return journeys.find((j) => j.direction === direction && j.dateIst === now.dateIst && !j.actualArrivalIso) ?? null;
  }, [journeys, direction, now.dateIst]);

  const saveArrival = useCallback(() => {
    const value = arrivalInput.trim();
    if (!isValidHhmm(value)) {
      setArrivalError('Enter arrival as a valid 24-hour time like 09:05.');
      return;
    }
    if (journey) {
      const chrono = validateJourneyChronology(journey.actualDepartureTimeIst, value);
      if (chrono) {
        setArrivalError(chrono);
        return;
      }
    }
    setArrivalError(null);
    if (journey) {
      if (demo) {
        demoDispatch({
          type: 'RECORD_ARRIVAL',
          nowIso: new Date().toISOString(),
          journeyId: journey.id,
          arrivalHhmm: value,
        });
      } else {
        void liveCorrectJourney(journey.id, { actualArrivalHhmm: value });
      }
    }
    setArrivalInput('');
  }, [arrivalInput, demo, journey, demoDispatch, liveCorrectJourney]);

  const onLeave = useCallback(
    (sessionId: string) => {
      if (demo) {
        demoDispatch({ type: 'MONITORING_ACTION', nowIso: new Date().toISOString(), sessionId, action: 'IVE_LEFT' });
      } else {
        void liveMonitoringAction(sessionId, 'IVE_LEFT');
      }
    },
    [demo, demoDispatch, liveMonitoringAction]
  );

  const onSnooze = useCallback(
    (sessionId: string) => {
      if (demo) {
        demoDispatch({ type: 'MONITORING_ACTION', nowIso: new Date().toISOString(), sessionId, action: 'SNOOZE_10M' });
      } else {
        void liveMonitoringAction(sessionId, 'SNOOZE_10M');
      }
    },
    [demo, demoDispatch, liveMonitoringAction]
  );

  const onStop = useCallback(
    (sessionId: string) => {
      if (demo) {
        demoDispatch({ type: 'MONITORING_ACTION', nowIso: new Date().toISOString(), sessionId, action: 'STOP_MONITORING' });
      } else {
        void liveMonitoringAction(sessionId, 'STOP_MONITORING');
      }
    },
    [demo, demoDispatch, liveMonitoringAction]
  );

  const onSkipToday = useCallback(
    (sessionId: string | null) => {
      if (demo) {
        if (sessionId) {
          demoDispatch({ type: 'MONITORING_ACTION', nowIso: new Date().toISOString(), sessionId, action: 'SKIP_TODAY' });
        } else {
          demoDispatch({
            type: 'SET_DAY_OVERRIDE',
            override: { dateIst: now.dateIst, direction, skipped: true },
          });
        }
      } else {
        void liveDayOverride({ dateIst: now.dateIst, direction, skipped: true });
      }
    },
    [demo, demoDispatch, direction, now.dateIst, liveDayOverride]
  );

  const onResumeToday = useCallback(() => {
    if (demo) {
      demoDispatch({ type: 'CLEAR_DAY_OVERRIDE', direction });
    } else {
      void liveDayOverride({ dateIst: now.dateIst, direction, skipped: false });
    }
  }, [demo, demoDispatch, direction, liveDayOverride, now.dateIst]);

  const onStartMonitoring = useCallback(
    (startMode: 'IMMEDIATE' | 'SCHEDULED_LEAD') => {
      if (demo) {
        demoDispatch({
          type: 'START_OR_REFRESH_SESSION',
          nowIso: new Date().toISOString(),
          direction,
          startMode,
          watchMode: 'ALL_OPTIONS',
        });
      } else {
        void startLiveMonitoring({ direction, startMode, watchMode: 'ALL_OPTIONS' });
      }
    },
    [demo, demoDispatch, direction, startLiveMonitoring]
  );

  const onRefresh = useCallback(() => {
    if (demo) {
      demoDispatch({ type: 'REFRESH_ACTIVE_SESSIONS', nowIso: new Date().toISOString() });
    } else {
      void refreshLiveState();
    }
  }, [demo, demoDispatch, refreshLiveState]);

  const onSelectOption = useCallback(
    (optionId: string) => {
      if (!session) return;
      if (demo) {
        demoDispatch({ type: 'SELECT_OPTION', nowIso: new Date().toISOString(), sessionId: session.id, optionId });
      } else {
        void liveSelectOption(session.id, optionId);
      }
    },
    [demo, demoDispatch, session, liveSelectOption]
  );

  const togglePlan = useCallback(() => {
    LayoutAnimation.easeInEaseOut();
    setPlanExpanded((v) => !v);
  }, []);

  const liveEnv: DataEnvironment = demo ? 'DEMO' : (session?.dataEnvironment ?? 'DEMO');
  const liveConfigured =
    state.connection.liveApiConfigured ?? state.live.quota?.liveApiConfigured ?? null;
  const primaryOption = session ? pickPrimaryOption(session) : null;
  const sessionLive =
    session &&
    session.status !== 'LEFT' &&
    session.status !== 'SKIPPED' &&
    session.status !== 'STOPPED' &&
    session.status !== 'EXPIRED';
  const windowPassed = schedule
    ? hhmmToMinutes(now.timeIst) > hhmmToMinutes(schedule.windowEnd)
    : false;

  const hero = () => {
    if (!profile) return null;

    if (!profile.homeLocation) {
      return (
        <Card style={{ gap: spacing.s }}>
          <ThemedText variant="title">Set up home first</ThemedText>
          <ThemedText variant="muted">
            Add your home in the Plan tab — search or enter coordinates — to get departure
            recommendations.
          </ThemedText>
        </Card>
      );
    }

    if (skippedToday) {
      return (
        <Card style={{ gap: spacing.s }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <ThemedText variant="title">Skipped for today</ThemedText>
            <Badge tone="risk" label="SKIPPED" />
          </View>
          <ThemedText variant="muted">Your weekly plan is untouched. Monitoring stays off until you resume.</ThemedText>
          <Button title="Resume today" onPress={onResumeToday} />
        </Card>
      );
    }

    if (session && primaryOption && sessionLive) {
      return (
        <Card style={{ gap: spacing.s }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <ThemedText variant="title">Next: leave at {primaryOption.departureTimeIst}</ThemedText>
            <Badge tone={statusTone(session.status)} label={session.status} />
          </View>
          <DepartureTimeline option={primaryOption} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s }}>
            <Button title="I’ve left" onPress={() => onLeave(session.id)} accessibilityHint="Stops departure prompts; with trip recording on, starts a journey record." />
            <Button title="Snooze 10m" variant="secondary" onPress={() => onSnooze(session.id)} />
            <Button title="Stop" variant="secondary" onPress={() => onStop(session.id)} />
          </View>
          <Button title="Refresh estimates" variant="ghost" onPress={() => onStartMonitoring('IMMEDIATE')} loading={state.liveLoading} />
          <ThemedText variant="muted" style={{ fontSize: 12 }}>
            {STATUS_EXPLAIN[session.status]} Estimates can go stale — refresh before trusting a time.
          </ThemedText>
        </Card>
      );
    }

    if (session && session.status === 'LEFT') {
      return (
        <Card style={{ gap: spacing.s }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <ThemedText variant="title">On your way</ThemedText>
            <Badge tone="primary" label="LEFT" />
          </View>
          <ThemedText>
            Departure recorded{session.departureEstimateSnapshot ? ` at ${session.departureEstimateSnapshot.issuedAtIst}` : ''}. Departure prompts have stopped.
          </ThemedText>
          {journey ? (
            <>
              <Field
                label="Record arrival (HH:mm)"
                value={arrivalInput}
                onChangeText={setArrivalInput}
                placeholder="09:05"
                keyboardType="numbers-and-punctuation"
                error={arrivalError}
                hint="Saved to today’s journey; original estimates are never changed."
              />
              <Button title={demo ? 'Save arrival (demo)' : 'Save arrival'} onPress={saveArrival} />
            </>
          ) : (
            <ThemedText variant="muted">
              {profile.telemetryConsent
                ? 'No open journey for this direction today.'
                : 'Trip recording is off — enable it in Settings to measure arrival accuracy.'}
            </ThemedText>
          )}
        </Card>
      );
    }

    if (session && (session.status === 'EXPIRED' || session.status === 'STOPPED')) {
      return (
        <Card style={{ gap: spacing.s }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <ThemedText variant="title">
              {session.status === 'EXPIRED' ? 'Window ended' : 'Monitoring stopped'}
            </ThemedText>
            <Badge tone="risk" label={session.status} />
          </View>
          <ThemedText variant="muted">{STATUS_EXPLAIN[session.status]}</ThemedText>
          {!windowPassed ? (
            <Button title="Start again" onPress={() => onStartMonitoring('IMMEDIATE')} loading={state.liveLoading} />
          ) : (
            <ThemedText variant="muted">Today’s window ({schedule?.windowStart}–{schedule?.windowEnd}) has passed.</ThemedText>
          )}
        </Card>
      );
    }

    if (!isWorkday) {
      return (
        <Card style={{ gap: spacing.s }}>
          <ThemedText variant="title">No commute today</ThemedText>
          <ThemedText variant="muted">
            {nextWorkday
              ? `Next ${DIRECTION_LABEL[direction].toLowerCase()} trip: ${nextWorkday.dayName}, window ${schedule?.windowStart}–${schedule?.windowEnd}, preferred ${schedule?.preferredDeparture}.`
              : `No scheduled days for ${DIRECTION_LABEL[direction].toLowerCase()}. Edit your weekly plan to add some.`}
          </ThemedText>
        </Card>
      );
    }

    return (
      <Card style={{ gap: spacing.s }}>
        <ThemedText variant="title">
          {windowPassed ? 'Window passed for today' : `Ready to watch ${schedule?.windowStart}–${schedule?.windowEnd}?`}
        </ThemedText>
        <ThemedText variant="muted">
          {windowPassed
            ? 'The departure window ended. Start again only if you still plan to travel.'
            : `Computes labeled options around your preferred ${schedule?.preferredDeparture} and alerts you while the app is open.`}
        </ThemedText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s }}>
          <Button
            title="Start monitoring"
            onPress={() => onStartMonitoring('IMMEDIATE')}
            disabled={state.mode === 'CONNECTED' && !state.connection.loggedIn}
            loading={state.liveLoading}
          />
          {session ? <Button title="Refresh state only" variant="ghost" onPress={onRefresh} /> : null}
        </View>
      </Card>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <View
        style={{
          paddingHorizontal: spacing.l,
          paddingBottom: spacing.s,
          backgroundColor: p.surface,
          borderBottomWidth: 1,
          borderBottomColor: p.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: p.ink, fontSize: 22, fontWeight: '800' }}>Today</Text>
            <Text style={{ color: p.inkMuted, fontSize: 13 }}>
              {now.dateIst} · {now.timeWithSecIst}
            </Text>
          </View>
          <IconButton
            name={unacknowledged > 0 ? 'notifications' : 'notifications-outline'}
            label={`Alerts. ${unacknowledged} unacknowledged. Opens the in-app alerts list.`}
            onPress={() => setAlertsOpen(true)}
            badgeCount={unacknowledged}
          />
        </View>
      </View>

      <ScreenScroll>
        <ModeBanner mode={demo ? 'DEMO' : 'CONNECTED'} dataEnvironment={liveEnv} />

        {!demo && !state.connection.loggedIn ? (
          <ErrorState message="Not logged in to the pilot backend. Open Settings to connect and log in with a pilot employee ID and PIN." />
        ) : null}

        {!demo && state.connection.loggedIn && !profile ? (
          <View style={{ marginTop: spacing.m }}>
            {state.liveError ? (
              <ErrorState message={state.liveError} onRetry={() => void refreshLiveState().catch(() => undefined)} retryLabel="Retry pilot state" />
            ) : state.liveLoading ? (
              <LoadingView label="Loading your pilot profile and commute plan…" />
            ) : (
              <Card style={{ gap: spacing.s }}>
                <ThemedText variant="title">Pilot profile is not loaded</ThemedText>
                <ThemedText variant="muted">Your saved commute plan is still being restored from the pilot backend.</ThemedText>
                <Button title="Load pilot profile" onPress={() => void refreshLiveState().catch(() => undefined)} />
              </Card>
            )}
          </View>
        ) : null}

        <SegmentedControl
          label="Commute direction"
          options={[
            { value: 'HOME_TO_WORK', label: 'To work' },
            { value: 'WORK_TO_HOME', label: 'To home' },
          ]}
          value={direction}
          onChange={setDirection}
        />

        {/* Decision-first hero */}
        <View style={{ marginTop: spacing.m }}>{hero()}</View>

        {/* All options, right below the decision */}
        {session && session.latestOptions.length > 1 ? (
          <View style={{ marginTop: spacing.m, gap: spacing.m }}>
            {session.latestOptions.map((option) => (
              <OptionCard
                key={option.id}
                option={option}
                selected={session.selectedOptionId === option.id}
                onSelect={() => onSelectOption(option.id)}
              />
            ))}
            <ThemedText variant="muted" style={{ fontSize: 12 }}>
              Tap “Watch this option” to track one departure instead of all options. No GPS tracking is used.
            </ThemedText>
          </View>
        ) : null}

        {session?.unsupportedModeReason ? (
          <View style={{ marginTop: spacing.m }}>
            <ErrorState message={session.unsupportedModeReason} />
          </View>
        ) : null}

        {!demo ? (
          <Card style={{ marginTop: spacing.m }}>
            <ThemedText variant="title" style={{ fontSize: 15, marginBottom: spacing.s }}>
              Data source
            </ThemedText>
            <SegmentedControl
              label="Data source"
              options={[
                { value: 'DEMO', label: 'Labeled demo data' },
                { value: 'LIVE', label: 'LIVE provider data', disabled: liveConfigured === false },
              ]}
              value={state.liveDataEnvironment}
              onChange={(v) => setLiveDataEnvironment(v)}
            />
            <ThemedText variant="muted" style={{ marginTop: spacing.s, fontSize: 12 }}>
              {liveConfigured === false
                ? 'Backend has no provider key configured — LIVE is unavailable; demo data comes from the real backend.'
                : session
                  ? `Current session source: ${session.dataEnvironment === 'LIVE' ? 'LIVE provider data' : 'labeled demo data'}. Selection applies to the next start or refresh.`
                  : 'No session yet. The selected source applies when you start monitoring or refresh.'}
            </ThemedText>
            {state.liveCacheUpdatedAt ? (
              <ThemedText variant="muted" style={{ marginTop: 4, fontSize: 11 }}>
                Cached server snapshot · {Math.max(0, Math.floor((Date.now() - state.liveCacheUpdatedAt) / 60_000))} min old
              </ThemedText>
            ) : null}
          </Card>
        ) : null}

        {/* Collapsible plan details + today-only overrides */}
        {profile && schedule ? (
          <Card style={{ marginTop: spacing.m }}>
            <Button
              title={planExpanded ? 'Hide today’s plan details' : 'Change today’s plan'}
              variant="ghost"
              onPress={togglePlan}
              accessibilityHint="Expands schedule details and today-only overrides."
            />
            {planExpanded ? (
              <View style={{ gap: spacing.m, paddingBottom: spacing.s }}>
                <View style={{ gap: 6 }}>
                  <ThemedText variant="title" style={{ fontSize: 15 }}>
                    {DIRECTION_LABEL[direction]}
                  </ThemedText>
                  <ThemedText variant="muted" style={{ fontSize: 12 }}>
                    {profile.homeLocation
                      ? `${profile.homeLocation.label} → ${profile.workLocation.label}`
                      : 'Home not set — see Plan'}
                  </ThemedText>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    <Badge tone="neutral" label={schedule.mode} />
                    <Badge tone="neutral" label={`Window ${schedule.windowStart}–${schedule.windowEnd}`} />
                    <Badge tone="neutral" label={`Prefer ${schedule.preferredDeparture}`} />
                    {schedule.arrivalDeadline ? <Badge tone="neutral" label={`Deadline ${schedule.arrivalDeadline}`} /> : null}
                    <Badge tone="neutral" label={`Buffer +${schedule.safetyBufferMinutes}m`} />
                    <Badge tone="neutral" label={schedule.days.join(' ')} />
                  </View>
                  <ThemedText variant="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    Weekly plan lives in the Plan tab. The safety buffer is yours, separate from any estimate.
                  </ThemedText>
                </View>

                <View style={{ gap: spacing.s }}>
                  <ThemedText variant="title" style={{ fontSize: 15 }}>
                    Today only
                  </ThemedText>
                  <ThemedText variant="muted" style={{ fontSize: 12 }}>
                    Applies to {now.dateIst} only; your weekly plan is untouched.
                  </ThemedText>
                  <SegmentedControl
                    label={`Mode for today, currently ${schedule.mode}`}
                    options={[
                      { value: 'CAR', label: 'Car today' },
                      { value: 'BIKE', label: 'Two-wheeler today' },
                      { value: 'BMTC', label: 'BMTC today' },
                    ]}
                    value={schedule.mode}
                    onChange={(m) => {
                      if (demo) {
                        demoDispatch({
                          type: 'SET_DAY_OVERRIDE',
                          override: { dateIst: now.dateIst, direction, skipped: false, overrideMode: m },
                        });
                      } else {
                        void liveDayOverride({ dateIst: now.dateIst, direction, skipped: false, overrideMode: m });
                      }
                    }}
                  />
                  <Button title="Skip this direction today" variant="danger" onPress={() => onSkipToday(session?.id ?? null)} />
                </View>
              </View>
            ) : null}
          </Card>
        ) : null}

        {state.liveError && (demo || state.connection.loggedIn && profile) ? (
          <View style={{ marginTop: spacing.m }}>
            <ErrorState message={state.liveError} onRetry={() => void refreshLiveState()} retryLabel="Retry backend request" />
          </View>
        ) : null}
        {state.liveLoading ? <LoadingView label="Talking to the pilot backend…" /> : null}
      </ScreenScroll>

      <AlertsModal
        visible={alertsOpen}
        alerts={alerts}
        onClose={() => setAlertsOpen(false)}
        onAcknowledge={demo ? (id) => demoDispatch({ type: 'ACK_ALERT', alertId: id }) : undefined}
        onAcknowledgeAll={demo ? () => demoDispatch({ type: 'ACK_ALL_ALERTS' }) : undefined}
      />
    </View>
  );
}
