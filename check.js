// Huurmelder: haalt het huuraanbod van Hef Wonen en ikwilhuren.nu op,
// vergelijkt met state.json en stuurt Telegram-meldingen bij nieuwe
// advertenties, prijswijzigingen en woningen die weer beschikbaar komen.
// Plus een dagelijkse "ik leef nog".
//
// Gebruik:  node check.js           (echt draaien, stuurt berichten)
//           node check.js --dry     (toont berichten alleen in de console)
//           node check.js --dry --full   (ikwilhuren: forceer volledige scan)
// Nodig:    Node 18+, env TELEGRAM_TOKEN en TELEGRAM_CHAT_ID

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATE_FILE = path.join(__dirname, 'state.json');
const DRY = process.argv.includes('--dry');
const FORCE_FULL = process.argv.includes('--full');
const HEARTBEAT_HOUR = 8; // Nederlandse tijd
const FULL_SCAN_HOUR = 7; // ikwilhuren: dagelijkse volledige scan vanaf dit uur
const FAIL_ALERT_AFTER = 3; // na zoveel mislukte runs op rij een waarschuwing
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Huurmelder/1.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} bij ${url}`);
  return res.text();
}

// ---------- bron 1: Hef Wonen ----------

const HEF_BASE = 'https://huuraanbod.hefwonen.nl';
const HEF_PAGE = HEF_BASE + '/huuraanbod';
const HEF_CATEGORIES = { rent: 'Woning', bog: 'Bedrijfsruimte', park: 'Parkeren' };

const hefwonen = {
  id: 'hefwonen',
  name: 'Hef Wonen',
  page: HEF_PAGE,
  owns: (key) => /^(rent|bog|park):/.test(key),

  async fetch() {
    const html = await getText(HEF_PAGE);

    // De site stuurt het aanbod mee als Nuxt-state: window.__NUXT__=(function(a,b,...){...}(...))
    const m = html.match(/<script>window\.__NUXT__=([\s\S]*?);?<\/script>/);
    if (!m) throw new Error('Nuxt-state niet gevonden; is de site veranderd?');

    // Evalueren in een lege sandbox zonder require/process/netwerk, met tijdslimiet.
    const ctx = vm.createContext(Object.create(null));
    const nuxt = vm.runInContext('(' + m[1] + ')', ctx, { timeout: 2000 });
    const state = JSON.parse(JSON.stringify(nuxt && nuxt.state ? nuxt.state : {}));

    const listings = [];
    for (const [cat, label] of Object.entries(HEF_CATEGORIES)) {
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
          url: x.slug && !/\s/.test(x.slug) ? `${HEF_BASE}/huuraanbod/${x.slug}` : HEF_PAGE,
        });
      }
    }
    if (listings.length === 0) throw new Error('Geen advertenties gevonden in de pagina; waarschijnlijk is de structuur veranderd');
    return { listings, complete: true };
  },
};

// ---------- bron 2: ikwilhuren.nu (MVGM) ----------

const IKW_BASE = 'https://ikwilhuren.nu';
const IKW_LIST = IKW_BASE + '/aanbod/?sort=aanbodASC'; // aanbodASC = nieuwste eerst
const IKW_QUICK_PAGES = 3; // elke run: zoveel nieuwste pagina's (10 per pagina)
const IKW_CENTER = { name: 'Rotterdam', lat: 51.92248806, lng: 4.48653571 };
const IKW_RADIUS_KM = 10;
// Grove voorselectie op postcodecijfers, zodat niet elke postcode van NL opgezocht hoeft te worden.
const IKW_PC4_RANGE = [2600, 3399];

const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&euro;/g, '€').replace(/&amp;/g, '&')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

function parseIkwPage(html) {
  const out = [];
  const chunks = html.split('<div class="card card-woning').slice(1);
  for (const c of chunks) {
    const link = c.match(/href="(\/object\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const slug = link[1].replace(/\/$/, '');
    const hash = (slug.match(/-([0-9a-f]{32})$/) || [])[1] || slug;
    const pc = c.match(/<span>(\d{4}) ?([A-Z]{2}) ([^<]+)<\/span>/);
    const status = c.match(/status-dot bg-status-([a-z-]+)[^>]*><\/span>([^<]*)/);
    const price = c.match(/€\s*([\d.]+),-\s*\/mnd/);
    const area = c.match(/(\d+)\s*m<sup>2<\/sup>/);
    const bedrooms = c.match(/(\d+)\s*slaapkamer/);
    const avail = c.match(/fa-calendar[^>]*><\/i><\/span>([^<]+)/);
    // De CDN-host (x.static.nbo.nl) weigert directe verzoeken; hetzelfde pad werkt via ikwilhuren.nu.
    const img = c.match(/src=['"](?:https?:)?(?:\/\/[^/'"]+)?(\/media\/[^'"]+)['"]/);
    out.push({
      key: `ikw:${hash}`,
      category: 'Woning',
      title: decode(link[2]),
      pc4: pc ? Number(pc[1]) : null,
      postcode: pc ? pc[1] + pc[2] : null,
      place: pc ? `${pc[1]} ${pc[2]} ${decode(pc[3])}` : '',
      price: price ? Number(price[1].replace(/\./g, '')) : null,
      priceText: price ? `€ ${price[1]}` : null,
      serviceText: null,
      statusCode: status ? (status[1] === 'te-huur' ? 'available' : status[1]) : null,
      statusLabel: status ? decode(status[2]) : null,
      area: area ? `${area[1]} m²` : null,
      rooms: null,
      bedrooms: bedrooms ? Number(bedrooms[1]) : null,
      type: null,
      energy: null,
      available: avail ? decode(avail[1]) : null,
      photo: img ? IKW_BASE + img[1] : null,
      url: IKW_BASE + slug + '/',
    });
  }
  return out;
}

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Postcode -> afstand tot het middelpunt, via PDOK (gratis geodienst van de overheid). Cache in state.
async function postcodeDistance(postcode, cache) {
  if (postcode in cache) return cache[postcode];
  const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${postcode}&fq=type:postcode&rows=1&fl=centroide_ll`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`PDOK HTTP ${res.status}`);
  const doc = ((await res.json()).response || {}).docs?.[0];
  const m = doc && doc.centroide_ll && doc.centroide_ll.match(/POINT\(([\d.]+) ([\d.]+)\)/);
  const km = m ? Math.round(distanceKm(IKW_CENTER, { lng: Number(m[1]), lat: Number(m[2]) }) * 10) / 10 : null;
  cache[postcode] = km;
  return km;
}

