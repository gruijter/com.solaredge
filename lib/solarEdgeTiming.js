/*
Copyright 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.solaredge.

com.solaredge is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.solaredge is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.solaredge.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

/*
Energy tick right after SolarEdge has new inverter data. Measured (2026-10-15, site 1665942): the
inverter's lastMeasurement moves once per exactly 300 s, always at the same second (12:40:28,
12:45:28, ...), and is served within ~5 s; the energy overview changes at the same moments. The
powerflow is real time and keeps its own fast tick. Same approach as com.foxess lib/foxEssTiming.js.
*/

const PERIOD_MS = 5 * 60 * 1000;

const MARGIN_MS = 20 * 1000;
const MARGIN_STEP_MS = 15 * 1000;
const MARGIN_DECAY_MS = 5 * 1000;
const MAX_MARGIN_MS = 2 * 60 * 1000;

// snapshots of one account further apart than this fall back to the period boundary
const MAX_SPREAD_MS = 60 * 1000;

/**
 * The site's upload interval after a new snapshot: the shortest seen, at least the period. Sites
 * that upload less often (e.g. every 15 minutes) have no new snapshot on most ticks.
 * @param {number|undefined} cadenceMs the interval so far, undefined before the first
 * @param {number} gapMs the time between an inverter's last two snapshots
 */
const learnCadence = (cadenceMs, gapMs) => Math.max(PERIOD_MS, Math.min(cadenceMs || Infinity, gapMs));

/**
 * Whether a tick that found snapshot `atMs` (the one before was `previousMs`) says anything about
 * the margin: a new snapshot always does; the old one again only when a new one was due by now. A
 * snapshot older than one period past its due time is not current (e.g. the inverter sleeps at
 * night): it does not judge a tick.
 */
const judgesTick = ({
  previousMs, atMs, nowMs, cadenceMs = PERIOD_MS,
}) => {
  const age = nowMs - atMs;
  if (age >= cadenceMs + PERIOD_MS) return false;
  return atMs > previousMs || age >= cadenceMs;
};

/**
 * The tick's position within the period, from the snapshot moments of all known inverters.
 * @param {number[]} snapshotMs epoch ms of the latest snapshot of each inverter
 * @returns {number} ms after the period boundary; 0 when unknown or too spread out
 */
const tickPhase = (snapshotMs, marginMs = MARGIN_MS, periodMs = PERIOD_MS) => {
  const phases = snapshotMs.filter((t) => Number.isFinite(t)).map((t) => ((t % periodMs) + periodMs) % periodMs);
  if (!phases.length) return 0;
  // spread on a circle: the smallest arc that holds them all
  const sorted = [...phases].sort((a, b) => a - b);
  let widestGap = sorted[0] + periodMs - sorted[sorted.length - 1];
  let last = sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > widestGap) {
      widestGap = gap;
      last = sorted[i - 1];
    }
  }
  if (periodMs - widestGap > MAX_SPREAD_MS) return 0;
  return (last + marginMs) % periodMs;
};

/**
 * The margin after a tick: longer when it got no new snapshot, shorter when it did.
 * @param {number} marginMs the current margin
 * @param {boolean} gotNew whether the tick brought a snapshot newer than the one before it
 * @returns {number} the next margin
 */
const adaptMargin = (marginMs, gotNew) => (gotNew
  ? Math.max(MARGIN_MS, marginMs - MARGIN_DECAY_MS)
  : Math.min(MAX_MARGIN_MS, marginMs + MARGIN_STEP_MS));

/**
 * Time until the next moment at `phaseMs` after a period boundary, at least a second away.
 * @returns {number} ms
 */
const delayToNextTick = (nowMs, phaseMs, periodMs = PERIOD_MS) => {
  const next = Math.floor((nowMs - phaseMs) / periodMs) * periodMs + phaseMs + periodMs;
  return next - nowMs < 1000 ? next - nowMs + periodMs : next - nowMs;
};

module.exports = {
  PERIOD_MS,
  MARGIN_MS,
  MAX_MARGIN_MS,
  learnCadence,
  judgesTick,
  tickPhase,
  adaptMargin,
  delayToNextTick,
};
