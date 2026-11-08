/** Departure recommendation card + alert row + mode banner. */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { CommuteAlert, DepartureOption } from '../types/shared';
import { spacing, usePalette } from '../theme';
import { Badge, Card, ThemedText } from './ui';
import { DepartureTimeline } from './Timeline';

export function OptionCard({
  option,
  selected,
  onSelect,
  selectDisabled,
}: {
  option: DepartureOption;
  selected: boolean;
  onSelect: () => void;
  selectDisabled?: boolean;
}) {
  const p = usePalette();
  return (
    <Card style={{ gap: spacing.s, borderColor: selected ? p.primary : p.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.s }}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {option.roles.map((role) => (
            <Badge key={role} tone={role === 'LEAVE_NOW' ? 'primary' : 'neutral'} label={roleLabel(role)} />
          ))}
        </View>
        {option.environment === 'DEMO' ? <Badge tone="demo" label="DEMO ESTIMATE" /> : <Badge tone="live" label="LIVE ESTIMATE" />}
      </View>
      <ThemedText variant="title">{option.title}</ThemedText>
      <ThemedText variant="muted">{option.whyRecommended}</ThemedText>
      <DepartureTimeline option={option} />
      {option.betaNotice ? (
        <Text style={{ color: p.risk, fontSize: 12 }}>{option.betaNotice}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          selected
            ? `Selected option departing ${option.departureTimeIst}`
            : `Watch this option departing ${option.departureTimeIst}`
        }
        accessibilityState={{ selected, disabled: Boolean(selectDisabled) }}
        disabled={selectDisabled}
        onPress={onSelect}
        style={({ pressed }) => ({
          marginTop: spacing.xs,
          minHeight: 48,
          borderRadius: 8,
          borderWidth: selected ? 0 : 1.5,
          borderColor: p.primary,
          backgroundColor: selected ? p.primary : 'transparent',
          opacity: selectDisabled ? 0.45 : pressed ? 0.75 : 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.l,
        })}
      >
        <Text style={{ color: selected ? p.onPrimary : p.primary, fontWeight: '700', fontSize: 15 }}>
          {selected ? 'Watching this option' : 'Watch this option'}
        </Text>
      </Pressable>
    </Card>
  );
}

export function roleLabel(role: string): string {
  switch (role) {
    case 'LEAVE_NOW':
      return 'LEAVE NOW';
    case 'SHORTEST_PREDICTED':
      return 'SHORTEST';
    case 'LATEST_FOR_DEADLINE':
      return 'LATEST FOR DEADLINE';
    default:
      return role;
  }
}

export function AlertRow({
  alert,
  onAcknowledge,
}: {
  alert: CommuteAlert;
  onAcknowledge?: () => void;
}) {
  const p = usePalette();
  const tone =
    alert.severity === 'CRITICAL' ? p.risk : alert.severity === 'WARNING' ? p.risk : p.primary;
  const bg = alert.severity === 'INFO' ? p.primarySoft : p.riskSoft;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        alert.acknowledged
          ? `${alert.title}. Acknowledged.`
          : `${alert.title}. Double-tap to acknowledge.`
      }
      onPress={onAcknowledge}
      disabled={!onAcknowledge || alert.acknowledged}
      style={{
        backgroundColor: bg,
        borderRadius: 12,
        padding: spacing.l,
        marginBottom: spacing.s,
        opacity: alert.acknowledged ? 0.6 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.s }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
        <Text style={{ color: p.ink, fontWeight: '700', fontSize: 15, flex: 1 }}>{alert.title}</Text>
      </View>
      <Text style={{ color: p.ink, fontSize: 14, marginTop: 4 }}>{alert.message}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        <Text style={{ color: p.inkMuted, fontSize: 12 }}>
          {alert.createdAtIst} · in-app only
        </Text>
        <Text style={{ color: alert.acknowledged ? p.inkMuted : p.primary, fontSize: 12, fontWeight: '600' }}>
          {alert.acknowledged ? 'Acknowledged' : 'Tap to acknowledge'}
        </Text>
      </View>
    </Pressable>
  );
}

export function ModeBanner({
  mode,
  dataEnvironment,
}: {
  mode: 'DEMO' | 'CONNECTED';
  dataEnvironment: 'DEMO' | 'LIVE';
}) {
  const p = usePalette();
  if (mode === 'DEMO') {
    return (
      <View
        accessibilityRole="text"
        accessibilityLabel="Demo mode banner. All data on this screen is labeled synthetic demo data stored on this device."
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.s,
          backgroundColor: p.demoBadgeBg,
          borderRadius: 10,
          paddingHorizontal: spacing.m,
          paddingVertical: spacing.s + 2,
          marginBottom: spacing.m,
        }}
      >
        <Badge tone="demo" label="DEMO" />
        <Text style={{ color: p.demoBadgeInk, fontSize: 12, flex: 1 }}>
          Local demo — synthetic labeled data on this device. Not live traffic.
        </Text>
      </View>
    );
  }
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Connected to pilot backend banner. Data source ${dataEnvironment}.`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.s,
        backgroundColor: dataEnvironment === 'LIVE' ? p.liveBadgeBg : p.demoBadgeBg,
        borderRadius: 10,
        paddingHorizontal: spacing.m,
        paddingVertical: spacing.s + 2,
        marginBottom: spacing.m,
      }}
    >
      <Badge tone={dataEnvironment === 'LIVE' ? 'live' : 'demo'} label={dataEnvironment === 'LIVE' ? 'LIVE DATA' : 'DEMO DATA'} />
      <Text style={{ color: dataEnvironment === 'LIVE' ? p.liveBadgeInk : p.demoBadgeInk, fontSize: 12, flex: 1 }}>
        {dataEnvironment === 'LIVE'
          ? 'Connected to the pilot backend with live provider estimates.'
          : 'Connected to the pilot backend; estimates come from its labeled demo engine.'}
      </Text>
    </View>
  );
}