const ikwilhuren = {
  id: 'ikwilhuren',
  name: 'ikwilhuren.nu',
  page: IKW_BASE + '/aanbod/',
  owns: (key) => key.startsWith('ikw:'),

  async fetch(state, nl) {
    state.sources.ikwilhuren = state.sources.ikwilhuren || {};
    const src = state.sources.ikwilhuren;
    const full = FORCE_FULL || !src.lastFullScan || (nl.hour >= FULL_SCAN_HOUR && src.lastFullScan !== nl.date);

    const first = await getText(IKW_LIST + '&page=1');
    const lastPage = Math.max(1, ...[...first.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1])));
    const pages = full ? lastPage : Math.min(IKW_QUICK_PAGES, lastPage);

    const all = parseIkwPage(first);
    for (let p = 2; p <= pages; p++) {
      await sleep(full ? 400 : 150);
      all.push(...parseIkwPage(await getText(`${IKW_LIST}&page=${p}`)));
    }
    if (all.length === 0) throw new Error('Geen advertenties gevonden op ikwilhuren.nu; waarschijnlijk is de structuur veranderd');

    // Alleen woningen binnen de straal houden.
    state.geoCache = state.geoCache || {};
    const listings = [];
    const seen = new Set();
    for (const l of all) {
      if (seen.has(l.key)) continue;
      seen.add(l.key);
      if (!l.postcode || l.pc4 < IKW_PC4_RANGE[0] || l.pc4 > IKW_PC4_RANGE[1]) continue;
      const km = await postcodeDistance(l.postcode, state.geoCache);
      if (km == null || km > IKW_RADIUS_KM) continue;
      l.type = `${km.toString().replace('.', ',')} km van ${IKW_CENTER.name}`;
      delete l.pc4;
      delete l.postcode;
      listings.push(l);
    }

    if (full) src.lastFullScan = nl.date;
    console.log(`ikwilhuren: ${pages} pagina('s), ${all.length} advertenties, ${listings.length} binnen ${IKW_RADIUS_KM} km${full ? ' (volledige scan)' : ''}`);
    // Alleen bij een volledige scan weten we zeker wat er niet meer staat.
    return { listings, complete: full };
  },
};

