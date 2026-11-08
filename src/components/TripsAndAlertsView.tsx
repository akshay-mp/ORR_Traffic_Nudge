import React, { useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Edit3,
} from 'lucide-react';
import {
  CommuteAlert,
  JourneyRecord,
  MonitoringSession,
} from '../types/commute';
import { getNowIstParts } from '../lib/commuteEngine';

interface TripsAndAlertsViewProps {
  mode: 'TRIPS' | 'ALERTS';
  journeys: JourneyRecord[];
  alerts: CommuteAlert[];
  sessions: MonitoringSession[];
  onUpdateJourney: (
    id: string,
    payload: {
      actualDepartureHhmm?: string;
      actualArrivalHhmm?: string;
      changedPlanOrRoute?: boolean;
      usefulRating?: 'YES' | 'SOMEWHAT' | 'NO' | null;
      feedbackNote?: string;
    }
  ) => Promise<void>;
  notificationPermission: NotificationPermission | 'unsupported';
  onRequestNotificationPermission: () => Promise<void>;
}

export const TripsAndAlertsView: React.FC<TripsAndAlertsViewProps> = ({
  mode,
  journeys,
  alerts,
  sessions,
  onUpdateJourney,
  notificationPermission,
  onRequestNotificationPermission,
}) => {
  const [editingJourneyId, setEditingJourneyId] = useState<string | null>(null);
  const [editDepHhmm, setEditDepHhmm] = useState('');
  const [editArrHhmm, setEditArrHhmm] = useState('');
  const [editChangedRoute, setEditChangedRoute] = useState(false);
  const [editUseful, setEditUseful] = useState<'YES' | 'SOMEWHAT' | 'NO' | null>(null);
  const [editNote, setEditNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const openEditor = (j: JourneyRecord) => {
    setEditingJourneyId(j.id);
    setEditDepHhmm(j.actualDepartureTimeIst);
    setEditArrHhmm(j.actualArrivalTimeIst || getNowIstParts().timeIst);
    setEditChangedRoute(j.changedPlanOrRoute);
    setEditUseful(j.usefulRating ?? null);
    setEditNote(j.feedbackNote || '');
  };

  const handleSaveEdit = async (journeyId: string) => {
    setSubmitting(true);
    try {
      await onUpdateJourney(journeyId, {
        actualDepartureHhmm: editDepHhmm,
        actualArrivalHhmm: editArrHhmm,
        changedPlanOrRoute: editChangedRoute,
        usefulRating: editUseful,
        feedbackNote: editNote,
      });
      setEditingJourneyId(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (mode === 'ALERTS') {
    const totalSuppressed = sessions.reduce(
      (acc, s) => acc + (s.suppressedDuplicatesCount || 0),
      0
    );

    return (
      <div className="space-y-6 pb-24">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
              Notification History &amp; Delivery Status
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Chronological log of departure reminders, +5 min ETA deterioration warnings, and deadline threat alerts. Minor fluctuations and duplicates are automatically suppressed.
            </p>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            <span>Alerts issued: {alerts.length}</span>
            <span aria-hidden="true"> · </span>
            <span>Duplicates suppressed today: {totalSuppressed}</span>
          </div>
        </div>

        {/* Honest Notification Infrastructure Banner */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Delivery Mode: In-App Live Polling + Opt-In Browser Notifications (Foreground-Verified)
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              The Express server runs a durable in-process 5-minute refresh scheduler while the container is active. Closed-tab background Web Push requires configuring VAPID keys (<span className="font-mono">VAPID_PUBLIC_KEY</span> / <span className="font-mono">VAPID_PRIVATE_KEY</span>) and a persistent Cloud Scheduler worker. We do not claim browser timers continue after tab closure.
            </p>
          </div>
          {notificationPermission !== 'granted' &&
            notificationPermission !== 'unsupported' && (
              <button
                type="button"
                onClick={onRequestNotificationPermission}
                className="min-h-[44px] px-4 py-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-semibold rounded-xl whitespace-nowrap shrink-0"
              >
                Enable Browser Alerts
              </button>
            )}
        </div>

        {alerts.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-10 text-center space-y-2">
            <Bell className="w-8 h-8 text-slate-400 mx-auto" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              No commute alerts recorded yet
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Start monitoring on the Today Dashboard. You will receive a departure reminder for your selected plan and an alert if your predicted arrival deteriorates by 5+ minutes or threatens your arrival deadline.
            </p>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl divide-y divide-slate-100 dark:divide-slate-800">
            {alerts.map((alert) => (
              <div key={alert.id} className="p-5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {alert.severity === 'CRITICAL' || alert.severity === 'WARNING' ? (
                      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                    ) : (
                      <Bell className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                    )}
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {alert.title}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>{alert.createdAtIst}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{alert.type.replace(/_/g, ' ')}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{alert.deliveredChannels.join(' + ')}</span>
                  </div>
                </div>

                <p className="text-sm text-slate-800 dark:text-slate-200 font-medium leading-relaxed">
                  {alert.message}
                </p>

                {(alert.previousEtaIst || alert.newEtaIst) && (
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    {alert.previousEtaIst && (
                      <>
                        <span>Previous ETA: {alert.previousEtaIst}</span>
                        <span aria-hidden="true"> · </span>
                      </>
                    )}
                    {alert.newEtaIst && <span>Updated ETA: {alert.newEtaIst}</span>}
                    {alert.deadlineIst && (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span>Deadline: {alert.deadlineIst}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Personal Trip History & Journey Completion View
  const uncompletedJourneys = journeys.filter((j) => !j.metrics.isCompleted);

  return (
    <div className="space-y-6 pb-24">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Personal Trip History &amp; ETA Verification
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Confirm actual arrival times, provide optional usefulness feedback, or correct manually entered journey times. Original recorded ETA snapshots remain strictly immutable.
          </p>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
          <span>Total recorded: {journeys.length}</span>
          <span aria-hidden="true"> · </span>
          <span>Awaiting arrival: {uncompletedJourneys.length}</span>
        </div>
      </div>

      {journeys.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-10 text-center space-y-2">
          <Clock className="w-8 h-8 text-slate-400 mx-auto" />
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No personal trips recorded yet
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            When you press &ldquo;I&rsquo;ve left&rdquo; on the Today Dashboard, ORR Pulse captures an immutable snapshot of your communicated ETA so you can confirm your arrival time and measure 5-minute accuracy.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {journeys.map((j) => {
            const isEditing = editingJourneyId === j.id;
            const isLateOver5 = j.metrics.lateOver5MinVsDeparture === true;
            const errDep = j.metrics.errorVsDepartureMin;
            const errSel = j.metrics.errorVsSelectedMin;

            return (
              <div
                key={j.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      <span>{j.dateIst}</span>
                      <span aria-hidden="true"> · </span>
                      <span>
                        {j.direction === 'HOME_TO_WORK'
                          ? 'Home → Work'
                          : 'Work → Home'}
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span>Mode: {j.transportMode}</span>
                      <span aria-hidden="true"> · </span>
                      <span>
                        Dataset:{' '}
                        {j.environment === 'DEMO'
                          ? 'Labeled Demo Synthetic'
                          : 'Live Pilot Record'}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mt-1">
                      {j.originLabel} → {j.destinationLabel}
                    </h3>
                  </div>

                  <div className="flex items-center gap-3">
                    {!j.metrics.isCompleted ? (
                      <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                        In Progress — Confirm Arrival Below
                      </span>
                    ) : isLateOver5 ? (
                      <span className="text-xs font-semibold text-rose-700 dark:text-rose-400 flex items-center gap-1">
                        <AlertTriangle className="w-4 h-4" />
                        <span>
                          Trust Failure: +{errDep} min vs Departure ETA (&gt;5m threshold)
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>
                          Within 5-Min Target ({errDep !== null && errDep > 0 ? `+${errDep}` : errDep} min vs Departure ETA)
                        </span>
                      </span>
                    )}

                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => openEditor(j)}
                        className="min-h-[40px] px-3 py-1.5 text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-xl hover:bg-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>
                          {j.metrics.isCompleted
                            ? 'Correct Actual Times'
                            : 'Confirm Arrival'}
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Immutable Snapshots vs Actual Confirmed Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 space-y-1">
                    <div className="text-[11px] font-medium text-slate-500">
                      1. Estimate When Option Selected (Immutable)
                    </div>
                    {j.selectedEstimate ? (
                      <>
                        <div className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                          ETA {j.selectedEstimate.predictedArrivalTimeIst} IST ({j.selectedEstimate.predictedDurationMin} min)
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                          Issued at {j.selectedEstimate.issuedAtIst} · {j.selectedEstimate.estimateBasis}
                        </div>
                        {errSel !== null && (
                          <div className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400 pt-0.5">
                            Error vs Selected: {errSel > 0 ? `+${errSel}` : errSel} min (Abs: {j.metrics.absErrorVsSelectedMin}m)
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-xs text-slate-500">No prior selection recorded</div>
                    )}
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 space-y-1">
                    <div className="text-[11px] font-medium text-slate-500">
                      2. Estimate When &ldquo;I&rsquo;ve Left&rdquo; Pressed (Immutable)
                    </div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      ETA {j.departureEstimate.predictedArrivalTimeIst} IST ({j.departureEstimate.predictedDurationMin} min)
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                      Issued at {j.departureEstimate.issuedAtIst} · {j.departureEstimate.estimateBasis}
                    </div>
                    {errDep !== null && (
                      <div className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400 pt-0.5">
                        Error vs Departure: {errDep > 0 ? `+${errDep}` : errDep} min (Abs: {j.metrics.absErrorVsDepartureMin}m)
                      </div>
                    )}
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 space-y-1">
                    <div className="text-[11px] font-medium text-slate-500">
                      3. User-Confirmed Actual Journey
                    </div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      Left {j.actualDepartureTimeIst} →{' '}
                      {j.actualArrivalTimeIst
                        ? `Arrived ${j.actualArrivalTimeIst} (${j.metrics.actualDurationMin} min)`
                        : 'Arrival Unconfirmed'}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      <span>Changed plan/route: {j.changedPlanOrRoute ? 'Yes' : 'No'}</span>
                      <span aria-hidden="true"> · </span>
                      <span>Useful: {j.usefulRating || 'Unrated'}</span>
                      {j.correctionHistoryCount > 0 && (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span>Corrected {j.correctionHistoryCount}x</span>
                        </>
                      )}
                    </div>
                    {j.feedbackNote && (
                      <div className="text-xs text-slate-600 dark:text-slate-400 italic pt-0.5">
                        &ldquo;{j.feedbackNote}&rdquo;
                      </div>
                    )}
                  </div>
                </div>

                {/* Inline Journey Completion / Manual Time Correction Form */}
                {isEditing && (
                  <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-4 bg-slate-50/70 dark:bg-slate-950/60 p-4 rounded-xl">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        Confirm or Correct Actual Journey Times (Original Estimates Remain Immutable)
                      </h4>
                      <span className="text-[11px] font-mono text-slate-500">
                        Asia/Kolkata (IST)
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Actual Departure Time (IST)
                        </label>
                        <input
                          type="time"
                          value={editDepHhmm}
                          onChange={(e) => setEditDepHhmm(e.target.value)}
                          className="w-full min-h-[44px] px-3 py-2 text-sm font-mono tabular-nums bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Actual Arrival Time (IST)
                        </label>
                        <input
                          type="time"
                          value={editArrHhmm}
                          onChange={(e) => setEditArrHhmm(e.target.value)}
                          className="w-full min-h-[44px] px-3 py-2 text-sm font-mono tabular-nums bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl"
                        />
                      </div>

                      <div className="flex items-end pb-2">
                        <label className="flex items-center gap-2.5 cursor-pointer text-xs font-medium text-slate-800 dark:text-slate-200">
                          <input
                            type="checkbox"
                            checked={editChangedRoute}
                            onChange={(e) => setEditChangedRoute(e.target.checked)}
                            className="w-4 h-4 accent-teal-600 rounded"
                          />
                          <span>Changed plan or route after leaving</span>
                        </label>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Was this recommendation useful? (Optional)
                        </label>
                        <div className="flex gap-2">
                          {(['YES', 'SOMEWHAT', 'NO'] as const).map((rating) => (
                            <button
                              key={rating}
                              type="button"
                              onClick={() => setEditUseful(rating)}
                              className={`min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-colors ${
                                editUseful === rating
                                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                                  : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {rating === 'YES'
                                ? 'Yes'
                                : rating === 'SOMEWHAT'
                                ? 'Somewhat'
                                : 'No'}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Commute Note (Optional)
                        </label>
                        <input
                          type="text"
                          value={editNote}
                          onChange={(e) => setEditNote(e.target.value)}
                          placeholder="e.g. Heavy bottleneck at Bellandur flyover..."
                          className="w-full min-h-[40px] px-3 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => setEditingJourneyId(null)}
                        className="min-h-[40px] px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => handleSaveEdit(j.id)}
                        className="min-h-[40px] px-5 py-2 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-xl"
                      >
                        {submitting ? 'Saving...' : 'Save Confirmed Times'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
