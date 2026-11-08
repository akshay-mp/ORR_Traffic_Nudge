/**
 * Settings: mode switching, pilot backend connection (URL + pilot login with
 * roster), quota/server info, trip recording, honest notification status,
 * demo reset, and server-side deletions with confirmation.
 *
 * Account deletion / data export controls are intentionally NOT shown: the
 * existing pilot backend has no such endpoints.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import type { PilotRosterEntry } from '../services/pilotApi';
import type { NativePushResult } from '../services/nativePushContract';
import { nativePushExplanation } from '../services/nativePushPresentation';
import { useApp } from '../state/appStore';
import { validateBaseUrl, validatePin } from '../validation/validate';
import { spacing, usePalette } from '../theme';
import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  Field,
  LoadingView,
  ScreenScroll,
  SectionHeader,
  SegmentedControl,
  ThemedText,
  ToggleRow,
} from '../components/ui';

export function SettingsScreen() {
  const p = usePalette();
  const {
    state,
    setMode,
    setBaseUrl,
    fetchRoster,
    login,
    logout,
    refreshLiveState,
    liveUpdateProfile,
    liveDeleteLocations,
    liveDeleteJourneys,
    nativePushStatus,
    nativePushBusy,
    enableNativePush,
    disableNativePush,
    refreshNativePushStatus,
    retryNativePushCleanup,
    demoDispatch,
  } = useApp();

  const demo = state.mode === 'DEMO';
  const [urlDraft, setUrlDraft] = useState(state.connection.baseUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [roster, setRoster] = useState<PilotRosterEntry[] | null>(null);
  const [selectedUser, setSelectedUser] = useState<PilotRosterEntry | null>(null);
  const [userIdDraft, setUserIdDraft] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'roster' | 'login' | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [pushActionError, setPushActionError] = useState<string | null>(null);

  const runPushAction = useCallback(async (action: () => Promise<NativePushResult>) => {
    setPushActionError(null);
    try {
      const result = await action();
      if (result.state === 'error') setPushActionError(nativePushExplanation(result));
    } catch (error) {
      setPushActionError(error instanceof Error ? error.message : 'Unable to confirm the push setting. Refresh status before retrying.');
    }
  }, []);

  const applyUrlAndFetchRoster = useCallback(async () => {
    const err = validateBaseUrl(urlDraft);
    setUrlError(err);
    if (err) return;
    setConnError(null);
    setBusy('roster');
    try {
      const resp = await fetchRoster(urlDraft.trim().replace(/\/+$/, ''));
      setBaseUrl(urlDraft.trim().replace(/\/+$/, ''));
      setRoster(resp.roster);
    } catch (e) {
      setRoster(null);
      setConnError(e instanceof Error ? e.message : 'Could not load the pilot roster.');
    } finally {
      setBusy(null);
    }
  }, [urlDraft, fetchRoster, setBaseUrl]);

  const doLogin = useCallback(async () => {
    const baseUrl = urlDraft.trim().replace(/\/+$/, '');
    const baseUrlError = validateBaseUrl(baseUrl);
    setUrlError(baseUrlError);
    if (baseUrlError) return;
    const user = selectedUser?.employeeCode ?? userIdDraft.trim();
    if (!user) {
      setConnError('Choose a pilot employee from the roster or type an employee code / user id.');
      return;
    }
    const pinErr = validatePin(pin);
    setPinError(pinErr);
    if (pinErr) return;
    setConnError(null);
    setBusy('login');
    try {
      await login(user, pin.trim(), baseUrl);
    } catch (e) {
      setConnError(e instanceof Error ? e.message : 'Login failed.');
    } finally {
      setBusy(null);
    }
  }, [selectedUser, userIdDraft, pin, login, urlDraft, state.connection.baseUrl]);

  const confirmDemoReset = useCallback(() => {
    Alert.alert(
      'Reset local demo data?',
      'This clears all demo trips, sessions, alerts, and plan edits stored on this device and restores the original fixtures. Your pilot backend data (if connected) is not touched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset demo',
          style: 'destructive',
          onPress: () => demoDispatch({ type: 'RESET_DEMO', nowIso: new Date().toISOString() }),
        },
      ]
    );
  }, [demoDispatch]);

  const confirmDeleteLocations = useCallback(() => {
    Alert.alert(
      'Delete saved locations on the server?',
      'This calls the pilot backend to delete your saved home/work locations and stop active sessions. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete locations', style: 'destructive', onPress: () => void liveDeleteLocations() },
      ]
    );
  }, [liveDeleteLocations]);

  const confirmDeleteJourneys = useCallback(() => {
    Alert.alert(
      'Delete journey history on the server?',
      'This calls the pilot backend to delete ALL of your personal journey records and alert history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete history', style: 'destructive', onPress: () => void liveDeleteJourneys() },
      ]
    );
  }, [liveDeleteJourneys]);

  const profile = demo ? state.demo.profile : state.live.profile;
  const telemetry = profile?.telemetryConsent ?? false;
  const quota = state.live.quota;

  return (
    <ScreenScroll>
      <SectionHeader label="Mode" />
      <Card>
        <SegmentedControl
          label="App mode"
          options={[
            { value: 'DEMO', label: 'Local demo' },
            { value: 'CONNECTED', label: 'Pilot backend' },
          ]}
          value={demo ? 'DEMO' : 'CONNECTED'}
          onChange={(v) => setMode(v)}
        />
        <ThemedText variant="muted" style={{ marginTop: spacing.s }}>
          {demo
            ? 'Local demo: fully offline synthetic data labeled DEMO on every screen. No backend, credentials, or provider keys needed.'
            : 'Pilot backend: connects to the ORR Pulse pilot server’s seeded employee roster and PINs — pilot-grade convenience auth, not production authentication.'}
        </ThemedText>
      </Card>

      <SectionHeader label="Pilot backend connection" />
      <Card>
        <Field
          label="Base URL (origin only)"
          value={urlDraft}
          onChangeText={setUrlDraft}
          error={urlError}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://10.0.2.2:3000"
          hint="Android emulator: http://10.0.2.2:3000 · Physical device on same Wi-Fi: http://<your-LAN-IP>:3000 (e.g. 192.168.1.20). Plain http is limited to localhost/private LAN."
        />
        <Button title="Save URL & load roster" variant="secondary" onPress={() => void applyUrlAndFetchRoster()} loading={busy === 'roster'} />
        {roster ? (
          <>
            <Divider />
            <ThemedText variant="muted">Pilot roster ({roster.length} employees). Select yours:</ThemedText>
            <View style={{ marginTop: spacing.s }}>
              {roster.map((r) => (
                <View
                  key={r.id}
                  style={{
                    paddingVertical: 6,
                    borderBottomWidth: 1,
                    borderBottomColor: p.border,
                    backgroundColor: selectedUser?.id === r.id ? p.primarySoft : 'transparent',
                    borderRadius: 8,
                    paddingHorizontal: 6,
                  }}
                >
                  <Button
                    title={selectedUser?.id === r.id ? `✓ ${r.employeeCode} — ${r.name}` : `${r.employeeCode} — ${r.name}`}
                    variant="ghost"
                    onPress={() => setSelectedUser(r)}
                  />
                  <Text style={{ color: p.inkMuted, fontSize: 12, paddingLeft: 6 }}>
                    {r.role} · default PIN {r.defaultPinHint} (pilot roster shares PIN hints)
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
        {state.connection.loggedIn ? (
          <>
            <Divider />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.s, flexWrap: 'wrap' }}>
              <Badge tone="live" label="LOGGED IN" />
              <ThemedText variant="muted">
                {state.live.profile?.name ?? 'Pilot employee'} ({state.live.profile?.employeeCode}) · {state.connection.baseUrl}
              </ThemedText>
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.s, marginTop: spacing.s, flexWrap: 'wrap' }}>
              <Button title="Refresh server state" variant="secondary" onPress={() => void refreshLiveState()} loading={state.liveLoading} />
              <Button title="Log out" variant="danger" onPress={() => void logout()} />
            </View>
          </>
        ) : (
          <>
            <Divider />
            {!roster ? (
              <Field
                label="Employee code or user id"
                value={userIdDraft}
                onChangeText={setUserIdDraft}
                autoCapitalize="characters"
                placeholder="PTP-01"
              />
            ) : null}
            <Field
              label="4-digit PIN"
              value={pin}
              onChangeText={setPin}
              error={pinError}
              keyboardType="number-pad"
              maxLength={4}
              secureTextEntry
            />
            <Button title="Log in to pilot backend" onPress={() => void doLogin()} loading={busy === 'login'} />
            <ThemedText variant="muted" style={{ marginTop: spacing.s }}>
              Your session token is stored in the device secure store (SecureStore). No token or PIN is ever built into the app.
            </ThemedText>
          </>
        )}
        {connError ? (
          <View style={{ marginTop: spacing.m }}>
            <ErrorState message={connError} onRetry={() => void applyUrlAndFetchRoster()} retryLabel="Retry connection" />
          </View>
        ) : null}
        {state.liveError ? (
          <View style={{ marginTop: spacing.m }}>
            <ErrorState message={state.liveError} onRetry={() => void refreshLiveState()} retryLabel="Retry" />
          </View>
        ) : null}
      </Card>

      {quota ? (
        <>
          <SectionHeader label="Backend status" />
          <Card>
            <ThemedText variant="muted">
              Server clock {state.live.serverClock?.timeWithSecIst ?? '—'} · quota {quota.requestsUsedToday}/{quota.dailyLimit} today
              {quota.lastErrorMessage ? ` · last provider error: ${quota.lastErrorMessage}` : ''}
            </ThemedText>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: spacing.s, flexWrap: 'wrap' }}>
              <Badge tone={quota.liveApiConfigured ? 'live' : 'neutral'} label={quota.liveApiConfigured ? 'LIVE provider configured' : 'LIVE provider NOT configured'} />
              <Badge tone={quota.lastProviderStatus === 'OK' ? 'ok' : quota.lastProviderStatus === 'UNCONFIGURED' ? 'neutral' : 'risk'} label={quota.lastProviderStatus} />
            </View>
          </Card>
        </>
      ) : null}

      <SectionHeader label="Trip recording" />
      <Card>
        <ToggleRow
          label={demo ? 'Record demo trips (this device)' : 'Record pilot trips (server)'}
          description="Trip recording is a separate control from notifications and connection. When off, “I’ve left” marks the session LEFT but creates no journey record."
          value={telemetry}
          onValueChange={(v) => {
            if (demo) {
              demoDispatch({ type: 'UPDATE_PROFILE', patch: { telemetryConsent: v } });
            } else {
              void liveUpdateProfile({ telemetryConsent: v });
            }
          }}
        />
      </Card>

      <SectionHeader label="Notifications" />
      <Card style={{ gap: spacing.s }}>
        <ThemedText>
          {demo
            ? 'Demo alerts remain local to this device. Native push requires a connected pilot account.'
            : state.connection.loggedIn
              ? `Pilot push consent: ${state.live.profile?.pushOptIn ? 'on' : 'off'}`
              : 'Sign in to the connected pilot account to manage native push.'}
        </ThemedText>
        {!demo && state.connection.loggedIn ? (
          <>
            <ThemedText variant="muted">
              Device permission: {nativePushStatus?.permission ?? 'not checked'} · This installation: {nativePushStatus?.registered ? 'registered' : nativePushStatus?.pendingCleanup ? 'cleanup pending' : 'not confirmed'} · Server transport: {nativePushStatus?.nativePushEnabled === null || nativePushStatus?.nativePushEnabled === undefined ? 'unavailable' : nativePushStatus.nativePushEnabled ? 'enabled' : 'disabled'}
            </ThemedText>
            <ThemedText variant="muted">{nativePushExplanation(nativePushStatus)}</ThemedText>
            <View style={{ flexDirection: 'row', gap: spacing.s, flexWrap: 'wrap' }}>
              {state.live.profile?.pushOptIn ? (
                <>
                  <Button
                    title="Retry device registration"
                    variant="secondary"
                    loading={nativePushBusy}
                    onPress={() => void runPushAction(enableNativePush)}
                  />
                  <Button
                    title="Turn off native push"
                    variant="danger"
                    loading={nativePushBusy}
                    onPress={() => void runPushAction(disableNativePush)}
                  />
                </>
              ) : (
                <Button
                  title="Enable native push"
                  loading={nativePushBusy}
                  onPress={() => void runPushAction(enableNativePush)}
                />
              )}
              {nativePushStatus?.pendingCleanup ? (
                <Button
                  title="Retry device cleanup"
                  variant="secondary"
                  loading={nativePushBusy}
                  onPress={() => void runPushAction(retryNativePushCleanup)}
                />
              ) : null}
              <Button
                title="Refresh push status"
                variant="ghost"
                onPress={() => void refreshNativePushStatus()}
              />
            </View>
            {pushActionError ? <ErrorState message={pushActionError} /> : null}
          </>
        ) : (
          <ThemedText variant="muted">
            In-app alerts still appear on Today. Native notification permission is never requested automatically.
          </ThemedText>
        )}
      </Card>

      <SectionHeader label="Demo data" />
      <Card>
        <ThemedText variant="muted" style={{ marginBottom: spacing.s }}>
          Reset restores the original demo fixtures (anchored to today’s IST date) and clears demo
          trips, sessions, alerts, and plan edits on this device only.
        </ThemedText>
        <Button title="Reset local demo data" variant="danger" onPress={confirmDemoReset} />
      </Card>

      {!demo && state.connection.loggedIn ? (
        <>
          <SectionHeader label="Server data deletion" />
          <Card style={{ gap: spacing.s }}>
            <ThemedText variant="muted">
              These call the pilot backend to permanently delete YOUR data. Each requires an explicit confirmation.
            </ThemedText>
            <Button title="Delete my saved locations (server)" variant="danger" onPress={confirmDeleteLocations} />
            <Button title="Delete my journey & alert history (server)" variant="danger" onPress={confirmDeleteJourneys} />
            <ThemedText variant="muted" style={{ fontSize: 12 }}>
              Account deletion and data export are not offered because the pilot backend has no such endpoints.
            </ThemedText>
          </Card>
        </>
      ) : null}

      {state.liveLoading ? <LoadingView label="Working…" /> : null}
    </ScreenScroll>
  );
}
