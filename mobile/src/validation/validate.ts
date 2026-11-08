/**
 * Input validation for plan editing, journey corrections, and connection setup.
 * All rules produce human-readable messages safe to render inline.
 */
export type ValidationErrors = Record<string, string>;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHhmm(value: string): boolean {
  return HHMM_RE.test(value.trim());
}

export function validateHhmmField(value: string, label: string): string | null {
  if (!isValidHhmm(value)) {
    return `${label} must be a valid 24-hour time like 08:30.`;
  }
  return null;
}

export function hhmmToMinutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  return h * 60 + m;
}

export function validateNonnegativeInteger(
  value: string,
  label: string,
  max = 120
): string | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return `${label} must be a whole number (0 or more).`;
  }
  const parsed = parseInt(trimmed, 10);
  if (parsed > max) {
    return `${label} must be at most ${max}.`;
  }
  return null;
}

export function validateCoordinate(
  value: string,
  kind: 'lat' | 'lng'
): string | null {
  const trimmed = value.trim();
  if (!/^-?\d{1,3}(\.\d+)?$/.test(trimmed)) {
    return kind === 'lat' ? 'Latitude must be a decimal number.' : 'Longitude must be a decimal number.';
  }
  const parsed = parseFloat(trimmed);
  if (kind === 'lat' && (parsed < -90 || parsed > 90)) {
    return 'Latitude must be between -90 and 90 (Bengaluru is about 12.9).';
  }
  if (kind === 'lng' && (parsed < -180 || parsed > 180)) {
    return 'Longitude must be between -180 and 180 (Bengaluru is about 77.6).';
  }
  return null;
}

export interface ScheduleDraft {
  windowStart: string;
  windowEnd: string;
  preferredDeparture: string;
  /** Empty string means "no deadline". */
  arrivalDeadline: string;
  safetyBufferMinutes: string;
  days: string[];
}

export interface ScheduleDraftErrors {
  windowStart?: string;
  windowEnd?: string;
  preferredDeparture?: string;
  arrivalDeadline?: string;
  safetyBufferMinutes?: string;
  days?: string;
}

export function validateScheduleDraft(draft: ScheduleDraft): ScheduleDraftErrors {
  const errors: ScheduleDraftErrors = {};

  const ws = validateHhmmField(draft.windowStart, 'Window start');
  if (ws) errors.windowStart = ws;
  const we = validateHhmmField(draft.windowEnd, 'Window end');
  if (we) errors.windowEnd = we;
  const pd = validateHhmmField(draft.preferredDeparture, 'Preferred departure');
  if (pd) errors.preferredDeparture = pd;
  if (draft.arrivalDeadline) {
    const ad = validateHhmmField(draft.arrivalDeadline, 'Arrival deadline');
    if (ad) errors.arrivalDeadline = ad;
  }
  const sb = validateNonnegativeInteger(draft.safetyBufferMinutes, 'Safety buffer', 120);
  if (sb) errors.safetyBufferMinutes = sb;

  if (draft.days.length === 0) {
    errors.days = 'Select at least one workday.';
  }

  if (!errors.windowStart && !errors.windowEnd) {
    if (hhmmToMinutesOfDay(draft.windowEnd) <= hhmmToMinutesOfDay(draft.windowStart)) {
      errors.windowEnd = 'Window end must be after window start.';
    }
  }

  if (
    !errors.windowStart &&
    !errors.windowEnd &&
    !errors.preferredDeparture &&
    isValidHhmm(draft.windowStart) &&
    isValidHhmm(draft.windowEnd) &&
    isValidHhmm(draft.preferredDeparture)
  ) {
    const p = hhmmToMinutesOfDay(draft.preferredDeparture);
    if (p < hhmmToMinutesOfDay(draft.windowStart) || p > hhmmToMinutesOfDay(draft.windowEnd)) {
      errors.preferredDeparture = 'Preferred departure must sit inside the window.';
    }
  }

  return errors;
}

export function scheduleDraftHasErrors(errors: ScheduleDraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  const m = hostname.match(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  return Boolean(m);
}

function isPrivateLanHost(hostname: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const m172 = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m172) {
    const second = parseInt(m172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}

/**
 * Validate a pilot backend base URL as a pure ORIGIN.
 *
 * Rules:
 * - Must parse as http(s) URL with an explicit host.
 * - No embedded credentials (user:pass@host), query, or fragment.
 * - No path beyond an optional trailing "/" (the API paths are appended by the client).
 * - Plain http is allowed ONLY for loopback or private-LAN hosts: the pilot
 *   token would otherwise cross a public network in clear text.
 */
export function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter the pilot backend base URL.';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'URL must look like http://10.0.2.2:3000 or http://192.168.1.20:3000.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'URL must start with http:// or https://.';
  }
  if (parsed.username || parsed.password) {
    return 'Remove any user:password embedded in the URL.';
  }
  if (parsed.search) {
    return 'Remove any ?query from the URL — only the origin (scheme://host:port) is allowed.';
  }
  if (parsed.hash) {
    return 'Remove any #fragment from the URL — only the origin (scheme://host:port) is allowed.';
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return 'Enter only the origin (scheme://host:port) without a path, e.g. http://10.0.2.2:3000.';
  }
  const host = parsed.hostname;
  if (parsed.protocol === 'http:' && !isLoopbackHost(host) && !isPrivateLanHost(host)) {
    return 'Plain http is only allowed for localhost or a private LAN address (10.x, 172.16–31.x, 192.168.x). For anything else use https.';
  }
  return null;
}

export function validatePin(value: string): string | null {
  if (!/^\d{4}$/.test(value.trim())) {
    return 'PIN is the 4-digit pilot employee PIN.';
  }
  return null;
}

/**
 * Journeys are same-day IST records (server contract: PUT /api/journeys/:id
 * maps both HH:mm onto the journey's dateIst). An arrival at or before the
 * departure is therefore invalid data, not a short trip — reject it instead of
 * letting negative durations clamp to a believable value.
 */
export function validateJourneyChronology(
  departureHhmm: string,
  arrivalHhmm: string | null
): string | null {
  if (!arrivalHhmm) return null;
  if (!isValidHhmm(departureHhmm) || !isValidHhmm(arrivalHhmm)) return null;
  const arr = hhmmToMinutesOfDay(arrivalHhmm);
  const dep = hhmmToMinutesOfDay(departureHhmm);
  if (arr <= dep) {
    return 'Arrival must be later than departure on the same day (overnight trips are not supported).';
  }
  return null;
}

export function validateManualLocation(input: {
  label: string;
  lat: string;
  lng: string;
}): { label?: string; lat?: string; lng?: string } {
  const errors: { label?: string; lat?: string; lng?: string } = {};
  if (!input.label.trim()) {
    errors.label = 'Give this place a label, e.g. "Home – HSR Layout".';
  }
  const latErr = validateCoordinate(input.lat, 'lat');
  if (latErr) errors.lat = latErr;
  const lngErr = validateCoordinate(input.lng, 'lng');
  if (lngErr) errors.lng = lngErr;
  return errors;
}
