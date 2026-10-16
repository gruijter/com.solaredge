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

const Homey = require('homey');
const ModbusClient = require('./ModbusClient');
const ModbusDevice = require('./modbus_device');
const pointMap = require('./solarEdgePointMap');

/*
 * Pairing of the local Modbus TCP drivers, after com.solarwatt's CommonDriver. The user enters the
 * address (no mDNS yet), then picks from the units found there: one inverter, or each meter or
 * battery behind it.
 */

const DEFAULT_POLL_INTERVAL = 10; // seconds

/** Pairing must answer well inside Homey's 30s budget, so probes are kept short. */
const PAIR_TIMEOUT = 4000;

module.exports = class ModbusDriver extends Homey.Driver {

  async onInit() {
    this.definition = pointMap[this.id];
    this.log(`${this.id} driver has been initialized`);
  }

  /** manual (address) -> list_devices (the units found there) -> add_devices. */
  onPair(session) {
    let found = [];
    session.setHandler('manual_fields', async () => ({ port: this.definition.port, unitId: this.definition.unitId }));
    session.setHandler('manual_connect', async (data) => {
      found = await this.findDevices(data);
      return found.length;
    });
    session.setHandler('list_devices', async () => found);
  }

  normalizeEndpoint({ host, port, unitId }) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) throw Error(this.homey.__('errors.hostRequired'));
    return {
      host: cleanHost,
      port: Number(port) || this.definition.port,
      unitId: Number(unitId) || this.definition.unitId,
    };
  }

  /**
   * Read `blocks` into one address-keyed map, in order, `readGapMs` apart.
   * @returns {Promise<Map<number, number>>}
   */
  async read(client, blocks) {
    const registers = new Map();
    for (const [index, block] of blocks.entries()) {
      if (index > 0 && this.definition.readGapMs) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          this.homey.setTimeout(resolve, this.definition.readGapMs);
        });
      }
      // eslint-disable-next-line no-await-in-loop
      const data = await client.readRegisters(block.start, block.count);
      for (let i = 0; i < block.count; i += 1) registers.set(block.start + i, data.readUInt16BE(i * 2));
    }
    return registers;
  }

  /**
   * The devices this driver can add at an address, ready for list_devices; throws when nothing
   * (suitable) answers there.
   */
  async findDevices(fields) {
    const endpoint = this.normalizeEndpoint(fields);
    const client = new ModbusClient({
      ...endpoint, timeout: PAIR_TIMEOUT, log: (message) => this.log(message),
    });
    const read = (blocks) => this.read(client, blocks);

    let devices;
    try {
      const units = await this.definition.findUnits(read);
      devices = [];
      for (const { base } of units) {
        // eslint-disable-next-line no-await-in-loop
        const registers = await read(this.definition.identityBlocks(base));
        devices.push(this.buildDevice({ endpoint, base, registers }));
      }
    } catch (error) {
      this.log(`[pair] ${endpoint.host}:${endpoint.port}#${endpoint.unitId}: ${error.message}`);
      throw Error(`${this.homey.__('errors.modbusProbeFailed')} (${error.message})`);
    } finally {
      client.destroy();
    }

    if (devices.length === 0) throw Error(this.homey.__('errors.modbusNoUnits'));
    return devices;
  }

  /** The Homey device object for the unit at `base`. */
  buildDevice({ endpoint, base, registers }) {
    const identity = this.definition.identity(registers, base);
    const name = this.manifest.name[this.homey.i18n.getLanguage()] || this.manifest.name.en;
    return {
      name: `${name} ${identity.serialNumber || endpoint.host}`,
      data: { id: this.definition.dataId(registers, base) || `${endpoint.host}-${base}` },
      store: { base },
      settings: {
        ...endpoint,
        pollInterval: DEFAULT_POLL_INTERVAL,
        ...ModbusDevice.identitySettings(identity, this.manifest),
      },
    };
  }

};
