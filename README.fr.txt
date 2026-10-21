Suivez votre installation SolarEdge en direct dans Homey : production solaire, consommation de la maison, le réseau, votre batterie et la recharge de votre véhicule électrique. Utilisez les données dans les Flows et dans Homey Energy.

Deux modes de connexion :
- Cloud : connectez-vous avec l'adresse e-mail et le mot de passe de votre compte mySolarEdge. Fonctionne sur tous les Homey, y compris Homey Cloud.
- Modbus : connexion directe à l'onduleur sur votre réseau local. Fonctionne uniquement sur Homey Pro. Modbus TCP doit être activé sur l'onduleur (votre installateur peut le faire dans SetApp).

Appareils cloud : onduleur (un appareil par onduleur), compteur, batterie, borne de recharge et Home Load Controller.
Appareils Modbus : onduleur, compteur, batterie et SolarEdge Home EV Charger, avec pilotage de la puissance de sortie, de l'injection sur le réseau, de la charge de la batterie et de la recharge du véhicule.

Limitations connues : la connexion cloud ne fonctionne pas pour les comptes utilisant l'authentification à deux facteurs (2FA) ou se connectant avec un compte d'entreprise (authentification unique, SSO).
