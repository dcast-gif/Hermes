/**
 * tfl.js — TrainWatch TfL API helpers
 */

const BASE = 'https://api.tfl.gov.uk';

const MODES = ['national-rail', 'tube', 'overground', 'elizabeth-line', 'dlr'];

// ── STATION SEARCH ─────────────────────────────────────────
export async function searchStations(query, limit = 10) {
  const q = String(query || '').trim().replace(/[''`]/g, "'");
  if (q.length < 2) return [];

  const url = new URL(`${BASE}/StopPoint/Search/${encodeURIComponent(q)}`);
  url.searchParams.set('modes', MODES.join(','));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Station search failed: ${res.status}`);

  const data = await res.json();
  return (data.matches || [])
    .filter(s => s.id && s.name)
    .map(s => ({
      id: s.id,
      name: s.name,
      modes: s.modes || [],
      zone: s.zone || null
    }))
    .slice(0, limit);
}

// ── LIVE DEPARTURES ────────────────────────────────────────
// Returns next departures from a stop
// ── LIVE DEPARTURES (tube/overground/elizabeth/dlr) ────────
export async function getDepartures(stopId) {
  const url = `${BASE}/StopPoint/${encodeURIComponent(stopId)}/Arrivals`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Departures failed: ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : [])
    .filter(d => d.timeToStation >= 0)
    .sort((a, b) => a.timeToStation - b.timeToStation)
    .slice(0, 30)
    .map(d => ({
      id: d.vehicleId || d.id || `${d.lineId}-${d.timeToStation}`,
      line: d.lineName || d.lineId || 'Unknown',
      lineId: d.lineId || '',
      destination: d.towards || d.destinationName || 'Unknown',
      platform: d.platformName || d.platform || null,
      expectedMins: Math.round(d.timeToStation / 60),
      expectedTime: minsToTime(d.timeToStation),
      scheduledTime: d.expectedArrival
        ? new Date(d.expectedArrival).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : null,
      status: d.currentLocation || 'On time',
      mode: d.modeName || 'tube'
    }));
}

// ── NATIONAL RAIL DEPARTURES via Journey Planner ───────────
// Uses TfL's journey planner to get departures from a stop at a given time
export async function getNationalRailDepartures(stopId, timeStr) {
  // timeStr format: "HH:MM" — defaults to now
  const now = new Date();
  const depTime = timeStr || now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const depDate = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;

  // We use a known busy destination (London Waterloo) as a dummy "to"
  // to get the departures board from this stop
  // The real goal is to get all trains leaving this stop
  // TfL's /StopPoint/{id}/Timetable/{lineId} is another option but requires knowing the line
  // Best option: use the departures board endpoint
  const url = new URL(`${BASE}/Journey/JourneyResults/${encodeURIComponent(stopId)}/to/1000198`);
  url.searchParams.set('nationalSearch', 'true');
  url.searchParams.set('timeIs', 'Departing');
  url.searchParams.set('time', depTime.replace(':', ''));
  url.searchParams.set('date', depDate);
  url.searchParams.set('journeyPreference', 'LeastTime');

  const res = await fetch(url.toString());
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Journey planner failed: ${res.status}`);
  }

  const data = await res.json();
  const journeys = data.journeys || [];

  // Extract first leg of each journey = the departing train from our stop
  const seen = new Set();
  const deps = [];
  journeys.forEach(j => {
    const firstLeg = j.legs?.[0];
    if (!firstLeg) return;
    const depPoint = firstLeg.departurePoint?.commonName || '';
    const depTime = firstLeg.departureTime
      ? new Date(firstLeg.departureTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : null;
    const dest = firstLeg.arrivalPoint?.commonName || j.legs?.[j.legs.length-1]?.arrivalPoint?.commonName || 'Unknown';
    const line = firstLeg.routeOptions?.[0]?.name || firstLeg.mode?.name || 'National Rail';
    const lineId = firstLeg.routeOptions?.[0]?.lineIdentifier?.id || 'national-rail';
    const platform = firstLeg.platform || null;
    const key = `${depTime}-${dest}-${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    deps.push({
      id: key,
      line,
      lineId,
      destination: dest,
      platform,
      expectedMins: null,
      expectedTime: depTime,
      scheduledTime: depTime,
      status: 'On time',
      mode: 'national-rail'
    });
  });

  return deps;
}

// ── SMART DEPARTURES ───────────────────────────────────────
export async function getSmartDepartures(stop, timeStr) {
  const isNationalRail = (stop.modes || []).includes('national-rail') &&
    !(stop.modes || []).includes('tube') &&
    !(stop.modes || []).includes('elizabeth-line') &&
    !(stop.modes || []).includes('overground');

  if (isNationalRail) {
    return getNationalRailDepartures(stop.id, timeStr);
  }
  try {
    return await getDepartures(stop.id);
  } catch(e) {
    return getNationalRailDepartures(stop.id, timeStr);
  }
}

// ── LINE STATUS ────────────────────────────────────────────
export async function getLineStatus(lineId) {
  if (!lineId) return null;
  const res = await fetch(`${BASE}/Line/${encodeURIComponent(lineId)}/Status`);
  if (!res.ok) return null;
  const data = await res.json();
  const line = Array.isArray(data) ? data[0] : data;
  return line?.lineStatuses?.[0]?.statusSeverityDescription || 'Good Service';
}

export async function getMultiLineStatus(lineIds) {
  const ids = [...new Set(lineIds.filter(Boolean))];
  if (!ids.length) return {};
  const res = await fetch(`${BASE}/Line/${encodeURIComponent(ids.join(','))}/Status`);
  if (!res.ok) return {};
  const data = await res.json();
  const out = {};
  (Array.isArray(data) ? data : []).forEach(line => {
    out[line.id] = line.lineStatuses?.[0]?.statusSeverityDescription || 'Good Service';
  });
  return out;
}

// ── DISRUPTIONS ────────────────────────────────────────────
export async function getStopDisruptions(stopId) {
  const res = await fetch(`${BASE}/StopPoint/${encodeURIComponent(stopId)}/Disruption`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── HELPERS ────────────────────────────────────────────────
function minsToTime(seconds) {
  const now = new Date();
  now.setSeconds(now.getSeconds() + seconds);
  return now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function debounce(fn, delay = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// ── GLOBAL ACCESS ──────────────────────────────────────────
window.TW = {
  searchStations,
  getDepartures,
  getNationalRailDepartures,
  getSmartDepartures,
  getLineStatus,
  getMultiLineStatus,
  getStopDisruptions,
  debounce
};