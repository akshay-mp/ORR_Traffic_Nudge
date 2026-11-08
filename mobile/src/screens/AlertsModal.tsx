/** In-app alerts list (the bell in Today). Explicitly in-app only; no push claims. */
import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CommuteAlert } from '../types/shared';
import { spacing, usePalette } from '../theme';
import { AlertRow } from '../components/domain';
import { Button, EmptyState, IconButton } from '../components/ui';

export function AlertsModal({
  visible,
  alerts,
  onClose,
  onAcknowledge,
  onAcknowledgeAll,
}: {
  visible: boolean;
  alerts: CommuteAlert[];
  onClose: () => void;
  /** Acknowledgement is local-only (demo); live alerts come from the server as-is. */
  onAcknowledge?: (alertId: string) => void;
  onAcknowledgeAll?: () => void;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const unacknowledged = alerts.filter((a) => !a.acknowledged).length;

  return (
    <Modal visible={visible} animationType="slide" accessibilityViewIsModal onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: p.background, paddingTop: insets.top }}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Alerts (in-app)</Text>
          <IconButton name="close" label="Close alerts" onPress={onClose} />
        </View>
        <Text style={{ color: p.inkMuted, fontSize: 13, paddingHorizontal: spacing.l }}>
          Alerts appear inside the app only. Remote push notifications are a later milestone — delivery
          outside the app is not implemented yet.
        </Text>
        <ScrollView contentContainerStyle={{ padding: spacing.l, paddingBottom: insets.bottom + spacing.xxl }}>
          {alerts.length === 0 ? (
            <EmptyState
              icon="notifications-off-outline"
              title="No alerts yet"
              message="Start monitoring in Today to receive departure reminders and ETA change alerts while the app is open."
            />
          ) : (
            <>
              {unacknowledged > 0 && onAcknowledgeAll ? (
                <View style={{ marginBottom: spacing.m }}>
                  <Button title={`Acknowledge all (${unacknowledged})`} variant="secondary" onPress={onAcknowledgeAll} />
                </View>
              ) : null}
              {alerts.map((a) => (
                <AlertRow key={a.id} alert={a} onAcknowledge={onAcknowledge ? () => onAcknowledge(a.id) : undefined} />
              ))}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
  },
  headerTitle: { fontSize: 18, fontWeight: '800' },
});
