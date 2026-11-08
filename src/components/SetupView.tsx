import React, { useState } from 'react';
import {
  Check,
  MapPin,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  CommuteDirection,
  DataEnvironment,
  DayOfWeek,
  DirectionSchedule,
  LocationPoint,
  TransportMode,
  UserProfile,
} from '../types/commute';
import {
  BMTC_TIMETABLE_LIMITATION_NOTE,
  PRESTIGE_TECH_PARK_DEFAULT,
  TWO_WHEELER_BETA_WARNING,
} from '../lib/commuteEngine';

interface SetupViewProps {
  profile: UserProfile;
  environment: DataEnvironment;
  onSaveProfile: (updated: Partial<UserProfile>) => Promise<void>;
  onSearchPlaces: (query: string) => Promise<LocationPoint[]>;
  onDeleteLocations: () => Promise<void>;
  onDeleteJourneys: () => Promise<void>;
  notificationPermission: NotificationPermission | 'unsupported';
  onRequestNotificationPermission: () => Promise<void>;
}

const ALL_DAYS: Array<{ key: DayOfWeek; label: string }> = [
  { key: 'MON', label: 'Mon' },
  { key: 'TUE', label: 'Tue' },
  { key: 'WED', label: 'Wed' },
  { key: 'THU', label: 'Thu' },
  { key: 'FRI', label: 'Fri' },
  { key: 'SAT', label: 'Sat' },
  { key: 'SUN', label: 'Sun' },
];

