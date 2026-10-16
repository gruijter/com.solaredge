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

const {
  u16, i16, u32, u32le, u64le, f32le, str, round: roundValue,
} = require('./registers');

/*
 * Register maps of the local Modbus TCP drivers, in the shape of com.solarwatt's point map. Holding
 * registers (function 0x03), protocol addresses (base 0). Sources: SolarEdge "SunSpec Logging"
 * technical note v3.2 (inverter, meters) and "Power Control Open Protocol" v1.3 (batteries); KEBA
 * KeContact P30 Modbus TCP Programmers Guide v1.07 (EV charger). None of it tested live yet.
 *
 * A meter or battery is one of several behind the inverter: `base` is its register offset from the
 * first one, found at pairing (findUnits) and kept in the device store.
 *
 * Per driver: identityBlocks(base)/identity(regs, base) for the settings page, blocks(base) read
 * every poll, capabilities (decoder per capability, in tile order), and optionally detectBlocks/
 * detect/unsupported to drop what the unit lacks (as com.solarwatt). A decoder returns undefined
 * when its registers were not read (tile unchanged), null when the unit reports no value.
 */

/** registers.round, keeping null (read, no value) as null rather than 0. */
const round = (value, decimals) => (value === null ? null : roundValue(value, decimals));

// Modbus TCP defaults: 1502 on SetApp inverters, 502 on those with a display (technical note);
// the other Modbus app on Dijker's Homey reads his SE5K on 502
const SOLAREDGE_PORTS = [1502, 502];

const SOLAREDGE = /^SolarEdge/i; // manufacturer in the common block (every dump, Dijker, Paul)

const SUNSPEC_ID = 0x53756e53; // "SunS" at 40000
const COMMON_BLOCK = { start: 40000, count: 70 }; // common block plus the inverter model id at 40069

/**
 * A SunSpec value with its scale factor: raw * 10^sf. null for SunSpec's not-implemented value
 * (0x8000 signed, 0xFFFF unsigned) or an implausible scale factor.
 */
const sunspec = (regs, address, sfAddress, { signed = true } = {}) => {
  const raw = signed ? i16(regs, address) : u16(regs, address);
  const sf = i16(regs, sfAddress);
  if (raw === undefined || sf === undefined) return undefined;
  if (raw === (signed ? -0x8000 : 0xffff) || sf < -10 || sf > 10) return null;
  return raw * (10 ** sf);
};

/** A SunSpec acc32 energy counter (Wh, with scale factor) in kWh. 0 means "not accumulated". */
const sunspecEnergy = (regs, address, sfAddress) => {
  const raw = u32(regs, address);
  const sf = i16(regs, sfAddress);
  if (raw === undefined || sf === undefined) return undefined;
  if (raw === 0 || raw === 0xffffffff || sf < -10 || sf > 10) return null;
  return round((raw * (10 ** sf)) / 1000, 3);
};

/** Flip to Homey's sign convention. */
const negate = (value) => (value === undefined || value === null ? value : -value);

/** A percentage, null outside 0-100 (initialising batteries report such values, per solaredged). */
const percent = (value) => {
  if (value === undefined) return undefined;
  return value >= 0 && value <= 100 ? round(value, 1) : null;
};

/** Model, serial number etc. of the inverter, from the common block. */
const commonIdentity = (regs) => ({
  manufacturer: str(regs, 40004, 16),
  model: str(regs, 40020, 16),
  firmware: str(regs, 40044, 8),
  serialNumber: str(regs, 40052, 16),
});

const isSunSpec = (regs) => u32(regs, 40000) === SUNSPEC_ID;

/** Discovery: the inverter of this Modbus server is a SolarEdge, not another SunSpec brand. */
const isSolarEdge = async (read) => SOLAREDGE.test(commonIdentity(await read([COMMON_BLOCK])).manufacturer || '');

/** "SE5000H 7E1234AB": the inverter a meter or battery is read through. */
const inverterLabel = (regs) => {
  const { model, serialNumber } = commonIdentity(regs);
  return [model, serialNumber].filter(Boolean).join(' ') || undefined;
};

/** Device data id: the inverter's serial number plus `suffix`; undefined without a serial. */
const unitId = (regs, suffix) => {
  const { serialNumber } = commonIdentity(regs);
  return serialNumber ? `${serialNumber}${suffix}` : undefined;
};

// --- inverter ---------------------------------------------------------------------------

// I_Status (40107), technical note "Inverter Device Status Values"; ids of capability inverter_status
const INVERTER_STATUS = {
  1: 'off', 2: 'sleeping', 3: 'starting', 4: 'production', 5: 'throttled', 6: 'shutting_down', 7: 'fault', 8: 'standby',
};
const INVERTER_FAULT = 7;

// SolarEdge EV chargers answer as an inverter on their own unit id, without telemetry (solaredged)
const EV_CHARGER_MODEL = /^SE-EV-SA/i;

const isInverter = (regs) => isSunSpec(regs)
  && [101, 102, 103].includes(u16(regs, 40069))
  && !EV_CHARGER_MODEL.test(commonIdentity(regs).model || '');

/** Phase capabilities beyond the unit's phase count (detect: `phases`). */
const absentPhases = (detected, capabilities) => {
  const phases = Number(detected.phases);
  if (!Number.isInteger(phases)) return [];
  return capabilities.filter((capability) => Number(capability.split('.')[1]) > phases);
};

/** Rated AC power (W) from the model name: SE5K 5000, SE10000H 10000, SE27.6K 27600. */
const ratedFromModel = (model) => {
  const match = /^SE(\d+(?:\.\d+)?)(K?)/i.exec(model || '');
  return match ? Math.round(Number(match[1]) * (match[2] ? 1000 : 1)) : undefined;
};

/*
 * Inverter AC limit (target_power), Power Control Open Protocol v1.3. Both setpoints are dynamic
 * commands: not saved (no flash wear), lost on an inverter restart, so written again.
 * - With enhanced dynamic power control on (0xF300 = 1): 0xF322, float32 % of 0xF30C (W). The
 *   inverter falls back (0xF312) when it gets no command within 0xF310 s, so it is refreshed well
 *   within that. Dijker's SE5K: on, 0xF30C 5250 W, timeout 550 s, fallback 100 %; 0xF001 ignored.
 * - Otherwise 0xF001, uint16 % of the rated power; needs AdvancedPwrControlEn (0xF142) and
 *   ReactivePwrConfig (0xF104) = 4 (document). Not seen working: a write is verified by reading back.
 */
