#!/usr/bin/env node
// Fetches Poly Prep's public iCal feeds and a weather snapshot, and rewrites
// the FEED_EVENTS and WEATHER_SNAPSHOT blocks inside index.html (between the
// ===POLY-SYNC-=== and ===WEATHER-SNAPSHOT-=== markers). EXTRA_EVENTS and
// MANUAL_EVENTS are never touched.
//
// Usage: node sync-poly.js
// Last line of output is "RESULT: CHANGED" or "RESULT: NO_CHANGES".

const fs = require("fs");
const path = require("path");

const HTML_PATH = path.join(__dirname, "index.html");
// Keep in sync with WX_URL in index.html
const WX_URL = "https://api.open-meteo.com/v1/forecast?latitude=40.6687&longitude=-73.9737" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum,wind_speed_10m_max,uv_index_max" +
  "&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code" +
  "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York&forecast_days=7";
const FEEDS = [
  { name: "All School",   category: "school", url: "https://www.polyprep.org/sync/PolyCalendar.php?format=cal&event_type=All%20School&exclude=false" },
  { name: "Lower School", category: "school", url: "https://www.polyprep.org/sync/PolyCalendar.php?format=cal&event_type=Lower%20School&exclude=false" },
  { name: "Arts",         category: "arts",   url: "https://www.polyprep.org/sync/PolyCalendar.php?format=cal&event_type=Arts&exclude=false" },
];

// Closures / no-class days — always big dates
const CLOSED_RE = /school closed|no classes|break\b|vacation|professional day|conferences/i;
// Other milestones parents plan around
const BIG_RE = /opening day|first day|homecoming|state of the school|back to school night|nursery adjustment|nursery regular schedule|pictures day/i;
// Nursery-relevant highlight
const NURSERY_RE = /nursery|pre-k/i;
// Arts-feed internals not aimed at families
const ARTS_SKIP_RE = /preseason|audition|tech rehearsal/i;

function unfold(ics) {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}
function unescapeText(s) {
  return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}
function parseEvents(ics) {
  const events = [];
  for (const block of unfold(ics).split("BEGIN:VEVENT").slice(1)) {
    // Nested VALARMs carry their own DESCRIPTION ("Reminder for ...") that
    // would otherwise overwrite the event's.
    const body = block.split("END:VEVENT")[0].replace(/BEGIN:VALARM[\s\S]*?END:VALARM/g, "");
    const props = {};
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/);
      if (m) props[m[1]] = m[2];
    }
    if (props.DTSTART && props.SUMMARY) events.push(props);
  }
  return events;
}
function splitDT(v) {
  // "20260907T120000" -> { date: "2026-09-07", time: "120000" }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{6}))?/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] || null };
}
function fmtTime(t) {
  let h = parseInt(t.slice(0, 2), 10);
  const min = t.slice(2, 4);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}
function shiftDate(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = n => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function toEvent(props, feed) {
  const title = unescapeText(props.SUMMARY);
  if (feed.category === "arts" && ARTS_SKIP_RE.test(title)) return null;

  const start = splitDT(props.DTSTART);
  if (!start) return null;
  let end = props.DTEND ? splitDT(props.DTEND) : null;
  // DTEND at midnight is exclusive — the event really ends the day before
  if (end && end.time === "000000") end.date = shiftDate(end.date, -1);

  // Their all-day conventions: start at 00:00, or the noon-to-23:59:59 pattern
  const allDay =
    start.time === "000000" ||
    (start.time === "120000" && end && end.time === "235959");

  const closed = CLOSED_RE.test(title);
  const ev = {
    date: start.date,
    title,
    category: closed ? "closed" : feed.category,
  };
  if (end && end.date > start.date) ev.endDate = end.date;
  if (!allDay && start.time) ev.time = fmtTime(start.time);
  const notes = [unescapeText(props.DESCRIPTION || ""), unescapeText(props.LOCATION || "")]
    .filter(Boolean).join(" · ");
  if (notes) ev.notes = notes;
  if (closed || BIG_RE.test(title)) ev.big = true;
  if (NURSERY_RE.test(title)) ev.nursery = true;
  ev.uid = props.UID || `${start.date}|${title}`;
  return ev;
}

async function fetchFeedEvents() {
  const byUid = new Map();
  for (const feed of FEEDS) {
    const res = await fetch(feed.url);
    if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
    const parsed = parseEvents(await res.text());
    let kept = 0;
    for (const props of parsed) {
      const ev = toEvent(props, feed);
      if (ev && !byUid.has(ev.uid)) { byUid.set(ev.uid, ev); kept++; }
    }
    console.log(`${feed.name}: ${parsed.length} events in feed, ${kept} kept`);
  }
  const events = [...byUid.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ? 0 : 1) - (b.time ? 0 : 1));
  for (const ev of events) delete ev.uid;
  return events;
}

