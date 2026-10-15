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
 * Checks that `homey app validate` cannot make, run with `npm test`. They read the built app.json:
 * run `homey app build` after a compose change.
 *
 * 1. What existing devices depend on is still there (ids, setting keys, capabilities).
 * 2. Every capability a device sets is in its manifest or added in code; setCapability() skips
 *    an unknown one without a word.
 * 3. Every energy capability reference names a capability of the driver.
 * 4. Every translation has all 13 locales, every errors.* key used in code exists in every
 *    locales file, and every language has its README.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'it', 'da', 'sv', 'no', 'pl', 'ru', 'ar', 'ko'];

// v1.8.1, the last version before the rewrite. Remove an entry only together with the
// migration step that removes it from existing devices.
const PINNED = {
  appId: 'com.solaredge',
  customCapabilities: ['solaredge-home-load-controller-state'],
  settings: ['username', 'password'],
  drivers: {
    battery: ['measure_battery', 'measure_power', 'battery_charging_state'],
    evcharger: ['measure_power', 'meter_power.charged', 'meter_power.discharged', 'evcharger_charging', 'evcharger_charging_state'],
    'home-load-controller': ['solaredge-home-load-controller-state'],
    inverter: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year'],
    meter: ['measure_power', 'meter_power.imported', 'meter_power.exported'],
  },
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const app = readJson(path.join(ROOT, 'app.json'));
const drivers = Object.fromEntries(app.drivers.map((driver) => [driver.id, driver]));
const failures = [];

// --- 1. what existing devices depend on ---------------------------------------------------

if (app.id !== PINNED.appId) failures.push(`app id is ${app.id}, not ${PINNED.appId}`);
for (const id of PINNED.customCapabilities) {
  if (!app.capabilities?.[id]) failures.push(`custom capability ${id} is gone`);
}
for (const [id, capabilities] of Object.entries(PINNED.drivers)) {
  const driver = drivers[id];
  if (!driver) {
    failures.push(`driver ${id} is gone`);
    continue;
  }
  const missing = capabilities.filter((capability) => !driver.capabilities.includes(capability));
  if (missing.length) failures.push(`${id}: capabilities gone without migration: ${missing.join(', ')}`);
  const settings = (driver.settings || []).flatMap((setting) => [setting, ...(setting.children || [])]).map((setting) => setting.id);
  const missingSettings = PINNED.settings.filter((setting) => !settings.includes(setting));
  if (missingSettings.length) failures.push(`${id}: settings gone: ${missingSettings.join(', ')}`);
}

// --- 2. capabilities set in code exist ----------------------------------------------------

const CAPABILITY_ID = /^(?:measure|meter|battery|evcharger|alarm|target)_[a-z_]+(?:\.[a-z0-9_]+)?$|^solaredge-[a-z-]+$/;
const stringLiterals = (source) => [...source.matchAll(/'([^'\n]+)'/g)].map((match) => match[1]);

for (const driver of app.drivers) {
  const file = path.join(ROOT, 'drivers', driver.id, 'device.js');
  const source = fs.readFileSync(file, 'utf8');
  const added = [...source.matchAll(/addCapability\('([^']+)'\)/g)].map((match) => match[1]);
  const used = new Set(stringLiterals(source).filter((literal) => CAPABILITY_ID.test(literal)));
  for (const capability of used) {
    if (!driver.capabilities.includes(capability) && !added.includes(capability)) {
      failures.push(`${driver.id}/device.js uses ${capability}, which is neither in the manifest nor added`);
    }
  }
}

// --- 3. energy references -----------------------------------------------------------------

for (const driver of app.drivers) {
  for (const [key, value] of Object.entries(driver.energy || {})) {
    if (key.endsWith('Capability') && !driver.capabilities.includes(value)) {
      failures.push(`${driver.id}: energy.${key} names ${value}, which is not one of its capabilities`);
    }
  }
}

// --- 4. translations ----------------------------------------------------------------------

let translations = 0;
const walk = (node, trail) => {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${trail}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;
  // a translation object: strings per locale, or arrays per locale for the app's tags
  const kind = typeof node.en === 'string' ? 'string' : Array.isArray(node.en) && 'array';
  if (kind) {
    translations += 1;
    const missing = LOCALES.filter((locale) => (kind === 'array' ? !Array.isArray(node[locale]) : typeof node[locale] !== 'string'));
    if (missing.length) failures.push(`app.json ${trail} missing: ${missing.join(', ')}`);
  }
  for (const key of Object.keys(node)) walk(node[key], `${trail}.${key}`);
};
walk(app, '');

const codeFiles = ['app.js',
  ...fs.readdirSync(path.join(ROOT, 'lib')).map((file) => path.join('lib', file)),
  ...app.drivers.flatMap((driver) => ['driver.js', 'device.js'].map((file) => path.join('drivers', driver.id, file)))];
const usedKeys = new Set(codeFiles
  .flatMap((file) => stringLiterals(fs.readFileSync(path.join(ROOT, file), 'utf8')))
  .filter((literal) => /^errors\.\w+$/.test(literal)));
const lookup = (object, key) => key.split('.').reduce((node, part) => node?.[part], object);
for (const locale of LOCALES) {
  const strings = readJson(path.join(ROOT, 'locales', `${locale}.json`));
  const missing = [...usedKeys].filter((key) => typeof lookup(strings, key) !== 'string');
  if (missing.length) failures.push(`locales/${locale}.json missing: ${missing.join(', ')}`);
  const readme = locale === 'en' ? 'README.txt' : `README.${locale}.txt`;
  if (!fs.existsSync(path.join(ROOT, readme))) failures.push(`${readme} is missing`);
}

// --- report -------------------------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL - ${failures.length} problem(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK - ${app.drivers.length} drivers keep what existing devices use, `
    + `${translations} translations and ${usedKeys.size} error texts carry all 13 locales`);
}