const POWER_LIMIT = 0xf001;
const REACTIVE_POWER_CONFIG = 0xf104; // int32, low word first; 4 = RRCR
const ADVANCED_POWER_CONTROL = 0xf142; // int32, low word first; 1 = enabled
const DYNAMIC_POWER_CONTROL = 0xf300; // 1 = enabled; the block runs to 0xF323
const MAX_ACTIVE_POWER = 0xf304; // float32, W
const DYNAMIC_LIMIT_BASE = 0xf30c; // float32, W: 100 % of 0xF322
const COMMAND_TIMEOUT = 0xf310; // uint32, s
const FALLBACK_LIMIT = 0xf312; // float32, %: the limit after the command timeout
const DYNAMIC_POWER_LIMIT = 0xf322; // float32, %
const LIMIT_SETTLE_MS = 1000; // a dynamic setpoint takes effect within 1 s (technical note, appendix B)

/** The limit's register set for what detect() found: 0xF322 or 0xF001, and its 100 % in W. */
const limitControl = (detected) => (detected.dynamicPowerControl
  ? { dynamic: true, base: detected.dynamicLimitBase }
  : { dynamic: false, base: detected.ratedPower });

/** A float32 as two registers, low word first. */
const floatWords = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatBE(value, 0);
  return [bytes.readUInt16BE(2), bytes.readUInt16BE(0)];
};

/** Read back the limit (%) as the inverter holds it now. */
const readLimit = async (client, dynamic) => {
  const data = await client.readRegisters(dynamic ? DYNAMIC_POWER_LIMIT : POWER_LIMIT, dynamic ? 2 : 1);
  if (!dynamic) return data.readUInt16BE(0);
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16BE(data.readUInt16BE(2), 0);
  bytes.writeUInt16BE(data.readUInt16BE(0), 2);
  return bytes.readFloatBE(0);
};

/** Write the limit (%), dynamic as float32 to 0.01 %, else as a whole percent. */
const writeLimit = (client, dynamic, percent) => (dynamic
  ? client.writeRegisters(DYNAMIC_POWER_LIMIT, floatWords(percent))
  : client.writeRegister(POWER_LIMIT, percent));

const sameLimit = (a, b) => Math.abs(a - b) < 0.01;

/*
 * Export limit, Power Control Open Protocol v1.3 p. 15: the site's export (or production) held to
 * 0xE002 W, by an inverter reading a meter. Bits 0-2 of 0xE000 pick the meter mode; 0 is off.
 * Stored in flash (solaredge-modbus-multi), so written only when it changes.
 */
const EXPORT_CONTROL = 0xe000; // uint16, bits
const SITE_LIMIT = 0xe002; // float32, W
const EXPORT_LIMIT_MODES = 0b111;

const exportLimited = (mode) => Number.isInteger(mode) && (mode & EXPORT_LIMIT_MODES) !== 0;

/** Write a float32 (low word first) and read it back: the inverter acknowledges what it ignores. */
const writeFloatChecked = async (client, address, value) => {
  await client.writeRegisters(address, floatWords(value));
  const data = await client.readRegisters(address, 2);
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16BE(data.readUInt16BE(2), 0);
  bytes.writeUInt16BE(data.readUInt16BE(0), 2);
  return Math.abs(bytes.readFloatBE(0) - value) < 0.5;
};

/** How target_power limits this inverter, for the settings page. */
const powerControlLabel = (detected, device) => {
  const { dynamic, base } = limitControl(detected);
  if (!(base > 0)) return device.homey.__('settings.powerControl.unavailable');
  if (!dynamic) return device.homey.__('settings.powerControl.basic');
  return device.homey.__('settings.powerControl.dynamic', {
    fallback: detected.fallbackLimit ?? '?', timeout: detected.commandTimeout ?? '?',
  });
};

