import React, { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  CommuteDirection,
  DataEnvironment,
  DepartureOption,
  LocationPoint,
  TransportMode,
} from '../types/commute';
import {
  computeDemoSlotPrediction,
  hhmmToMinutes,
  minutesToHhmm,
} from '../lib/commuteEngine';

export interface DurationTrendPoint {
  timeIst: string; // "HH:mm"
  minutesAgo: number; // 180 down to 0
  durationMin: number;
  staticDurationMin: number;
  sourceLabel: 'Observed Refresh' | 'Current Live' | 'Static Baseline' | 'Demo 3h Curve';
}

interface CommuteTrendMiniChartProps {
  origin: LocationPoint | null;
  destination: LocationPoint;
  direction: CommuteDirection;
  mode: TransportMode;
  environment: DataEnvironment;
  currentIstHhmm: string;
  dateIst: string;
  selectedOption: DepartureOption | null;
  observedHistory: Array<{ timeIst: string; durationMin: number; staticDurationMin?: number }>;
}

export const CommuteTrendMiniChart: React.FC<CommuteTrendMiniChartProps> = ({
  origin,
  destination,
  mode,
  environment,
  currentIstHhmm,
  dateIst,
  selectedOption,
  observedHistory,
}) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const trendPoints = useMemo<DurationTrendPoint[]>(() => {
    if (!origin) return [];

    const nowTotalMin = hhmmToMinutes(currentIstHhmm);
    const points: DurationTrendPoint[] = [];

    // Generate 13 intervals over the last 3 hours (180 mins ago to Now, step = 15 mins)
    const stepsAgo = [180, 165, 150, 135, 120, 105, 90, 75, 60, 45, 30, 15, 0];

    const fallbackDuration = selectedOption?.predictedDurationMin ?? 35;
    const fallbackStatic =
      selectedOption?.staticDurationMin ?? Math.max(15, Math.round(fallbackDuration * 0.78));

    for (const minsAgo of stepsAgo) {
      const slotMin = nowTotalMin - minsAgo;
      const slotHhmm = minutesToHhmm(slotMin);

      if (environment === 'DEMO') {
        const slotIso = new Date(`${dateIst}T${slotHhmm}:00+05:30`).toISOString();
        const demoRes = computeDemoSlotPrediction({
          origin,
          destination,
          mode,
          departureTimeIst: slotHhmm,
          departureIso: slotIso,
          isNowSlot: minsAgo === 0,
        });
        const dur =
          minsAgo === 0 && selectedOption
            ? selectedOption.predictedDurationMin
            : demoRes.prediction?.predictedDurationMin ?? fallbackDuration;
        const stat =
          demoRes.prediction?.staticDurationMin ?? fallbackStatic;

        points.push({
          timeIst: slotHhmm,
          minutesAgo: minsAgo,
          durationMin: dur,
          staticDurationMin: stat,
          sourceLabel: 'Demo 3h Curve',
        });
      } else {
        // LIVE Mode: Never fabricate unpolled live traffic history.
        // Match any observed session refresh within ±7 minutes of this slot,
        // use selectedOption for Now (minsAgo === 0), and use the route's staticDurationMin baseline otherwise.
        if (minsAgo === 0 && selectedOption) {
          points.push({
            timeIst: slotHhmm,
            minutesAgo: 0,
            durationMin: selectedOption.predictedDurationMin,
            staticDurationMin: fallbackStatic,
            sourceLabel: 'Current Live',
          });
          continue;
        }

        const matchedObs = observedHistory.find(
          (obs) => Math.abs(hhmmToMinutes(obs.timeIst) - slotMin) <= 7
        );

        if (matchedObs) {
          points.push({
            timeIst: matchedObs.timeIst,
            minutesAgo: minsAgo,
            durationMin: matchedObs.durationMin,
            staticDurationMin: matchedObs.staticDurationMin ?? fallbackStatic,
            sourceLabel: 'Observed Refresh',
          });
        } else {
          points.push({
            timeIst: slotHhmm,
            minutesAgo: minsAgo,
            durationMin: fallbackStatic,
            staticDurationMin: fallbackStatic,
            sourceLabel: 'Static Baseline',
          });
        }
      }
    }

    return points;
  }, [
    origin,
    destination,
    mode,
    environment,
    currentIstHhmm,
    dateIst,
    selectedOption,
    observedHistory,
  ]);

  if (!origin || trendPoints.length === 0) {
    return null;
  }

  const durations = trendPoints.map((p) => p.durationMin);
  const minDur = Math.min(...durations);
  const maxDur = Math.max(...durations);
  const currentDur = trendPoints[trendPoints.length - 1].durationMin;
  const staticBaseline = trendPoints[trendPoints.length - 1].staticDurationMin;
  const spreadMin = maxDur - minDur;

  const inspectIdx = activeIndex !== null ? activeIndex : trendPoints.length - 1;
  const inspectedPoint = trendPoints[inspectIdx] || trendPoints[trendPoints.length - 1];
  const deltaVsStatic = inspectedPoint.durationMin - inspectedPoint.staticDurationMin;

  // SVG coordinate math
  const svgWidth = 640;
  const svgHeight = 148;
  const padLeft = 36;
  const padRight = 16;
  const padTop = 18;
  const padBottom = 26;
  const plotWidth = svgWidth - padLeft - padRight;
  const plotHeight = svgHeight - padTop - padBottom;

  const yFloor = Math.max(5, Math.min(minDur, staticBaseline) - 6);
  const yCeil = Math.max(maxDur, staticBaseline) + 6;
  const ySpan = Math.max(8, yCeil - yFloor);

  const getX = (idx: number) =>
    padLeft + (idx / Math.max(1, trendPoints.length - 1)) * plotWidth;
  const getY = (val: number) =>
    padTop + plotHeight - ((val - yFloor) / ySpan) * plotHeight;

  const polylinePoints = trendPoints
    .map((pt, i) => `${getX(i).toFixed(1)},${getY(pt.durationMin).toFixed(1)}`)
    .join(' ');

  const areaPath = `M ${getX(0).toFixed(1)} ${(padTop + plotHeight).toFixed(1)} L ${trendPoints
    .map((pt, i) => `${getX(i).toFixed(1)} ${getY(pt.durationMin).toFixed(1)}`)
    .join(' L ')} L ${getX(trendPoints.length - 1).toFixed(1)} ${(
    padTop + plotHeight
  ).toFixed(1)} Z`;

  const baselineY = getY(staticBaseline);

  const modeLabel =
    mode === 'BIKE'
      ? 'Bike (Two-Wheeler)'
      : mode === 'CAR'
      ? 'Car (Traffic-Aware)'
      : 'BMTC Bus (Timetable)';

  return (
    <section
      aria-label="Last 3 Hours Commute Duration Trend"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4"
    >
      {/* Header & Summary KPIs */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Last 3 Hours Commute Duration Trend ({trendPoints[0].timeIst}–{currentIstHhmm} IST)
            </h2>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            <span>Selected Route: {selectedOption?.corridorSummary || `${origin.label.split(',')[0]} → ${destination.label.split('(')[0].trim()}`}</span>
            <span aria-hidden="true"> · </span>
            <span>Mode: {modeLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>
              {environment === 'DEMO'
                ? 'Source: Labeled Demo 15-Min Corridor Curve'
                : 'Source: Live Session Refreshes + Static Baseline'}
            </span>
          </p>
        </div>

        {/* Unboxed Tabular KPI Summary */}
        <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
          <span>
            3h Low: <strong className="text-slate-900 dark:text-slate-100">{minDur}m</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            3h Peak: <strong className="text-slate-900 dark:text-slate-100">{maxDur}m</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Now: <strong className="text-teal-700 dark:text-teal-400">{currentDur}m</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Spread: <strong className="text-slate-900 dark:text-slate-100">{spreadMin}m</strong>
          </span>
        </div>
      </div>

      {/* SVG Mini Trend Chart */}
      <div className="relative bg-slate-50/80 dark:bg-slate-950/60 border border-slate-100 dark:border-slate-800/80 rounded-xl p-3">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-36 overflow-visible select-none"
          role="img"
          aria-label={`Line chart showing commute duration between ${minDur} and ${maxDur} minutes over the past 3 hours`}
        >
          <defs>
            <linearGradient id="orrTrendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0d9488" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#0d9488" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Horizontal Y-Axis Gridlines */}
          {[yFloor, Math.round((yFloor + yCeil) / 2), yCeil].map((tickVal, idx) => {
            const yPos = getY(tickVal);
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={yPos}
                  x2={svgWidth - padRight}
                  y2={yPos}
                  stroke="currentColor"
                  className="text-slate-200 dark:text-slate-800"
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 6}
                  y={yPos + 3}
                  textAnchor="end"
                  className="fill-slate-400 dark:fill-slate-500 text-[10px] font-mono"
                >
                  {tickVal}m
                </text>
              </g>
            );
          })}

          {/* Static Free-Flow Baseline Reference Line */}
          <line
            x1={padLeft}
            y1={baselineY}
            x2={svgWidth - padRight}
            y2={baselineY}
            stroke="currentColor"
            className="text-slate-400 dark:text-slate-600"
            strokeWidth="1"
            strokeDasharray="4 4"
          />

          {/* Shaded Area under Duration Curve */}
          <path d={areaPath} fill="url(#orrTrendFill)" />

          {/* Duration Trend Polyline */}
          <polyline
            fill="none"
            stroke="#0d9488"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={polylinePoints}
          />

          {/* Interactive Data Points & X-Axis Labels */}
          {trendPoints.map((pt, i) => {
            const cx = getX(i);
            const cy = getY(pt.durationMin);
            const isSelected = inspectIdx === i;
            const isPeak = pt.durationMin === maxDur && spreadMin > 0;
            const showTimeLabel = i % 3 === 0 || i === trendPoints.length - 1;

            return (
              <g
                key={pt.timeIst}
                className="cursor-pointer"
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => setActiveIndex(i)}
              >
                {/* Invisible wider touch target column for mobile thumb scrubbing */}
                <rect
                  x={cx - plotWidth / (trendPoints.length * 2)}
                  y={padTop}
                  width={plotWidth / trendPoints.length}
                  height={plotHeight + 20}
                  fill="transparent"
                />

                {isSelected && (
                  <line
                    x1={cx}
                    y1={padTop}
                    x2={cx}
                    y2={padTop + plotHeight}
                    stroke="#0d9488"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                )}

                <circle
                  cx={cx}
                  cy={cy}
                  r={isSelected ? 5 : isPeak ? 4 : 3}
                  className={
                    isSelected
                      ? 'fill-teal-600 stroke-white dark:stroke-slate-900 stroke-2'
                      : isPeak
                      ? 'fill-amber-600 stroke-white dark:stroke-slate-900 stroke-1'
                      : pt.sourceLabel === 'Static Baseline'
                      ? 'fill-slate-400 dark:fill-slate-600'
                      : 'fill-teal-600 dark:fill-teal-400'
                  }
                />

                {showTimeLabel && (
                  <text
                    x={cx}
                    y={svgHeight - 6}
                    textAnchor="middle"
                    className={`text-[10px] font-mono ${
                      isSelected
                        ? 'fill-slate-900 dark:fill-slate-100 font-semibold'
                        : 'fill-slate-400 dark:fill-slate-500'
                    }`}
                  >
                    {i === trendPoints.length - 1 ? `Now (${pt.timeIst})` : pt.timeIst}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Inspected Point Details Bar */}
        <div className="mt-2 pt-2 border-t border-slate-200/70 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums">
          <div className="text-slate-700 dark:text-slate-300">
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {inspectedPoint.minutesAgo === 0
                ? `Current (${inspectedPoint.timeIst} IST)`
                : `${inspectedPoint.timeIst} IST (${inspectedPoint.minutesAgo}m ago)`}
            </span>
            <span aria-hidden="true"> · </span>
            <span className="font-bold text-teal-700 dark:text-teal-400">
              {inspectedPoint.durationMin} min
            </span>
            <span aria-hidden="true"> · </span>
            <span>
              {deltaVsStatic > 0
                ? `+${deltaVsStatic} min congestion vs ${inspectedPoint.staticDurationMin}m baseline`
                : `At ${inspectedPoint.staticDurationMin}m baseline`}
            </span>
          </div>
          <div className="text-[11px] text-slate-500">
            <span>Basis: {inspectedPoint.sourceLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>Tap or hover points to inspect</span>
          </div>
        </div>
      </div>
    </section>
  );
};
