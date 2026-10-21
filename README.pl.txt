Śledź swoją instalację SolarEdge na żywo w Homey: produkcję energii słonecznej, zużycie w domu, sieć, swój magazyn energii i ładowanie samochodu elektrycznego. Używaj danych we Flows i w Homey Energy.

Dwa sposoby połączenia:
- Chmura: zaloguj się adresem e-mail i hasłem swojego konta mySolarEdge. Działa na każdym Homey, również na Homey Cloud.
- Modbus: bezpośrednie połączenie z falownikiem w sieci lokalnej. Działa tylko na Homey Pro. Modbus TCP musi być włączony w falowniku (instalator może to zrobić w SetApp).

Urządzenia w chmurze: falownik (jedno urządzenie na falownik), licznik, magazyn energii, ładowarka EV i Home Load Controller.
Urządzenia Modbus: falownik, licznik, magazyn energii i SolarEdge Home EV Charger, ze sterowaniem mocą wyjściową, oddawaniem energii do sieci, ładowaniem magazynu i ładowaniem samochodu.

Znane ograniczenia: logowanie w chmurze nie działa dla kont z uwierzytelnianiem dwuskładnikowym (2FA) ani dla kont logujących się kontem firmowym (logowanie jednokrotne, SSO).