const inverterModbus = {
  port: 1502,
  ports: SOLAREDGE_PORTS,
  unitId: 1,
  mdns: true,
  discoverable: isSolarEdge,
  identityBlocks: () => [COMMON_BLOCK],
  identity: (regs) => commonIdentity(regs),
  dataId: (regs) => unitId(regs, ''),
  findUnits: async (read) => (isInverter(await read([COMMON_BLOCK])) ? [{ base: 0 }] : []),
  blocks: () => [
    { start: 40069, count: 40 }, // inverter model 101-103, up to the vendor status (40108)
    {
      start: POWER_LIMIT, count: 1, optional: true, when: (detected) => !detected.dynamicPowerControl,
    },
    {
      start: DYNAMIC_POWER_LIMIT, count: 2, optional: true, when: (detected) => detected.dynamicPowerControl === true,
    },
    {
      start: EXPORT_CONTROL, count: 4, optional: true, when: (detected) => exportLimited(detected.exportControl),
    },
  ],
  capabilities: {
    // AC output; on a hybrid inverter negative while it charges the battery from the grid (seen in a dump)
    measure_power: (regs) => round(sunspec(regs, 40083, 40084), 0),
    target_power: (regs, device) => {
      const { dynamic, base } = limitControl(device.detected);
      const percent = dynamic ? f32le(regs, DYNAMIC_POWER_LIMIT) : u16(regs, POWER_LIMIT);
      if (percent === undefined || !(base > 0)) return undefined;
      return Math.round((Math.max(0, Math.min(percent, 100)) / 100) * base);
    },
    // the site limit, while export limitation is on
    export_limit: (regs) => {
      const mode = u16(regs, EXPORT_CONTROL);
      const watts = f32le(regs, SITE_LIMIT);
      if (mode === undefined || watts === undefined) return undefined;
      return exportLimited(mode) && Number.isFinite(watts) ? Math.round(watts) : null;
    },
    meter_power: (regs) => sunspecEnergy(regs, 40093, 40095),
    measure_temperature: (regs) => round(sunspec(regs, 40103, 40106), 1),
    // phase-to-neutral; the 3-phase dump (SE17K) has all three, 1-phase units only A
    'measure_voltage.1': (regs) => round(sunspec(regs, 40079, 40082, { signed: false }), 1),
    'measure_voltage.2': (regs) => round(sunspec(regs, 40080, 40082, { signed: false }), 1),
    'measure_voltage.3': (regs) => round(sunspec(regs, 40081, 40082, { signed: false }), 1),
    measure_frequency: (regs) => round(sunspec(regs, 40085, 40086, { signed: false }), 2),
    /*
     * DC voltage only: DC power (40100) is AC power / 0.985 on every inverter seen, also while a
     * battery charged from the grid (5 inverters, Dijker live), and DC current is power / voltage.
     * So no DC power, current or efficiency tiles: they would repeat the AC power.
     */
    'measure_voltage.dc': (regs) => round(sunspec(regs, 40098, 40099, { signed: false }), 1),
    inverter_status: (regs) => {
      const status = u16(regs, 40107);
      if (status === undefined) return undefined;
      return INVERTER_STATUS[status] || null;
    },
    alarm_problem: (regs) => {
      const status = u16(regs, 40107);
      return status === undefined ? undefined : status === INVERTER_FAULT;
    },
  },
  detectBlocks: () => [
    { start: 40020, count: 16 },
    { start: 40069, count: 1 },
    { start: REACTIVE_POWER_CONFIG, count: 2 },
    { start: ADVANCED_POWER_CONTROL, count: 2 },
    { start: DYNAMIC_POWER_CONTROL, count: 36 },
    // absent where SolarEdge has not enabled the storage data set (as the batteries)
    { start: EXPORT_CONTROL, count: 1 },
  ],
  // 101 single, 102 split, 103 three phase
  detect: (regs) => {
    const detected = {};
    const model = u16(regs, 40069);
    if ([101, 102, 103].includes(model)) detected.phases = model - 100;
    const maxActive = f32le(regs, MAX_ACTIVE_POWER);
    const rated = maxActive > 0 ? Math.round(maxActive) : ratedFromModel(str(regs, 40020, 16));
    if (rated) detected.ratedPower = rated;
    const advanced = u32le(regs, ADVANCED_POWER_CONTROL);
    if (advanced !== undefined) detected.advancedPowerControl = advanced === 1;
    const reactive = u32le(regs, REACTIVE_POWER_CONFIG);
    if (reactive !== undefined) detected.reactivePowerConfig = reactive;
    const dynamic = u16(regs, DYNAMIC_POWER_CONTROL);
    if (dynamic !== undefined) detected.dynamicPowerControl = dynamic === 1;
    const base = f32le(regs, DYNAMIC_LIMIT_BASE);
    if (base > 0) detected.dynamicLimitBase = Math.round(base);
    const timeout = u32le(regs, COMMAND_TIMEOUT);
    if (timeout !== undefined) detected.commandTimeout = timeout;
    const fallback = f32le(regs, FALLBACK_LIMIT);
    if (fallback >= 0 && fallback <= 100) detected.fallbackLimit = round(fallback, 1);
    const exportControl = u16(regs, EXPORT_CONTROL);
    if (exportControl !== undefined) detected.exportControl = exportControl;
    return detected;
  },
  detectedSettings: (detected, device) => ({
    // read from 0xF304 where the inverter has it, else from the model name (detect)
    ratedPower: detected.ratedPower > 0 ? `${detected.ratedPower} W` : '',
    phases: detected.phases ? String(detected.phases) : '',
    powerControl: powerControlLabel(detected, device),
  }),
  unsupported: (detected) => [
    ...absentPhases(detected, ['measure_voltage.1', 'measure_voltage.2', 'measure_voltage.3']),
    // only once detection ran (phases known) and found nothing to scale the limit with
    ...(detected.phases && !(limitControl(detected).base > 0) ? ['target_power'] : []),
    // a slider that does nothing without export limitation set up by the installer
    ...(detected.phases && !exportLimited(detected.exportControl) ? ['export_limit'] : []),
  ],
  // from 0 to the limit's 100 %; 0xF001 has whole-percent steps
  capabilityOptions: (detected) => {
    const { dynamic, base } = limitControl(detected);
    const options = {};
    if (base > 0) options.target_power = { min: 0, max: base, step: dynamic ? 10 : base / 100 };
    if (detected.ratedPower > 0) options.export_limit = { min: 0, max: detected.ratedPower, step: 10 };
    return options;
  },
  controls: [
    {
      capabilities: ['target_power'],
      // Number(null) is 0 and an unknown base gives NaN, which a uint16 write turns into 0 %
      guard: ({ device, values }) => (typeof values.target_power === 'number' && Number.isFinite(values.target_power)
        && limitControl(device.detected).base > 0 ? null : 'errors.powerLimitUnknown'),
      write: async ({ client, device, values }) => {
        const { dynamic, base } = limitControl(device.detected);
        const share = Math.max(0, Math.min(100, (values.target_power / base) * 100));
        const percent = dynamic ? Math.round(share * 100) / 100 : Math.round(share);
        await writeLimit(client, dynamic, percent);
        await device.pause(LIMIT_SETTLE_MS);
        // an inverter that ignores the register still acknowledges the write
        if (!sameLimit(await readLimit(client, dynamic), percent)) {
          throw Object.assign(Error(device.homey.__('errors.powerLimitRejected')), { refusal: true });
        }
        device.limitWrittenAt = Date.now();
        await device.setStoreValue('powerLimit', percent);
      },
      // after an inverter restart or a fallback, and before the dynamic command times out
      reapply: async ({ client, device, regs }) => {
        const wanted = device.getStoreValue('powerLimit');
        if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted >= 100) return;
        const { dynamic } = limitControl(device.detected);
        const current = dynamic ? f32le(regs, DYNAMIC_POWER_LIMIT) : u16(regs, POWER_LIMIT);
        if (current === undefined) return;
        const timeoutMs = (Number(device.detected.commandTimeout) || 0) * 1000;
        const due = dynamic && timeoutMs > 0 && Date.now() - (device.limitWrittenAt || 0) > timeoutMs / 3;
        if (sameLimit(current, wanted) && !due) return;
        if (!sameLimit(current, wanted)) device.log(`power limit is ${current} %, writing ${wanted} % again`);
        await writeLimit(client, dynamic, wanted);
        device.limitWrittenAt = Date.now();
      },
    },
    {
      capabilities: ['export_limit'],
      guard: async ({ client }) => {
        const mode = (await client.readRegisters(EXPORT_CONTROL, 1)).readUInt16BE(0);
        return exportLimited(mode) ? null : 'errors.exportLimitOff';
      },
      write: async ({ client, device, values }) => {
        const watts = Math.round(Math.max(0, Number(values.export_limit) || 0));
        if (device.getCapabilityValue('export_limit') === watts) return;
        if (!(await writeFloatChecked(client, SITE_LIMIT, watts))) {
          throw Object.assign(Error(device.homey.__('errors.exportLimitRejected')), { refusal: true });
        }
      },
    },
  ],
};

