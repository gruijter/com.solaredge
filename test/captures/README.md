# Captures

Real API responses per site (`<siteId>.json`), replayed by `test/responses.js` in `npm test`.
Without captures that test is skipped.

Record them from a mySolarEdge account:

```bash
SOLAREDGE_USERNAME=... SOLAREDGE_PASSWORD=... node test/capture.js
```

This runs the app's own pairing and one poll per offered device against the live API and records
every call it makes. The account is only read: write calls are refused. Each site gets its own
file. Running it again overwrites that file.

A capture holds the site's name, address and serial numbers, so everything in this folder except
this README is gitignored. `test/` is in `.homeyignore`, so captures never end up in the app.

When the code starts calling an endpoint that is not in a capture, `responses.js` fails with
`not captured: <method> <args>`. Record the capture again.
