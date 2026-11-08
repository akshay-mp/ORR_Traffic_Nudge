/**
 * Plan: home/work place setup (search or manual coordinates), weekly inbound /
 * outbound schedules with validation, telemetry opt-in. Today-only overrides
 * live on the Today screen — this screen only edits the weekly plan.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import type { DirectionSchedule, LocationPoint } from '../types/shared';
import { useApp } from '../state/appStore';
import { searchDemoPlaces } from '../services/demoFixtures';
import { pilotApi } from '../services/pilotApi';
import {
  ScheduleDraft,
  ScheduleDraftErrors,
  scheduleDraftHasErrors,
  validateManualLocation,
  validateScheduleDraft,
} from '../validation/validate';
import {
  PlanFormSnapshot,
  PlanDirection,
  formIdentity,
  profileToFormSnapshot,
  syncFormToIdentity,
} from '../state/planForm';
import { spacing, usePalette } from '../theme';
import {
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  Field,
  LoadingView,
  ScreenScroll,
  SectionHeader,
  SegmentedControl,
  ThemedText,
  ToggleRow,
} from '../components/ui';
import { ModeBanner } from '../components/domain';

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const MODES = ['CAR', 'BIKE', 'BMTC'] as const;
type Mode = (typeof MODES)[number];

export function PlanScreen() {
  const p = usePalette();
  const { state, demoDispatch, liveUpdateProfile } = useApp();
  const demo = state.mode === 'DEMO';
  const profile = demo ? state.demo.profile : state.live.profile;

  // Form state is keyed to one data owner: (mode, origin, profile id). On any
  // identity change (mode switch, different backend, another user logging in)
  // drafts are re-initialized from the new profile; routine refreshes keep the
  // same identity and preserve unsaved edits.
  const identity = formIdentity(
    demo ? 'DEMO' : 'CONNECTED',
    state.connection.baseUrl,
    profile
  );
  const [form, setForm] = useState<{ identity: string; snapshot: PlanFormSnapshot }>(() => ({
    identity,
    snapshot: profileToFormSnapshot(profile, state.demo.profile.schedules),
  }));
  const syncedForm = syncFormToIdentity(form, identity, profile, state.demo.profile.schedules);
  if (syncedForm !== form) {
    setForm(syncedForm);
  }
  const { drafts, enabled: enabledDraft, modes: modeDraft } = syncedForm.snapshot;
  const setDraft = useCallback(
    (dir: PlanDirection, patch: Partial<ScheduleDraft>) =>
      setForm((prev) => ({
        identity: prev.identity,
        snapshot: {
          ...prev.snapshot,
          drafts: { ...prev.snapshot.drafts, [dir]: { ...prev.snapshot.drafts[dir], ...patch } },
        },
      })),
    []
  );
  const setEnabled = useCallback(
    (dir: PlanDirection, v: boolean) =>
      setForm((prev) => ({
        identity: prev.identity,
        snapshot: {
          ...prev.snapshot,
          enabled: { ...prev.snapshot.enabled, [dir]: v },
        },
      })),
    []
  );
  const setModeFor = useCallback(
    (dir: PlanDirection, v: Mode) =>
      setForm((prev) => ({
        identity: prev.identity,
        snapshot: {
          ...prev.snapshot,
          modes: { ...prev.snapshot.modes, [dir]: v },
        },
      })),
    []
  );

  const [homeQuery, setHomeQuery] = useState('');
  const [homeResults, setHomeResults] = useState<LocationPoint[] | null>(null);
  const [workQuery, setWorkQuery] = useState('');
  const [workResults, setWorkResults] = useState<LocationPoint[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [manualFor, setManualFor] = useState<'home' | 'work' | null>(null);
  const [manualLabel, setManualLabel] = useState('');
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [manualErrors, setManualErrors] = useState<{ label?: string; lat?: string; lng?: string }>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const errors: Record<'HOME_TO_WORK' | 'WORK_TO_HOME', ScheduleDraftErrors> = useMemo(
    () => ({
      HOME_TO_WORK: validateScheduleDraft(drafts.HOME_TO_WORK),
      WORK_TO_HOME: validateScheduleDraft(drafts.WORK_TO_HOME),
    }),
    [drafts]
  );
  const hasErrors = scheduleDraftHasErrors(errors.HOME_TO_WORK) || scheduleDraftHasErrors(errors.WORK_TO_HOME);

  const searchPlaces = useCallback(
    async (target: 'home' | 'work') => {
      const query = target === 'home' ? homeQuery : workQuery;
      setSearching(true);
      setSearchError(null);
      try {
        if (demo) {
          const places = searchDemoPlaces(query);
          if (target === 'home') setHomeResults(places);
          else setWorkResults(places);
        } else {
          if (!state.connection.token) {
            setSearchError('Log in to the pilot backend in Settings before searching places.');
            return;
          }
          // Connected place search uses the backend's labeled DEMO presets unless
          // LIVE is configured and selected; backend decides what it can serve.
          const env = state.liveDataEnvironment;
          const resp = await pilotApi.searchPlaces(
            state.connection.baseUrl,
            state.connection.token,
            query,
            env
          );
          if (target === 'home') setHomeResults(resp.places);
          else setWorkResults(resp.places);
        }
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : 'Place search failed.');
      } finally {
        setSearching(false);
      }
    },
    [demo, homeQuery, workQuery, state.connection.baseUrl, state.connection.token, state.liveDataEnvironment]
  );

  const applyPlace = useCallback(
    (target: 'home' | 'work', place: LocationPoint) => {
      const confirmed: LocationPoint = { ...place, confirmedAt: new Date().toISOString() };
      if (demo) {
        demoDispatch({
          type: 'UPDATE_PROFILE',
          patch: target === 'home' ? { homeLocation: confirmed } : { workLocation: confirmed },
        });
      } else if (state.connection.token) {
        void liveUpdateProfile(target === 'home' ? { homeLocation: confirmed } : { workLocation: confirmed });
      }
      if (target === 'home') setHomeResults(null);
      else setWorkResults(null);
    },
    [demo, demoDispatch, liveUpdateProfile, state.connection.token]
  );

  const submitManual = useCallback(() => {
    const e = validateManualLocation({ label: manualLabel, lat: manualLat, lng: manualLng });
    setManualErrors(e);
    if (e.label || e.lat || e.lng) return;
    const place: LocationPoint = {
      label: manualLabel.trim(),
      address: `${manualLabel.trim()} (manual coordinates)`,
      lat: parseFloat(manualLat.trim()),
      lng: parseFloat(manualLng.trim()),
      confirmedAt: new Date().toISOString(),
    };
    if (manualFor) applyPlace(manualFor, place);
    setManualFor(null);
    setManualLabel('');
    setManualLat('');
    setManualLng('');
  }, [manualLabel, manualLat, manualLng, manualFor, applyPlace]);

  const savePlan = useCallback(async () => {
    if (hasErrors) {
      setSaveMsg('Fix the highlighted fields before saving.');
      return;
    }
    const build = (dir: PlanDirection): DirectionSchedule => {
      const d = drafts[dir];
      return {
        direction: dir,
        enabled: enabledDraft[dir],
        mode: modeDraft[dir],
        days: d.days as DirectionSchedule['days'],
        windowStart: d.windowStart.trim(),
        windowEnd: d.windowEnd.trim(),
        arrivalDeadline: d.arrivalDeadline.trim() ? d.arrivalDeadline.trim() : null,
        preferredDeparture: d.preferredDeparture.trim(),
        safetyBufferMinutes: parseInt(d.safetyBufferMinutes, 10),
        leadTimeMinutes: profile?.schedules[dir].leadTimeMinutes ?? 15,
        alertThresholdMinutes: profile?.schedules[dir].alertThresholdMinutes ?? 5,
      };
    };
    const schedules = { HOME_TO_WORK: build('HOME_TO_WORK'), WORK_TO_HOME: build('WORK_TO_HOME') };
    if (demo) {
      demoDispatch({ type: 'UPDATE_PROFILE', patch: { schedules } });
      setSaveMsg('Weekly plan saved to this device (demo).');
    } else {
      try {
        await liveUpdateProfile({ schedules });
        setSaveMsg('Weekly plan saved to the pilot backend.');
      } catch (error) {
        setSaveMsg(`Unable to confirm the weekly plan save. Refresh the plan before retrying: ${error instanceof Error ? error.message : 'Pilot request failed.'}`);
      }
    }
  }, [hasErrors, drafts, enabledDraft, modeDraft, profile, demo, demoDispatch, liveUpdateProfile]);

  const telemetry = profile?.telemetryConsent ?? false;

  const setTelemetry = useCallback(
    (v: boolean) => {
      if (demo) {
        demoDispatch({ type: 'UPDATE_PROFILE', patch: { telemetryConsent: v } });
      } else {
        void liveUpdateProfile({ telemetryConsent: v });
      }
    },
    [demo, demoDispatch, liveUpdateProfile]
  );

  if (!profile && !demo) {
    return (
      <ScreenScroll>
        <ModeBanner mode="CONNECTED" dataEnvironment={state.liveDataEnvironment} />
        <EmptyState
          icon="cloud-offline-outline"
          title="No pilot profile loaded"
          message="Connect and log in via Settings to edit your server-side plan, or switch back to demo mode."
        />
      </ScreenScroll>
    );
  }

  const renderScheduleEditor = (dir: PlanDirection) => {
    const d = drafts[dir];
    const e = errors[dir];
    const set = (patch: Partial<ScheduleDraft>) => setDraft(dir, patch);
    return (
      <Card key={dir} style={{ marginTop: spacing.m }}>
        <ThemedText variant="title">
          {dir === 'HOME_TO_WORK' ? 'To work (inbound)' : 'To home (outbound)'}
        </ThemedText>
        <View style={{ marginTop: spacing.s }}>
          <ToggleRow
            label="Enabled on selected days"
            value={enabledDraft[dir]}
            onValueChange={(v) => setEnabled(dir, v)}
          />
        </View>
        <View style={{ marginVertical: spacing.s }}>
          <ThemedText variant="muted">Transport mode</ThemedText>
          <SegmentedControl
            label={`${dir} transport mode`}
            options={MODES.map((m) => ({ value: m, label: m === 'BIKE' ? 'Two-wheeler' : m === 'CAR' ? 'Car' : 'BMTC bus' }))}
            value={modeDraft[dir]}
            onChange={(v) => setModeFor(dir, v)}
          />
        </View>
        <ThemedText variant="muted">Workdays</ThemedText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s, marginTop: spacing.xs, marginBottom: spacing.m }}>
          {DAY_LABELS.map((day) => (
            <Chip
              key={day}
              label={day}
              selected={d.days.includes(day)}
              onPress={() =>
                set({ days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] })
              }
            />
          ))}
        </View>
        {e.days ? <Text style={{ color: p.danger, fontSize: 12, marginBottom: spacing.s }}>{e.days}</Text> : null}
        <View style={{ flexDirection: 'row', gap: spacing.m }}>
          <View style={{ flex: 1 }}>
            <Field label="Window start (HH:mm)" value={d.windowStart} onChangeText={(v) => set({ windowStart: v })} error={e.windowStart} keyboardType="numbers-and-punctuation" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Window end (HH:mm)" value={d.windowEnd} onChangeText={(v) => set({ windowEnd: v })} error={e.windowEnd} keyboardType="numbers-and-punctuation" />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.m }}>
          <View style={{ flex: 1 }}>
            <Field label="Preferred departure (HH:mm)" value={d.preferredDeparture} onChangeText={(v) => set({ preferredDeparture: v })} error={e.preferredDeparture} keyboardType="numbers-and-punctuation" />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="Arrival deadline (optional)"
              value={d.arrivalDeadline}
              onChangeText={(v) => set({ arrivalDeadline: v })}
              error={e.arrivalDeadline}
              hint="Leave empty for no deadline"
              keyboardType="numbers-and-punctuation"
            />
          </View>
        </View>
        <Field
          label="Safety buffer minutes (kept separate from estimates)"
          value={d.safetyBufferMinutes}
          onChangeText={(v) => set({ safetyBufferMinutes: v })}
          error={e.safetyBufferMinutes}
          keyboardType="number-pad"
          hint="Your own buffer added on top of any predicted arrival"
        />
      </Card>
    );
  };

  return (
    <ScreenScroll>
      <ModeBanner mode={demo ? 'DEMO' : 'CONNECTED'} dataEnvironment={state.liveDataEnvironment} />

      <SectionHeader label="Home" />
      <Card>
        {profile?.homeLocation ? (
          <>
            <ThemedText>{profile.homeLocation.label}</ThemedText>
            <ThemedText variant="muted" style={{ marginTop: 2 }}>
              {profile.homeLocation.lat.toFixed(4)}, {profile.homeLocation.lng.toFixed(4)} · confirmed
              {profile.homeLocation.placeId ? ' from search' : ' manually'}
            </ThemedText>
          </>
        ) : (
          <ThemedText variant="muted">Home is not set. Recommendations stay disabled until you set one.</ThemedText>
        )}
        <Divider />
        <Field
          label="Search places"
          value={homeQuery}
          onChangeText={setHomeQuery}
          placeholder="e.g. HSR Layout"
          hint={demo ? 'Searches the labeled local demo list.' : 'Searches the pilot backend place service.'}
          onSubmitEditing={() => void searchPlaces('home')}
        />
        <View style={{ flexDirection: 'row', gap: spacing.s, flexWrap: 'wrap' }}>
          <Button title="Search home" variant="secondary" onPress={() => void searchPlaces('home')} loading={searching} />
          <Button
            title="Enter coordinates manually"
            variant="ghost"
            onPress={() => {
              setManualFor('home');
              setManualErrors({});
            }}
          />
        </View>
        {searchError ? <ErrorState message={searchError} /> : null}
        {homeResults
          ? homeResults.map((place) => (
              <Pressable
                key={place.placeId ?? place.label}
                accessibilityRole="button"
                accessibilityLabel={`Set home to ${place.label}`}
                onPress={() => applyPlace('home', place)}
                style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: p.border }}
              >
                <Text style={{ color: p.ink, fontWeight: '600' }}>{place.label}</Text>
                <Text style={{ color: p.inkMuted, fontSize: 12 }}>{place.address}</Text>
              </Pressable>
            ))
          : null}
      </Card>

      <SectionHeader label="Work" />
      <Card>
        <ThemedText>{profile?.workLocation.label ?? 'Work not set'}</ThemedText>
        <ThemedText variant="muted" style={{ marginTop: 2, marginBottom: spacing.s }}>
          {profile ? `${profile.workLocation.lat.toFixed(4)}, ${profile.workLocation.lng.toFixed(4)}` : ''}
        </ThemedText>
        <Field label="Search places" value={workQuery} onChangeText={setWorkQuery} placeholder="e.g. Prestige Tech Park" onSubmitEditing={() => void searchPlaces('work')} />
        <View style={{ flexDirection: 'row', gap: spacing.s, flexWrap: 'wrap' }}>
          <Button title="Search work" variant="secondary" onPress={() => void searchPlaces('work')} loading={searching} />
          <Button
            title="Enter coordinates manually"
            variant="ghost"
            onPress={() => {
              setManualFor('work');
              setManualErrors({});
            }}
          />
        </View>
        {workResults
          ? workResults.map((place) => (
              <Pressable
                key={place.placeId ?? place.label}
                accessibilityRole="button"
                accessibilityLabel={`Set work to ${place.label}`}
                onPress={() => applyPlace('work', place)}
                style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: p.border }}
              >
                <Text style={{ color: p.ink, fontWeight: '600' }}>{place.label}</Text>
                <Text style={{ color: p.inkMuted, fontSize: 12 }}>{place.address}</Text>
              </Pressable>
            ))
          : null}
      </Card>

      {manualFor ? (
        <Card style={{ marginTop: spacing.m }}>
          <ThemedText variant="title">Manual entry — {manualFor}</ThemedText>
          <ThemedText variant="muted" style={{ marginTop: 2, marginBottom: spacing.s }}>
            Coordinates are used exactly as entered; nothing is geocoded or guessed from the label.
          </ThemedText>
          <Field label="Label" value={manualLabel} onChangeText={setManualLabel} error={manualErrors.label} placeholder="e.g. Home – HSR Layout" />
          <View style={{ flexDirection: 'row', gap: spacing.m }}>
            <View style={{ flex: 1 }}>
              <Field label="Latitude" value={manualLat} onChangeText={setManualLat} error={manualErrors.lat} keyboardType="numbers-and-punctuation" placeholder="12.9116" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Longitude" value={manualLng} onChangeText={setManualLng} error={manualErrors.lng} keyboardType="numbers-and-punctuation" placeholder="77.6474" />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: spacing.s }}>
            <Button title="Confirm place" onPress={submitManual} />
            <Button title="Cancel" variant="ghost" onPress={() => setManualFor(null)} />
          </View>
        </Card>
      ) : null}

      <SectionHeader label="Weekly schedules (IST)" />
      <ThemedText variant="muted" style={{ marginBottom: spacing.s }}>
        These apply every week. To change just today, use Today’s “today only” controls instead.
      </ThemedText>
      {renderScheduleEditor('HOME_TO_WORK')}
      {renderScheduleEditor('WORK_TO_HOME')}
      <View style={{ flexDirection: 'row', gap: spacing.s, marginTop: spacing.m, alignItems: 'center' }}>
        <Button title="Save weekly plan" onPress={savePlan} disabled={hasErrors} />
        {saveMsg ? (
          <Text style={{ color: hasErrors || saveMsg.startsWith('Could not save') ? p.danger : p.ok, fontSize: 13, flex: 1 }}>{saveMsg}</Text>
        ) : (
          hasErrors && <Badge tone="risk" label="Fix highlighted fields to save" />
        )}
      </View>

      <SectionHeader label="Trip recording" />
      <Card>
        <ToggleRow
          label="Record trips"
          description={
            demo
              ? 'Demo telemetry, stored only on this device. Controls whether “I’ve left” creates a correctable journey record.'
              : 'Pilot telemetry on the backend. Controls whether “I’ve left” creates a journey record used for pilot accuracy metrics.'
          }
          value={telemetry}
          onValueChange={setTelemetry}
        />
      </Card>
    </ScreenScroll>
  );
}
