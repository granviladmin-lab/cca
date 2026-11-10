import { ROUND_MS, bucketAt, numberFor, nextChangeAt, formatCountdown } from './shared.js';

const $ = (id) => document.getElementById(id);

const els = {
  lock: $('lock'),
  lockForm: $('lock-form'),
  password: $('password'),
  unlock: $('unlock'),
  lockError: $('lock-error'),
  app: $('app'),
  clock: $('clock'),
  millis: $('millis'),
  date: $('date'),
  utc: $('utc'),
  zone: $('zone'),
  source: $('time-source'),
  syncDetail: $('sync-detail'),
  number: $('number'),
  roundLabel: $('round-label'),
  countdown: $('countdown'),
  progress: $('round-progress'),
};

const PASSWORD = {
  salt: '276d7f7acd18e59fd5f73f896dec2ce6',
  iterations: 200_000,
  hash: '8fffbc28fa47513e0cd961f3a4c1e9830cf73bcc49a49da5a139204d1f52ba72',
};
const UNLOCK_KEY = 'carterlink.v2.unlocked';
const TIME_API = 'https://timeapi.io/api/Time/current/zone?timeZone=UTC';
const TIME_LIMIT = 5 * 60 * 1000;

const pad2 = (value) => String(value).padStart(2, '0');
const pad3 = (value) => String(value).padStart(3, '0');

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

let anchor = { epoch: Date.now(), perf: performance.now() };
let sync = {
  kind: 'device',
  server: 'device clock',
  accuracy: null,
  syncedAt: null,
};
let syncing = false;
let started = false;

let shownBucket = null;
let shownDate = '';
let shownZone = '';
let shownSyncDetail = '';
let shownSource = '';

const serverNow = () => anchor.epoch + (performance.now() - anchor.perf);

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function passwordMatches(value) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser cannot check the password. Try a current browser over HTTPS.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(PASSWORD.salt),
      iterations: PASSWORD.iterations,
      hash: 'SHA-256',
    },
    key,
    256,
  );
  return bytesToHex(bits) === PASSWORD.hash;
}

function unlockedThisSession() {
  try {
    return sessionStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberUnlock() {
  try {
    sessionStorage.setItem(UNLOCK_KEY, '1');
  } catch {
    // A private window may refuse session storage. The page still unlocks.
  }
}

function showApp() {
  els.lock.hidden = true;
  els.app.hidden = false;
  document.body.classList.remove('locked');
  start();
}

function start() {
  if (started) return;
  started = true;
  syncTime();
  setInterval(syncTime, TIME_LIMIT);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!sync.syncedAt || performance.now() - sync.syncedAt > 60_000)) {
      syncTime();
    }
  });
  requestAnimationFrame(tick);
}

function ageText(seconds) {
  if (seconds == null) return 'not yet';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}

function setSource(text, className, title) {
  if (text === shownSource) return;
  els.source.textContent = text;
  els.source.className = `pill ${className}`;
  els.source.title = title;
  shownSource = text;
}

