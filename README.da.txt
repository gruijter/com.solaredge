Følg dit SolarEdge-anlæg live i Homey: solproduktion, husets forbrug, elnettet, dit batteri og opladning af din elbil. Brug dataene i Flows og i Homey Energy.

To måder at forbinde på:
- Cloud: log ind med e-mailadressen og adgangskoden til din mySolarEdge-konto. Virker på alle Homey, også Homey Cloud.
- Modbus: forbind direkte til inverteren på dit lokale netværk. Virker kun på Homey Pro. Modbus TCP skal være slået til på inverteren (din installatør kan gøre det i SetApp).

Cloud-enheder: inverter (én enhed pr. inverter), måler, batteri, ladestander og Home Load Controller.
Modbus-enheder: inverter, måler, batteri og SolarEdge Home EV Charger, inklusive styring af udgangseffekt, eksport til nettet, opladning af batteriet og opladning af elbilen.

Kendte begrænsninger: cloud-login virker ikke for konti med totrinsbekræftelse (2FA) eller som logger ind med en virksomhedskonto (single sign-on).
