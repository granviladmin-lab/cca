// Message board relayed through ntfy.sh, a public pub/sub service that keeps
// messages for about 12 hours. Both the channel name and the AES-GCM key are
// derived from the client password, so neither appears in this source and
// ntfy only ever sees ciphertext under a channel nobody can guess.

const RELAY = 'https://ntfy.sh';
const BOARD_SALT = 'b3c1e07f5a9d42c88e16f0a4d29b7c53';
const BOARD_ITERATIONS = 200_000;
const SECRET_KEY = 'carterlink.v2.board';
const NAME_KEY = 'carterlink.v2.name';
const MAX_TEXT = 1000;
const MAX_NAME = 32;

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => Number.parseInt(h, 16));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// 48 bytes from the password: the first 32 are the AES key, the last 16 name the channel.
export async function deriveBoardSecret(password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(BOARD_SALT), iterations: BOARD_ITERATIONS, hash: 'SHA-256' },
    base,
    384,
  );
  return toHex(bits);
}

export function saveBoardSecret(secret) {
  try {
    sessionStorage.setItem(SECRET_KEY, secret);
  } catch {
    // Private windows may refuse storage; the board still works until reload.
  }
}

export function loadBoardSecret() {
  try {
    return sessionStorage.getItem(SECRET_KEY);
  } catch {
    return null;
  }
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export async function startBoard(secret) {
  const bytes = fromHex(secret);
  const key = await crypto.subtle.importKey('raw', bytes.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const topic = `cl2-${toHex(bytes.slice(32))}`;

  const els = {
    list: $('board-list'),
    empty: $('board-empty'),
    status: $('board-status'),
    form: $('board-form'),
    name: $('board-name'),
    text: $('board-text'),
    send: $('board-send'),
    error: $('board-error'),
  };

  const seen = new Set();
  const posts = [];
  let loaded = false;

  try {
    els.name.value = localStorage.getItem(NAME_KEY) || '';
  } catch {
    // Name memory is a convenience only.
  }

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = `board-status ${cls || ''}`;
  }

  async function encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return `cl2:${toB64(iv)}:${toB64(ct)}`;
  }

  async function decrypt(body) {
    const [tag, iv, ct] = String(body).split(':');
    if (tag !== 'cl2' || !iv || !ct) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct));
      const data = JSON.parse(dec.decode(plain));
      if (typeof data.n !== 'string' || typeof data.t !== 'string') return null;
      return { name: data.n.slice(0, MAX_NAME), text: data.t.slice(0, MAX_TEXT) };
    } catch {
      return null; // wrong key, tampered, or someone else's junk on the channel
    }
  }

  function render(post, fresh) {
    const li = document.createElement('li');
    if (fresh) li.className = 'fresh';
    const meta = document.createElement('div');
    meta.className = 'board-meta';
    const who = document.createElement('b');
    who.textContent = post.name || 'anonymous';
    const when = document.createElement('time');
    const date = new Date(post.time * 1000);
    when.dateTime = date.toISOString();
    when.textContent = (Date.now() - date < 20 * 3600 * 1000 && date.getDate() === new Date().getDate()
      ? timeFormat : dayFormat).format(date);
    meta.append(who, when);
    const body = document.createElement('p');
    body.className = 'board-body';
    body.textContent = post.text;
    li.append(meta, body);
    return li;
  }

  function insert(post, fresh) {
    // Keep posts in time order even if the relay delivers them out of order.
    let index = posts.length;
    while (index > 0 && posts[index - 1].time > post.time) index -= 1;
    posts.splice(index, 0, post);
    const nearBottom = els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 60;
    els.list.insertBefore(render(post, fresh), els.list.children[index] || null);
    els.empty.hidden = true;
    if (nearBottom || !loaded || post.mine) els.list.scrollTop = els.list.scrollHeight;
  }

  async function onMessage(msg) {
    if (msg.event !== 'message' || !msg.id || seen.has(msg.id)) return;
    seen.add(msg.id);
    const post = await decrypt(msg.message);
    if (!post) return;
    insert({ ...post, time: msg.time, id: msg.id, mine: msg.mine }, loaded);
  }

  // History first (ntfy keeps ~12 h), then a live stream from the newest id.
  async function loadHistory() {
    const res = await fetch(`${RELAY}/${topic}/json?poll=1&since=all`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`relay returned ${res.status}`);
    const lines = (await res.text()).split('\n').filter(Boolean);
    let last = 'all';
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        await onMessage(msg);
        if (msg.id) last = msg.id;
      } catch {
        // skip malformed lines
      }
    }
    return last;
  }

  let source = null;
  let lastId = 'all';

  function connect() {
    if (source) source.close();
    source = new EventSource(`${RELAY}/${topic}/sse?since=${encodeURIComponent(lastId)}`);
    source.onopen = () => setStatus('live', 'live');
    source.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && msg.event === 'message') lastId = msg.id;
        onMessage(msg);
      } catch {
        // ignore
      }
    };
    source.onerror = () => {
      // EventSource retries on its own, but it would replay from the original
      // since= value; reconnect manually from the newest id instead.
      setStatus('reconnecting…', 'down');
      source.close();
      setTimeout(connect, 3000);
    };
  }

  try {
    lastId = await loadHistory();
  } catch {
    setStatus('offline', 'down');
  }
  loaded = true;
  els.empty.hidden = posts.length > 0;
  els.list.scrollTop = els.list.scrollHeight;
  connect();

  // Reconnect promptly when a phone wakes the tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && source && source.readyState === EventSource.CLOSED) connect();
  });

  function autosize() {
    els.text.style.height = 'auto';
    els.text.style.height = `${Math.min(els.text.scrollHeight + 2, 160)}px`;
  }
  els.text.addEventListener('input', autosize);
  els.text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = els.name.value.trim().slice(0, MAX_NAME);
    const text = els.text.value.trim().slice(0, MAX_TEXT);
    if (!name) {
      els.error.textContent = 'Add your name first.';
      els.name.focus();
      return;
    }
    if (!text || els.send.disabled) return;

    els.send.disabled = true;
    els.error.textContent = '';
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // ignore
    }
    try {
      const res = await fetch(`${RELAY}/${topic}`, { method: 'POST', body: await encrypt({ n: name, t: text }) });
      if (res.status === 429) throw new Error('Posting too fast. Wait a moment and try again.');
      if (!res.ok) throw new Error(`Could not post (relay returned ${res.status}).`);
      const msg = await res.json();
      await onMessage({ ...msg, mine: true });
      els.text.value = '';
      autosize();
      els.text.focus();
    } catch (error) {
      els.error.textContent = error.message || 'Could not post. Check your connection.';
    } finally {
      els.send.disabled = false;
    }
  });
}
