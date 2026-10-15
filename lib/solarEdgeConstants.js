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

// app-wide poll tick event (app.js emits, devices listen)
const POLL_EVENT = 'poll';

// one tick for all devices, so their identical calls (powerflow per site) go out once
const POLL_INTERVAL = 5 * 1000;

// TODO: set to false before release, so diagnostics reports don't carry the mySolarEdge login
const LOG_CREDENTIALS = true;

module.exports = {
  LOG_CREDENTIALS,
  POLL_EVENT,
  POLL_INTERVAL,
};
