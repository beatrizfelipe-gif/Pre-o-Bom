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

// ─── AUTH (opcional) ─────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'API Key inválida', hint: 'Header: x-api-key: ' + API_KEY });
  }
  next();
}

// ─── CACHE (5 min) ───────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
  const h = cache.get(key);
  if (!h) return null;
  if (Date.now() - h.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return h.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ─── HISTÓRICO ───────────────────────────────────────────────────
const quotations = new Map();

// ─── ML: cliente axios configurado ──────────────────────────────
const mlClient = axios.create({
  baseURL: 'https://api.mercadolibre.com',
  timeout: 15000,
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; PrecoBom/1.0)',
  }
});

// ─── ML: busca por nome ─────────────────────────────────────────
async function searchMLByName(query, limit = 8) {
  const cacheKey = 'search:' + query.toLowerCase().trim();
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const { data } = await mlClient.get('/sites/MLB/search', {
    params: { q: query, limit }
  });

  const results = (data.results || []).map(item => ({
    store:       'Mercado Livre',
    storeKey:    'mercadolivre',
    title:       item.title,
    price:       item.price,
    oldPrice:    item.original_price || null,
    currency:    'BRL',
    freeShip:    item.shipping?.free_shipping || false,
    freight:     item.shipping?.free_shipping ? 'Frete grátis' : 'Calcular frete',
    freightCost: item.shipping?.free_shipping ? 0 : null,
    rating:      item.reviews?.rating_average || null,
    reviews:     item.reviews?.total || null,
    condition:   item.condition || 'new',
    thumbnail:   item.thumbnail || null,
    url:         item.permalink,
    itemId:      item.id,
  }));

  setCache(cacheKey, results);
  return results;
}

// ─── ML: busca por ID ───────────────────────────────────────────
async function searchMLById(itemId) {
  const cacheKey = 'item:' + itemId;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const { data: item } = await mlClient.get(`/items/${itemId}`);
  const freeShip = item.shipping?.free_shipping || false;

  const result = [{
    store:       'Mercado Livre',
    storeKey:    'mercadolivre',
    title:       item.title,
    price:       item.price,
    oldPrice:    item.original_price || null,
    currency:    'BRL',
    freeShip,
    freight:     freeShip ? 'Frete grátis' : 'Calcular frete',
    freightCost: freeShip ? 0 : null,
    rating:      null,
    reviews:     null,
    condition:   item.condition || 'new',
    thumbnail:   item.thumbnail?.replace('I.jpg', 'O.jpg') || null,
    url:         item.permalink,
    itemId:      item.id,
    brand:       item.attributes?.find(a => a.id === 'BRAND')?.value_name || null,
    soldQty:     item.sold_quantity || null,
  }];

  setCache(cacheKey, result);
  return result;
}

// ─── EXTRAI ID MLB ───────────────────────────────────────────────
function extractMLId(url) {
  const patterns = [
    /item_id%3A(MLB\d+)/i,
    /item_id=(MLB\d+)/i,
    /\/(MLB\d+)/i,
    /(MLB\d+)/i,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1] || m[0];
  }
  return null;
}

function detectStore(url) {
  if (/mercadolivre\.com\.br|mercadolibre\.com/i.test(url)) return 'mercadolivre';
  if (/amazon\.com\.br/i.test(url))                          return 'amazon';
  if (/magazineluiza\.com\.br/i.test(url))                   return 'magalu';
  if (/americanas\.com\.br/i.test(url))                      return 'americanas';
  return 'other';
}

