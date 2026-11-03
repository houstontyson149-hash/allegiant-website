const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const env = process.env;
const BRAND = env.BRAND_NAME || 'Allegiant';
const PUBLIC_HOST = (env.PUBLIC_HOST || 'localhost').toLowerCase();
const ADMIN_HOST = (env.ADMIN_HOST || 'admin.localhost').toLowerCase();
const PROTO = env.PROTOCOL || 'http';
const PORT = env.PORT || 3000;
const COPY = `© ${new Date().getFullYear()} ${BRAND}. All rights reserved.`;

// ---------- database ----------
// On Railway, set DATA_DIR to your Volume mount path (e.g. /data) so the database survives redeploys
const DATA_DIR = env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, avatar TEXT);
CREATE TABLE IF NOT EXISTS admins(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS aircraft(id INTEGER PRIMARY KEY, name TEXT, type TEXT, first_row INT, last_row INT, layout TEXT);
CREATE TABLE IF NOT EXISTS flights(id INTEGER PRIMARY KEY, number TEXT, origin_code TEXT, origin_city TEXT,
  dest_code TEXT, dest_city TEXT, depart_at TEXT, boarding_at TEXT, gate TEXT, aircraft_id INT);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, conf TEXT UNIQUE, user_id TEXT, flight_id INT, seat TEXT, seq INT,
  created TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(flight_id, seat), UNIQUE(flight_id, user_id));
CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, kind TEXT, title TEXT, ref TEXT);
`);
(env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  .forEach(id => db.prepare('INSERT OR IGNORE INTO admins(id) VALUES(?)').run(id));
if (!db.prepare('SELECT COUNT(*) c FROM aircraft').get().c) {
  const ins = db.prepare('INSERT INTO aircraft(name,type,first_row,last_row,layout) VALUES(?,?,?,?,?)');
  ins.run('Airbus A319', 'A319', 1, 24, 'ABC DEF');
  ins.run('Airbus A320', 'A320', 1, 30, 'ABC DEF');
  ins.run('Boeing 737-800', '738', 1, 33, 'ABC DEF');
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const dateShort = dt => { const [, m, d] = dt.split('T')[0].split('-'); return `${+d} ${MON[+m - 1]}`; };
const time12 = dt => { let [h, m] = dt.split('T')[1].split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`; };
const letters = a => a.layout.replace(/\s/g, '');
const zoneFor = (a, row) => { const t = (row - a.first_row) / (a.last_row - a.first_row + 1); return t >= 2 / 3 ? 1 : t >= 1 / 3 ? 2 : 3; };
function newConf() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = ''; for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
    if (!db.prepare('SELECT 1 FROM bookings WHERE conf=?').get(c)) return c;
  }
}
function embedUrl(kind, ref) {
  if (kind === 'youtube') {
    const id = (ref.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || [])[1];
    return id && `https://www.youtube-nocookie.com/embed/${id}`;
  }
  const id = (ref.match(/tubitv\.com\/(?:movies|tv-shows|series|video|embed)\/(\d+)/) || [])[1];
  return id && `https://tubitv.com/embed/${id}`;
}

// ---------- app + host routing ----------
const app = express();
const pub = express.Router();
const adm = express.Router();
app.use(express.urlencoded({ extended: false }));
app.set('trust proxy', 1);
app.get('/static/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/static/:f(logo|logo-white).png', (req, res) => res.sendFile(path.join(__dirname, req.params.f + '.png')));
app.use(session({ secret: env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROTO === 'https', maxAge: 1000 * 60 * 60 * 24 * 14 } }));
app.use((req, res, next) => {
  req.isAdminHost = req.hostname.toLowerCase() === ADMIN_HOST;
  (req.isAdminHost ? adm : pub)(req, res, next);
});