function weatherGroup(code) {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  return "dry";
}
// Coarse buckets, so small forecast wiggles don't cause a commit/republish.
function weatherDigest(daily) {
  return daily.time.slice(0, 3).map((d, i) => [
    d,
    Math.round(daily.temperature_2m_max[i] / 3),
    Math.round(daily.temperature_2m_min[i] / 3),
    Math.floor((daily.precipitation_probability_max[i] || 0) / 20),
    weatherGroup(daily.weather_code[i]),
  ].join(":")).join("|");
}

function replaceBlock(html, name, body) {
  const start = `// ===${name}-START===`;
  const end = `// ===${name}-END===`;
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s === -1 || e === -1) throw new Error(`${name} markers not found in index.html`);
  const headerEnd = html.indexOf("\n", s);
  return html.slice(0, headerEnd + 1) + body + "\n  " + html.slice(e);
}

async function main() {
  const original = fs.readFileSync(HTML_PATH, "utf8");
  let html = original;
  const todayISO = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local

  const events = await fetchFeedEvents();
  const lines = events.map(ev => "    " + JSON.stringify(ev).replace(/</g, "\\u003C") + ",");
  const existing = html.match(/const FEED_EVENTS = \[\n([\s\S]*?)\n  \];/);
  if (!existing || existing[1] !== lines.join("\n")) {
    html = replaceBlock(html, "POLY-SYNC",
      `  const LAST_SYNCED = "${todayISO}";\n` +
      `  const FEED_EVENTS = [\n${lines.join("\n")}\n  ];`);
    console.log(`Feeds changed: ${events.length} events`);
  } else {
    console.log("Feeds unchanged");
  }

  try {
    const res = await fetch(WX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { daily, hourly } = await res.json();
    const digest = weatherDigest(daily);
    const old = html.match(/"digest":"([^"]*)"/);
    if (!old || old[1] !== digest) {
      const snapshot = { fetched: new Date().toISOString(), digest, daily, hourly };
      html = replaceBlock(html, "WEATHER-SNAPSHOT",
        `  const WEATHER_SNAPSHOT = ${JSON.stringify(snapshot)};`);
      console.log(`Weather changed: ${digest}`);
    } else {
      console.log("Weather unchanged (within thresholds)");
    }
  } catch (err) {
    console.warn(`Weather skipped: ${err.message}`);
  }

  if (html !== original) fs.writeFileSync(HTML_PATH, html);

  // Warn when a feed event looks like a hand-entered EXTRA_EVENTS entry on the
  // same date (and isn't already suppressed by its `replaces`) — a human
  // should drop one of them.
  const extraBlock = html.match(/const EXTRA_EVENTS = \[[\s\S]*?\n  \];/);
  if (extraBlock) {
    const words = s => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    const similar = (a, b) => {
      const wa = words(a), wb = words(b);
      const shared = [...wa].filter(w => wb.has(w)).length;
      return shared / Math.max(1, Math.min(wa.size, wb.size)) >= 0.6;
    };
    const extras = [...extraBlock[0].matchAll(
      /date: "(\d{4}-\d{2}-\d{2})"(?:, endDate: "[^"]*")?, title: "([^"]*)"[^}]*?(?:replaces: "([^"]*)")?[^}]*\}/g)];
    const dupes = extras.filter(([, date, title, replaces]) => date >= todayISO && !replaces &&
      events.some(ev => ev.date === date && similar(ev.title, title)));
    for (const [, date, title] of dupes) {
      console.warn(`WARNING: possible duplicate on ${date}: EXTRA_EVENTS "${title}" ` +
        `matches a feed event. Remove it from EXTRA_EVENTS or add a \`replaces\`.`);
    }
  }

  console.log(html !== original ? "RESULT: CHANGED" : "RESULT: NO_CHANGES");
}

main().catch(err => { console.error(err.message); process.exit(1); });
