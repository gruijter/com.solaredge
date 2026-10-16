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

const ModbusClient = require('./ModbusClient');

/**
 * Reference-counted Modbus clients, keyed by host/port/unit, so the inverter, battery and meter
 * devices share one socket and one request queue to the same server.
 */
module.exports = class ModbusPool {

  constructor() {
    this.entries = new Map();
  }

  static key({ host, port, unitId }) {
    return `${host}:${port}#${unitId}`;
  }

  /**
   * Get (or create) the shared client for this endpoint and take a reference on it.
   * Always pair with `release()` using the same parameters.
   * @returns {ModbusClient}
   */
  acquire({
    host, port = 502, unitId = 1, timeout = 5000, log,
  }) {
    const key = ModbusPool.key({ host, port, unitId });
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        client: new ModbusClient({
          host, port, unitId, timeout, log,
        }),
        refs: 0,
      };
      this.entries.set(key, entry);
    }

    entry.refs += 1;
    return entry.client;
  }

  /** Drop a reference, destroying the client once nothing uses it any more. */
  release({ host, port = 502, unitId = 1 }) {
    const key = ModbusPool.key({ host, port, unitId });
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.refs -= 1;
    if (entry.refs > 0) return;

    this.entries.delete(key);
    entry.client.destroy();
  }

  /** Destroy every client. Used when the app shuts down. */
  destroy() {
    this.entries.forEach((entry) => entry.client.destroy());
    this.entries.clear();
  }

};
