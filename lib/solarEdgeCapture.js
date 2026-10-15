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
Raw API responses in the app log, so a user's diagnostics report doubles as test material (as
com.foxess lib/foxEssCapture.js). Each call (method + arguments) is logged once per arm (app
start, device restart, pairing), in chunks. `node test/from-logs.js <report.txt>` turns a report
back into test/captures/<siteId>.json for test/responses.js.
*/

const START = '===SOLAREDGE-CAPTURE-START';
const END = '===SOLAREDGE-CAPTURE-END';
const CHUNK = 700; // characters per log line
const MAX_BYTES = 64 * 1024;
const REARM_COOLDOWN = 60 * 1000;

// Contact details and signed links in the calls that describe the site; the site name is usually
// its street address. Serial numbers, ids, device names and all other calls are kept as they are.
const SITE_METHODS = new Set(['getSites', 'getSite', 'getSiteInformation', 'getSiteDetails', 'getSiteLayout']);
const PII_KEYS = new Set(['name', 'siteName', 'address', 'address2', 'city', 'fieldCity', 'zip', 'state', 'stateCode',
  'latitude', 'longitude', 'email', 'phone', 'accountName', 'accountGuid', 'linkSmallImage', 'linkBigImage',
  'bigImageDownloadLink', 'image']);

const redactSite = (value) => {
  if (Array.isArray(value)) return value.map(redactSite);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // a name below the site (inverter, string, optimizer in the layout) is kept
    if (k === 'name' && value.type && value.type !== 'SITE') out[k] = v;
    else if (PII_KEYS.has(k) && v !== null) out[k] = '<redacted>';
    else out[k] = redactSite(v);
  }
  return out;
};

const redactResult = (method, result) => (SITE_METHODS.has(method) ? redactSite(result) : result);

/** Argument objects as a key that ignores property order (as test/harness.js callKey). */
const callKey = (method, args) => `${method} ${JSON.stringify(Object.fromEntries(Object.entries(args ?? {}).sort()))}`;

let isArmed = false;
let captured = new Set();
let count = 0;
let reason = '';
let lastArmAt = 0;

const capture = {

  /**
   * Arm capturing: the next answer to every distinct call is logged once.
   * @param {string} why shown in the log
   * @param {object} [options] { force }: skip the cooldown (app start, pairing)
   */
  arm(why, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastArmAt < REARM_COOLDOWN) return false;
    lastArmAt = now;
    reason = why;
    isArmed = true;
    captured = new Set();
    return true;
  },

  /**
   * Log one call while armed, once per method + arguments per arm.
   * @param {object} call { method, args, result } or { method, args, error: { message, code, status } }
   * @param {Function} log the app/device logger
   */
  record({
    method, args, result, error,
  }, log) {
    if (!isArmed || typeof log !== 'function') return false;
    const key = callKey(method, args);
    if (captured.has(key)) return false;
    captured.add(key);

    count += 1;
    const name = `${method}_${count}`;
    let text;
    try {
      text = JSON.stringify({
        method, args, at: Date.now(), ...(error ? { error } : { result: redactResult(method, result) }),
      });
    } catch (err) {
      log(`capture ${name}: could not serialise (${err.message})`);
      return false;
    }
    if (text.length > MAX_BYTES) {
      log(`capture ${name}: skipped, ${text.length} bytes exceeds the ${MAX_BYTES} byte cap`);
      return false;
    }

    const chunks = Math.ceil(text.length / CHUNK);
    log(`${START} ${name} ${chunks} (${reason})===`);
    for (let i = 0; i < chunks; i += 1) {
      log(`${name}|${i + 1}|${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    }
    log(`${END} ${name}===`);
    return true;
  },

  /**
   * The client with every get* call recorded; everything else passes through. One wrapper per
   * client: devices compare clients by identity.
   */
  wrap(client, log) {
    return new Proxy(client, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== 'function' || typeof property !== 'string') return value;
        if (!/^get[A-Z]/.test(property)) return value.bind(target);
        return async (args) => {
          try {
            const result = await value.call(target, args);
            capture.record({ method: property, args, result }, log);
            return result;
          } catch (error) {
            capture.record({
              method: property,
              args,
              error: {
                message: error.message, name: error.name, code: error.code, status: error.status,
              },
            }, log);
            throw error;
          }
        };
      },
    });
  },

  /**
   * Read the captured calls back out of a diagnostics report; anchors on `<name>|<index>|`, so
   * line prefixes don't matter.
   * @param {string} text the whole report
   * @returns {{calls: object[], errors: string[]}} the calls in the order they were logged
   */
  parseLog(text) {
    const calls = [];
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
      const body = line.match(/([A-Za-z]+_\d+)\|(\d+)\|(.*)$/);
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
        calls.push(JSON.parse(joined));
      } catch (err) {
        errors.push(`${name}: reassembled text is not valid JSON (${err.message})`);
      }
    }

    return { calls, errors };
  },

};

module.exports = capture;