function layout(req, title, body) {
  const u = req.session.user, a = req.isAdminHost;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | ${esc(BRAND)}${a ? ' Admin' : ''}</title><link rel="stylesheet" href="/static/style.css"></head><body>
<header><a class="brand" href="/"><img src="/static/logo-white.png" alt="${esc(BRAND)}" style="height:38px;vertical-align:middle">${a ? ' <small>admin</small>' : ''}</a>
<nav>${a ? '' : '<a href="/">Flights</a><a href="/trips">My trips</a><a href="/inflight">Inflight entertainment</a>'}</nav>
<span class="who">${u ? `${esc(u.name)} · <a href="/logout">Log out</a>` : '<a href="/login">Link Discord</a>'}</span></header>
<main>${req.session.flash ? `<div class="flash">${esc((() => { const f = req.session.flash; req.session.flash = null; return f; })())}</div>` : ''}${body}</main>
<footer>${esc(COPY)}</footer></body></html>`;
}
const flash = (req, m) => { req.session.flash = m; };
const needLogin = (req, res, next) => { if (req.session.user) return next(); req.session.returnTo = req.originalUrl; res.redirect('/login'); };
const needAdmin = (req, res, next) => {
  if (!req.session.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  if (!db.prepare('SELECT 1 FROM admins WHERE id=?').get(req.session.user.id)) return res.status(403).send(layout(req, 'Forbidden', '<div class="card">Your Discord account is not an admin.</div>'));
  next();
};

// ---------- Discord auth (both hosts; each host has its own session) ----------
for (const r of [pub, adm]) {
  r.get('/login', (req, res) => {
    if (!/^\d{15,25}$/.test(env.DISCORD_CLIENT_ID || '')) return res.status(500).send('DISCORD_CLIENT_ID is missing or not a number. Set it in Railway Variables to your Discord Application ID.');
    const state = crypto.randomBytes(16).toString('hex'); req.session.state = state;
    const redirect = `${PROTO}://${req.get('host')}/auth/callback`;
    res.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify', redirect_uri: redirect, state }));
  });
  r.get('/auth/callback', async (req, res) => {
    try {
      if (!req.query.code || req.query.state !== req.session.state) return res.status(400).send('Bad OAuth state');
      const redirect = `${PROTO}://${req.get('host')}/auth/callback`;
      const t = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirect }) })).json();
      const me = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
      if (!me.id) return res.status(400).send('Discord login failed');
      const name = me.global_name || me.username;
      db.prepare('INSERT INTO users(id,name,avatar) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar').run(me.id, name, me.avatar);
      req.session.user = { id: me.id, name };
      const to = req.session.returnTo || '/'; req.session.returnTo = null;
      res.redirect(to);
    } catch (e) { console.error(e); res.status(500).send('Login error'); }
  });
  r.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
}

// ---------- PUBLIC SITE ----------
const flightRow = f => `<div class="card row"><div><div class="big">${esc(f.origin_code)} → ${esc(f.dest_code)}</div>
<div class="muted">${esc(f.origin_city)} to ${esc(f.dest_city)} · Flight ${esc(f.number)} · ${esc(dateShort(f.depart_at))} · ${esc(f.aircraft_name || '')}</div></div>
<div>${f.seats_left} seats left<br><a class="btn" href="/flight/${f.id}">Choose seat</a></div></div>`;
const flightsQ = `SELECT f.*, a.name aircraft_name, (a.last_row-a.first_row+1)*LENGTH(REPLACE(a.layout,' ','')) - (SELECT COUNT(*) FROM bookings b WHERE b.flight_id=f.id) AS seats_left
 FROM flights f LEFT JOIN aircraft a ON a.id=f.aircraft_id`;

pub.get('/', (req, res) => {
  const fl = db.prepare(flightsQ + ' ORDER BY f.depart_at').all();
  res.send(layout(req, 'Flights', `<div class="hero"><h1>Fly ${esc(BRAND)}</h1><p>Pick a scheduled flight, choose your seat, and get your boarding pass.</p></div>
${fl.map(flightRow).join('') || '<div class="card">No flights scheduled yet.</div>'}`));
});

pub.get('/flight/:id', (req, res) => {
  const f = db.prepare(flightsQ + ' WHERE f.id=?').get(req.params.id);
  if (!f) return res.status(404).send(layout(req, 'Not found', '<div class="card">Flight not found.</div>'));
  const a = db.prepare('SELECT * FROM aircraft WHERE id=?').get(f.aircraft_id);
  if (!a) return res.send(layout(req, 'Flight', '<div class="card">This flight has no aircraft assigned.</div>'));
  const taken = new Set(db.prepare('SELECT seat FROM bookings WHERE flight_id=?').all(f.id).map(r => r.seat));
  const mine = req.session.user && db.prepare('SELECT * FROM bookings WHERE flight_id=? AND user_id=?').get(f.id, req.session.user.id);
  let rows = '';
  for (let r = a.first_row; r <= a.last_row; r++) {
    rows += `<div class="srow"><span class="rn">${r}</span>` + [...a.layout].map(ch => ch === ' ' ? '<span class="aisle"></span>'
      : `<label class="seat"><input type="radio" name="seat" value="${r}${ch}" ${taken.has(r + ch) ? 'disabled' : ''} required><span>${r}${ch}</span></label>`).join('') + '</div>';
  }
  res.send(layout(req, `Flight ${f.number}`, `${flightRow(f)}
${mine ? `<div class="card">You are booked in seat <b>${esc(mine.seat)}</b>. <a class="btn" href="/pass/${mine.conf}">View boarding pass</a></div>` :
 req.session.user ? `<form method="post" action="/flight/${f.id}/book"><div class="card">Booking as <b>${esc(req.session.user.name)}</b>. Pick a seat:</div>
<div style="text-align:center"><div class="cabin">${rows}</div></div><p style="text-align:center"><button>Confirm seat</button></p></form>`
 : '<div class="card">Link your Discord account to book a seat. <a class="btn" href="/login">Link Discord</a></div>'}`));
});