// --- meter ------------------------------------------------------------------------------

const METER_COMMON = 40121; // common block of the 1st meter, 67 registers
const METER_MODEL = 40188; // its model block (201-204)
const METER_STRIDE = 174; // to the 2nd and 3rd meter
const METER_PHASES = {
  201: 1, 202: 2, 203: 3, 204: 3,
}; // single, split, wye, delta
const METER_MODELS = Object.keys(METER_PHASES).map(Number);
const MPPT_MODEL = 160;

/** Synergy inverters carry the multiple-MPPT model at 40121, which moves the meters up by 50 or 70. */
const mpptShift = (regs) => {
  if (u16(regs, METER_COMMON) !== MPPT_MODEL) return 0;
  const units = u16(regs, METER_COMMON + 8);
  if (units === 2) return 50;
  if (units === 3) return 70;
  return 0;
};

const meterPhases = ['measure_power.1', 'measure_power.2', 'measure_power.3', 'measure_voltage.1', 'measure_voltage.2', 'measure_voltage.3'];

const meterModbus = {
  port: 1502,
  ports: SOLAREDGE_PORTS,
  unitId: 1,
  mdns: true,
  discoverable: isSolarEdge,
  identityBlocks: (base) => [COMMON_BLOCK, { start: METER_COMMON + base, count: 67 }],
  identity: (regs, base) => ({
    manufacturer: str(regs, METER_COMMON + base + 2, 16),
    model: str(regs, METER_COMMON + base + 18, 16),
    firmware: str(regs, METER_COMMON + base + 42, 8),
    serialNumber: str(regs, METER_COMMON + base + 50, 16),
    settings: {
      // "Export+Import", "Production", "Consumption": one function only, also for dual-function meters
      meterFunction: str(regs, METER_COMMON + base + 34, 8),
      connectedTo: inverterLabel(regs),
    },
  }),
  dataId: (regs, base) => unitId(regs, `-meter-${base}`),
  // Only enabled meters are readable, packed from the 1st position on (technical note).
  findUnits: async (read) => {
    if (!isSunSpec(await read([COMMON_BLOCK]))) return [];
    const shift = mpptShift(await read([{ start: METER_COMMON, count: 10 }]).catch(() => new Map()));
    const units = [];
    for (let i = 0; i < 3; i += 1) {
      const base = shift + (METER_STRIDE * i);
      // eslint-disable-next-line no-await-in-loop
      const regs = await read([{ start: METER_MODEL + base, count: 1 }]).catch(() => new Map());
      if (!METER_MODELS.includes(u16(regs, METER_MODEL + base))) break;
      units.push({ base });
    }
    return units;
  },
  blocks: (base) => [
    { start: METER_MODEL + base, count: 55 }, // model id up to the energy scale factor (40242)
  ],
  capabilities: {
    /*
     * The register is positive for export (solaredge-modbus-multi wiki, Export+Import meter at the
     * grid; not verified live): flipped to import positive.
     */
    measure_power: (regs, { base }) => round(negate(sunspec(regs, 40206 + base, 40210 + base)), 0),
    'measure_power.1': (regs, { base }) => round(negate(sunspec(regs, 40207 + base, 40210 + base)), 0),
    'measure_power.2': (regs, { base }) => round(negate(sunspec(regs, 40208 + base, 40210 + base)), 0),
    'measure_power.3': (regs, { base }) => round(negate(sunspec(regs, 40209 + base, 40210 + base)), 0),
    'measure_voltage.1': (regs, { base }) => round(sunspec(regs, 40196 + base, 40203 + base), 1),
    'measure_voltage.2': (regs, { base }) => round(sunspec(regs, 40197 + base, 40203 + base), 1),
    'measure_voltage.3': (regs, { base }) => round(sunspec(regs, 40198 + base, 40203 + base), 1),
    measure_frequency: (regs, { base }) => round(sunspec(regs, 40204 + base, 40205 + base), 2),
    'meter_power.imported': (regs, { base }) => sunspecEnergy(regs, 40234 + base, 40242 + base),
    'meter_power.exported': (regs, { base }) => sunspecEnergy(regs, 40226 + base, 40242 + base),
  },
  detectBlocks: (base) => [{ start: METER_MODEL + base, count: 1 }],
  detect: (regs, previous, base) => {
    const model = u16(regs, METER_MODEL + base);
    if (!METER_MODELS.includes(model)) return {};
    return { phases: METER_PHASES[model], delta: model === 204 };
  },
  detectedSettings: (detected) => ({ phases: detected.phases ? String(detected.phases) : '' }),
  // a delta meter has no neutral, so no phase-to-neutral voltages
  unsupported: (detected) => [
    ...absentPhases(detected, meterPhases),
    ...(detected.delta ? ['measure_voltage.1', 'measure_voltage.2', 'measure_voltage.3'] : []),
  ],
};

// --- battery ----------------------------------------------------------------------------

const BATTERY_COMMON = 57600; // 0xE100, 68 registers
const BATTERY_OFFSETS = [0, 256, 768]; // 0xE100, 0xE200 (Power Control document), 0xE400 (solaredge-modbus-multi)
const BATTERY_STATUS = { charging: 3, discharging: 4, fault: 5 };

/**
 * A lifetime counter in Wh as kWh. 0 is null (not implemented), and so is anything above 2^53 Wh:
 * the not-implemented pattern of a uint64 is unknown (0xFFFF... or 0x8000... assumed).
 */
const batteryEnergy = (wh) => {
  if (wh === undefined) return undefined;
  return wh > 0 && wh <= Number.MAX_SAFE_INTEGER ? round(wh / 1000, 3) : null;
};

/** Strings of some batteries carry the serial number at the end (solaredge-modbus-multi). */
/** A float32 power rating in W for the settings page; '' when the battery has none. */
const wattLabel = (watt) => (watt > 0 ? `${Math.round(watt)} W` : '');

const withoutSerial = (text, serial) => (text && serial && text.endsWith(serial) ? text.slice(0, -serial.length).trim() : text);

