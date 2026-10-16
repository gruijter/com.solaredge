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
 * The capabilities of each driver's devices, for pairing and for DeviceMigrator. Tile order as in
 * com.solarwatt and com.foxess: measure_power first, then the readings, the energy meters, the
 * status, and the alarms last.
 *
 * A device has its driver's manifest capabilities, the optional ones it reported (store
 * seenCaps: at pairing, else on a later poll) and the legacy ones it still has.
 */

const DRIVERS = {
  inverter: {
    order: ['measure_power', 'meter_power', 'meter_power.day', 'meter_power.month', 'meter_power.year',
      'measure_temperature.max', 'measure_voltage.1', 'measure_voltage.2', 'measure_voltage.3', 'inverter_status',
      'alarm_problem', 'alarm_connectivity'],
    // Phase power and current are left out: an inverter feeds its phases evenly (Dijker:
    // 348/349/343 W), so they are a third of measure_power. So is the DC voltage: optimizers hold
    // it fixed (Dijker: 745-748 V producing, ~1 V at night).
    optional: ['measure_temperature.max', 'measure_voltage.1', 'measure_voltage.2', 'measure_voltage.3', 'inverter_status'],
  },
  battery: {
    order: ['measure_power', 'measure_battery', 'battery_charging_state', 'meter_power.charged', 'meter_power.discharged',
      'measure_soh', 'measure_residual_energy', 'alarm_connectivity'],
    optional: ['measure_soh', 'measure_residual_energy'],
  },
  evcharger: {
    order: ['measure_power', 'evcharger_charging', 'evcharger_charging_state', 'meter_power.session', 'ev_session_duration',
      'ev_charge_mode', 'ev_solar_charging', 'ev_vehicle', 'meter_power.charged'],
    optional: ['meter_power.session', 'ev_session_duration', 'ev_charge_mode', 'ev_solar_charging', 'ev_vehicle'],
  },
  'home-load-controller': {
    order: ['measure_power', 'solaredge-home-load-controller-state'],
    optional: ['measure_power'],
  },
  meter: {
    order: ['measure_power', 'measure_power.load', 'measure_power.solar', 'measure_power.grid',
      'meter_power.imported', 'meter_power.exported', 'alarm_connectivity'],
    // kept, for their flows, on devices paired while measure_power was still consumption (same
    // value as measure_power now)
    legacy: ['measure_power.grid'],
  },
};

const lists = (driverId) => ({
  order: [], optional: [], legacy: [], ...DRIVERS[driverId],
});

module.exports = {

  /** Every capability a device of the driver can have, in tile order. */
  order: (driverId) => lists(driverId).order,

  /** Capabilities added only once the API reports a value for them. */
  optional: (driverId) => lists(driverId).optional,

  /** Capabilities no longer in the driver that stay on devices which have them. */
  legacy: (driverId) => lists(driverId).legacy,

  /**
   * The optional capabilities among `values` ({ capability: value }) that have a value.
   * @returns {string[]}
   */
  seenIn: (driverId, values) => lists(driverId).optional
    .filter((capability) => values[capability] !== null && values[capability] !== undefined),

  /**
   * A device's capability list: `base` (the driver manifest's), the optional ones in `seenCaps`
   * and the legacy ones `has` reports, in tile order; any the order lacks after them.
   * @param {string} driverId
   * @param {string[]} base
   * @param {Object<string, boolean>} [seenCaps]
   * @param {function(string): boolean} [has] whether the device has a capability
   * @returns {string[]}
   */
  list(driverId, base, seenCaps = {}, has = () => false) {
    const { order, optional, legacy } = lists(driverId);
    const wanted = new Set([
      ...base,
      ...optional.filter((capability) => seenCaps[capability]),
      ...legacy.filter((capability) => has(capability)),
    ]);
    return [...order.filter((capability) => wanted.has(capability)), ...[...wanted].filter((capability) => !order.includes(capability))];
  },

};
