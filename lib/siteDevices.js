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

/**
 * Every device of a getSiteDevices / getSiteBatteries answer: `devices` and all lists in
 * `devicesByType`, once per reporterId. A real EV charger answer (briadelour/SolarEdgeEVCharger
 * example_raw_json) has it only in devicesByType.EV_CHARGER, with `devices` empty.
 * @returns {object[]}
 */
module.exports = (response) => {
  const all = [...(response?.devices || []), ...Object.values(response?.devicesByType || {}).flat()];
  const seen = new Set();
  return all.filter((device) => {
    const id = device?.reporterId ?? device?.info?.serialNumber;
    if (id === undefined || seen.has(id)) return id === undefined;
    seen.add(id);
    return true;
  });
};
