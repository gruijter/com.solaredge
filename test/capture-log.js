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
 * lib/solarEdgeCapture.js: calls through a wrapped client end up in log lines that parseLog turns
 * back into the same calls, once per call per arm, with the site's contact details redacted; and
 * test/from-logs.js reads such a report.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const capture = require('../lib/solarEdgeCapture');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic-site.json'), 'utf8'));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const callKey = (method, args) => `${method} ${JSON.stringify(args ?? null)}`;
const answers = new Map(fixture.calls.map((call) => [callKey(call.method, call.args), call]));
const backend = new Proxy({ deadline: null }, {
  get(target, property) {
    if (typeof property !== 'string' || !property.startsWith('get')) return target[property];
    return async (args) => {
      const call = answers.get(callKey(property, args));
      if (call.error) throw Object.assign(new Error(call.error.message), call.error);
      return structuredClone(call.result);
    };
  },
});

(async () => {
  const lines = [];
  // as Homey writes them in a diagnostics report: a prefix before every line
  const log = (line) => lines.push(`2026-10-15T11:00:00.000Z [log] [ManagerApps] [App] ${line}`);
  const client = capture.wrap(backend, log);

  capture.arm('test', { force: true });
  for (const call of fixture.calls) await client[call.method](call.args).catch(() => null); // eslint-disable-line no-await-in-loop
  const once = lines.length;
  await client.getSitePowerflow({ siteId: fixture.site.id });
  check(lines.length === once, 'a repeated call was logged again within one arm');
  check(!capture.arm('within the cooldown'), 'arm() without force ignored its cooldown');

  client.deadline = 123;
  check(backend.deadline === 123, 'a property set on the wrapper did not reach the client');

  const { calls, errors } = capture.parseLog(lines.join('\n'));
  check(!errors.length, `parse errors: ${errors.join('; ')}`);
  check(calls.length === fixture.calls.length, `${calls.length} calls parsed, ${fixture.calls.length} made`);
  for (const original of fixture.calls) {
    const parsed = calls.find((call) => callKey(call.method, call.args) === callKey(original.method, original.args));
    if (!parsed) {
      failures.push(`${original.method} not in the log`);
      continue;
    }
    if (original.method === 'getSites') {
      const site = parsed.result[fixture.site.id];
      check(site.name === '<redacted>', `site name not redacted: ${site.name}`);
      check(site.timezone === fixture.site.timezone && site.installationDate === fixture.site.installationDate, 'site timezone or installationDate lost');
    } else {
      check(isDeepStrictEqual(parsed.result, original.result), `${original.method}: result changed on the way`);
    }
  }

  const dropped = lines.findIndex((line) => /_\d+\|1\|/.test(line));
  const truncated = lines.filter((line, i) => i !== dropped).join('\n');
  check(capture.parseLog(truncated).errors.length === 1, 'a missing chunk was not reported');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solaredge-capture-'));
  const report = path.join(dir, 'report.txt');
  fs.writeFileSync(report, lines.join('\n'));
  const output = execFileSync(process.execPath, [path.join(__dirname, 'from-logs.js'), report, '--dry'], { encoding: 'utf8' });
  check(output.includes(`site ${fixture.site.id}: ${fixture.calls.length} calls`), `from-logs.js: ${output.trim()}`);
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`OK - capture: ${calls.length} calls through ${lines.length} log lines and back`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
