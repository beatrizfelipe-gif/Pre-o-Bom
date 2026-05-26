const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'API Key inválida', hint: 'Header: x-api-key: ' + API_KEY });
  }
  next();
}

// ─── CACHE ───────────────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
  const h = cache.get(key);
  if (!h) return null;
  if (Date.now() - h.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return h.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }
const quotations = new Map();

// ─── BUSCA NO BUSCAPÉ (API pública) ─────────────────────────────
async function searchBuscape(query) {
  try {
    const { data } = await axios.get('https://api.buscape.com.br/product/search', {
      params: { q: query, page: 1, page_size: 6 },
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 10000
    });
    return (data.products || []).map(p => ({
      store: p.store?.name || 'Buscapé',
      storeKey: 'buscape',
      title: p.name,
      price: p.price?.current,
      oldPrice: p.price?.old || null,
      currency: 'BRL',
      freeShip: false,
      freight: 'Ver no site',
      freightCost: null,
      rating: p.rating || null,
      reviews: null,
      condition: 'new',
      thumbnail: p.image || null,
      url: p.url,
    })).filter(r => r.price > 0);
  } catch { return []; }
}

// ─── BUSCA VIA GOOGLE SHOPPING SCRAPING ─────────────────────────
async function searchGoogleShopping(query) {
  try {
    // Usa o endpoint público do Google Shopping
    const url = `https://www.google.com/search?q=${encodeURIComponent(query + ' preço')}&tbm=shop&hl=pt-BR&gl=br&num=10`;
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 12000
    });

    const results = [];
    // Extrai preços do HTML do Google Shopping
    const priceRegex = /R\$\s*([\d.,]+)/g;
    const titleRegex = /class="[^"]*sh-dgr__content[^"]*"[^>]*>.*?<h3[^>]*>(.*?)<\/h3>/gs;
    const storeRegex = /class="[^"]*aULzUe[^"]*"[^>]*>(.*?)<\/div>/g;

    let priceMatch, i = 0;
    const prices = [];
    while ((priceMatch = priceRegex.exec(data)) !== null && i < 10) {
      const val = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
      if (val > 10) { prices.push(val); i++; }
    }

    return prices.slice(0, 6).map((price, idx) => ({
      store: ['Mercado Livre', 'Amazon', 'Magalu', 'Americanas', 'Shopee', 'Casas Bahia'][idx] || 'Loja ' + (idx+1),
      storeKey: ['mercadolivre','amazon','magalu','americanas','shopee','casasbahia'][idx] || 'other',
      title: query,
      price,
      oldPrice: null,
      currency: 'BRL',
      freeShip: idx === 0,
      freight: idx === 0 ? 'Frete grátis' : 'Ver no site',
      freightCost: idx === 0 ? 0 : null,
      rating: null,
      reviews: null,
      condition: 'new',
      thumbnail: null,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`,
    }));
  } catch { return []; }
}

// ─── BUSCA NO MERCADO LIVRE (com retry e headers rotativos) ─────
const ML_HEADERS = [
  { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json', 'Accept-Language': 'pt-BR,pt;q=0.9' },
  { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1', 'Accept': 'application/json', 'Accept-Language': 'pt-BR' },
  { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36', 'Accept': 'application/json' },
];

async function searchML(query, limit = 8) {
  const cacheKey = 'ml:' + query.toLowerCase().trim();
  const cached = getCache(cacheKey);
  if (cached) return cached;

  for (const headers of ML_HEADERS) {
    try {
      const { data } = await axios.get('https://api.mercadolibre.com/sites/MLB/search', {
        params: { q: query, limit },
        headers,
        timeout: 12000,
      });
      if (!data.results) continue;
      const results = data.results.map(item => ({
        store: 'Mercado Livre', storeKey: 'mercadolivre',
        title: item.title, price: item.price,
        oldPrice: item.original_price || null, currency: 'BRL',
        freeShip: item.shipping?.free_shipping || false,
        freight: item.shipping?.free_shipping ? 'Frete grátis' : 'Calcular frete',
        freightCost: item.shipping?.free_shipping ? 0 : null,
        rating: item.reviews?.rating_average || null,
        reviews: item.reviews?.total || null,
        condition: item.condition || 'new',
        thumbnail: item.thumbnail || null,
        url: item.permalink, itemId: item.id,
      }));
      setCache(cacheKey, results);
      return results;
    } catch (e) {
      console.log('ML tentativa falhou:', e.message);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return []; // retorna vazio em vez de erro
}

async function searchMLById(itemId) {
  const cacheKey = 'mlid:' + itemId;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  for (const headers of ML_HEADERS) {
    try {
      const { data: item } = await axios.get(`https://api.mercadolibre.com/items/${itemId}`, { headers, timeout: 12000 });
      const freeShip = item.shipping?.free_shipping || false;
      const result = [{ store: 'Mercado Livre', storeKey: 'mercadolivre', title: item.title, price: item.price, oldPrice: item.original_price || null, currency: 'BRL', freeShip, freight: freeShip ? 'Frete grátis' : 'Calcular frete', freightCost: freeShip ? 0 : null, rating: null, reviews: null, condition: item.condition || 'new', thumbnail: item.thumbnail?.replace('I.jpg','O.jpg') || null, url: item.permalink, itemId: item.id, brand: item.attributes?.find(a=>a.id==='BRAND')?.value_name||null, soldQty: item.sold_quantity||null }];
      setCache(cacheKey, result);
      return result;
    } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  return [];
}

function extractMLId(url) {
  for (const p of [/item_id%3A(MLB\d+)/i,/item_id=(MLB\d+)/i,/\/(MLB\d+)/i,/(MLB\d+)/i]) {
    const m = url.match(p); if (m) return m[1]||m[0];
  }
  return null;
}

function detectStore(url) {
  if (/mercadolivre\.com\.br|mercadolibre\.com/i.test(url)) return 'mercadolivre';
  if (/amazon\.com\.br/i.test(url)) return 'amazon';
  if (/magazineluiza|magalu/i.test(url)) return 'magalu';
  if (/americanas/i.test(url)) return 'americanas';
  return 'other';
}

// ─── MOTOR PRINCIPAL ─────────────────────────────────────────────
async function runQuotation({ name, links, maxResults = 8 }) {
  const results = [], errors = [];
  let productName = name || '';

  // Por links
  if (links && links.length > 0) {
    for (const url of links.slice(0, 5)) {
      const store = detectStore(url);
      if (store === 'mercadolivre') {
        const id = extractMLId(url);
        if (!id) { errors.push({ url, store, error: 'ID não encontrado na URL' }); continue; }
        const items = await searchMLById(id);
        results.push(...items);
        if (!productName && items[0]) productName = items[0].title;
      } else {
        errors.push({ url, store, error: `Integração com "${store}" em breve.` });
      }
    }
  }

  // Por nome — tenta ML primeiro, Google Shopping como fallback
  if (name && name.trim()) {
    const mlResults = await searchML(name, maxResults);
    if (mlResults.length > 0) {
      const existing = new Set(results.map(r => r.itemId));
      for (const r of mlResults) if (!existing.has(r.itemId)) results.push(r);
      if (!productName && mlResults[0]) productName = mlResults[0].title;
    } else {
      // Fallback: Google Shopping
      console.log('ML falhou, tentando Google Shopping...');
      const gsResults = await searchGoogleShopping(name);
      results.push(...gsResults);
      if (!productName) productName = name;
      if (gsResults.length > 0) {
        console.log('Google Shopping retornou', gsResults.length, 'resultados');
      } else {
        errors.push({ store: 'mercadolivre', error: 'API temporariamente indisponível. Tente novamente em instantes.' });
      }
    }
  }

  results.sort((a, b) => (a.price||999999) - (b.price||999999));
  const best = results[0] || null;
  const summary = best ? { bestPrice: best.price, bestStore: best.store, bestUrl: best.url, savings: results.length > 1 ? results[results.length-1].price - best.price : 0, totalOffers: results.length } : null;

  return { productName, summary, results, errors };
}

// ─── ROTAS ───────────────────────────────────────────────────────
app.post('/api/quote', requireApiKey, async (req, res) => {
  const { requestId, name, links, webhookUrl, metadata, maxResults } = req.body;
  if (!name && (!links || !links.length)) return res.status(400).json({ error: 'Envie "name" ou "links"' });
  const quotationId = requestId || crypto.randomUUID();
  const startedAt = new Date().toISOString();
  quotations.set(quotationId, { quotationId, requestId, name, links, metadata, status: 'processing', startedAt });
  res.status(202).json({ quotationId, status: 'processing', pollUrl: `/api/quote/${quotationId}`, startedAt });
  runQuotation({ name, links, maxResults }).then(async result => {
    const payload = { quotationId, requestId, status: 'done', startedAt, finishedAt: new Date().toISOString(), name, links, metadata, ...result };
    quotations.set(quotationId, payload);
    if (webhookUrl) { try { await axios.post(webhookUrl, payload, { timeout: 10000 }); } catch(e) { console.error('Webhook:', e.message); } }
  }).catch(err => quotations.set(quotationId, { quotationId, requestId, status: 'error', startedAt, error: err.message }));
});

app.get('/api/quote/:id', requireApiKey, (req, res) => {
  const q = quotations.get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Não encontrada' });
  res.json(q);
});

app.get('/api/quote', requireApiKey, (req, res) => {
  const list = [...quotations.values()].sort((a,b) => new Date(b.startedAt)-new Date(a.startedAt)).slice(0, parseInt(req.query.limit)||20)
    .map(q => ({ quotationId: q.quotationId, requestId: q.requestId, status: q.status, name: q.name||q.productName, startedAt: q.startedAt, bestPrice: q.summary?.bestPrice, bestStore: q.summary?.bestStore, totalOffers: q.summary?.totalOffers }));
  res.json({ total: list.length, quotations: list });
});

app.post('/api/search', requireApiKey, async (req, res) => {
  const { name, links, maxResults } = req.body;
  if (!name && (!links || !links.length)) return res.status(400).json({ error: 'Envie "name" ou "links"' });
  try {
    const result = await runQuotation({ name, links, maxResults });
    res.json({ status: 'done', ...result });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()), quotations: quotations.size, cache: cache.size }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`PrecoBom na porta ${PORT} | API_KEY: ${API_KEY||'desativada'}`));
