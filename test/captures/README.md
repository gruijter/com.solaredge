# Captures

Real API responses per site (`<siteId>.json`), replayed by `test/responses.js` in `npm test`,
together with the made-up site in `test/fixtures/synthetic-site.json` (`node test/make-synthetic.js`).

## From a tester's diagnostics report

The app logs every distinct API answer once after an app start, a device restart and a pairing
(`lib/solarEdgeCapture.js`). Ask the tester to:

1. restart the app,
2. wait 1–2 minutes (the first poll and the 5-minute energy calls run right after the start),
3. send a diagnostics report.

Then turn the report into a capture:

```bash
node test/from-logs.js report.txt          # test/captures/<siteId>.json per site
node test/from-logs.js report.txt --dry    # only show what it found
```

The site's name, address, coordinates and image links are redacted in the log; serial numbers and
device names are kept. Look in the report for the device lines logged once per app run (`battery`,
`device state`, `inverter status`, `unknown ...`, `... fell from ...`): they show what the drivers
made of the data, and where it did not match what they assume.

## From an account

```bash
SOLAREDGE_USERNAME=... SOLAREDGE_PASSWORD=... node test/capture.js
```

This runs the app's own pairing and one poll per offered device against the live API and records
every call it makes. The account is only read: write calls are refused. Each site gets its own
file. Running it again overwrites that file.

A capture holds the site's serial numbers (and, from `capture.js`, its name and address), so
everything in this folder except this README is gitignored. `test/` is in `.homeyignore`, so
captures never end up in the app.

When the code starts calling an endpoint that is not in a capture, `responses.js` fails with
`not captured: <method> <args>`. Record the capture again.
