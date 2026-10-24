# PolyCalPal

The unofficial what's-happening board for Poly Prep nursery parents, live at
[polycalpal.com](https://polycalpal.com). Made by parents; not affiliated with
or endorsed by Poly Prep.

- `index.html` is the whole site. Weather loads live in the browser from
  [Open-Meteo](https://open-meteo.com).
- `sync-poly.js` pulls the school's public calendar feeds (and a fallback
  weather snapshot) into `index.html`. A GitHub Action runs it hourly and
  commits when something changed.
- Hand-curated dates live in `EXTRA_EVENTS`; parent-added events go in
  `MANUAL_EVENTS`. The sync never touches either.
