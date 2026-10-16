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
Raw registers in the app log, so a user's diagnostics report doubles as test material. Each
Modbus device logs its identity, detection and first poll once per (re)start, in chunks, as
lib/solarEdgeCapture.js does for the cloud API responses. Copied from com.solarwatt.
*/

const START = '===SOLAREDGE-MODBUS-CAPTURE-START';
const END = '===SOLAREDGE-MODBUS-CAPTURE-END';
const CHUNK = 700; // characters per log line
const MAX_BYTES = 32 * 1024;

/** { "37609": "0d2a00fa…" }: each run of consecutive addresses as 4 hex digits per register. */
const toRuns = (registers) => {
  const runs = {};
  let start;
  let previous;
  for (const address of [...registers.keys()].sort((a, b) => a - b)) {
    if (previous === undefined || address !== previous + 1) {
      start = address;
      runs[start] = '';
    }
    runs[start] += registers.get(address).toString(16).padStart(4, '0');
    previous = address;
  }
  return runs;
};

/** The register map back from toRuns. */
const fromRuns = (runs) => {
  const registers = new Map();
  for (const [start, hex] of Object.entries(runs || {})) {
    for (let i = 0; i * 4 < hex.length; i += 1) {
      registers.set(Number(start) + i, parseInt(hex.slice(i * 4, i * 4 + 4), 16));
    }
  }
  return registers;
};

/**
 * Log a payload once in chunks. `name` is letters only, e.g. "batteryPoll".
 * @returns {boolean} whether it was logged
 */
const record = (name, payload, log) => {
  let text;
  try {
    text = JSON.stringify(payload);
  } catch (error) {
    log(`capture ${name}: could not serialise (${error.message})`);
    return false;
  }
  if (text.length > MAX_BYTES) {
    log(`capture ${name}: skipped, ${text.length} bytes exceeds the ${MAX_BYTES} byte cap`);
    return false;
  }
  const chunks = Math.ceil(text.length / CHUNK);
  log(`${START} ${name} ${chunks} (${payload.reason || ''})===`);
  for (let i = 0; i < chunks; i += 1) {
    log(`${name}|${i + 1}|${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  log(`${END} ${name}===`);
  return true;
};

/**
 * Read captures back out of a diagnostics report; anchors on `<name>|<index>|`, so line
 * prefixes don't matter. A name captured twice keeps the last.
 * @returns {{captures: object, errors: string[]}} parsed payloads by capture name
 */
const parseLog = (text) => {
  const captures = {};
  const errors = [];
  const parts = new Map(); // name -> Map(index -> chunk)
  const expected = new Map(); // name -> chunk count

  for (const line of String(text).split(/\r?\n/)) {
    const header = line.match(new RegExp(`${START} (\\S+) (\\d+)`));
    if (header) {
      expected.set(header[1], Number(header[2]));
      parts.set(header[1], new Map());
      continue;
    }
    const body = line.match(/([A-Za-z]+)\|(\d+)\|(.*)$/);
    if (body && parts.has(body[1])) parts.get(body[1]).set(Number(body[2]), body[3]);
  }

  for (const [name, chunks] of parts) {
    const total = expected.get(name);
    const missing = [];
    let joined = '';
    for (let i = 1; i <= total; i += 1) {
      if (!chunks.has(i)) missing.push(i);
      else joined += chunks.get(i);
    }
    if (missing.length) {
      errors.push(`${name}: missing chunk(s) ${missing.join(', ')} of ${total} - report truncated?`);
      continue;
    }
    try {
      captures[name] = JSON.parse(joined);
    } catch (error) {
      errors.push(`${name}: reassembled text is not valid JSON (${error.message})`);
    }
  }

  return { captures, errors };
};

module.exports = {
  toRuns, fromRuns, record, parseLog,
};
