# SolarEdge for Homey

Powering People's Lives Around the World

<img src="./assets/images/large.png" alt="SolarEdge" width="500"/>

Connect your SolarEdge installation to [Homey](https://homey.app) and follow your solar production, battery, grid and EV charging live. Use the data in Flows and in Homey Energy.

The app signs in with your **mySolarEdge** account (the e-mail address and password of the mySolarEdge app). You do not need an API key or installer access.

## Supported devices

During pairing, the app only offers the devices your site actually has.

- **Inverter:** solar power, plus the energy produced today, this month, this year and in total.
- **Meter** (sites with a grid meter): home consumption, grid power (import positive, export negative), solar power, and the imported and exported energy for Homey Energy.
- **Battery:** charge and discharge power, state of charge and charging state.
- **EV Charger:** charging power and state, energy charged, and starting and stopping charging from Homey.
- **Home Load Controller:** SolarEdge smart energy switches. You can set them to on, off or auto from the device or from a Flow.

Live power updates every 5 seconds. Energy totals update every 5 minutes.

## Installation

Install the app from the [Homey App Store](https://homey.app/a/com.solaredge). Add a device and sign in with your mySolarEdge e-mail and password.

## Support

Questions and feedback are welcome on the [Homey Community forum](https://community.homey.app/t/134605). Report bugs as a [GitHub issue](https://github.com/gruijter/com.solaredge/issues).

## Credits

Originally developed by Emile Nijssen (Athom). Maintained by Robin de Gruijter.

## License

[GPL-3.0](./LICENSE)