/*
 * StorEdge control, Power Control Open Protocol v1.3 p. 16-18 and 26: one block for all batteries
 * of the inverter, so only the 1st battery device carries the controls. Remote control (0xE004 = 4)
 * runs 0xE00D for 0xE00B seconds, then falls back to 0xE00A. It needs advanced power control
 * (0xF142 = 1, 0xF104 = 4) and export limitation off (0xE000 = 0); the app does not change those.
 * 0xE004, 0xE008 and 0xE00A are stored in flash (solaredge-modbus-multi), so written only on a change;
 * 0xE00B-0xE010 are not.
 */
const STORAGE_CONTROL = 0xe004; // uint16
const BACKUP_RESERVE = 0xe008; // float32, %
const DEFAULT_COMMAND = 0xe00a; // uint16
const COMMAND_TIMEOUT_REMOTE = 0xe00b; // uint32, s
const COMMAND_MODE = 0xe00d; // uint16
const CHARGE_LIMIT = 0xe00e; // float32, W
const DISCHARGE_LIMIT = 0xe010; // float32, W
const STORAGE_BLOCK = { start: STORAGE_CONTROL, count: 14 }; // 0xE004-0xE011

const STORAGE_MODES = {
  1: 'self_use', 2: 'time_of_use', 3: 'backup', 4: 'remote',
};
const REMOTE_CONTROL = 4;
// 0xE00D/0xE00A: 0 off, 1 charge excess PV only, 3 charge from PV and AC, 4 maximize export
const COMMAND = {
  off: 0, excessPv: 1, charge: 3, discharge: 4,
};
const REMOTE_TIMEOUT_S = 60;
const BATTERY_KEEP_ALIVE_S = 20; // 3 writes per timeout
// a battery that reports no rating: SolarEdge Home Battery 48V, 5 kW (datasheet)
const DEFAULT_BATTERY_POWER_W = 5000;

const batteryRating = (device, key) => (device.detected[key] > 0 ? device.detected[key] : DEFAULT_BATTERY_POWER_W);

/** The target power modes run through remote control, with their setpoint (W, + charges). */
const REMOTE_MODES = {
  homey: (device) => Number(device.getCapabilityValue('target_power')) || 0,
  force_charge: (device) => batteryRating(device, 'maxChargePower'),
  force_discharge: (device) => -batteryRating(device, 'maxDischargePower'),
};

/** As com.solarwatt: the slider alone hands control to Homey, as Homey's "Set target power" card does. */
const targetPowerMode = (device, values) => {
  if (values.target_power_mode !== undefined) return values.target_power_mode;
  return values.target_power === undefined ? device.getCapabilityValue('target_power_mode') : 'homey';
};

const showTargetPowerMode = async (device, mode) => {
  if (device.getCapabilityValue('target_power_mode') === mode) return;
  await device.setCapabilityValue('target_power_mode', mode).catch((error) => device.error(error));
};

const remoteInControl = (device) => REMOTE_MODES[device.getCapabilityValue('target_power_mode')] !== undefined;

const readU16 = async (client, address) => (await client.readRegisters(address, 1)).readUInt16BE(0);

/** A persistent register: written only when it differs. */
const writeU16IfChanged = async (client, address, value) => {
  if (await readU16(client, address) !== value) await client.writeRegister(address, value);
};

/** One remote-control command: a setpoint in W, positive to charge. */
const writeRemoteCommand = async (client, device, watts) => {
  const setpoint = Math.round(Math.max(-batteryRating(device, 'maxDischargePower'), Math.min(batteryRating(device, 'maxChargePower'), watts)));
  await client.writeRegisters(COMMAND_TIMEOUT_REMOTE, [REMOTE_TIMEOUT_S, 0]); // uint32, low word first
  if (setpoint > 0) {
    await client.writeRegisters(CHARGE_LIMIT, floatWords(setpoint));
    await client.writeRegister(COMMAND_MODE, COMMAND.charge);
  } else if (setpoint < 0) {
    await client.writeRegisters(DISCHARGE_LIMIT, floatWords(-setpoint));
    await client.writeRegister(COMMAND_MODE, COMMAND.discharge);
  } else {
    await client.writeRegister(COMMAND_MODE, COMMAND.off);
  }
};

/** Why remote control cannot run here, as a locale key; null when it can. */
const remoteControlRefusal = async (client) => {
  const advanced = await client.readRegisters(ADVANCED_POWER_CONTROL, 2);
  const reactive = await client.readRegisters(REACTIVE_POWER_CONFIG, 2);
  if (advanced.readUInt16BE(0) !== 1 || reactive.readUInt16BE(0) !== 4) return 'errors.advancedPowerControlOff';
  if (exportLimited(await readU16(client, EXPORT_CONTROL))) return 'errors.exportLimitActive';
  return null;
};