// ---------- bron 3: Zuidwestwonen (ZIG-portaal) ----------

const ZWW_BASE = 'https://www.zuidwestwonen.nl';
const ZWW_CITIES = ['Vlissingen', 'Oost-Souburg'];

const nlDate = (s) => (s || '').replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$3-$2-$1');
const euro = (n) => '€ ' + n.toLocaleString('nl-NL', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

const zuidwestwonen = {
  id: 'zuidwestwonen',
  name: 'Zuidwestwonen',
  page: ZWW_BASE + '/aanbod',
  owns: (key) => key.startsWith('zww:'),

  async fetch() {
    const res = await fetch(ZWW_BASE + '/portal/object/frontend/getallobjects/format/json', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} bij Zuidwestwonen`);
    const all = (await res.json()).result;
    if (!Array.isArray(all) || all.length === 0) throw new Error('Geen advertenties gevonden bij Zuidwestwonen; waarschijnlijk is de structuur veranderd');

    const listings = [];
    for (const o of all) {
      const city = o.city && o.city.name;
      const model = (o.model && o.model.modelCategorie && o.model.modelCategorie.code) || null;
      // Alleen huur- en koopwoningen; geen woningruil en geen parkeren.
      if (!ZWW_CITIES.includes(city)) continue;
      if (!o.dwellingType || o.dwellingType.categorie !== 'woning') continue;
      if (o.isWoningruil || model === 'woningruil') continue;
      const koop = o.rentBuy === 'Koop';
      if (!koop && o.rentBuy !== 'Huur') continue;

      const price = koop ? Number(o.sellingPrice) || null : Number(o.totalRent) || null;
      const label = o.energyLabel && o.energyLabel.icon ? o.energyLabel.icon.replace(/^icon_label_/, '').toUpperCase() : null;
      const action = o.actionLabel && o.actionLabel.localizedLabel;
      listings.push({
        key: `zww:${o.id}`,
        category: koop ? 'Koopwoning' : 'Woning',
        title: [o.street, o.houseNumber, o.houseNumberAddition].filter(Boolean).join(' '),
        place: [o.postalcode, city].filter(Boolean).join(' '),
        price,
        priceText: price ? euro(price) : null,
        priceSuffix: koop ? ' k.k.' : ' p.m.',
        serviceText: null,
        netRentText: !koop && o.netRent ? euro(Number(o.netRent)) : null,
        statusCode: 'available',
        statusLabel: action || (koop ? 'Te koop' : 'Te huur'),
        area: o.areaDwelling ? `${o.areaDwelling} m²` : null,
        rooms: null,
        bedrooms: o.sleepingRoom && Number(o.sleepingRoom.amountOfRooms) || null,
        type: [o.dwellingType.localizedName, model].filter(Boolean).join(' · '),
        energy: label,
        available: o.closingDate ? `reageren tot ${nlDate(o.closingDate)}` : null,
        photo: o.pictures && o.pictures[0] ? ZWW_BASE + o.pictures[0].uri : null,
        url: `${ZWW_BASE}/aanbod/nu-te-huur/${koop ? 'te-koop' : 'huurwoningen'}/details/${o.urlKey}`,
      });
    }
    return { listings, complete: true };
  },
};

const SOURCES = [hefwonen, ikwilhuren, zuidwestwonen];

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
      const img = await fetch(photo, { headers: { 'User-Agent': UA } });
      if (!img.ok) throw new Error('foto HTTP ' + img.status);
      const type = img.headers.get('content-type') || 'image/jpeg';
      const fd = new FormData();
      fd.append('chat_id', chat_id);
      fd.append('caption', text);
      fd.append('parse_mode', 'HTML');
      fd.append('photo', new Blob([await img.arrayBuffer()], { type }), 'foto.' + (type.split('/')[1] || 'jpg'));
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
  if (l.priceText) {
    facts.push(`${esc(l.priceText)}${l.priceSuffix || ' p.m.'}` +
      (l.serviceText ? ` (+ ${esc(l.serviceText)} service)` : l.netRentText ? ` (kaal ${esc(l.netRentText)})` : ''));
  }
  if (l.area) facts.push(esc(l.area));
  if (l.rooms) facts.push(`${l.rooms} kamers` + (l.bedrooms ? ` (${l.bedrooms} slaapk.)` : ''));
  else if (l.bedrooms) facts.push(`${l.bedrooms} slaapk.`);
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

async function processSource(source, state, nl, now) {
  const src = (state.sources[source.id] = state.sources[source.id] || {});
  const firstRun = !src.initialized;

  let result;
  try {
    result = await source.fetch(state, nl);
  } catch (e) {
    src.failures = (src.failures || 0) + 1;
    console.error(`${source.name}: ophalen mislukt:`, e.message);
    if (src.failures === FAIL_ALERT_AFTER) {
      await send(`<b>Huurmelder: let op</b>\n${esc(source.name)} kon ${FAIL_ALERT_AFTER} keer op rij niet worden gelezen.\nFout: ${esc(e.message)}`).catch(() => {});
    }
    return { ok: false };
  }
  if (src.failures >= FAIL_ALERT_AFTER) {
    await send(`<b>Huurmelder</b>\n${esc(source.name)} wordt weer normaal gelezen.`);
  }
  src.failures = 0;

  const seenNow = new Set();
  let sent = 0;
  for (const l of result.listings) {
    seenNow.add(l.key);
    const old = state.listings[l.key];
    let headline = null;

    if (!old) {
      headline = `🏠 Nieuw bij ${source.name}`;
    } else if (old.gone) {
      headline = `🔁 Weer online bij ${source.name}`;
    } else if (old.price != null && l.price != null && old.price !== l.price) {
      const diff = l.price - old.price;
      headline = `💶 Prijswijziging bij ${source.name}: € ${old.price.toLocaleString('nl-NL')} → € ${l.price.toLocaleString('nl-NL')} (${diff > 0 ? '+' : '−'}€ ${Math.abs(diff).toLocaleString('nl-NL')})`;
    } else if (old.statusCode && old.statusCode !== 'available' && l.statusCode === 'available') {
      headline = `✅ Weer beschikbaar bij ${source.name} (was: ${old.statusLabel || old.statusCode})`;
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

  // Wat niet meer op de site staat markeren als verdwenen (zonder melding), alleen bij een volledige lijst.
  if (result.complete) {
    for (const [key, v] of Object.entries(state.listings)) {
      if (source.owns(key) && !seenNow.has(key) && !v.gone) { v.gone = true; v.goneSince = now; }
    }
  }

  src.initialized = true;
  console.log(`${source.name}: ${result.listings.length} advertenties, ${sent} melding(en)${firstRun ? ' (eerste run, alleen vastgelegd)' : ''}.`);
  return { ok: true, firstRun, count: result.listings.length };
}

async function main() {
  if (!DRY && (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_TOKEN en TELEGRAM_CHAT_ID moeten gezet zijn (of gebruik --dry)');
  }
  const now = new Date().toISOString();
  const nl = nlNow();
  const state = loadState() || { listings: {}, lastHeartbeat: null };

  // Overstap vanaf de versie met alleen Hef Wonen.
  if (!state.sources) {
    state.sources = { hefwonen: { initialized: Object.keys(state.listings).length > 0, failures: state.failures || 0 } };
    delete state.failures;
  }

  const results = {};
  for (const s of SOURCES) results[s.id] = await processSource(s, state, nl, now);

  const started = SOURCES.filter((s) => results[s.id].firstRun);
  if (started.length) {
    const what = started.map((s) => `${s.name}: ${results[s.id].count} advertenties`).join('\n');
    await send(`<b>Huurmelder: nieuwe bron actief</b>\nHuidig aanbod vastgelegd.\n${esc(what)}\nVanaf nu krijg je hiervan ook meldingen.`);
  }

  if (nl.hour >= HEARTBEAT_HOUR && state.lastHeartbeat !== nl.date) {
    const lines = SOURCES.map((s) => {
      const items = Object.entries(state.listings).filter(([k, v]) => s.owns(k) && !v.gone && (s.id !== 'hefwonen' || k.startsWith('rent:')));
      const vrij = items.filter(([, v]) => v.statusCode === 'available').length;
      const status = results[s.id].ok ? '' : ' ⚠️ laatste check mislukt';
      return `${esc(s.name)}: ${items.length} woningen (${vrij} beschikbaar)${status}`;
    });
    await send(`<b>Huurmelder leeft nog</b> 👋\n${lines.join('\n')}`);
    state.lastHeartbeat = nl.date;
  }

  saveState(state);
  if (SOURCES.every((s) => !results[s.id].ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
