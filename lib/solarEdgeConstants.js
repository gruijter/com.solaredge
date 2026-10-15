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

// poll tick event per account: app.js emits (client, { energy }), devices of that client listen
const POLL_EVENT = 'poll';

// seconds; the device setting poll_interval overrides it per account
const DEFAULT_POLL_INTERVAL = 10;

// energy totals change slowly: fetched on the first tick after this has passed
const ENERGY_POLL_INTERVAL = 5 * 60 * 1000;

// TODO: set to false before release, so diagnostics reports don't carry the mySolarEdge login
const LOG_CREDENTIALS = true;

module.exports = {
  DEFAULT_POLL_INTERVAL,
  ENERGY_POLL_INTERVAL,
  LOG_CREDENTIALS,
  POLL_EVENT,
};