const batteryModbus = {
  port: 1502,
  ports: SOLAREDGE_PORTS,
  unitId: 1,
  mdns: true,
  discoverable: isSolarEdge,
  identityBlocks: (base) => [
    COMMON_BLOCK,
    { start: BATTERY_COMMON + base, count: 68 },
    // continuous charge and discharge power (0xE144, 0xE146), not in any dump seen
    { start: BATTERY_COMMON + base + 68, count: 4, optional: true },
  ],
  identity: (regs, base) => {
    const serialNumber = str(regs, BATTERY_COMMON + base + 48, 16);
    const rated = f32le(regs, BATTERY_COMMON + base + 66);
    return {
      manufacturer: withoutSerial(str(regs, BATTERY_COMMON + base, 16), serialNumber),
      model: withoutSerial(str(regs, BATTERY_COMMON + base + 16, 16), serialNumber),
      firmware: str(regs, BATTERY_COMMON + base + 32, 16),
      serialNumber,
      settings: {
        ratedEnergy: rated > 0 ? `${round(rated / 1000, 2)} kWh` : '',
        maxChargePower: wattLabel(f32le(regs, BATTERY_COMMON + base + 68)),
        maxDischargePower: wattLabel(f32le(regs, BATTERY_COMMON + base + 70)),
        connectedTo: inverterLabel(regs),
      },
    };
  },
  dataId: (regs, base) => unitId(regs, `-battery-${base}`),
  // Battery data over Modbus is enabled per inverter by SolarEdge; without it the read fails.
  findUnits: async (read) => {
    if (!isSunSpec(await read([COMMON_BLOCK]))) return [];
    const units = [];
    for (const base of BATTERY_OFFSETS) {
      const address = BATTERY_COMMON + base + 66; // rated energy, float32
      // eslint-disable-next-line no-await-in-loop
      const regs = await read([{ start: address, count: 2 }]).catch(() => new Map());
      if (!(f32le(regs, address) > 0)) break;
      units.push({ base });
    }
    return units;
  },
  blocks: (base) => [
    { start: BATTERY_COMMON + base + 108, count: 30 }, // temperature (0xE16C) up to the status (0xE186)
    { ...STORAGE_BLOCK, optional: true, when: (detected) => detected.storageControl === true },
  ],
  capabilities: {
    // positive while charging (dumps: +5002 W with status charging, -66 W discharging)
    measure_power: (regs, { base }) => round(f32le(regs, BATTERY_COMMON + base + 116), 0),
    // owned by Homey: see `controls`
    target_power: null,
    // the inverter's storage mode; remote control shows the mode Homey runs it in
    target_power_mode: (regs, device) => {
      const mode = u16(regs, STORAGE_CONTROL);
      if (mode === undefined) return undefined;
      if (mode === REMOTE_CONTROL) return remoteInControl(device) ? device.getCapabilityValue('target_power_mode') : null;
      return STORAGE_MODES[mode] || null;
    },
    measure_battery: (regs, { base }) => {
      const soe = percent(f32le(regs, BATTERY_COMMON + base + 132));
      return soe === undefined || soe === null ? soe : round(soe, 0);
    },
    battery_charging_state: (regs, { base }) => {
      const status = u32le(regs, BATTERY_COMMON + base + 134);
      if (status === undefined) return undefined;
      if (status === BATTERY_STATUS.charging) return 'charging';
      if (status === BATTERY_STATUS.discharging) return 'discharging';
      return 'idle';
    },
    // the backup reserve: SoC kept for an outage, on inverters with backup hardware
    battery_min_soc: (regs) => {
      const reserve = f32le(regs, BACKUP_RESERVE);
      return reserve === undefined ? undefined : percent(reserve);
    },
    /*
     * Lifetime counters (Wh), reported to reset (LG, BYD) or run backwards (Home Battery 48V) by
     * solaredge-modbus-multi users; not in any dump seen. 0 counts as "not implemented".
     */
    'meter_power.charged': (regs, { base }) => batteryEnergy(u64le(regs, BATTERY_COMMON + base + 122)),
    'meter_power.discharged': (regs, { base }) => batteryEnergy(u64le(regs, BATTERY_COMMON + base + 118)),
    measure_temperature: (regs, { base }) => round(f32le(regs, BATTERY_COMMON + base + 108), 1),
    measure_soh: (regs, { base }) => percent(f32le(regs, BATTERY_COMMON + base + 130)),
    measure_residual_energy: (regs, { base }) => {
      const wh = f32le(regs, BATTERY_COMMON + base + 128);
      return wh === undefined || Number.isNaN(wh) ? wh : round(wh / 1000, 2);
    },
    alarm_problem: (regs, { base }) => {
      const status = u32le(regs, BATTERY_COMMON + base + 134);
      return status === undefined ? undefined : status === BATTERY_STATUS.fault;
    },
  },
  detectBlocks: (base) => [
    { start: BATTERY_COMMON + base + 68, count: 4 },
    { start: STORAGE_CONTROL, count: 1 },
  ],
  detect: (regs, previous, base) => {
    const detected = { first: base === 0 };
    const maxCharge = f32le(regs, BATTERY_COMMON + base + 68);
    const maxDischarge = f32le(regs, BATTERY_COMMON + base + 70);
    if (maxCharge > 0) detected.maxChargePower = Math.round(maxCharge);
    if (maxDischarge > 0) detected.maxDischargePower = Math.round(maxDischarge);
    detected.storageControl = u16(regs, STORAGE_CONTROL) !== undefined;
    return detected;
  },
  // the controls on the 1st battery only, and only where the inverter has the storage block
  unsupported: (detected) => (detected.first === false || detected.storageControl === false
    ? ['target_power', 'target_power_mode', 'battery_min_soc'] : []),
  capabilityOptions: (detected) => {
    if (!(detected.maxChargePower > 0) || !(detected.maxDischargePower > 0)) return {};
    return { target_power: { min: -detected.maxDischargePower, max: detected.maxChargePower, step: 50 } };
  },
  controls: [
    {
      capabilities: ['target_power', 'target_power_mode'],
      keepAliveSeconds: BATTERY_KEEP_ALIVE_S,
      initial: { target_power: 0 },
      guard: async ({ client, device, values }) => {
        const mode = targetPowerMode(device, values);
        if (values.target_power !== undefined && !Number.isFinite(values.target_power)) return 'errors.notSupported';
        return REMOTE_MODES[mode] ? remoteControlRefusal(client) : null;
      },
      write: async ({ client, device, values }) => {
        const mode = targetPowerMode(device, values);
        if (REMOTE_MODES[mode]) {
          await writeU16IfChanged(client, DEFAULT_COMMAND, COMMAND.excessPv); // recommended fallback (p. 26)
          await writeU16IfChanged(client, STORAGE_CONTROL, REMOTE_CONTROL);
          const watts = mode === 'homey' && values.target_power !== undefined ? values.target_power : REMOTE_MODES[mode](device);
          await writeRemoteCommand(client, device, watts);
          await showTargetPowerMode(device, mode);
          return;
        }
        const code = Object.keys(STORAGE_MODES).find((key) => STORAGE_MODES[key] === mode);
        if (!code || Number(code) === REMOTE_CONTROL) throw Error(`Unknown storage mode ${mode}`);
        await writeU16IfChanged(client, STORAGE_CONTROL, Number(code));
      },
      keepAlive: async ({ client, device }) => {
        if (!remoteInControl(device)) return;
        // someone else left remote control: follow, rather than take it back
        if (await readU16(client, STORAGE_CONTROL) !== REMOTE_CONTROL) return;
        await writeRemoteCommand(client, device, REMOTE_MODES[device.getCapabilityValue('target_power_mode')](device));
      },
      // back to the fallback right away, rather than after the timeout
      release: async ({ client, device }) => {
        if (!remoteInControl(device)) return;
        await client.writeRegister(COMMAND_MODE, COMMAND.excessPv);
      },
    },
    {
      capabilities: ['battery_min_soc'],
      guard: ({ values }) => (Number.isFinite(values.battery_min_soc)
        && values.battery_min_soc >= 0 && values.battery_min_soc <= 100 ? null : 'errors.socRange'),
      write: async ({ client, device, values }) => {
        const soc = Math.round(values.battery_min_soc);
        if (device.getCapabilityValue('battery_min_soc') === soc) return;
        if (!(await writeFloatChecked(client, BACKUP_RESERVE, soc))) {
          throw Object.assign(Error(device.homey.__('errors.backupReserveRejected')), { refusal: true });
        }
      },
    },
  ],
};

