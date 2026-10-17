// Shared by the iPad station (station.html) and the viewer (index.html).
// Written for Safari on iOS 12: no optional chaining, no ??, no class fields.
//
// Everything in the feed repo is AES-256-GCM encrypted with a key derived from
// the station password (PBKDF2-SHA256), so the public repo only holds ciphertext.
// File layout in each encrypted blob: 12-byte IV followed by the ciphertext.
var STATION = {
  owner: 'granviladmin-lab',
  repo: 'ipad-station-feed',
  branch: 'main',
  // Not secret: it only makes precomputed password tables useless.
  salt: 'YLDXZ8h7l9vTLU693NiqnQ==',
  iterations: 600000,
  // Mooresville, NC 28115
  place: 'Mooresville, NC',
  lat: 35.5849,
  lon: -80.8101,
  tz: 'America/New_York',
  keepEvents: 150
};

function b64ToBytes(s) {
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(u8) {
  var s = '';
  for (var i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function deriveKey(password) {
  var enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey'])
    .then(function (base) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64ToBytes(STATION.salt), iterations: STATION.iterations, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
}

function encryptBytes(key, bytes) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, bytes).then(function (ct) {
    var out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return out;
  });
}

function decryptBytes(key, blob) {
  var u8 = new Uint8Array(blob);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12))
    .then(function (pt) { return new Uint8Array(pt); });
}

function encryptJSON(key, obj) {
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(obj)));
}

function decryptJSON(key, blob) {
  return decryptBytes(key, blob).then(function (u8) { return JSON.parse(new TextDecoder().decode(u8)); });
}

function randomId() {
  var u8 = crypto.getRandomValues(new Uint8Array(8)), s = '';
  for (var i = 0; i < u8.length; i++) s += ('0' + u8[i].toString(16)).slice(-2);
  return s;
}

// Weather codes from Open-Meteo (WMO). [label, emoji]
var WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️']
};

function wmo(code) { return WMO[code] || ['—', '🌡️']; }

function fetchWeather() {
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + STATION.lat + '&longitude=' + STATION.lon +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day' +
    '&hourly=temperature_2m,weather_code,precipitation_probability' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=' + encodeURIComponent(STATION.tz) + '&forecast_days=7';
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('weather ' + r.status);
    return r.json();
  });
}

function fetchAlerts() {
  return fetch('https://api.weather.gov/alerts/active?point=' + STATION.lat + ',' + STATION.lon, {
    headers: { Accept: 'application/geo+json' }
  }).then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .then(function (j) { return (j.features || []).map(function (f) { return f.properties; }); })
    .catch(function () { return []; });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: STATION.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}
