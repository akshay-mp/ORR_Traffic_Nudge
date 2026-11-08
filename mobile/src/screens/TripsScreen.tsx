/**
 * Trips: journey history with per-trip detail, immutable original estimates on
 * display, and manual time corrections that never alter the original snapshots.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { JourneyRecord } from '../types/shared';
import { useApp } from '../state/appStore';
import { isValidHhmm, validateJourneyChronology } from '../validation/validate';
import { spacing, usePalette } from '../theme';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  LoadingView,
  ScreenScroll,
  SegmentedControl,
  ThemedText,
  ToggleRow,
} from '../components/ui';
import { ModeBanner } from '../components/domain';

function fmtDelta(min: number | null): string {
  if (min === null) return '—';
  return min > 0 ? `+${min} min` : `${min} min`;
}

export function TripsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { state, demoDispatch, liveCorrectJourney } = useApp();
  const demo = state.mode === 'DEMO';
  const journeys = demo ? state.demo.journeys : state.live.journeys;

  const [openJourneyId, setOpenJourneyId] = useState<string | null>(null);
  const [depInput, setDepInput] = useState('');
  const [arrInput, setArrInput] = useState('');
  const [changed, setChanged] = useState(false);
  const [useful, setUseful] = useState<'YES' | 'SOMEWHAT' | 'NO' | null>(null);
  const [note, setNote] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...journeys].sort((a, b) => (a.dateIst < b.dateIst ? 1 : a.dateIst > b.dateIst ? -1 : 0)),
    [journeys]
  );

  // Detail view is derived from the store by id so it always reflects the
  // latest saved correction (arrival no longer "missing" after saving).
  const openJourney = useMemo(
    () => (openJourneyId ? journeys.find((j) => j.id === openJourneyId) ?? null : null),
    [openJourneyId, journeys]
  );

  const openDetail = useCallback((j: JourneyRecord) => {
    setOpenJourneyId(j.id);
    setDepInput(j.actualDepartureTimeIst);
    setArrInput(j.actualArrivalTimeIst ?? '');
    setChanged(j.changedPlanOrRoute);
    setUseful(j.usefulRating ?? null);
    setNote(j.feedbackNote ?? '');
    setEditError(null);
    setSaveMsg(null);
  }, []);

  const saveCorrection = useCallback(async () => {
    if (!openJourney) return;
    if (!isValidHhmm(depInput.trim())) {
      setEditError('Departure must be a valid 24-hour time like 08:31.');
      return;
    }
    if (arrInput.trim() && !isValidHhmm(arrInput.trim())) {
      setEditError('Arrival must be a valid 24-hour time like 09:05, or empty to keep it unset.');
      return;
    }
    const chrono = validateJourneyChronology(depInput.trim(), arrInput.trim() || null);
    if (chrono) {
      setEditError(chrono);
      return;
    }
    setEditError(null);
    if (demo) {
      demoDispatch({
        type: 'CORRECT_JOURNEY',
        nowIso: new Date().toISOString(),
        journeyId: openJourney.id,
        actualDepartureHhmm: depInput.trim(),
        ...(arrInput.trim() ? { actualArrivalHhmm: arrInput.trim() } : {}),
        changedPlanOrRoute: changed,
        usefulRating: useful,
        feedbackNote: note,
      });
      setSaveMsg('Corrected on this device. Original estimates untouched.');
    } else {
      try {
        await liveCorrectJourney(openJourney.id, {
          actualDepartureHhmm: depInput.trim(),
          ...(arrInput.trim() ? { actualArrivalHhmm: arrInput.trim() } : {}),
          changedPlanOrRoute: changed,
          usefulRating: useful,
          feedbackNote: note,
        });
        setSaveMsg('Correction sent to the pilot backend. Original estimates untouched.');
      } catch (error) {
        setSaveMsg(`Unable to confirm the trip correction. Refresh trip history before retrying: ${error instanceof Error ? error.message : 'Pilot request failed.'}`);
      }
    }
  }, [openJourney, depInput, arrInput, changed, useful, note, demo, demoDispatch, liveCorrectJourney]);

  return (
    <ScreenScroll>
      <ModeBanner mode={demo ? 'DEMO' : 'CONNECTED'} dataEnvironment={state.liveDataEnvironment} />
      <ThemedText variant="title" style={{ marginBottom: spacing.m }}>
        Trip history
      </ThemedText>
      {sorted.length === 0 ? (
        <EmptyState
          icon="bus-outline"
          title="No trips recorded yet"
          message={
            demo
              ? 'Press “I’ve left” on Today (with demo trip recording on) to create a journey you can correct here.'
              : 'Trips appear after you log “I’ve left” on the backend with trip recording enabled.'
          }
        />
      ) : (
        sorted.map((j) => (
          <Pressable
            key={j.id}
            accessibilityRole="button"
            accessibilityLabel={`Trip on ${j.dateIst}, ${j.direction === 'HOME_TO_WORK' ? 'to work' : 'to home'}, departed ${j.actualDepartureTimeIst}${j.actualArrivalTimeIst ? `, arrived ${j.actualArrivalTimeIst}` : ', arrival missing'}. Opens details.`}
            onPress={() => openDetail(j)}
            style={{ marginBottom: spacing.s }}
          >
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <ThemedText variant="title">
                  {j.dateIst} · {j.direction === 'HOME_TO_WORK' ? 'To work' : 'To home'}
                </ThemedText>
                {j.environment === 'DEMO' ? <Badge tone="demo" label="DEMO" /> : <Badge tone="live" label="LIVE" />}
              </View>
              <ThemedText variant="muted" style={{ marginTop: 2 }}>
                {j.originLabel} → {j.destinationLabel} · {j.transportMode}
              </ThemedText>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: spacing.s }}>
                <Badge tone="neutral" label={`Departed ${j.actualDepartureTimeIst}`} />
                <Badge tone={j.actualArrivalTimeIst ? 'neutral' : 'risk'} label={j.actualArrivalTimeIst ? `Arrived ${j.actualArrivalTimeIst}` : 'Arrival missing'} />
                <Badge tone={j.metrics.isCompleted && (j.metrics.lateOver5MinVsDeparture ?? false) ? 'risk' : 'ok'} label={`vs departure ETA ${fmtDelta(j.metrics.errorVsDepartureMin)}`} />
                {j.correctionHistoryCount > 0 ? <Badge tone="neutral" label={`Corrected ×${j.correctionHistoryCount}`} /> : null}
                {j.changedPlanOrRoute ? <Badge tone="neutral" label="Changed plan/route" /> : null}
              </View>
            </Card>
          </Pressable>
        ))
      )}

      <Modal visible={openJourney !== null} animationType="slide" onRequestClose={() => setOpenJourneyId(null)} accessibilityViewIsModal>
        <View style={{ flex: 1, backgroundColor: p.background, paddingTop: insets.top }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.m }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: p.ink }}>Trip detail</Text>
            <IconButton name="close" label="Close trip detail" onPress={() => setOpenJourneyId(null)} />
          </View>
          {openJourney ? (
            <ScrollView contentContainerStyle={{ padding: spacing.l, paddingBottom: insets.bottom + spacing.xxl }}>
              <ThemedText variant="title">
                {openJourney.dateIst} · {openJourney.direction === 'HOME_TO_WORK' ? 'To work' : 'To home'} · {openJourney.transportMode}
              </ThemedText>
              <ThemedText variant="muted" style={{ marginTop: 2, marginBottom: spacing.m }}>
                {openJourney.originLabel} → {openJourney.destinationLabel}
              </ThemedText>

              <Card style={{ marginBottom: spacing.m }}>
                <ThemedText variant="title" style={{ fontSize: 15 }}>
                  Original estimates (immutable)
                </ThemedText>
                <ThemedText variant="muted" style={{ marginTop: 4 }}>
                  Selected: depart {openJourney.selectedEstimate?.departureTimeIst}, predicted {openJourney.selectedEstimate?.predictedDurationMin} min → arrive {openJourney.selectedEstimate?.predictedArrivalTimeIst} ({openJourney.selectedEstimate?.dataSource})
                </ThemedText>
                <ThemedText variant="muted" style={{ marginTop: 2 }}>
                  At departure: depart {openJourney.departureEstimate.departureTimeIst}, predicted {openJourney.departureEstimate.predictedDurationMin} min → arrive {openJourney.departureEstimate.predictedArrivalTimeIst} ({openJourney.departureEstimate.issuedAtIst})
                </ThemedText>
                <ThemedText variant="muted" style={{ marginTop: spacing.s }}>
                  These snapshots never change, even after corrections — they are what was communicated at the time.
                </ThemedText>
              </Card>

              <Card style={{ marginBottom: spacing.m }}>
                <ThemedText variant="title" style={{ fontSize: 15 }}>
                  Correct actual times
                </ThemedText>
                <Field label="Actual departure (HH:mm)" value={depInput} onChangeText={setDepInput} keyboardType="numbers-and-punctuation" error={editError && editError.includes('eparture') ? editError : null} />
                <Field
                  label={openJourney.actualArrivalTimeIst ? 'Actual arrival (HH:mm)' : 'Actual arrival (HH:mm — still missing)'}
                  value={arrInput}
                  onChangeText={setArrInput}
                  keyboardType="numbers-and-punctuation"
                  hint="Empty keeps arrival unset"
                  error={editError && editError.includes('rrival') ? editError : null}
                />
                <ToggleRow label="I changed my plan or route" value={changed} onValueChange={setChanged} />
                <ThemedText variant="muted" style={{ marginVertical: spacing.s }}>
                  Was the recommendation useful?
                </ThemedText>
                <SegmentedControl
                  label="Useful rating"
                  options={[
                    { value: 'YES', label: 'Yes' },
                    { value: 'SOMEWHAT', label: 'Somewhat' },
                    { value: 'NO', label: 'No' },
                    { value: 'CLEAR', label: 'Clear' },
                  ]}
                  value={useful ?? 'CLEAR'}
                  onChange={(v) => setUseful(v === 'CLEAR' ? null : v)}
                />
                <Field label="Feedback note (optional)" value={note} onChangeText={setNote} multiline placeholder="What happened on the road?" />
                <View style={{ flexDirection: 'row', gap: spacing.s, alignItems: 'center' }}>
                  <Button title={demo ? 'Save correction (demo)' : 'Save correction'} onPress={saveCorrection} />
                  {saveMsg ? <Text style={{ color: saveMsg.startsWith('Could not save') ? p.danger : p.ok, fontSize: 13, flex: 1 }}>{saveMsg}</Text> : null}
                </View>
              </Card>

              {openJourney.metrics.isCompleted ? (
                <Card>
                  <ThemedText variant="title" style={{ fontSize: 15 }}>
                    Accuracy vs communicated ETAs
                  </ThemedText>
                  <ThemedText variant="muted" style={{ marginTop: 4 }}>
                    Actual duration {openJourney.metrics.actualDurationMin} min · vs departure ETA {fmtDelta(openJourney.metrics.errorVsDepartureMin)}
                    {openJourney.metrics.errorVsSelectedMin !== null ? ` · vs selected ETA ${fmtDelta(openJourney.metrics.errorVsSelectedMin)}` : ''}
                  </ThemedText>
                </Card>
              ) : null}
            </ScrollView>
          ) : null}
          {state.liveLoading ? <LoadingView label="Saving correction…" /> : null}
        </View>
      </Modal>
    </ScreenScroll>
  );
}
