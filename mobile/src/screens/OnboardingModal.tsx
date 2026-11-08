/** First-launch welcome for DEMO mode: brief, user-facing, explicit opt-in. */
import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/appStore';
import { spacing, usePalette } from '../theme';
import { Badge, Button, ToggleRow } from '../components/ui';

export function OnboardingModal({ visible }: { visible: boolean }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { state, demoDispatch } = useApp();
  // Opt-in is explicit: starts off unless already enabled.
  const [telemetry, setTelemetry] = useState(false);

  if (!visible) return null;

  return (
    <Modal visible animationType="fade" transparent={false} accessibilityViewIsModal>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.background }}
        contentContainerStyle={{
          padding: spacing.xl,
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.xxl,
        }}
      >
        <View style={{ alignItems: 'flex-start', gap: spacing.m }}>
          <Badge tone="demo" label="DEMO" />
          <Text style={[styles.title, { color: p.ink }]}>Welcome to ORR Pulse</Text>
          <Text style={{ color: p.ink, fontSize: 16, lineHeight: 24 }}>
            Try a sample commute. Demo times are illustrative, not live traffic.
          </Text>
          <View style={{ gap: spacing.s }}>
            <Text style={{ color: p.inkMuted, fontSize: 14 }}>• See when to leave for the ORR</Text>
            <Text style={{ color: p.inkMuted, fontSize: 14 }}>• Skip or change just today’s trip</Text>
            <Text style={{ color: p.inkMuted, fontSize: 14 }}>• Review and correct your trips</Text>
          </View>
          <View style={styles.card}>
            <ToggleRow
              label="Record sample trips on this device (optional)"
              description="Kept on this device only. You can change this anytime in Settings."
              value={telemetry}
              onValueChange={setTelemetry}
            />
          </View>
          <Button
            title="Get started"
            onPress={() => {
              if (telemetry !== state.demo.profile.telemetryConsent) {
                demoDispatch({
                  type: 'UPDATE_PROFILE',
                  patch: { telemetryConsent: telemetry },
                });
              }
              demoDispatch({ type: 'ONBOARDING_ACKNOWLEDGED' });
            }}
          />
        </View>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '800' },
  card: { alignSelf: 'stretch' },
});
