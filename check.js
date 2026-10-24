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

const OFFLINE_ALERT_AFTER_MS = 3 * 60 * 60 * 1000; // site offline: pas na 3 uur waarschuwen

// Fout die betekent dat de site (tijdelijk) niet bereikbaar is, in plaats van dat de structuur veranderd is.
function offlineError(msg) {
  const e = new Error(msg);
  e.offline = true;
  return e;
}

// fetch met time-out en één herpoging. Netwerkfouten, time-outs, 5xx en onderhoudspagina's tellen als "offline".
async function http(url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      const host = new URL(url).host;
      if (res.status >= 500 || res.status === 429 || /offline|onderhoud|maintenance/i.test(body.slice(0, 2000))) {
        lastErr = offlineError(`${host} geeft HTTP ${res.status}${/offline|onderhoud|maintenance/i.test(body.slice(0, 2000)) ? ' (onderhoudspagina)' : ''}`);
      } else {
        throw new Error(`${host} geeft HTTP ${res.status}`);
      }
    } catch (e) {
      if (!e.offline && !(e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'TypeError')) throw e;
      lastErr = e.offline ? e : offlineError(`${new URL(url).host} reageert niet (${e.name === 'TimeoutError' ? 'time-out' : e.message})`);
    }
    if (attempt === 1) await sleep(5000);
  }
  throw lastErr;
}