function renderSync() {
  if (sync.kind === 'network') {
    const accuracy = sync.accuracy ? `±${sync.accuracy} ms` : 'network';
    setSource(`network · ${accuracy}`, 'synced', `Network time from ${sync.server}`);
  } else if (sync.kind === 'page') {
    setSource('page clock · ±1 s', 'warning', 'Fallback clock from the page server response');
  } else {
    setSource('device clock', 'warning', 'No network time source is available');
  }

  const age = sync.syncedAt == null ? null : (performance.now() - sync.syncedAt) / 1_000;
  const detail =
    sync.kind === 'device'
      ? 'no network time yet — using this device’s clock'
      : `synced ${ageText(age)} · ${sync.server}`;
  if (detail !== shownSyncDetail) {
    els.syncDetail.textContent = detail;
    shownSyncDetail = detail;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function syncFromApi() {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${TIME_API}&t=${Date.now()}`, {
    cache: 'no-store',
    mode: 'cors',
  });
  const finishedAt = performance.now();
  if (!response.ok) throw new Error(`time service returned ${response.status}`);

  const data = await response.json();
  const epoch = Date.UTC(
    data.year,
    data.month - 1,
    data.day,
    data.hour,
    data.minute,
    data.seconds,
    data.milliSeconds || 0,
  );
  if (!Number.isFinite(epoch)) throw new Error('time service returned an invalid timestamp');

  const rtt = Math.max(0, finishedAt - startedAt);
  anchor = { epoch: epoch + rtt / 2, perf: finishedAt };
  sync = {
    kind: 'network',
    server: 'timeapi.io',
    accuracy: Math.max(1, Math.round(rtt / 2)),
    syncedAt: finishedAt,
  };
  renderSync();
}

async function syncFromPage() {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`./shared.js?t=${Date.now()}`, {
    cache: 'no-store',
  });
  const finishedAt = performance.now();
  const header = response.headers.get('date');
  if (!header) throw new Error('page server did not send a Date header');

  const parsed = Date.parse(header);
  if (!Number.isFinite(parsed)) throw new Error('page server sent an invalid Date header');

  // The HTTP Date header has one-second resolution. Its midpoint is a better
  // estimate than rounding down to the start of that second.
  anchor = { epoch: parsed + 500, perf: finishedAt };
  sync = {
    kind: 'page',
    server: 'page server (fallback)',
    accuracy: 1_000,
    syncedAt: finishedAt,
  };
  renderSync();
}

async function syncTime() {
  if (syncing) return;
  syncing = true;
  try {
    await syncFromApi();
  } catch {
    try {
      await syncFromPage();
    } catch {
      // Keep the last known anchor. A later attempt can catch up.
      if (sync.kind === 'device') renderSync();
    }
  } finally {
    syncing = false;
  }
}

function tick() {
  const now = serverNow();
  const date = new Date(now);

  els.clock.textContent = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  els.millis.textContent = `.${pad3(date.getMilliseconds())}`;

  const dateText = dateFormat.format(date);
  if (dateText !== shownDate) {
    els.date.textContent = dateText;
    shownDate = dateText;
  }

  els.utc.textContent = `UTC ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '−';
  const absolute = Math.abs(offsetMinutes);
  const zoneText = `${timeZone} · UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
  if (zoneText !== shownZone) {
    els.zone.textContent = zoneText;
    shownZone = zoneText;
  }

  renderSync();

  const bucket = bucketAt(now);
  if (bucket !== shownBucket) {
    const digits = numberFor(bucket);
    els.number.textContent = `${digits.slice(0, 3)} ${digits.slice(3)}`;
    els.roundLabel.textContent = `round ${bucket.toLocaleString()}`;

    if (shownBucket !== null) {
      els.number.classList.remove('flip');
      void els.number.offsetWidth;
      els.number.classList.add('flip');
    }
    shownBucket = bucket;
  }

  els.countdown.textContent = formatCountdown(nextChangeAt(now) - now);
  const progress = (now - bucket * ROUND_MS) / ROUND_MS;
  els.progress.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;

  requestAnimationFrame(tick);
}

els.lockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (els.unlock.disabled) return;

  const value = els.password.value;
  if (!value) {
    els.lockError.textContent = 'Enter the client password.';
    return;
  }

  els.unlock.disabled = true;
  els.lockError.textContent = '';
  try {
    if (!(await passwordMatches(value))) {
      els.lockError.textContent = 'That password does not match.';
      els.password.select();
      return;
    }
    rememberUnlock();
    showApp();
  } catch (error) {
    els.lockError.textContent = error.message || 'Could not check the password.';
  } finally {
    els.unlock.disabled = false;
  }
});

if (unlockedThisSession()) {
  showApp();
} else {
  els.password.focus();
}
