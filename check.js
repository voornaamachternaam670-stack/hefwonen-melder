// Hef Wonen melder: haalt het huuraanbod op, vergelijkt met state.json en
// stuurt Telegram-meldingen bij nieuwe advertenties, prijswijzigingen en
// woningen die weer beschikbaar komen. Plus een dagelijkse "ik leef nog".
//
// Gebruik:  node check.js           (echt draaien, stuurt berichten)
//           node check.js --dry     (toont berichten alleen in de console)
// Nodig:    Node 18+, env TELEGRAM_TOKEN en TELEGRAM_CHAT_ID

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = 'https://huuraanbod.hefwonen.nl';
const PAGE = BASE + '/huuraanbod';
const STATE_FILE = path.join(__dirname, 'state.json');
const DRY = process.argv.includes('--dry');
const HEARTBEAT_HOUR = 8; // Nederlandse tijd
const FAIL_ALERT_AFTER = 3; // na zoveel mislukte runs op rij een waarschuwing

const CATEGORIES = { rent: 'Woning', bog: 'Bedrijfsruimte', park: 'Parkeren' };

// ---------- ophalen en uitlezen ----------

async function fetchListings() {
  const res = await fetch(PAGE, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HefWonenMelder/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bij ophalen aanbod`);
  const html = await res.text();

  // De site stuurt het aanbod mee als Nuxt-state: window.__NUXT__=(function(a,b,...){...}(...))
  const m = html.match(/<script>window\.__NUXT__=([\s\S]*?);?<\/script>/);
  if (!m) throw new Error('Nuxt-state niet gevonden; is de site veranderd?');

  // Evalueren in een lege sandbox zonder require/process/netwerk, met tijdslimiet.
  const ctx = vm.createContext(Object.create(null));
  const nuxt = vm.runInContext('(' + m[1] + ')', ctx, { timeout: 2000 });
  const state = JSON.parse(JSON.stringify(nuxt && nuxt.state ? nuxt.state : {}));

  const listings = [];
  for (const [cat, label] of Object.entries(CATEGORIES)) {
    for (const x of state[cat] || []) {
      if (!x || !x.id) continue;
      const a = x.address || {};
      const ch = x.characteristic || {};
      const lay = ch.layout || {};
      const h = x.handover || {};
      listings.push({
        key: `${cat}:${x.id}`,
        category: label,
        title: x.title || [a.street, a.house_number, a.house_number_extension].filter(Boolean).join(' '),
        place: [a.postal_code, a.location].filter(Boolean).join(' '),
        price: typeof h.price === 'number' ? h.price : null,
        priceText: h.price_formatted || null,
        serviceText: h.service_costs ? h.service_costs_formatted : null,
        statusCode: (x.status && x.status.code) || null,
        statusLabel: (x.status && x.status.label) || null,
        area: ch.living_area_formatted || null,
        rooms: lay.number_of_rooms || null,
        bedrooms: lay.number_of_bedrooms || null,
        type: ch.subtype || ch.type || null,
        energy: ch.energy_label || null,
        available: x.available_at_label || null,
        photo: (x.media && x.media.primary_photo) || null,
        // Sommige slugs bevatten spaties en hebben geen detailpagina; dan naar het overzicht.
        url: x.slug && !/\s/.test(x.slug) ? `${BASE}/huuraanbod/${x.slug}` : PAGE,
      });
    }
  }
  if (listings.length === 0) throw new Error('Geen advertenties gevonden in de pagina; waarschijnlijk is de structuur veranderd');
  return listings;
}

// ---------- Telegram ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tg(method, body) {
  const token = process.env.TELEGRAM_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
  return json;
}

async function send(text, photo) {
  if (DRY) {
    console.log('--- [dry] ' + (photo ? '(met foto) ' : '') + '\n' + text.replace(/<[^>]+>/g, '') + '\n');
    return;
  }
  const chat_id = process.env.TELEGRAM_CHAT_ID;
  if (photo) {
    try {
      // Foto zelf downloaden en uploaden: Telegram accepteert .webp-URL's niet altijd als foto.
      const img = await fetch(photo);
      if (!img.ok) throw new Error('foto HTTP ' + img.status);
      const fd = new FormData();
      fd.append('chat_id', chat_id);
      fd.append('caption', text);
      fd.append('parse_mode', 'HTML');
      fd.append('photo', new Blob([await img.arrayBuffer()], { type: img.headers.get('content-type') || 'image/webp' }), 'foto.webp');
      await tg('sendPhoto', fd);
      return;
    } catch (e) {
      console.warn('Foto versturen mislukt, stuur tekst:', e.message);
    }
  }
  await tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: false });
}

function describe(l, headline) {
  const lines = [`<b>${esc(headline)}</b>`, `<b>${esc(l.title)}</b>`];
  if (l.place) lines.push(esc(l.place));
  const facts = [];
  if (l.priceText) facts.push(`${esc(l.priceText)} p.m.` + (l.serviceText ? ` (+ ${esc(l.serviceText)} service)` : ''));
  if (l.area) facts.push(esc(l.area));
  if (l.rooms) facts.push(`${l.rooms} kamers` + (l.bedrooms ? ` (${l.bedrooms} slaapk.)` : ''));
  if (facts.length) lines.push(facts.join(' · '));
  const extra = [l.category !== 'Woning' ? l.category : null, l.type, l.energy ? `label ${l.energy}` : null].filter(Boolean);
  if (extra.length) lines.push(esc(extra.join(' · ')));
  if (l.statusLabel) lines.push(`Status: ${esc(l.statusLabel)}` + (l.available ? ` · ${esc(l.available)}` : ''));
  lines.push(`<a href="${esc(l.url)}">Bekijk advertentie</a>`);
  return lines.join('\n');
}

// ---------- state ----------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
}

function nlNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// ---------- hoofdlogica ----------

async function main() {
  if (!DRY && (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_TOKEN en TELEGRAM_CHAT_ID moeten gezet zijn (of gebruik --dry)');
  }
  const now = new Date().toISOString();
  const nl = nlNow();
  const prev = loadState();
  const state = prev || { listings: {}, lastHeartbeat: null, failures: 0 };

  let listings;
  try {
    listings = await fetchListings();
  } catch (e) {
    state.failures = (state.failures || 0) + 1;
    console.error('Ophalen mislukt:', e.message);
    if (state.failures === FAIL_ALERT_AFTER) {
      await send(`<b>Hef Wonen melder: let op</b>\nHet aanbod kon ${FAIL_ALERT_AFTER} keer op rij niet worden gelezen.\nFout: ${esc(e.message)}`).catch(() => {});
    }
    if (prev) saveState(state);
    process.exitCode = 1;
    return;
  }
  if (state.failures >= FAIL_ALERT_AFTER) {
    await send('<b>Hef Wonen melder</b>\nHet aanbod wordt weer normaal gelezen.');
  }
  state.failures = 0;

  const firstRun = !prev;
  const seenNow = new Set();
  let sent = 0;

  for (const l of listings) {
    seenNow.add(l.key);
    const old = state.listings[l.key];
    let headline = null;

    if (!old) {
      headline = '🏠 Nieuwe advertentie';
    } else if (old.gone) {
      headline = '🔁 Weer online';
    } else if (old.price != null && l.price != null && old.price !== l.price) {
      const diff = l.price - old.price;
      headline = `💶 Prijswijziging: € ${old.price.toLocaleString('nl-NL')} → € ${l.price.toLocaleString('nl-NL')} (${diff > 0 ? '+' : '−'}€ ${Math.abs(diff).toLocaleString('nl-NL')})`;
    } else if (old.statusCode && old.statusCode !== 'available' && l.statusCode === 'available') {
      headline = `✅ Weer beschikbaar (was: ${old.statusLabel || old.statusCode})`;
    }

    if (headline && !firstRun) {
      await send(describe(l, headline), l.photo);
      sent++;
    }

    state.listings[l.key] = {
      title: l.title,
      price: l.price,
      statusCode: l.statusCode,
      statusLabel: l.statusLabel,
      firstSeen: old ? old.firstSeen : now,
      gone: false,
    };
  }

  // Wat niet meer op de site staat markeren als verdwenen (zonder melding).
  for (const [key, v] of Object.entries(state.listings)) {
    if (!seenNow.has(key) && !v.gone) { v.gone = true; v.goneSince = now; }
  }

  if (firstRun) {
    const counts = Object.values(CATEGORIES).map((c) => `${listings.filter((l) => l.category === c).length} ${c.toLowerCase()}`).join(', ');
    await send(`<b>Hef Wonen melder is actief</b>\nHuidig aanbod vastgelegd (${counts}). Vanaf nu krijg je een bericht bij nieuwe advertenties, prijswijzigingen en woningen die weer beschikbaar komen.`);
    state.lastHeartbeat = nl.date;
  } else if (nl.hour >= HEARTBEAT_HOUR && state.lastHeartbeat !== nl.date) {
    const woningen = listings.filter((l) => l.category === 'Woning');
    const vrij = woningen.filter((l) => l.statusCode === 'available').length;
    await send(`<b>Hef Wonen melder leeft nog</b> 👋\nNu online: ${woningen.length} woningen (${vrij} beschikbaar, ${woningen.length - vrij} onder optie), ${listings.length - woningen.length} overig.\n<a href="${PAGE}">Bekijk het aanbod</a>`);
    state.lastHeartbeat = nl.date;
  }

  saveState(state);
  console.log(`${listings.length} advertenties gelezen, ${sent} melding(en) verstuurd${firstRun ? ' (eerste run, alleen vastgelegd)' : ''}.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