async function getText(url) {
  return (await http(url)).text();
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
  const res = await http(url);
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
    const res = await http(ZWW_BASE + '/portal/object/frontend/getallobjects/format/json', {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
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

// ---------- bron 4: Corpowonen (makelaar voor corporaties, vooral koop) ----------

const CORPO_BASE = 'https://www.corpowonen.nl';
// Plaatsen zoals Corpowonen ze in de URL gebruikt; koop en huur worden allebei gevolgd.
const CORPO_CITIES = ['amsterdam', 'utrecht', 'rotterdam'];
const CORPO_TYPES = ['koop', 'huur'];
const CORPO_MAX_PAGES = 40; // veiligheidsgrens per zoekopdracht
const CORPO_MAX_KOOPPRIJS = 400000; // koopwoningen duurder dan dit worden overgeslagen

function parseCorpoRows(html, type) {
  const out = [];
  for (const r of html.split('<div class="object-row">').slice(1)) {
    const link = r.match(/<span class="address"><a href="(\/object\/(\d+)\/[^"]+)">([^<]+)<\/a>/);
    if (!link) continue;
    const pc = r.match(/<span class="postcode">([^<]+)<\/span>/);
    // Bij "Bijna verkocht" staat de prijs doorgestreept in een extra span.
    const price = r.match(/<span class="price">(?:<span[^>]*>)?([^<]+)</);
    const size = r.match(/<span class="size">([^<]+)<\/span>/);
    const rooms = r.match(/<span class="rooms">(\d+)/);
    const img = r.match(/<img[^>]+src="([^"]+)"/);
    // Labels staan er dubbel in (mobiel + desktop), daarom ontdubbelen. vov = verkocht onder voorbehoud.
    const labels = [...new Map([...r.matchAll(/label label-([a-z-]+)">([^<]*)/g)]
      .map((m) => [m[1], { code: m[1], text: decode(m[2]) }])).values()];
    const priceText = price ? decode(price[1]) : null;
    const amount = priceText && priceText.match(/€\s*([\d.]+)/);
    const sold = labels.find((l) => /^vov$|bod|verkocht|verhuurd|optie|voorbehoud/.test(l.code));
    out.push({
      key: `corpo:${link[2]}`,
      category: type === 'koop' ? 'Koopwoning' : 'Woning',
      title: decode(link[3]),
      place: pc ? decode(pc[1]) : '',
      price: amount ? Number(amount[1].replace(/\./g, '')) : null,
      priceText: priceText ? priceText.replace(/\s*(k\.k\.|v\.o\.n\.|p\/?m\.?|per maand)$/i, '') : null,
      priceSuffix: priceText && /v\.o\.n\./i.test(priceText) ? ' v.o.n.' : type === 'koop' ? ' k.k.' : ' p.m.',
      serviceText: null,
      statusCode: sold ? sold.code : 'available',
      statusLabel: sold ? sold.text : labels.map((l) => l.text).filter(Boolean).join(', ') || (type === 'koop' ? 'Te koop' : 'Te huur'),
      area: size ? decode(size[1]).replace('&sup2;', '²') : null,
      rooms: rooms ? Number(rooms[1]) : null,
      bedrooms: null,
      type: null,
      energy: null,
      available: null,
      photo: img ? (img[1].startsWith('/') ? CORPO_BASE + img[1] : img[1]).replace('_thumb.', '_large.') : null,
      url: CORPO_BASE + link[1],
    });
  }
  return out;
}

const corpowonen = {
  id: 'corpowonen',
  name: 'Corpowonen',
  page: CORPO_BASE + '/aanbod/',
  owns: (key) => key.startsWith('corpo:'),

  async fetch() {
    const byKey = new Map();
    let requests = 0;
    for (const type of CORPO_TYPES) {
      for (const city of CORPO_CITIES) {
        const found = new Set();
        for (let p = 1; p <= CORPO_MAX_PAGES; p++) {
          if (requests++) await sleep(300);
          const url = `${CORPO_BASE}/objecten-ophalen/${type}/${city}/${p > 1 ? `pagina-${p}/` : ''}`;
          let j;
          try { j = await (await http(url)).json(); }
          catch (e) { if (e.offline) throw e; throw new Error(`Corpowonen gaf geen geldige data (${e.message}); waarschijnlijk is de site veranderd`); }
          if (typeof j.properties !== 'string') throw new Error('Corpowonen: veld "properties" ontbreekt; waarschijnlijk is de site veranderd');
          const rows = parseCorpoRows(j.properties, type);
          const before = found.size;
          for (const l of rows) { byKey.set(l.key, l); found.add(l.key); }
          // Klaar zodra alles van deze zoekopdracht binnen is of een pagina niets nieuws oplevert.
          if (found.size === before || found.size >= (Number(j.totalResults) || 0)) break;
        }
      }
    }
    // Koopwoningen boven de maximumprijs overslaan; zonder bekende prijs toch meenemen.
    const listings = [...byKey.values()].filter((l) => l.category !== 'Koopwoning' || l.price == null || l.price <= CORPO_MAX_KOOPPRIJS);
    console.log(`Corpowonen: ${requests} verzoeken, ${listings.length} advertenties`);
    return { listings, complete: true };
  },
};

// ---------- bron 5 en 6: Ayvens occasions (België en Polen) -> aparte autochat ----------

// Telegram-groep "Automelder" (een chatnummer is niet geheim; het bot-token wel, dat staat in de Secrets).
const AUTO_CHAT_ID = process.env.TELEGRAM_CHAT_ID_AUTO || '-5353313333';
const AYVENS_BASE = 'https://usedcars.ayvens.com';
const AYVENS_MERKEN = 'audi+bmw+mercedes-benz+volkswagen';
const AYVENS_MAX_EUR = 25000;
const AYVENS_PAGE_SIZE = 120;
const AYVENS_MAX_PAGES = 20;

const AYVENS_FUEL = {
  'Petrol': 'Benzine',
  'Hybrid': 'Hybride',
  'Hybrid: Gasoline/Electric': 'Hybride',
  'Mild Hybrid: Gasoline/Electric': 'Mild hybride',
  'Plug-in Hybrid: Gasoline/Electric': 'Plug-in hybride',
};
const AYVENS_STATUS = {
  'Available': 'Beschikbaar',
  'Coming soon': 'Binnenkort beschikbaar',
  'Reserved': 'Gereserveerd',
  'Reserved for UCL': 'Gereserveerd',
};

const fmtNum = (n) => Math.round(n).toLocaleString('nl-NL');

// Wisselkoers PLN per euro van de ECB, 1x per dag opgehaald en in state bewaard.
async function plnPerEur(state, nl) {
  const fx = state.fx || {};
  if (fx.date === nl.date && fx.pln) return fx.pln;
  try {
    const xml = await getText('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    const m = xml.match(/currency=['"]PLN['"]\s+rate=['"]([\d.]+)['"]/);
    if (!m) throw new Error('PLN-koers niet gevonden');
    state.fx = { date: nl.date, pln: Number(m[1]) };
    return state.fx.pln;
  } catch (e) {
    if (fx.pln) { console.warn('ECB-koers ophalen mislukt, gebruik vorige:', e.message); return fx.pln; }
    throw e;
  }
}

function parseAyvensTiles(html) {
  const out = [];
  for (const chunk of html.split('class="product product-pid"').slice(1)) {
    const tr = chunk.match(/data-tracking-productclick="([^"]+)"/);
    if (!tr) continue;
    let p;
    try { p = JSON.parse(tr[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')).find((x) => x.ecommerce)?.ecommerce.click.products[0]; }
    catch { continue; }
    if (!p || !p.id) continue;
    const link = chunk.match(/class="link stretched-link" href="([^"]+)"/);
    const img = chunk.match(/data-src="([^"]+)"/);
    out.push({ p, href: link ? link[1] : null, img: img ? img[1].replace(/&amp;/g, '&').replace(/sw=\d+&sh=\d+/, 'sw=800&sh=600') : null });
  }
  return out;
}

function makeAyvens({ id, name, locale, path, keyPrefix, currency }) {
  return {
    id,
    name,
    app: 'Automelder',
    chat: AUTO_CHAT_ID,
    icon: '🚗',
    unit: "auto's",
    page: `${AYVENS_BASE}/${locale}/${path}/${AYVENS_MERKEN}/`,
    owns: (key) => key.startsWith(keyPrefix),

    async fetch(state, nl) {
      const rate = currency === 'PLN' ? await plnPerEur(state, nl) : 1;
      const byKey = new Map();
      const seenPids = new Set();
      for (let page = 0; page < AYVENS_MAX_PAGES; page++) {
        if (page) await sleep(500);
        const url = `${this.page}?prefn1=gearType&prefv1=Automatic&start=${page * AYVENS_PAGE_SIZE}&sz=${AYVENS_PAGE_SIZE}`;
        const tiles = parseAyvensTiles(await getText(url));
        if (page === 0 && tiles.length === 0) throw new Error(`${name}: geen auto's gevonden; waarschijnlijk is de site veranderd`);
        const before = seenPids.size;
        for (const { p } of tiles) seenPids.add(p.id);
        for (const { p, href, img } of tiles) {
          const fuel = AYVENS_FUEL[p.dimension2];
          if (!fuel || p.dimension3 !== 'Automatic' || p.dimension22 === 'Sold') continue; // geen diesel/elektrisch/verkocht
          const eur = p.price / rate;
          if (!(eur <= AYVENS_MAX_EUR)) continue;
          const reg = (p.dimension56 || '').match(/^(\d{4})-(\d{2})/);
          byKey.set(keyPrefix + p.id, {
            key: keyPrefix + p.id,
            title: `${p.brand && !String(p.name).startsWith(p.brand) ? p.brand + ' ' : ''}${p.name}`,
            price: p.price, // in eigen valuta, zodat koersschommelingen geen prijswijziging lijken
            currency,
            rate,
            statusCode: p.dimension22 === 'Available' ? 'available' : p.dimension22,
            statusLabel: AYVENS_STATUS[p.dimension22] || p.dimension22,
            lines: [
              p.variant,
              currency === 'PLN' ? `€ ${fmtNum(eur)} (${fmtNum(p.price)} zł)` : `€ ${fmtNum(p.price)}`,
              [fuel, 'Automaat', p.dimension5 != null ? `${fmtNum(p.dimension5)} km` : null, reg ? `${reg[2]}-${reg[1]}` : null].filter(Boolean).join(' · '),
            ],
            photo: img,
            url: href ? (href.startsWith('http') ? href : AYVENS_BASE + href) : this.page,
          });
        }
        // Laatste pagina, of een pagina die alleen al bekende auto's herhaalt.
        if (tiles.length < AYVENS_PAGE_SIZE || seenPids.size === before) break;
      }
      const listings = [...byKey.values()];
      console.log(`${name}: ${listings.length} auto's binnen de filters${currency === 'PLN' ? ` (koers ${rate} zł/€)` : ''}`);
      return { listings, complete: true };
    },
  };
}

const ayvensBE = makeAyvens({ id: 'ayvens-be', name: 'Ayvens België', locale: 'nl-be', path: 'autos', keyPrefix: 'aybe:', currency: 'EUR' });
const ayvensPL = makeAyvens({ id: 'ayvens-pl', name: 'Ayvens Polen', locale: 'pl-pl', path: 'samochody', keyPrefix: 'aypl:', currency: 'PLN' });

// Geld formatteren voor prijswijzigingen: zloty omrekenen naar euro, met de zloty erbij.
function money(v, l) {
  if (l.currency === 'PLN') return `€ ${fmtNum(v / l.rate)} (${fmtNum(v)} zł)`;
  return `€ ${v.toLocaleString('nl-NL')}`;
}

const SOURCES = [hefwonen, ikwilhuren, zuidwestwonen, corpowonen, ayvensBE, ayvensPL];

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

async function send(text, photo, chat) {
  if (DRY) {
    console.log('--- [dry] ' + (chat ? `[chat ${chat}] ` : '') + (photo ? '(met foto) ' : '') + '\n' + text.replace(/<[^>]+>/g, '') + '\n');
    return;
  }
  const chat_id = chat || process.env.TELEGRAM_CHAT_ID;
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
  if (l.lines) {
    // Bronnen met een eigen opmaak (auto's).
    for (const x of l.lines) if (x) lines.push(esc(x));
    if (l.statusLabel) lines.push(`Status: ${esc(l.statusLabel)}`);
    lines.push(`<a href="${esc(l.url)}">Bekijk advertentie</a>`);
    return lines.join('\n');
  }
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

// ---------- Darija: woorden van de dag (kanaal "Darija", alleen zenden) ----------

const DARIJA_CHAT_ID = process.env.TELEGRAM_CHAT_ID_DARIJA || '-1004363303061';
const DARIJA_HOUR = 7; // eerste run na 07:00 Nederlandse tijd
const DARIJA_FILE = path.join(__dirname, 'darija.json');

const dayNumber = (isoDate) => Math.floor(Date.parse(isoDate + 'T00:00:00Z') / 86400000);

// Voorspelbare "willekeur" per datum, zodat een herhaalde run dezelfde quiz geeft.
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function darijaWordsMessage(words, startIdx, goal, newTheme) {
  const first = startIdx + 1;
  const last = startIdx + words.length;
  const lines = [`🗣️ <b>Darija · ${esc(words[0].theme)}</b>`, `Woord ${first}–${last} van ${goal}`];
  if (newTheme) lines.push(`📚 <i>Nieuw thema: ${esc(words[0].theme)}</i>`);
  words.forEach((w, i) => {
    lines.push('', `<b>${first + i}. ${esc(w.d)}</b> · ${esc(w.nl)}`);
    if (w.ex) lines.push(`💬 <i>${esc(w.ex)}</i>`, `     ${esc(w.exnl || '')}`);
    if (w.tip) lines.push(`💡 ${esc(w.tip)}`);
  });
  return lines.join('\n');
}

function darijaQuizMessage(all, idxEnd, seed) {
  // Woorden van de afgelopen 7 dagen + een paar oudere ter herhaling.
  const weekStart = Math.max(0, idxEnd - 35);
  const thisWeek = seededShuffle(all.slice(weekStart, idxEnd), seed).slice(0, 5);
  const older = seededShuffle(all.slice(0, weekStart), seed + 7).slice(0, 2);
  const qs = seededShuffle([...thisWeek, ...older], seed + 13);
  const lines = ['🧠 <b>Darija · weekquiz</b>', 'Tik op het verborgen antwoord om het te zien.', ''];
  qs.forEach((w, i) => {
    if (i % 2 === 0) lines.push(`${i + 1}. Wat betekent <b>${esc(w.d)}</b>?`, `     👉 <tg-spoiler>${esc(w.nl)}</tg-spoiler>`);
    else lines.push(`${i + 1}. Hoe zeg je <b>${esc(w.nl)}</b> in het Darija?`, `     👉 <tg-spoiler>${esc(w.d)}</tg-spoiler>`);
  });
  lines.push('', 'Bsse7tek! Morgen weer nieuwe woorden. 👋');
  return lines.join('\n');
}

async function runDarija(state, nl) {
  let data;
  try { data = JSON.parse(fs.readFileSync(DARIJA_FILE, 'utf8')); }
  catch (e) { console.warn('Darija: darija.json niet leesbaar:', e.message); return; }
  const st = (state.darija = state.darija || {});
  const all = data.themes.flatMap((t) => t.words.map((w) => ({ ...w, theme: t.name })));

  if (!st.introSent) {
    await send(
      '🗣️ <b>Welkom bij Darija, woord van de dag!</b>\n\n' +
      `Elke ochtend krijg je hier ${data.perDay} nieuwe woorden, per thema. Op vrijdag volgt een weekquiz met verborgen antwoorden.\n\n` +
      '✍️ <b>Zo lees je de letters</b>\n' +
      '<b>3</b> · keelklank (ع), knijp je keel licht samen en zeg "a"\n' +
      '<b>7</b> · hese h diep uit je keel (ح)\n' +
      '<b>9</b> · diepe k achter in je keel (ق)\n' +
      '<b>kh</b> · harde g zoals in "lachen"\n' +
      '<b>gh</b> · zachte g, bijna een Franse r\n' +
      '<b>sh</b> · sj zoals in "sjaal"\n\n' +
      'Bslama! 👋', null, DARIJA_CHAT_ID);
    st.introSent = true;
  }

  if (nl.date < data.start || nl.hour < DARIJA_HOUR || st.lastDate === nl.date) return;
  const day = dayNumber(nl.date) - dayNumber(data.start);
  const idx = day * data.perDay;
  const words = all.slice(idx, idx + data.perDay);

  if (words.length === 0) {
    if (!st.emptyNotified) {
      await send('<b>Darija</b>\nDe woordenlijst is op. Vraag Claude om de volgende woorden toe te voegen.');
      st.emptyNotified = true;
    }
    return;
  }

  const prevTheme = idx > 0 ? all[idx - 1].theme : null;
  await send(darijaWordsMessage(words, idx, data.goal, prevTheme !== words[0].theme), null, DARIJA_CHAT_ID);

  // Vrijdag: weekquiz.
  if (new Date(nl.date + 'T12:00:00Z').getUTCDay() === 5) {
    await send(darijaQuizMessage(all, idx + words.length, dayNumber(nl.date)), null, DARIJA_CHAT_ID);
  }

  // Op tijd waarschuwen (in de eigen chat) dat de lijst bijna op is.
  const daysLeft = Math.floor((all.length - idx - words.length) / data.perDay);
  if (daysLeft <= 7 && st.lowWarnedAt !== all.length) {
    await send(`<b>Darija</b>\nNog ${daysLeft} dag(en) aan woorden over (${all.length} van ${data.goal}). Vraag Claude om de volgende woorden toe te voegen.`);
    st.lowWarnedAt = all.length;
  }

  st.lastDate = nl.date;
  console.log(`Darija: woorden ${idx + 1}-${idx + words.length} verstuurd.`);
}

// ---------- hoofdlogica ----------

async function processSource(source, state, nl, now) {
  const src = (state.sources[source.id] = state.sources[source.id] || {});
  const firstRun = !src.initialized;
  const app = source.app || 'Huurmelder';
  const chat = source.chat || undefined;

  let result;
  try {
    result = await source.fetch(state, nl);
  } catch (e) {
    src.failures = (src.failures || 0) + 1;
    src.failingSince = src.failingSince || now;
    console.error(`${source.name}: ophalen mislukt (${e.offline ? 'site offline' : 'structuur?'}):`, e.message);
    // Een site die tijdelijk plat ligt is normaal; pas waarschuwen als het lang duurt.
    // Een andere fout betekent meestal dat de site veranderd is; dan sneller waarschuwen.
    const longOffline = Date.parse(now) - Date.parse(src.failingSince) >= OFFLINE_ALERT_AFTER_MS;
    if (!src.alerted && (e.offline ? longOffline : src.failures >= FAIL_ALERT_AFTER)) {
      const text = e.offline
        ? `<b>${app}: ${esc(source.name)} is al ruim 3 uur onbereikbaar</b>\nDe site ligt er waarschijnlijk tijdelijk uit. De melder blijft het proberen en laat het weten als het weer werkt.\nFout: ${esc(e.message)}`
        : `<b>${app}: ${esc(source.name)} kan niet meer gelezen worden</b>\nDe site is waarschijnlijk aangepast, de melder moet bijgewerkt worden.\nFout: ${esc(e.message)}`;
      await send(text, null, chat).catch(() => {});
      src.alerted = true;
    }
    return { ok: false };
  }
  if (src.alerted) {
    await send(`<b>${app}</b>\n${esc(source.name)} wordt weer normaal gelezen. ✅`, null, chat);
  }
  src.failures = 0;
  delete src.failingSince;
  delete src.alerted;

  const seenNow = new Set();
  let sent = 0;
  for (const l of result.listings) {
    seenNow.add(l.key);
    const old = state.listings[l.key];
    let headline = null;

    if (!old) {
      headline = `${source.icon || '🏠'} Nieuw bij ${source.name}`;
    } else if (old.price != null && l.price != null && old.price !== l.price) {
      // Ook als hij weg was: bijv. een koopwoning die onder de maximumprijs zakt.
      const diff = l.price - old.price;
      headline = `💶 Prijs${diff < 0 ? 'verlaging' : 'verhoging'} bij ${source.name}: ${money(old.price, l)} → ${money(l.price, l)}`;
    } else if (old.gone) {
      headline = `🔁 Weer online bij ${source.name}`;
    } else if (old.statusCode && old.statusCode !== 'available' && l.statusCode === 'available') {
      headline = `✅ Weer beschikbaar bij ${source.name} (was: ${old.statusLabel || old.statusCode})`;
    }

    if (headline && !firstRun) {
      await send(describe(l, headline), l.photo, chat);
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

  // Overstap: de oude versie waarschuwde na 3 mislukte runs zonder dat te onthouden.
  for (const src of Object.values(state.sources)) {
    if (src.failures >= FAIL_ALERT_AFTER && src.alerted === undefined) src.alerted = true;
  }

  // Darija los van de melders: een fout hier mag de rest niet tegenhouden.
  try { await runDarija(state, nl); }
  catch (e) { console.error('Darija mislukt:', e.message); }
  if (process.argv.includes('--darija-only')) { saveState(state); return; }

  const results = {};
  for (const s of SOURCES) {
    // Autobronnen pas draaien als de aparte autochat is ingesteld.
    if (s.app === 'Automelder' && !s.chat && !DRY) {
      console.log(`${s.name}: overgeslagen, TELEGRAM_CHAT_ID_AUTO is niet ingesteld`);
      results[s.id] = { ok: true, skipped: true };
      continue;
    }
    results[s.id] = await processSource(s, state, nl, now);
  }
  const active = SOURCES.filter((s) => !results[s.id].skipped);
  const apps = [...new Set(active.map((s) => s.app || 'Huurmelder'))];

  // Startbericht en dagelijkse "leeft nog" per melder, elk in zijn eigen chat.
  for (const app of apps) {
    const group = active.filter((s) => (s.app || 'Huurmelder') === app);
    const chat = group[0].chat || undefined;
    const started = group.filter((s) => results[s.id].firstRun);
    if (started.length) {
      const what = started.map((s) => `${s.name}: ${results[s.id].count} ${s.unit || 'advertenties'}`).join('\n');
      await send(`<b>${app}: nieuwe bron actief</b>\nHuidig aanbod vastgelegd.\n${esc(what)}\nVanaf nu krijg je hiervan ook meldingen.`, null, chat);
    }
  }

  if (nl.hour >= HEARTBEAT_HOUR && state.lastHeartbeat !== nl.date) {
    for (const app of apps) {
      const group = active.filter((s) => (s.app || 'Huurmelder') === app);
      const lines = group.map((s) => {
        const items = Object.entries(state.listings).filter(([k, v]) => s.owns(k) && !v.gone && (s.id !== 'hefwonen' || k.startsWith('rent:')));
        const vrij = items.filter(([, v]) => v.statusCode === 'available').length;
        const status = results[s.id].ok ? '' : ' ⚠️ laatste check mislukt';
        return `${esc(s.name)}: ${items.length} ${s.unit || 'woningen'} (${vrij} beschikbaar)${status}`;
      });
      await send(`<b>${app} leeft nog</b> 👋\n${lines.join('\n')}`, null, group[0].chat || undefined);
    }
    state.lastHeartbeat = nl.date;
  }

  saveState(state);
  if (active.every((s) => !results[s.id].ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