pub.post('/flight/:id/book', needLogin, (req, res) => {
  const f = db.prepare('SELECT * FROM flights WHERE id=?').get(req.params.id);
  const a = f && db.prepare('SELECT * FROM aircraft WHERE id=?').get(f.aircraft_id);
  const m = /^(\d+)([A-Z])$/.exec(req.body.seat || '');
  if (!a || !m || +m[1] < a.first_row || +m[1] > a.last_row || !letters(a).includes(m[2])) { flash(req, 'Invalid seat.'); return res.redirect(`/flight/${req.params.id}`); }
  try {
    const seq = db.prepare('SELECT COUNT(*)+1 n FROM bookings WHERE flight_id=?').get(f.id).n;
    const conf = newConf();
    db.prepare('INSERT INTO bookings(conf,user_id,flight_id,seat,seq) VALUES(?,?,?,?,?)').run(conf, req.session.user.id, f.id, req.body.seat, seq);
    res.redirect(`/pass/${conf}`);
  } catch { flash(req, 'That seat is taken (or you already booked this flight).'); res.redirect(`/flight/${f.id}`); }
});

pub.get('/trips', needLogin, (req, res) => {
  const t = db.prepare(`SELECT b.*, f.number, f.origin_code, f.dest_code, f.depart_at FROM bookings b JOIN flights f ON f.id=b.flight_id WHERE b.user_id=? ORDER BY f.depart_at`).all(req.session.user.id);
  res.send(layout(req, 'My trips', `<h2>My trips</h2>${t.map(b => `<div class="card row"><div><div class="big">${esc(b.origin_code)} → ${esc(b.dest_code)}</div>
<div class="muted">Flight ${esc(b.number)} · ${esc(dateShort(b.depart_at))} · Seat ${esc(b.seat)} · Conf ${esc(b.conf)}</div></div><a class="btn" href="/pass/${b.conf}">Boarding pass</a></div>`).join('') || '<div class="card">No trips yet.</div>'}`));
});

const PLANE = '<svg viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';
pub.get('/pass/:conf', needLogin, async (req, res) => {
  const b = db.prepare(`SELECT b.*, f.*, b.id bid, u.name passenger FROM bookings b JOIN flights f ON f.id=b.flight_id JOIN users u ON u.id=b.user_id WHERE b.conf=?`).get(req.params.conf);
  if (!b || b.user_id !== req.session.user.id) return res.status(404).send(layout(req, 'Not found', '<div class="card">Boarding pass not found.</div>'));
  const a = db.prepare('SELECT * FROM aircraft WHERE id=?').get(b.aircraft_id);
  const zone = a ? zoneFor(a, parseInt(b.seat)) : '-';
  const qr = await QRCode.toDataURL(`${b.conf}|${b.number}|${b.origin_code}${b.dest_code}|${b.seat}|${b.seq}`, { margin: 1, width: 400 });
  res.send(layout(req, 'Boarding pass', `<div class="pass">
<div class="top"><div class="logo"><img src="/static/logo-white.png" alt="${esc(BRAND)}" style="height:44px"></div><div class="gate">${esc(dateShort(b.depart_at))} ${esc(b.origin_code)} - ${esc(b.dest_code)}<b>GATE ${esc(b.gate)}</b></div></div>
<div class="cities"><span>${esc(b.origin_city.toUpperCase())}</span><span>${esc(b.dest_city.toUpperCase())}</span></div>
<div class="codes"><span>${esc(b.origin_code)}</span>${PLANE}<span>${esc(b.dest_code)}</span></div>
<div class="meta"><div><small>FLIGHT</small><span>${esc(b.number)}</span></div><div><small>BOARDING</small><span>${esc(time12(b.boarding_at))}</span></div><div><small>ZONE</small><span>${zone}</span></div><div><small>SEAT</small><span>${esc(b.seat)}</span></div></div>
<div class="meta"><div><small>PASSENGER</small><span>${esc(b.passenger.toUpperCase())}</span></div></div>
<div class="qr"><img alt="QR" src="${qr}"><p>CONF #: ${esc(b.conf)} &nbsp; SEQ #: ${b.seq}</p></div>
<div class="rights">${esc(COPY)}</div></div>
<p class="noprint" style="text-align:center"><button onclick="print()">Print</button> <a class="btn alt" href="/inflight">Inflight entertainment</a></p>`));
});

