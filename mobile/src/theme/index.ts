/** Visual language: white/daylight base, navy ink, blue actions, amber timing risk. */
import { useColorScheme } from 'react-native';

export interface Palette {
  background: string;
  surface: string;
  surfaceMuted: string;
  ink: string;
  inkMuted: string;
  primary: string;
  primarySoft: string;
  onPrimary: string;
  risk: string;
  riskSoft: string;
  ok: string;
  okSoft: string;
  border: string;
  demoBadgeBg: string;
  demoBadgeInk: string;
  liveBadgeBg: string;
  liveBadgeInk: string;
  danger: string;
}

export const lightPalette: Palette = {
  background: '#F5F7FB',
  surface: '#FFFFFF',
  surfaceMuted: '#EEF2F8',
  ink: '#10243E',
  inkMuted: '#5A6B84',
  primary: '#1D5FDB',
  primarySoft: '#E3EDFC',
  onPrimary: '#FFFFFF',
  risk: '#9A5B00',
  riskSoft: '#FDF0D7',
  ok: '#1E7A46',
  okSoft: '#DDF3E6',
  border: '#D9E1EC',
  demoBadgeBg: '#EFE7FB',
  demoBadgeInk: '#5B3FA8',
  liveBadgeBg: '#DFF1E7',
  liveBadgeInk: '#1E7A46',
  danger: '#B3261E',
};

export const darkPalette: Palette = {
  background: '#0B1524',
  surface: '#15243A',
  surfaceMuted: '#1C2E48',
  ink: '#E8EEF7',
  inkMuted: '#9AAAC2',
  primary: '#7FA9F2',
  primarySoft: '#1D3557',
  onPrimary: '#0B1524',
  risk: '#F2C069',
  riskSoft: '#3A2E14',
  ok: '#6FD39A',
  okSoft: '#14301F',
  border: '#273953',
  demoBadgeBg: '#2E2450',
  demoBadgeInk: '#C4B0F0',
  liveBadgeBg: '#14301F',
  liveBadgeInk: '#6FD39A',
  danger: '#F2A9A2',
};

export const spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { s: 8, m: 12, l: 16 } as const;

/** Minimum accessible touch target per platform accessibility guidance. */
export const MIN_TOUCH_TARGET = 48;

export function usePalette(): Palette {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkPalette : lightPalette;
}
