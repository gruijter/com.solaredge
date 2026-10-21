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

const CommonDriver = require('../../lib/common_driver');
const SolarEdgeInverterDevice = require('./device');

module.exports = class SolarEdgeInverterDriver extends CommonDriver {

  async onPairFilterSite({ client, site }) {
    const sitePowerflow = await client.getSitePowerflow({ siteId: site.id });
    return sitePowerflow?.solarProduction?.isActive === true;
  }

  /** One device per inverter (as SolarEdge's web portal shows them); one for the site without an equipment list. */
  async onPairListDevices({ client, site }) {
    const devices = await super.onPairListDevices({ client, site });
    if (!devices.length) return devices;
    const equipment = await SolarEdgeInverterDevice.siteEquipment(client, site.id).catch((error) => {
      this.error(`[Pair] equipment of site ${site.id} failed:`, error.message);
      return null;
    });
    const serials = SolarEdgeInverterDevice.serialsOf(equipment);
    if (!serials.length) return devices;
    return serials.map((serialNumber) => ({
      ...devices[0],
      name: serials.length > 1 ? `${devices[0].name} ${serialNumber}` : devices[0].name,
      data: { serialNumber },
    }));
  }

  async onPairCapabilityValues({ client, site, device }) {
    return SolarEdgeInverterDevice.pairValues({
      client, site, homey: this.homey, device,
    });
  }

};