// inflight entertainment (requires at least one booking)
pub.get('/inflight', needLogin, (req, res) => {
  const has = db.prepare('SELECT 1 FROM bookings WHERE user_id=?').get(req.session.user.id);
  if (!has) return res.send(layout(req, 'Inflight', '<div class="card">Book a flight to unlock inflight entertainment.</div>'));
  const m = db.prepare('SELECT * FROM media ORDER BY kind,title').all();
  res.send(layout(req, 'Inflight entertainment', `<h2>Inflight entertainment</h2><div class="media">${m.map(x => `<a class="card" href="/inflight/${x.id}" style="text-decoration:none"><b>${esc(x.title)}</b><br><span class="muted">${x.kind === 'tubi' ? 'Tubi' : 'YouTube'}</span></a>`).join('') || '<div class="card">Nothing added yet.</div>'}</div>`));
});
pub.get('/inflight/:id', needLogin, (req, res) => {
  const has = db.prepare('SELECT 1 FROM bookings WHERE user_id=?').get(req.session.user.id);
  const x = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!has || !x) return res.redirect('/inflight');
  res.send(layout(req, x.title, `<h2>${esc(x.title)}</h2><iframe class="player" src="${esc(embedUrl(x.kind, x.ref))}" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe>
<p><a class="btn alt" href="/inflight">← Back</a> <a href="${esc(x.ref)}" target="_blank" rel="noopener">Open in ${x.kind === 'tubi' ? 'Tubi' : 'YouTube'}</a></p>`));
});