export const SetupView: React.FC<SetupViewProps> = ({
  profile,
  environment,
  onSaveProfile,
  onSearchPlaces,
  onDeleteLocations,
  onDeleteJourneys,
  notificationPermission,
  onRequestNotificationPermission,
}) => {
  const [activeDirection, setActiveDirection] = useState<CommuteDirection>('HOME_TO_WORK');
  const [homeLabel, setHomeLabel] = useState(profile.homeLocation?.label || '');
  const [homeAddress, setHomeAddress] = useState(profile.homeLocation?.address || '');
  const [homeLat, setHomeLat] = useState(String(profile.homeLocation?.lat ?? 12.9719));
  const [homeLng, setHomeLng] = useState(String(profile.homeLocation?.lng ?? 77.6412));

  const [workLabel, setWorkLabel] = useState(
    profile.workLocation?.label || PRESTIGE_TECH_PARK_DEFAULT.label
  );
  const [workAddress, setWorkAddress] = useState(
    profile.workLocation?.address || PRESTIGE_TECH_PARK_DEFAULT.address
  );
  const [workLat, setWorkLat] = useState(
    String(profile.workLocation?.lat ?? PRESTIGE_TECH_PARK_DEFAULT.lat)
  );
  const [workLng, setWorkLng] = useState(
    String(profile.workLocation?.lng ?? PRESTIGE_TECH_PARK_DEFAULT.lng)
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [searchTarget, setSearchTarget] = useState<'HOME' | 'WORK'>('HOME');
  const [searchResults, setSearchResults] = useState<LocationPoint[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [schedules, setSchedules] = useState<{
    HOME_TO_WORK: DirectionSchedule;
    WORK_TO_HOME: DirectionSchedule;
  }>(() => structuredClone(profile.schedules));

  const [telemetryConsent, setTelemetryConsent] = useState(profile.telemetryConsent);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [confirmDeleteLocations, setConfirmDeleteLocations] = useState(false);
  const [confirmDeleteJourneys, setConfirmDeleteJourneys] = useState(false);

  const currentSched = schedules[activeDirection];

  const updateCurrentSched = (patch: Partial<DirectionSchedule>) => {
    setSchedules((prev) => ({
      ...prev,
      [activeDirection]: {
        ...prev[activeDirection],
        ...patch,
      },
    }));
    setSaveSuccess(false);
  };

  const toggleDay = (day: DayOfWeek) => {
    const exists = currentSched.days.includes(day);
    const nextDays = exists
      ? currentSched.days.filter((d) => d !== day)
      : [...currentSched.days, day];
    updateCurrentSched({ days: nextDays });
  };

  const handlePlaceSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    setSearchError(null);
    try {
      const results = await onSearchPlaces(searchQuery);
      setSearchResults(results);
    } catch (err: any) {
      setSearchError(err?.message || 'Unable to search places.');
    } finally {
      setSearching(false);
    }
  };

  const applyPlaceSelection = (loc: LocationPoint) => {
    if (searchTarget === 'HOME') {
      setHomeLabel(loc.label);
      setHomeAddress(loc.address);
      setHomeLat(String(loc.lat));
      setHomeLng(String(loc.lng));
    } else {
      setWorkLabel(loc.label);
      setWorkAddress(loc.address);
      setWorkLat(String(loc.lat));
      setWorkLng(String(loc.lng));
    }
    setSearchResults([]);
    setSaveSuccess(false);
  };

  const handleSaveAll = async () => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      const parsedHomeLat = parseFloat(homeLat) || 12.9719;
      const parsedHomeLng = parseFloat(homeLng) || 77.6412;
      const parsedWorkLat = parseFloat(workLat) || PRESTIGE_TECH_PARK_DEFAULT.lat;
      const parsedWorkLng = parseFloat(workLng) || PRESTIGE_TECH_PARK_DEFAULT.lng;

      const updatedHome: LocationPoint | null = homeLabel.trim()
        ? {
            label: homeLabel.trim(),
            address: homeAddress.trim() || homeLabel.trim(),
            lat: parsedHomeLat,
            lng: parsedHomeLng,
            confirmedAt: new Date().toISOString(),
          }
        : null;

      const updatedWork: LocationPoint = {
        label: workLabel.trim() || PRESTIGE_TECH_PARK_DEFAULT.label,
        address: workAddress.trim() || PRESTIGE_TECH_PARK_DEFAULT.address,
        lat: parsedWorkLat,
        lng: parsedWorkLng,
        confirmedAt: new Date().toISOString(),
      };

      await onSaveProfile({
        homeLocation: updatedHome,
        workLocation: updatedWork,
        schedules,
        telemetryConsent,
        onboardingComplete: true,
      });
      setSaveSuccess(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8 pb-24">
      {/* Header Summary */}
      <div className="border-b border-slate-200 dark:border-slate-800 pb-5">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Commute Setup &amp; Schedule Preferences
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Configure your home and Prestige Tech Park locations, transport mode, departure windows, and arrival deadlines. All times use Asia/Kolkata (IST). Continuous GPS tracking is never required.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Locations & Search */}
        <div className="lg:col-span-5 space-y-6">
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                1. Home &amp; Work Locations
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Search via {environment === 'LIVE' ? 'Google Places API (New)' : 'Bengaluru Corridor Presets'} or enter manual coordinates/addresses directly.
              </p>
            </div>

            {/* Search Helper */}
            <form onSubmit={handlePlaceSearch} className="space-y-3">
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setSearchTarget('HOME')}
                  className={`flex-1 min-h-[40px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    searchTarget === 'HOME'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                  }`}
                >
                  Search for Home
                </button>
                <button
                  type="button"
                  onClick={() => setSearchTarget('WORK')}
                  className={`flex-1 min-h-[40px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    searchTarget === 'WORK'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                  }`}
                >
                  Search for Work
                </button>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="e.g. Indiranagar 100ft Rd, HSR Sector 2, Bellandur..."
                  className="flex-1 min-h-[44px] px-3.5 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <button
                  type="submit"
                  disabled={searching}
                  className="min-h-[44px] px-4 py-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-semibold rounded-xl hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Search className="w-4 h-4" />
                  <span>{searching ? 'Searching...' : 'Lookup'}</span>
                </button>
              </div>
            </form>

            {searchError && (
              <p className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-xl p-3">
                {searchError}
              </p>
            )}

            {searchResults.length > 0 && (
              <div className="border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800 max-h-56 overflow-y-auto">
                {searchResults.map((loc, i) => (
                  <button
                    key={`${loc.label}_${i}`}
                    type="button"
                    onClick={() => applyPlaceSelection(loc)}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {loc.label}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {loc.address}
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                        {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-teal-700 dark:text-teal-400 whitespace-nowrap shrink-0 mt-1">
                      Select {searchTarget === 'HOME' ? 'Home' : 'Work'}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Manual Home Location Entry */}
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Confirmed Home Location (Private to You)
                </label>
                <span className="text-[11px] text-slate-500">Manual entry supported</span>
              </div>
              <input
                type="text"
                value={homeLabel}
                onChange={(e) => {
                  setHomeLabel(e.target.value);
                  setSaveSuccess(false);
                }}
                placeholder="Neighborhood / Building Name (e.g. HSR Layout Sector 2)"
                className="w-full min-h-[44px] px-3.5 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-slate-100"
              />
              <input
                type="text"
                value={homeAddress}
                onChange={(e) => {
                  setHomeAddress(e.target.value);
                  setSaveSuccess(false);
                }}
                placeholder="Full street address, Bengaluru"
                className="w-full min-h-[44px] px-3.5 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-300"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">
                    Home Latitude
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    value={homeLat}
                    onChange={(e) => setHomeLat(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">
                    Home Longitude
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    value={homeLng}
                    onChange={(e) => setHomeLng(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                  />
                </div>
              </div>
            </div>

            {/* Manual Work Location Entry */}
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Confirmed Work Campus Location
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setWorkLabel(PRESTIGE_TECH_PARK_DEFAULT.label);
                    setWorkAddress(PRESTIGE_TECH_PARK_DEFAULT.address);
                    setWorkLat(String(PRESTIGE_TECH_PARK_DEFAULT.lat));
                    setWorkLng(String(PRESTIGE_TECH_PARK_DEFAULT.lng));
                  }}
                  className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline"
                >
                  Reset to Prestige Tech Park
                </button>
              </div>
              <input
                type="text"
                value={workLabel}
                onChange={(e) => setWorkLabel(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-slate-100"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">
                    Work Latitude
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    value={workLat}
                    onChange={(e) => setWorkLat(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">
                    Work Longitude
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    value={workLng}
                    onChange={(e) => setWorkLng(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Privacy, Consent & Data Deletion */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              3. Privacy, Notification Delivery &amp; Data Controls
            </h2>

            <label className="flex items-start gap-3 cursor-pointer py-1">
              <input
                type="checkbox"
                checked={telemetryConsent}
                onChange={(e) => {
                  setTelemetryConsent(e.target.checked);
                  setSaveSuccess(false);
                }}
                className="mt-1 w-4 h-4 accent-teal-600 rounded"
              />
              <div className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  Consent to Pilot ETA Reliability Measurement:
                </span>{' '}
                Record immutable ETA snapshots when an option is selected and when &ldquo;I&rsquo;ve left&rdquo; is pressed, alongside confirmed arrival times. Raw traffic API payloads are never persisted.
              </div>
            </label>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Browser Notification Permission
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Current status: <span className="font-mono">{notificationPermission}</span> · Foreground + server-polled in-app alerts active
                  </div>
                </div>
                {notificationPermission !== 'granted' &&
                  notificationPermission !== 'unsupported' && (
                    <button
                      type="button"
                      onClick={onRequestNotificationPermission}
                      className="min-h-[40px] px-3.5 py-2 text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-xl hover:bg-slate-200 whitespace-nowrap shrink-0"
                    >
                      Enable Browser Alerts
                    </button>
                  )}
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-3">
              {!confirmDeleteLocations ? (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteLocations(true)}
                  className="min-h-[44px] px-3.5 py-2 text-xs font-medium text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 rounded-xl hover:bg-rose-100 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Delete Saved Locations</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 bg-rose-50 dark:bg-rose-950/50 p-2 rounded-xl border border-rose-200 dark:border-rose-800">
                  <span className="text-xs text-rose-800 dark:text-rose-200">Confirm delete home address?</span>
                  <button
                    type="button"
                    onClick={async () => {
                      await onDeleteLocations();
                      setHomeLabel('');
                      setHomeAddress('');
                      setConfirmDeleteLocations(false);
                    }}
                    className="px-2.5 py-1 text-xs font-semibold bg-rose-600 text-white rounded-lg"
                  >
                    Yes, Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteLocations(false)}
                    className="px-2.5 py-1 text-xs text-slate-600 dark:text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {!confirmDeleteJourneys ? (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteJourneys(true)}
                  className="min-h-[44px] px-3.5 py-2 text-xs font-medium text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 rounded-xl hover:bg-rose-100 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Journey History</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 bg-rose-50 dark:bg-rose-950/50 p-2 rounded-xl border border-rose-200 dark:border-rose-800">
                  <span className="text-xs text-rose-800 dark:text-rose-200">Erase all your trips &amp; alerts?</span>
                  <button
                    type="button"
                    onClick={async () => {
                      await onDeleteJourneys();
                      setConfirmDeleteJourneys(false);
                    }}
                    className="px-2.5 py-1 text-xs font-semibold bg-rose-600 text-white rounded-lg"
                  >
                    Yes, Erase
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteJourneys(false)}
                    className="px-2.5 py-1 text-xs text-slate-600 dark:text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right Column: Separate Home-to-Work & Work-to-Home Configuration */}
        <div className="lg:col-span-7 space-y-6">
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  2. Directional Commute Configuration
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Configure Morning (Home → Work) and Evening (Work → Home) independently.
                </p>
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => setActiveDirection('HOME_TO_WORK')}
                  className={`min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeDirection === 'HOME_TO_WORK'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                  }`}
                >
                  Home → Work
                </button>
                <button
                  type="button"
                  onClick={() => setActiveDirection('WORK_TO_HOME')}
                  className={`min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeDirection === 'WORK_TO_HOME'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                  }`}
                >
                  Work → Home
                </button>
              </div>
            </div>

            {/* Transport Mode Selector */}
            <div className="space-y-2.5">
              <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                Transport Mode for {activeDirection === 'HOME_TO_WORK' ? 'Home → Work' : 'Work → Home'}
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(
                  [
                    {
                      mode: 'BIKE' as TransportMode,
                      title: 'Bike (Two-Wheeler)',
                      sub: 'Motorized two-wheeler routing (TWO_WHEELER)',
                    },
                    {
                      mode: 'CAR' as TransportMode,
                      title: 'Car',
                      sub: 'Traffic-aware driving + future forecast (DRIVE)',
                    },
                    {
                      mode: 'BMTC' as TransportMode,
                      title: 'BMTC Bus',
                      sub: 'Scheduled bus stops, walk & wait times (TRANSIT)',
                    },
                  ] as const
                ).map((item) => {
                  const selected = currentSched.mode === item.mode;
                  return (
                    <button
                      key={item.mode}
                      type="button"
                      onClick={() => updateCurrentSched({ mode: item.mode })}
                      className={`text-left p-3.5 rounded-xl border transition-colors min-h-[72px] ${
                        selected
                          ? 'border-teal-600 bg-teal-50/50 dark:bg-teal-950/30 text-slate-900 dark:text-slate-100'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">{item.title}</span>
                        {selected && <Check className="w-4 h-4 text-teal-600 shrink-0" />}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {item.sub}
                      </p>
                    </button>
                  );
                })}
              </div>

              {currentSched.mode === 'BIKE' && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/80 text-xs text-amber-900 dark:text-amber-200">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" />
                  <span>{TWO_WHEELER_BETA_WARNING}</span>
                </div>
              )}

              {currentSched.mode === 'BMTC' && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-100 dark:bg-slate-800/70 text-xs text-slate-700 dark:text-slate-300">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-slate-600 dark:text-slate-400" />
                  <span>{BMTC_TIMETABLE_LIMITATION_NOTE}</span>
                </div>
              )}
            </div>

            {/* Commute Days */}
            <div className="space-y-2.5">
              <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                Active Commute Days
              </label>
              <div className="flex flex-wrap gap-2">
                {ALL_DAYS.map((d) => {
                  const active = currentSched.days.includes(d.key);
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => toggleDay(d.key)}
                      className={`min-h-[44px] min-w-[48px] px-3 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                        active
                          ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200'
                      }`}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Departure Window, Preferred Departure, and Arrival Deadline */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div>
                <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                  Earliest Departure (Window Start, IST)
                </label>
                <input
                  type="time"
                  value={currentSched.windowStart}
                  onChange={(e) => updateCurrentSched({ windowStart: e.target.value })}
                  className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                  Latest Departure (Window End, IST)
                </label>
                <input
                  type="time"
                  value={currentSched.windowEnd}
                  onChange={(e) => updateCurrentSched({ windowEnd: e.target.value })}
                  className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                  Preferred Departure Time (IST)
                </label>
                <input
                  type="time"
                  value={currentSched.preferredDeparture}
                  onChange={(e) =>
                    updateCurrentSched({ preferredDeparture: e.target.value })
                  }
                  className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Arrival Deadline (IST, Optional)
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      updateCurrentSched({
                        arrivalDeadline: currentSched.arrivalDeadline ? null : '09:30',
                      })
                    }
                    className="text-[11px] font-medium text-teal-700 dark:text-teal-400 hover:underline"
                  >
                    {currentSched.arrivalDeadline ? 'Clear deadline' : '+ Set deadline'}
                  </button>
                </div>
                {currentSched.arrivalDeadline ? (
                  <input
                    type="time"
                    value={currentSched.arrivalDeadline}
                    onChange={(e) =>
                      updateCurrentSched({ arrivalDeadline: e.target.value })
                    }
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                  />
                ) : (
                  <div className="min-h-[44px] px-3.5 py-2 text-xs text-slate-500 bg-slate-50 dark:bg-slate-950 border border-dashed border-slate-300 dark:border-slate-700 rounded-xl flex items-center">
                    No arrival deadline set (window-only recommendations)
                  </div>
                )}
              </div>
            </div>

            {/* Monitoring Schedule Lead Time, Alert Threshold & Safety Buffer */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div>
                <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                  Auto-Monitor Lead Time
                </label>
                <select
                  value={currentSched.leadTimeMinutes}
                  onChange={(e) =>
                    updateCurrentSched({ leadTimeMinutes: Number(e.target.value) })
                  }
                  className="w-full min-h-[44px] px-3 py-2 text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                >
                  <option value={0}>0 min (Start at preferred time)</option>
                  <option value={10}>10 min before preferred departure</option>
                  <option value={15}>15 min before preferred departure</option>
                  <option value={20}>20 min before preferred departure</option>
                  <option value={30}>30 min before preferred departure</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                  Alert Deterioration Threshold
                </label>
                <select
                  value={currentSched.alertThresholdMinutes}
                  onChange={(e) =>
                    updateCurrentSched({
                      alertThresholdMinutes: Number(e.target.value),
                    })
                  }
                  className="w-full min-h-[44px] px-3 py-2 text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                >
                  <option value={3}>+3 min ETA deterioration</option>
                  <option value={5}>+5 min ETA deterioration (Pilot default)</option>
                  <option value={8}>+8 min ETA deterioration</option>
                  <option value={10}>+10 min ETA deterioration</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                  Personal Safety Buffer
                </label>
                <select
                  value={currentSched.safetyBufferMinutes}
                  onChange={(e) =>
                    updateCurrentSched({
                      safetyBufferMinutes: Number(e.target.value),
                    })
                  }
                  className="w-full min-h-[44px] px-3 py-2 text-xs font-medium bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
                >
                  <option value={0}>0 min (Raw provider ETA only)</option>
                  <option value={5}>+5 min buffer (Shown separately)</option>
                  <option value={10}>+10 min buffer (Shown separately)</option>
                  <option value={15}>+15 min buffer (Shown separately)</option>
                </select>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4">
              <div className="text-xs text-slate-500">
                {saveSuccess ? (
                  <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                    Commute setup saved and synced with server scheduler.
                  </span>
                ) : (
                  <span>Changes apply immediately to Today Dashboard recommendations.</span>
                )}
              </div>
              <button
                type="button"
                onClick={handleSaveAll}
                disabled={saving}
                className="min-h-[44px] px-6 py-2.5 bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0"
              >
                {saving ? 'Saving Setup...' : 'Save Commute Setup'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