// --- EV charger (KEBA KeContact P30) ----------------------------------------------------

/*
 * The SolarEdge Home EV Charger on its own IP address. That it is a KEBA P30 rests on evcc and one
 * installer's report (not verified). Every register is a uint32 read on its own (2 words, the guide
 * allows no more per request), high word first (assumed). Unit id 255 (guide).
 */
const keba = (address) => ({ start: address, count: 2 });

// 1000 charging state, 1004 cable state: guide sections 3.1 and 3.2
const KEBA_CHARGING = 3;
const KEBA_ERROR = 4;
const KEBA_INTERRUPTED = 5;
const KEBA_CABLE_IN_CAR = 5; // 5 and 7: plugged into station and car

// 1016, a decimal digit per feature (guide 3.8): 304111 is a P30 (3), socket (0), 32 A (4), c-series (1)
const KEBA_CURRENT = {
  1: 13, 2: 16, 3: 20, 4: 32,
};

const kebaProduct = (value) => {
  if (value === undefined) return {};
  const digits = String(value);
  if (!/^3\d{5}$/.test(digits)) return { model: `KeContact ${value}` };
  return { model: `KeContact P30 ${digits[3] === '1' ? 'c' : 'x'}-series`, current: KEBA_CURRENT[digits[2]] };
};

/*
 * Control (guide chapter 4): 5014 enable/disable, 5004 current in mA (6-63 A, until a reboot),
 * 5010 session energy in 10 Wh, 5050/5052 phase switching over contact X2. Every write a single
 * UINT16 (0x06). While Homey sets the current, failsafe 5016/5018 drops it to 6 A when the app stops
 * talking; the guide does not say which commands count, so the current is rewritten as keep-alive.
 */
const KEBA_VOLTAGE = 230; // nominal, per phase
const KEBA_MIN_CURRENT = 6000; // mA
const KEBA_MAX_CURRENT = 63000; // mA, "no limit": the charger keeps to its DIP switches and cable
const KEBA_FAILSAFE_TIMEOUT_S = 60;
const KEBA_KEEP_ALIVE_S = 20;
const KEBA_DEFAULT_PHASES = 3;
const KEBA_GAP_MS = 500;

const kebaRead = async (client, address) => {
  const data = await client.readRegisters(address, 2);
  return data.readUInt16BE(0) * 0x10000 + data.readUInt16BE(2);
};

/** Write UINT16 registers in order, the guide's 0.5 s apart. */
const kebaWrite = async (client, device, writes) => {
  for (const [index, [address, value]] of writes.entries()) {
    // eslint-disable-next-line no-await-in-loop
    if (index > 0) await device.pause(KEBA_GAP_MS);
    // eslint-disable-next-line no-await-in-loop
    await client.writeRegister(address, value);
  }
};

/**
 * Phases the car charges on: power / (230 V x current L1), kept from the last session. Not from
 * 1552, which is only the X2 switch state.
 */
const kebaPhases = async (client, device) => {
  const milliwatt = await kebaRead(client, 1020);
  await device.pause(KEBA_GAP_MS);
  const milliamp = await kebaRead(client, 1008);
  if (milliamp > 2000 && milliwatt > 0) {
    const phases = Math.max(1, Math.min(3, Math.round(milliwatt / (KEBA_VOLTAGE * milliamp))));
    if (device.getStoreValue('chargingPhases') !== phases) await device.setStoreValue('chargingPhases', phases);
    return phases;
  }
  return device.getStoreValue('chargingPhases') || KEBA_DEFAULT_PHASES;
};

const holdKebaCurrent = async (client, device, watts) => {
  const phases = await kebaPhases(client, device);
  const milliamp = Math.round(Math.max(KEBA_MIN_CURRENT, Math.min(KEBA_MAX_CURRENT, (watts / (KEBA_VOLTAGE * phases)) * 1000)));
  await kebaWrite(client, device, [[5016, KEBA_MIN_CURRENT], [5018, KEBA_FAILSAFE_TIMEOUT_S], [5004, milliamp]]);
};

// failsafe off: "charging will continue with the highest possible value" (guide 4.7.2)
const releaseKebaCurrent = (client, device) => kebaWrite(client, device, [[5018, 0], [5004, KEBA_MAX_CURRENT]]);

const kebaCarConnected = (device) => device.getCapabilityValue('evcharger_charging_state') !== 'plugged_out';
const kebaHomeyInControl = (device) => device.getCapabilityValue('target_power_mode') === 'homey';
const kebaStopped = (device) => device.getStoreValue('chargingStopped') === true;
const noteKebaStopped = async (device, stopped) => {
  if (kebaStopped(device) !== stopped) await device.setStoreValue('chargingStopped', stopped);
};

