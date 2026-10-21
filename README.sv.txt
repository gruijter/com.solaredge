Följ din SolarEdge-anläggning live i Homey: solproduktion, husets förbrukning, elnätet, ditt batteri och laddningen av din elbil. Använd datan i Flows och i Homey Energy.

Två sätt att ansluta:
- Moln: logga in med e-postadressen och lösenordet för ditt mySolarEdge-konto. Fungerar på alla Homey, även Homey Cloud.
- Modbus: anslut direkt till växelriktaren i ditt lokala nätverk. Fungerar bara på Homey Pro. Modbus TCP måste vara aktiverat på växelriktaren (din installatör kan göra det i SetApp).

Molnenheter: växelriktare (en enhet per växelriktare), mätare, batteri, laddbox och Home Load Controller.
Modbus-enheter: växelriktare, mätare, batteri och SolarEdge Home EV Charger, inklusive styrning av uteffekt, export till elnätet, laddning av batteriet och laddning av elbilen.

Kända begränsningar: molninloggningen fungerar inte för konton med tvåstegsverifiering (2FA) eller som loggar in med ett företagskonto (enkel inloggning, SSO).