// ─── MOTOR DE COTAÇÃO ────────────────────────────────────────────
async function runQuotation({ name, links, maxResults = 8 }) {
  const results = [];
  const errors  = [];
  let productName = name || '';

  // Busca por links
  if (links && links.length > 0) {
    for (const url of links.slice(0, 5)) {
      const store = detectStore(url);
      try {
        if (store === 'mercadolivre') {
          const id = extractMLId(url);
          if (!id) throw new Error('ID não encontrado na URL');
          const items = await searchMLById(id);
          results.push(...items);
          if (!productName && items[0]) productName = items[0].title;
        } else {
          errors.push({ url, store, error: `Integração com "${store}" em breve. Use links do Mercado Livre ou busque pelo nome.` });
        }
      } catch (err) {
        errors.push({ url, store, error: err.message });
      }
    }
  }

  // Busca por nome
  if (name && name.trim()) {
    try {
      const mlResults = await searchMLByName(name, maxResults);
      const existingIds = new Set(results.map(r => r.itemId));
      for (const r of mlResults) {
        if (!existingIds.has(r.itemId)) results.push(r);
      }
      if (!productName && mlResults[0]) productName = mlResults[0].title;
    } catch (err) {
      errors.push({ store: 'mercadolivre', error: 'Erro na busca: ' + err.message });
    }
  }

  results.sort((a, b) => (a.price || 999999) - (b.price || 999999));

  const best = results[0] || null;
  const summary = best ? {
    bestPrice:   best.price,
    bestStore:   best.store,
    bestUrl:     best.url,
    savings:     results.length > 1 ? (results[results.length - 1].price - best.price) : 0,
    totalOffers: results.length,
  } : null;

  return { productName, summary, results, errors };
}

// ════════════════════════════════════════════════════════════════
//  ROTAS
// ════════════════════════════════════════════════════════════════

// POST /api/quote — assíncrono com webhook
app.post('/api/quote', requireApiKey, async (req, res) => {
  const { requestId, name, links, webhookUrl, metadata, maxResults } = req.body;
  if (!name && (!links || !links.length)) {
    return res.status(400).json({ error: 'Envie "name" ou "links"' });
  }
  const quotationId = requestId || crypto.randomUUID();
  const startedAt   = new Date().toISOString();
  quotations.set(quotationId, { quotationId, requestId, name, links, metadata, status: 'processing', startedAt });

  res.status(202).json({ quotationId, status: 'processing', pollUrl: `/api/quote/${quotationId}`, startedAt });

  runQuotation({ name, links, maxResults }).then(async result => {
    const payload = { quotationId, requestId, status: 'done', startedAt, finishedAt: new Date().toISOString(), name, links, metadata, ...result };
    quotations.set(quotationId, payload);
    if (webhookUrl) {
      try { await axios.post(webhookUrl, payload, { headers: { 'x-precobom-event': 'quote.done' }, timeout: 10000 }); }
      catch (e) { console.error('Webhook error:', e.message); }
    }
  }).catch(err => {
    quotations.set(quotationId, { quotationId, requestId, status: 'error', startedAt, error: err.message });
    if (webhookUrl) axios.post(webhookUrl, { quotationId, status: 'error', error: err.message }, { timeout: 5000 }).catch(() => {});
  });
});

// GET /api/quote/:id — polling
app.get('/api/quote/:id', requireApiKey, (req, res) => {
  const q = quotations.get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Cotação não encontrada' });
  res.json(q);
});

// GET /api/quote — lista
app.get('/api/quote', requireApiKey, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const list = [...quotations.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit)
    .map(q => ({
      quotationId: q.quotationId, requestId: q.requestId, status: q.status,
      name: q.name || q.productName, startedAt: q.startedAt,
      bestPrice: q.summary?.bestPrice, bestStore: q.summary?.bestStore, totalOffers: q.summary?.totalOffers,
    }));
  res.json({ total: list.length, quotations: list });
});

// POST /api/search — síncrono
app.post('/api/search', requireApiKey, async (req, res) => {
  const { name, links, maxResults } = req.body;
  if (!name && (!links || !links.length)) {
    return res.status(400).json({ error: 'Envie "name" ou "links"' });
  }
  try {
    const result = await runQuotation({ name, links, maxResults });
    res.json({ status: 'done', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), quotations: quotations.size, cache: cache.size });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`PrecoBom API na porta ${PORT} | API_KEY: ${API_KEY || 'desativada'}`));
