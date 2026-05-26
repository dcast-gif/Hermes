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
export async function getDepartures(stopId) {
  // Try StopPoint arrivals (works for tube/overground/dlr/elizabeth)
  // For national-rail we use departures board
  const url = `${BASE}/StopPoint/${encodeURIComponent(stopId)}/Arrivals`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Departures failed: ${res.status}`);

  const data = await res.json();

  // Sort by expected arrival, take next 30
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
      scheduledTime: d.expectedArrival ? new Date(d.expectedArrival).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null,
      status: d.currentLocation || 'On time',
      mode: d.modeName || 'tube'
    }));
}

// ── NATIONAL RAIL DEPARTURES (via Journey Planner) ────────
// For national-rail stops, use the departures board endpoint
export async function getNationalRailDepartures(stopId) {
  const url = `${BASE}/StopPoint/${encodeURIComponent(stopId)}/Departures`;
  const res = await fetch(url);

  if (!res.ok) {
    // Fall back to arrivals endpoint
    return getDepartures(stopId);
  }

  const data = await res.json();
  const boards = data.departureBoardsResponse || data;
  const deps = Array.isArray(boards) ? boards : (boards.departures || []);

  return deps.slice(0, 30).map((d, i) => ({
    id: d.id || `nr-${i}-${d.scheduledDeparture}`,
    line: d.lineName || d.operator || 'National Rail',
    lineId: d.lineId || 'national-rail',
    destination: d.destinationName || d.destination || 'Unknown',
    platform: d.platform || null,
    expectedMins: null,
    expectedTime: d.expectedDeparture || d.scheduledDeparture || null,
    scheduledTime: d.scheduledDeparture || null,
    status: d.currentDepartures?.[0]?.reason || d.reason || 'On time',
    mode: 'national-rail'
  }));
}

// ── SMART DEPARTURES — tries best endpoint for stop ───────
export async function getSmartDepartures(stop) {
  const isNationalRail = (stop.modes || []).includes('national-rail') &&
    !(stop.modes || []).includes('tube') &&
    !(stop.modes || []).includes('elizabeth-line');

  try {
    if (isNationalRail) {
      return await getNationalRailDepartures(stop.id);
    } else {
      return await getDepartures(stop.id);
    }
  } catch (e) {
    // Try the other endpoint as fallback
    try {
      return await getDepartures(stop.id);
    } catch (e2) {
      throw new Error(`Could not fetch departures: ${e2.message}`);
    }
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