const evchargerModbus = {
  port: 502,
  unitId: 255,
  readGapMs: 500, // guide: read registers no faster than every 0.5 s
  identityBlocks: () => [keba(1014), keba(1016), keba(1018)],
  identity: (regs) => {
    const product = kebaProduct(u32(regs, 1016));
    const firmware = u32(regs, 1018);
    return {
      manufacturer: 'KEBA',
      model: product.model,
      // a byte per field (guide 3.9, whose example 0x30A0D00 reads 3.10.14 although 0x0D is 13)
      firmware: firmware === undefined ? undefined : [24, 16, 8].map((shift) => (firmware >>> shift) & 0xff).join('.'),
      serialNumber: u32(regs, 1014) === undefined ? undefined : String(u32(regs, 1014)),
      settings: { ratedCurrent: product.current ? `${product.current} A` : '' },
    };
  },
  dataId: (regs) => `keba-${u32(regs, 1014)}`,
  findUnits: async (read) => (u32(await read([keba(1014)]), 1014) > 0 ? [{ base: 0 }] : []),
  blocks: () => [keba(1000), keba(1004), keba(1006), keba(1020), keba(1036), keba(1502)],
  capabilities: {
    measure_power: (regs) => {
      const milliwatt = u32(regs, 1020);
      return milliwatt === undefined ? undefined : round(milliwatt / 1000, 0);
    },
    evcharger_charging: (regs) => {
      const state = u32(regs, 1000);
      return state === undefined ? undefined : state === KEBA_CHARGING;
    },
    evcharger_charging_state: (regs) => {
      const cable = u32(regs, 1004);
      const state = u32(regs, 1000);
      if (cable === undefined || state === undefined) return undefined;
      if (cable < KEBA_CABLE_IN_CAR) return 'plugged_out';
      if (state === KEBA_CHARGING) return 'plugged_in_charging';
      if (state === KEBA_INTERRUPTED) return 'plugged_in_paused';
      return 'plugged_in';
    },
    // 0.1 Wh
    'meter_power.session': (regs) => {
      const tenthWh = u32(regs, 1502);
      return tenthWh === undefined ? undefined : round(tenthWh / 10000, 3);
    },
    // owned by Homey: see `controls`
    target_power: null,
    target_power_mode: null,
    'meter_power.charged': (regs) => {
      const tenthWh = u32(regs, 1036);
      return tenthWh === undefined ? undefined : round(tenthWh / 10000, 3);
    },
    alarm_problem: (regs) => {
      const state = u32(regs, 1000);
      const error = u32(regs, 1006);
      if (state === undefined && error === undefined) return undefined;
      return state === KEBA_ERROR || Boolean(error);
    },
    // 5010 is write-only: what Homey set, until the car is unplugged
    session_energy_limit: (regs, device) => {
      const cable = u32(regs, 1004);
      if (cable === undefined) return undefined;
      return cable < KEBA_CABLE_IN_CAR ? null : device.getCapabilityValue('session_energy_limit');
    },
  },
  detectBlocks: () => [keba(1016)],
  detect: (regs) => {
    const { current } = kebaProduct(u32(regs, 1016));
    return current ? { ratedCurrent: current } : {};
  },
  // 0, or 6 A on one phase up to the rated current on three
  capabilityOptions: (detected) => {
    if (!(detected.ratedCurrent > 0)) return {};
    const minPower = (KEBA_MIN_CURRENT / 1000) * KEBA_VOLTAGE;
    return {
      target_power: {
        min: 0, max: detected.ratedCurrent * KEBA_VOLTAGE * 3, step: KEBA_VOLTAGE, excludeMin: 0, excludeMax: minPower,
      },
    };
  },
  controls: [
    {
      /*
       * As com.solarwatt's charger: 'homey' holds the current at target_power, 'device' leaves it to
       * the charger. Homey's "Set target power" card changes all three at once.
       */
      capabilities: ['evcharger_charging', 'target_power', 'target_power_mode'],
      keepAliveSeconds: KEBA_KEEP_ALIVE_S,
      initial: (device) => ({
        target_power: (device.detected.ratedCurrent || 16) * KEBA_VOLTAGE * KEBA_DEFAULT_PHASES,
        target_power_mode: 'device',
      }),
      guard: ({ device, values }) => {
        if (values.target_power !== undefined && !Number.isFinite(values.target_power)) return 'errors.notSupported';
        return values.evcharger_charging && !kebaCarConnected(device) ? 'errors.noCarConnected' : null;
      },
      write: async ({ client, device, values }) => {
        const mode = targetPowerMode(device, values);
        const target = values.target_power !== undefined ? values.target_power : device.getCapabilityValue('target_power');
        if (mode === 'homey') {
          if (values.evcharger_charging === false || !(Number(target) > 0)) {
            await client.writeRegister(5014, 0);
            await noteKebaStopped(device, true);
          } else {
            // current first, so a start never runs at full power
            await holdKebaCurrent(client, device, target);
            await noteKebaStopped(device, false);
            if (values.evcharger_charging === true) await kebaWrite(client, device, [[5014, 1]]);
          }
          await showTargetPowerMode(device, mode);
          return;
        }
        if (values.target_power_mode !== undefined) await releaseKebaCurrent(client, device);
        if (values.evcharger_charging !== undefined) {
          await kebaWrite(client, device, [[5014, values.evcharger_charging ? 1 : 0]]);
          await noteKebaStopped(device, !values.evcharger_charging);
        }
      },
      keepAlive: async ({ client, device }) => {
        if (!kebaCarConnected(device)) {
          // a stop by Homey does not apply to the next car
          await noteKebaStopped(device, false);
          return;
        }
        if (!kebaHomeyInControl(device) || kebaStopped(device)) return;
        const target = device.getCapabilityValue('target_power');
        if (Number(target) > 0) await holdKebaCurrent(client, device, target);
      },
      release: async ({ client, device }) => {
        if (!kebaHomeyInControl(device)) return;
        await releaseKebaCurrent(client, device);
      },
    },
    {
      // 5010 in 10 Wh; 0 as "no limit" is not in the guide
      capabilities: ['session_energy_limit'],
      guard: ({ device, values }) => {
        if (!Number.isFinite(values.session_energy_limit) || values.session_energy_limit < 0) return 'errors.notSupported';
        return kebaCarConnected(device) ? null : 'errors.noChargingSession';
      },
      write: async ({ client, values }) => client.writeRegister(5010, Math.min(0xffff, Math.round(values.session_energy_limit * 100))),
    },
  ],
  // contact X2 switches the phases when 5050 = 3 (Modbus); 0 leaves X2 alone
  settingWrites: {
    phaseSwitching: async ({ client, value }) => client.writeRegister(5050, value ? 3 : 0),
  },
  actions: {
    // 5052: 0 one phase, 1 three phases
    chargingPhases: async ({ client, device, phases }) => {
      if (!device.getSetting('phaseSwitching')) {
        throw Object.assign(Error(device.homey.__('errors.phaseSwitchingOff')), { refusal: true });
      }
      await client.writeRegister(5052, Number(phases) === 3 ? 1 : 0);
    },
  },
};

module.exports = {
  inverter_modbus: inverterModbus,
  meter_modbus: meterModbus,
  battery_modbus: batteryModbus,
  evcharger_modbus: evchargerModbus,
};
