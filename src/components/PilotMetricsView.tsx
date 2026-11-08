import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  ApiQuotaStatus,
  DataEnvironment,
  PilotMetricsReport,
  TransportMode,
} from '../types/commute';
import { runAllVerificationSuites } from '../lib/verificationSuite';

interface PilotMetricsViewProps {
  token: string;
  quota: ApiQuotaStatus;
  onUpdateQuotaLimit: (newLimit: number) => Promise<void>;
}

export const PilotMetricsView: React.FC<PilotMetricsViewProps> = ({
  token,
  quota,
  onUpdateQuotaLimit,
}) => {
  const [metricsEnv, setMetricsEnv] = useState<DataEnvironment>('LIVE');
  const [report, setReport] = useState<PilotMetricsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [customLimit, setCustomLimit] = useState(String(quota.dailyLimit));
  const [verificationSummary, setVerificationSummary] = useState(() =>
    runAllVerificationSuites()
  );

  const fetchMetrics = async (env: DataEnvironment) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/pilot/metrics?environment=${env}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setReport(data.report);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics(metricsEnv);
  }, [metricsEnv, token]);

  const modesOrder: Array<{ mode: TransportMode; label: string }> = [
    { mode: 'BIKE', label: 'Bike (Two-Wheeler)' },
    { mode: 'CAR', label: 'Car (Traffic-Aware)' },
    { mode: 'BMTC', label: 'BMTC Bus (Timetable)' },
  ];

  return (
    <div className="space-y-8 pb-24">
      {/* Header & Environment Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Restricted Pilot Metrics &amp; Readiness Report
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Aggregate ETA reliability evaluation only. Individual employee home addresses and personal trip timelines are never exposed here. Arriving &gt;5 minutes later than the communicated ETA counts as a trust failure.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
            <button
              type="button"
              onClick={() => setMetricsEnv('LIVE')}
              className={`min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                metricsEnv === 'LIVE'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              Live Pilot Metrics
            </button>
            <button
              type="button"
              onClick={() => setMetricsEnv('DEMO')}
              className={`min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                metricsEnv === 'DEMO'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              Labeled Demo Dataset
            </button>
          </div>
          <button
            type="button"
            onClick={() => fetchMetrics(metricsEnv)}
            className="min-h-[40px] px-3 py-1.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl hover:bg-slate-200"
            title="Refresh Aggregate Metrics"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Dataset Status Notice */}
      {report && (
        <div
          className={`p-4 rounded-2xl border text-xs leading-relaxed ${
            metricsEnv === 'LIVE'
              ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
              : 'bg-amber-50/80 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
          }`}
        >
          <div className="font-semibold text-sm mb-1">
            {metricsEnv === 'LIVE'
              ? 'Live Pilot Evaluation Status (Strictly Isolated from Demo Data)'
              : 'Labeled Demo Sandbox Metrics (Synthetic Verification Dataset)'}
          </div>
          <p>{report.meetsFiveMinuteTargetStatus}</p>
        </div>
      )}

      {/* Top Aggregate KPI Strip */}
      {report && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Completed / Missing Journeys
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {report.totalCompletedJourneys} completed · {report.totalMissingMeasurements} missing
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono">
              Status: {report.overallSampleStatus} (n={report.totalCompletedJourneys})
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Median Abs Error vs Departure ETA
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {report.overallMedianAbsErrorVsDepartureMin !== null
                ? `${report.overallMedianAbsErrorVsDepartureMin} min`
                : 'Unmeasured'}
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
              vs Selected Option:{' '}
              {report.overallMedianAbsErrorVsSelectedMin !== null
                ? `${report.overallMedianAbsErrorVsSelectedMin} min`
                : 'Unmeasured'}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              &gt;5 Min Late Rate (vs Departure ETA)
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {report.overallLateOver5MinVsDeparturePct !== null
                ? `${report.overallLateOver5MinVsDeparturePct}%`
                : 'Unmeasured'}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Trust failure threshold: &gt;5 min late
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              &gt;5 Min Late Rate (vs Selected ETA)
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {report.overallLateOver5MinVsSelectedPct !== null
                ? `${report.overallLateOver5MinVsSelectedPct}%`
                : 'Unmeasured'}
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
              Updated {report.generatedAtIst}
            </div>
          </div>
        </div>
      )}

      {/* Breakdown by Transport Mode Table */}
      {report && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Aggregate Results by Transport Mode ({metricsEnv} Dataset)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Bike (Two-Wheeler), Car, and BMTC Bus are evaluated separately. No invented confidence scores are shown.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-400 bg-slate-50/60 dark:bg-slate-950/60">
                  <th className="py-3 px-4">Transport Mode</th>
                  <th className="py-3 px-4">Sample Status</th>
                  <th className="py-3 px-4 text-right">Completed (n)</th>
                  <th className="py-3 px-4 text-right">Missing</th>
                  <th className="py-3 px-4 text-right">Median Abs Error (Selected)</th>
                  <th className="py-3 px-4 text-right">Median Abs Error (Departure)</th>
                  <th className="py-3 px-4 text-right">&gt;5m Late vs Selected</th>
                  <th className="py-3 px-4 text-right">&gt;5m Late vs Departure</th>
                  <th className="py-3 px-4 text-right">Changed Route</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {modesOrder.map(({ mode, label }) => {
                  const row = report.byMode[mode];
                  return (
                    <tr
                      key={mode}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-3.5 px-4 font-semibold text-slate-900 dark:text-slate-100">
                        {label}
                      </td>
                      <td className="py-3.5 px-4 font-mono">
                        {row.sampleStatus === 'MEASURED' ? (
                          <span className="text-teal-700 dark:text-teal-400 font-semibold">
                            MEASURED (n={row.completedCount})
                          </span>
                        ) : (
                          <span className="text-slate-400">UNMEASURED (n=0)</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                        {row.completedCount}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-500">
                        {row.missingMeasurementsCount}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                        {row.medianAbsErrorVsSelectedMin !== null
                          ? `${row.medianAbsErrorVsSelectedMin} min`
                          : '—'}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold">
                        {row.medianAbsErrorVsDepartureMin !== null
                          ? `${row.medianAbsErrorVsDepartureMin} min`
                          : '—'}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                        {row.lateOver5MinVsSelectedPct !== null
                          ? `${row.lateOver5MinVsSelectedPct}%`
                          : '—'}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold">
                        {row.lateOver5MinVsDeparturePct !== null
                          ? `${row.lateOver5MinVsDeparturePct}% (${row.lateOver5MinVsDepartureCount}/${row.completedCount})`
                          : '—'}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                        {row.changedPlanCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* API Request Quota & Budget Safeguards */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              API Cost &amp; Quota Safeguard ({quota.dateIst} IST)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Polling is restricted to active commute windows. Raw Google Maps traffic payloads are never persisted.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600 dark:text-slate-400">
              Daily Cap:
            </label>
            <input
              type="number"
              min={10}
              max={10000}
              value={customLimit}
              onChange={(e) => setCustomLimit(e.target.value)}
              className="w-24 min-h-[40px] px-3 py-1.5 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl"
            />
            <button
              type="button"
              onClick={() => onUpdateQuotaLimit(Number(customLimit) || 500)}
              className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-xl"
            >
              Update Cap
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs font-mono tabular-nums">
          <div>
            <span className="text-slate-500 block font-sans">Total Used Today</span>
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {quota.requestsUsedToday} / {quota.dailyLimit}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Routes API v2 Calls</span>
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {quota.routesRequests}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Places API (New) Calls</span>
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {quota.placesRequests}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block font-sans">Provider Status</span>
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {quota.lastProviderStatus}
            </span>
          </div>
        </div>
      </section>

      {/* Automated Verification Suite & Pilot Readiness Disclosure */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Automated Verification Suite ({verificationSummary.passedTests}/{verificationSummary.totalTests} Passed)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Executed {verificationSummary.totalAssertions} assertions at {verificationSummary.executedAtIst}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setVerificationSummary(runAllVerificationSuites())}
              className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold bg-teal-700 hover:bg-teal-800 text-white rounded-xl flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Re-Run Verification</span>
            </button>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {verificationSummary.results.map((r) => (
              <div key={r.id} className="py-3.5 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {r.category}: {r.name}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-slate-500 whitespace-nowrap shrink-0">
                    {r.assertionsRun} assertions · PASS
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 pl-6 leading-relaxed">
                  {r.evidence}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Honest Pilot Readiness Report */}
        <section className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
            <ShieldCheck className="w-5 h-5 text-teal-600 dark:text-teal-400 shrink-0" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Pilot Readiness &amp; Infrastructure Disclosure
            </h2>
          </div>

          <div className="space-y-3 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">
                1. What Works End-to-End
              </div>
              <p>
                Per-user authenticated commute setup (Home/Work + separate Morning/Evening schedules in Asia/Kolkata), up to 3 deduplicated departure recommendations, 5-minute active monitoring refresh, +5 min ETA deterioration &amp; deadline threat alerts, &ldquo;I&rsquo;ve left&rdquo; / Snooze 10m / Skip Today / Stop controls, immutable ETA snapshots, journey time corrections, and aggregate pilot metrics.
              </p>
            </div>

            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">
                2. Live Integrations vs. Labeled Demo Mode
              </div>
              <p>
                Live server-side routing uses Google Maps Platform Routes API v2 (<span className="font-mono">DRIVE</span>, <span className="font-mono">TWO_WHEELER</span>, <span className="font-mono">TRANSIT/BUS</span>) and Places API (New) Text Search. When testing without live API consumption, Labeled Demo Mode runs synthetic ORR traffic curves and keeps demo records strictly separated from Live Pilot Metrics.
              </p>
            </div>

            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">
                3. BMTC Live Feed &amp; Background Push Limitations
              </div>
              <p>
                BMTC bus recommendations in Google Maps Transit are based on scheduled GTFS timetables; live BMTC GPS bus locations are unavailable and are never fabricated. Monitoring runs in-app and via an in-process Node.js server interval while the container is running; closed-tab mobile Web Push was not tested on a physical mobile device and requires VAPID keys (<span className="font-mono">VAPID_PUBLIC_KEY</span>, <span className="font-mono">VAPID_PRIVATE_KEY</span>) plus an external Cloud Scheduler / always-on instance.
              </p>
            </div>

            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">
                4. Five-Minute ETA Reliability Target
              </div>
              <p>
                ORR Pulse does not claim to meet the 5-minute ETA accuracy target upfront. It instruments and measures whether actual arrivals exceed communicated ETAs by &gt;5 minutes across real pilot trips.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
