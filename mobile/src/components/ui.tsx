/** Shared accessible UI primitives. All touch targets meet >=48 units. */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MIN_TOUCH_TARGET, Palette, radius, spacing, usePalette } from '../theme';

export function useThemedStyles() {
  const palette = usePalette();
  return React.useMemo(() => makeStyles(palette), [palette]);
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    card: {
      backgroundColor: p.surface,
      borderRadius: radius.m,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: p.border,
      padding: spacing.l,
    },
    title: { color: p.ink, fontSize: 17, fontWeight: '700' },
    body: { color: p.ink, fontSize: 15, lineHeight: 21 },
    muted: { color: p.inkMuted, fontSize: 13, lineHeight: 18 },
    sectionHeader: {
      color: p.ink,
      fontSize: 13,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginTop: spacing.xl,
      marginBottom: spacing.s,
    },
    badge: {
      borderRadius: 999,
      paddingHorizontal: spacing.s + 2,
      paddingVertical: 2,
      alignSelf: 'flex-start',
      overflow: 'hidden',
    },
    badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
    buttonPrimary: {
      backgroundColor: p.primary,
      borderRadius: radius.s,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.l,
      paddingVertical: spacing.m,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonSecondary: {
      backgroundColor: p.surface,
      borderColor: p.primary,
      borderWidth: 1.5,
      borderRadius: radius.s,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.l,
      paddingVertical: spacing.m,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonGhost: {
      backgroundColor: 'transparent',
      borderRadius: radius.s,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.m,
      paddingVertical: spacing.s,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonDanger: {
      backgroundColor: 'transparent',
      borderColor: p.danger,
      borderWidth: 1.5,
      borderRadius: radius.s,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.l,
      paddingVertical: spacing.m,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonTextPrimary: { color: p.onPrimary, fontSize: 15, fontWeight: '700' },
    buttonTextSecondary: { color: p.primary, fontSize: 15, fontWeight: '700' },
    buttonTextDanger: { color: p.danger, fontSize: 15, fontWeight: '700' },
    input: {
      backgroundColor: p.surface,
      borderColor: p.border,
      borderWidth: 1,
      borderRadius: radius.s,
      color: p.ink,
      fontSize: 16,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.m,
      paddingVertical: spacing.s + 2,
    },
    label: { color: p.ink, fontSize: 13, fontWeight: '600', marginBottom: 4 },
    errorText: { color: p.danger, fontSize: 12, marginTop: 2 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.m },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginVertical: spacing.m },
  });
}

export function Card({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const s = useThemedStyles();
  return <View style={[s.card, style]}>{children}</View>;
}

export function ThemedText({
  variant = 'body',
  style,
  children,
}: {
  variant?: 'title' | 'body' | 'muted';
  style?: StyleProp<any>;
  children: React.ReactNode;
}) {
  const s = useThemedStyles();
  return (
    <Text
      style={[
        variant === 'title' ? s.title : variant === 'muted' ? s.muted : s.body,
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function SectionHeader({ label }: { label: string }) {
  const s = useThemedStyles();
  return (
    <Text accessibilityRole="header" style={s.sectionHeader}>
      {label}
    </Text>
  );
}

type BadgeTone = 'demo' | 'live' | 'risk' | 'ok' | 'neutral' | 'primary';

export function Badge({ tone, label }: { tone: BadgeTone; label: string }) {
  const p = usePalette();
  const s = useThemedStyles();
  const colors: Record<BadgeTone, { bg: string; ink: string }> = {
    demo: { bg: p.demoBadgeBg, ink: p.demoBadgeInk },
    live: { bg: p.liveBadgeBg, ink: p.liveBadgeInk },
    risk: { bg: p.riskSoft, ink: p.risk },
    ok: { bg: p.okSoft, ink: p.ok },
    neutral: { bg: p.surfaceMuted, ink: p.inkMuted },
    primary: { bg: p.primarySoft, ink: p.primary },
  };
  return (
    <View
      accessibilityRole="text"
      style={[s.badge, { backgroundColor: colors[tone].bg }]}
    >
      <Text style={[s.badgeText, { color: colors[tone].ink }]}>{label}</Text>
    </View>
  );
}

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  accessibilityHint?: string;
  loading?: boolean;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  accessibilityHint,
  loading,
}: ButtonProps) {
  const s = useThemedStyles();
  const pressedStyle = { opacity: 0.75 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        variant === 'primary' && s.buttonPrimary,
        variant === 'secondary' && s.buttonSecondary,
        variant === 'ghost' && s.buttonGhost,
        variant === 'danger' && s.buttonDanger,
        pressed ? pressedStyle : null,
        (disabled || loading) && { opacity: 0.45 },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" />
      ) : (
        <Text
          style={
            variant === 'primary'
              ? s.buttonTextPrimary
              : variant === 'danger'
              ? s.buttonTextDanger
              : s.buttonTextSecondary
          }
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function IconButton({
  name,
  label,
  onPress,
  badgeCount,
  disabled,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  badgeCount?: number;
  disabled?: boolean;
}) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: MIN_TOUCH_TARGET,
          height: MIN_TOUCH_TARGET,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Ionicons name={name} size={24} color={p.ink} />
      {typeof badgeCount === 'number' && badgeCount > 0 ? (
        <View
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: p.danger,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 4,
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>
            {badgeCount > 99 ? '99+' : badgeCount}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export interface FieldProps extends TextInputProps {
  label: string;
  error?: string | null;
  hint?: string;
}

export function Field({ label, error, hint, style, ...inputProps }: FieldProps) {
  const s = useThemedStyles();
  const p = usePalette();
  return (
    <View style={{ marginBottom: spacing.m }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        placeholderTextColor={p.inkMuted}
        accessibilityLabel={label}
        {...inputProps}
        style={[s.input, error ? { borderColor: p.danger } : null, style]}
      />
      {hint && !error ? <Text style={[s.muted, { marginTop: 2 }]}>{hint}</Text> : null}
      {error ? (
        <Text accessibilityRole="text" style={s.errorText}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function ToggleRow({
  label,
  value,
  onValueChange,
  description,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  description?: string;
}) {
  const s = useThemedStyles();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.s }}>
      <View style={{ flex: 1, paddingRight: spacing.m }}>
        <Text style={s.body}>{label}</Text>
        {description ? <Text style={s.muted}>{description}</Text> : null}
      </View>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel={label}
        value={value}
        onValueChange={onValueChange}
      />
    </View>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const p = usePalette();
  const s = useThemedStyles();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', gap: spacing.s, flexWrap: 'wrap' }}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="radio"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected, disabled: Boolean(opt.disabled) }}
            disabled={opt.disabled}
            onPress={() => onChange(opt.value)}
            style={{
              minHeight: MIN_TOUCH_TARGET,
              paddingHorizontal: spacing.l,
              borderRadius: 999,
              borderWidth: selected ? 0 : 1,
              borderColor: p.border,
              backgroundColor: selected ? p.primary : p.surface,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: opt.disabled ? 0.45 : 1,
            }}
          >
            <Text
              style={{
                color: selected ? p.onPrimary : p.ink,
                fontWeight: '700',
                fontSize: 14,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: spacing.m,
        borderRadius: radius.s,
        borderWidth: 1,
        borderColor: selected ? p.primary : p.border,
        backgroundColor: selected ? p.primarySoft : p.surface,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: selected ? p.primary : p.inkMuted, fontWeight: '700', fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Divider() {
  const s = useThemedStyles();
  return <View style={s.divider} />;
}

export function EmptyState({
  icon,
  title,
  message,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  message: string;
}) {
  const p = usePalette();
  const s = useThemedStyles();
  return (
    <View style={{ alignItems: 'center', padding: spacing.xl, gap: spacing.s }}>
      <Ionicons name={icon} size={32} color={p.inkMuted} />
      <Text style={s.title}>{title}</Text>
      <Text style={[s.muted, { textAlign: 'center' }]}>{message}</Text>
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const p = usePalette();
  const s = useThemedStyles();
  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: p.riskSoft,
        borderRadius: radius.m,
        padding: spacing.l,
        gap: spacing.s,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.s }}>
        <Ionicons name="warning" size={20} color={p.risk} />
        <Text style={{ color: p.risk, fontWeight: '700', flex: 1 }}>Something needs attention</Text>
      </View>
      <Text style={[s.body, { color: p.ink }]}>{message}</Text>
      {onRetry ? <Button title={retryLabel} variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function LoadingView({ label = 'Loading…' }: { label?: string }) {
  const s = useThemedStyles();
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.m }}>
      <ActivityIndicator size="large" />
      <Text style={s.muted}>{label}</Text>
    </View>
  );
}

export function ScreenScroll({ children }: { children: React.ReactNode }) {
  const p = usePalette();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.background }}
      contentContainerStyle={{ padding: spacing.l, paddingBottom: spacing.xxl }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
