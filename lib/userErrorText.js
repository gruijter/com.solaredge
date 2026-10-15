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

// error code -> locales key
const CODE_KEYS = {
  INVALID_CREDENTIALS: 'errors.invalidCredentials',
  DEVICE_NOT_FOUND: 'errors.deviceNotFound',
};

/**
 * The text for the user of an error from SolarEdgeCloudClient, fetch or a device.
 * @param {object} homey this.homey of a device or driver
 * @param {Error} error
 * @returns {string}
 */
module.exports = function userErrorText(homey, error) {
  if (CODE_KEYS[error?.code]) return homey.__(CODE_KEYS[error.code]);
  // AbortSignal.timeout and an unreachable host, from native fetch (verified on Node 24)
  if (error?.name === 'TimeoutError') return homey.__('errors.timeout');
  if (error?.message === 'fetch failed') return homey.__('errors.unreachable');
  return `${homey.__('errors.api')}: ${error?.message ?? error}`;
};
