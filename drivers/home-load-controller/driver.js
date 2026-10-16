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
const SolarEdgeHomeLoadControllerDevice = require('./device');
const siteDevices = require('../../lib/siteDevices');

module.exports = class SolarEdgeHomeLoadControllerDriver extends CommonDriver {

  async onPairListDevices({ client, site }) {
    const devices = siteDevices(await client.getSiteDevices({ siteId: site.id }));

    return devices
      .filter((device) => device.type === 'ON_OFF')
      .map((device) => ({
        name: device.name,
        data: {
          reporterId: device.reporterId,
          serialNumber: device.serialNumber,
        },
      }));
  }

  async onPairCapabilityValues({ client, site, device }) {
    return SolarEdgeHomeLoadControllerDevice.pairValues({ client, site, device });
  }

};
