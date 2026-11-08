/** Vertical departure → travel → arrival timeline with optional deadline marker. */
import React from 'react';
import { Text, View } from 'react-native';
import type { DepartureOption } from '../types/shared';
import { spacing, usePalette } from '../theme';
import { Badge, ThemedText } from './ui';

function modeIcon(mode: string): string {
  if (mode === 'BIKE') return '🛵';
  if (mode === 'BMTC') return '🚌';
  return '🚗';
}

export function DepartureTimeline({ option }: { option: DepartureOption }) {
  const p = usePalette();
  const deadline = option.deadlineRelation;

  const deadlineSummary = deadline.hasDeadline
    ? deadline.meetsRaw
      ? `Deadline ${deadline.deadlineTimeIst} — ${deadline.summaryText}`
      : `Deadline ${deadline.deadlineTimeIst} missed — ${deadline.summaryText}`
    : deadline.summaryText;

  return (
    <View
      accessibilityLabel={`Departure timeline. Depart ${option.departureTimeIst}. ${option.predictedDurationMin} minute predicted travel by ${option.transportMode}. Arrive ${option.predictedArrivalTimeIst}. ${deadlineSummary}`}
      style={{ gap: 0 }}
    >
      <TimelineRow
        time={option.departureTimeIst}
        title="Depart"
        subtitle={`${modeIcon(option.transportMode)} ${option.transportMode}${option.estimateBasis === 'CURRENT_TRAFFIC' ? ' · current traffic' : option.estimateBasis === 'TIMETABLE' ? ' · timetable' : ' · forecast'}`}
        dotColor={p.primary}
        lineToNext
      />
      <TimelineRow
        time={`~${option.predictedDurationMin} min`}
        title="Travel"
        subtitle={option.corridorSummary}
        dotColor={p.inkMuted}
        lineToNext
        compact
      />
      <TimelineRow
        time={option.predictedArrivalTimeIst}
        title="Arrive"
        subtitle={
          option.userSafetyBufferMin > 0
            ? `With your +${option.userSafetyBufferMin} min safety buffer: ${option.bufferedArrivalTimeIst}`
            : 'No safety buffer set'
        }
        dotColor={deadline.hasDeadline && !deadline.meetsRaw ? p.risk : p.ok}
      />
      <View
        accessibilityRole="text"
        style={{
          marginTop: spacing.s,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.s,
          flexWrap: 'wrap',
        }}
      >
        <Badge tone={deadline.hasDeadline && !deadline.meetsRaw ? 'risk' : 'neutral'} label={deadlineSummary} />
      </View>
      {option.estimateBasis === 'TIMETABLE' && option.transitDetails ? (
        <Text style={{ color: p.inkMuted, fontSize: 12, marginTop: spacing.s }}>
          {option.transitDetails.limitationNote}
        </Text>
      ) : null}
      <ThemedText variant="muted" style={{ marginTop: spacing.s }}>
        {option.dataSource} · updated {option.lastUpdatedIst}
      </ThemedText>
    </View>
  );
}

function TimelineRow({
  time,
  title,
  subtitle,
  dotColor,
  lineToNext,
  compact,
}: {
  time: string;
  title: string;
  subtitle: string;
  dotColor: string;
  lineToNext?: boolean;
  compact?: boolean;
}) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', minHeight: compact ? 40 : 56 }}>
      <View style={{ alignItems: 'center', width: 24 }}>
        <View
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: dotColor,
            marginTop: 4,
          }}
        />
        {lineToNext ? (
          <View style={{ flex: 1, width: 2, backgroundColor: p.border, marginTop: 2 }} />
        ) : null}
      </View>
      <View style={{ flex: 1, paddingLeft: spacing.m, paddingBottom: compact ? 0 : spacing.s }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.s }}>
          <Text style={{ color: p.ink, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
            {time}
          </Text>
          <Text style={{ color: p.inkMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {title}
          </Text>
        </View>
        <Text style={{ color: p.inkMuted, fontSize: 13, flex: 1 }}>{subtitle}</Text>
      </View>
    </View>
  );
}
