# Modbus register dumps

Holding registers of real SolarEdge inverters (`{ "holding": { "<address>": <word> } }`), served by
the fake Modbus server in `test/modbus.js`. Taken unchanged from
[frenck/python-solaredged](https://github.com/frenck/python-solaredged) `tests/fixtures/`
(MIT License, see `LICENSE.md`), which collected them from solaredge-modbus-multi issues.

| File | Inverter | Contains |
|---|---|---|
| `se17k_3phase.json` | SE17K-RW0T0BNN4 | 3-phase inverter, no meter or battery |
| `issue913_u1.json` | SE10000H-AUSNBBX14 | 1-phase, meter, two batteries |
| `issue827_u1.json` | SE10K-RWS48BEN4 | meter (2 positions), battery charging |
| `issue944_u1.json` | SE8000H-RWBMNBF54 | 1-phase, meter, battery discharging |
| `issue565_u3.json` | SE-EV-SA-US-40P | SolarEdge EV charger answering as an inverter |

The dumps hold only the registers python-solaredged reads; the fake server answers every other
address in a requested block with `0x8000`.