// ---------- ADMIN SITE ----------
adm.use(needAdmin);
const field = (label, name, extra = '') => `<div><label>${label}</label><input name="${name}" ${extra} required></div>`;
adm.get('/', (req, res) => {
  const ac = db.prepare('SELECT * FROM aircraft').all();
  const fl = db.prepare(flightsQ + ' ORDER BY f.depart_at').all();
  const md = db.prepare('SELECT * FROM media').all();
  const ad = db.prepare('SELECT a.id, u.name FROM admins a LEFT JOIN users u ON u.id=a.id').all();
  const del = (url) => `<form method="post" action="${url}" style="display:inline"><button class="danger">Delete</button></form>`;
  res.send(layout(req, 'Admin', `<h2>Aircraft types</h2><div class="card"><table><tr><th>Name</th><th>Type</th><th>Rows</th><th>Layout</th><th></th></tr>
${ac.map(a => `<tr><td>${esc(a.name)}</td><td>${esc(a.type)}</td><td>${a.first_row}-${a.last_row}</td><td>${esc(a.layout)}</td><td>${del('/aircraft/' + a.id + '/delete')}</td></tr>`).join('')}</table></div>
<form method="post" action="/aircraft" class="card"><b>Add aircraft</b><div class="grid">${field('Name', 'name', 'placeholder="Airbus A320"')}${field('Type code', 'type', 'placeholder="A320"')}
${field('First row', 'first_row', 'type=number min=1 value=1')}${field('Last row', 'last_row', 'type=number min=1 value=30')}${field('Layout (space = aisle)', 'layout', 'value="ABC DEF" pattern="[A-Z ]+"')}</div><p><button>Add aircraft</button></p></form>
<h2>Flights / routes</h2><div class="card"><table><tr><th>Flight</th><th>Route</th><th>Departs</th><th>Boarding</th><th>Gate</th><th>Aircraft</th><th></th></tr>
${fl.map(f => `<tr><td>${esc(f.number)}</td><td>${esc(f.origin_code)} → ${esc(f.dest_code)}</td><td>${esc(f.depart_at.replace('T', ' '))}</td><td>${esc(f.boarding_at.replace('T', ' '))}</td><td>${esc(f.gate)}</td><td>${esc(f.aircraft_name || '')}</td><td>${del('/flights/' + f.id + '/delete')}</td></tr>`).join('')}</table></div>
<form method="post" action="/flights" class="card"><b>Add flight</b><div class="grid">${field('Flight #', 'number', 'placeholder=608')}${field('Origin code', 'origin_code', 'maxlength=4 placeholder=PGD')}${field('Origin city', 'origin_city', 'placeholder="Punta Gorda, FL"')}
${field('Destination code', 'dest_code', 'maxlength=4 placeholder=IND')}${field('Destination city', 'dest_city', 'placeholder="Indianapolis, IN"')}${field('Departure', 'depart_at', 'type=datetime-local')}${field('Boarding', 'boarding_at', 'type=datetime-local')}${field('Gate', 'gate', 'placeholder=3A')}
<div><label>Aircraft</label><select name="aircraft_id">${ac.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div></div><p><button>Add flight</button></p></form>
<h2>Inflight entertainment</h2><div class="card"><table>${md.map(m => `<tr><td>${esc(m.kind)}</td><td>${esc(m.title)}</td><td>${del('/media/' + m.id + '/delete')}</td></tr>`).join('')}</table></div>
<form method="post" action="/media" class="card"><b>Add video</b><div class="grid"><div><label>Source</label><select name="kind"><option value="youtube">YouTube</option><option value="tubi">Tubi</option></select></div>
${field('Title', 'title')}${field('URL', 'ref', 'type=url placeholder="https://www.youtube.com/watch?v=… or https://tubitv.com/movies/12345/…"')}</div><p><button>Add</button></p></form>
<h2>Admins</h2><div class="card">${ad.map(a => `<div>${esc(a.name || 'Not logged in yet')} <span class="muted">(${esc(a.id)})</span></div>`).join('')}</div>
<form method="post" action="/admins" class="card"><div class="grid">${field('Discord user ID', 'id', 'pattern="\\d{15,25}"')}</div><p><button>Add admin</button></p></form>`));
});
const back = (req, res, m) => { if (m) flash(req, m); res.redirect('/'); };
adm.post('/aircraft', (req, res) => {
  const { name, type, first_row, last_row, layout: l } = req.body;
  if (+first_row > +last_row || !/^[A-Z ]+$/.test(l || '')) return back(req, res, 'Invalid aircraft.');
  db.prepare('INSERT INTO aircraft(name,type,first_row,last_row,layout) VALUES(?,?,?,?,?)').run(name, type, +first_row, +last_row, l.trim()); back(req, res, 'Aircraft added.');
});
adm.post('/aircraft/:id/delete', (req, res) => {
  if (db.prepare('SELECT 1 FROM flights WHERE aircraft_id=?').get(req.params.id)) return back(req, res, 'Aircraft is used by a flight.');
  db.prepare('DELETE FROM aircraft WHERE id=?').run(req.params.id); back(req, res, 'Deleted.');
});
adm.post('/flights', (req, res) => {
  const b = req.body, up = s => String(s).toUpperCase().trim();
  db.prepare('INSERT INTO flights(number,origin_code,origin_city,dest_code,dest_city,depart_at,boarding_at,gate,aircraft_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(b.number, up(b.origin_code), b.origin_city, up(b.dest_code), b.dest_city, b.depart_at, b.boarding_at, up(b.gate), +b.aircraft_id); back(req, res, 'Flight added.');
});
adm.post('/flights/:id/delete', (req, res) => {
  db.prepare('DELETE FROM bookings WHERE flight_id=?').run(req.params.id); db.prepare('DELETE FROM flights WHERE id=?').run(req.params.id); back(req, res, 'Flight deleted.');
});
adm.post('/media', (req, res) => {
  const { kind, title, ref } = req.body;
  if (!['youtube', 'tubi'].includes(kind) || !embedUrl(kind, ref || '')) return back(req, res, 'Could not read that URL for the chosen source.');
  db.prepare('INSERT INTO media(kind,title,ref) VALUES(?,?,?)').run(kind, title, ref); back(req, res, 'Added.');
});
adm.post('/media/:id/delete', (req, res) => { db.prepare('DELETE FROM media WHERE id=?').run(req.params.id); back(req, res); });
adm.post('/admins', (req, res) => { if (/^\d{15,25}$/.test(req.body.id || '')) db.prepare('INSERT OR IGNORE INTO admins(id) VALUES(?)').run(req.body.id); back(req, res, 'Admin added.'); });

app.use((err, req, res, next) => { console.error(err); res.status(500).send('Server error: ' + err.message); });

app.listen(PORT, () => console.log(`Public: ${PROTO}://${PUBLIC_HOST}:${PORT}  Admin: ${PROTO}://${ADMIN_HOST}:${PORT}`));
