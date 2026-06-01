const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY  = process.env.API_KEY  || null;
const SERP_KEY = process.env.SERP_KEY || '7887f4e0c88eda7e60bfb46546997dee54f41318ef79b30316ffdbcdf9633402';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY)
    return res.status(401).json({ error: 'API Key inválida' });
  next();
}

const cache = new Map();
function getCache(key) {
  const h = cache.get(key);
  if (!h) return null;
  if (Date.now() - h.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return h.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

const quotations = new Map();
const savingsStore = new Map();

async function searchSerpAPI(query) {
  const cacheKey = 'serp:' + query.toLowerCase().trim();
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const { data } = await axios.get('https://serpapi.com/search', {
    params: { api_key: SERP_KEY, engine: 'google_shopping', q: query, location: 'Brazil', hl: 'pt', gl: 'br', num: 10 },
    timeout: 15000,
  });
  const items = data.shopping_results || [];
  const results = items.slice(0, 8).map(item => {
    const priceStr = item.price || '';
    const priceNum = parseFloat(priceStr.replace('R$','').replace(/\./g,'').replace(',','.').trim());
    const freeShip = /gr[aá]tis/i.test(item.delivery || '');
    return { store: item.source || 'Loja', storeKey: slugify(item.source || 'other'), title: item.title || query, price: isNaN(priceNum) ? null : priceNum, oldPrice: null, currency: 'BRL', freeShip, freight: item.delivery || 'Ver no site', freightCost: freeShip ? 0 : null, rating: item.rating || null, reviews: item.reviews || null, condition: 'new', thumbnail: item.thumbnail || null, url: item.link || item.product_link || '#' };
  }).filter(r => r.price && r.price > 0);
  setCache(cacheKey, results);
  return results;
}

async function searchByLink(url) {
  let query = '';
  try {
    const u = new URL(url);
    const slug = u.pathname.split('/').filter(Boolean)[0] || '';
    query = slug.replace(/-/g, ' ').replace(/\b(p|mlb\d+)\b/gi, '').trim();
    if (!query) query = u.hostname;
  } catch { query = url; }
  if (!query) throw new Error('Não foi possível identificar o produto nesta URL');
  return await searchSerpAPI(query);
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g,'-').replace(/[^\w-]/g,'').substring(0,20);
}

async function runQuotation({ name, links, maxResults = 8 }) {
  const results = [], errors = [];
  let productName = name || '';
  if (links && links.length > 0) {
    for (const url of links.slice(0, 5)) {
      try {
        const items = await searchByLink(url);
        for (const r of items) { if (!results.find(x => x.store === r.store)) results.push(r); }
        if (!productName && items[0]) productName = items[0].title;
      } catch (err) { errors.push({ url, error: err.message }); }
    }
  }
  if (name && name.trim()) {
    try {
      const serpResults = await searchSerpAPI(name);
      for (const r of serpResults) { if (!results.find(x => x.store === r.store)) results.push(r); }
      if (!productName && serpResults[0]) productName = serpResults[0].title;
    } catch (err) { errors.push({ store: 'google_shopping', error: 'Erro na busca: ' + err.message }); }
  }
  results.sort((a, b) => (a.price || 999999) - (b.price || 999999));
  const best = results[0] || null;
  const summary = best ? { bestPrice: best.price, bestStore: best.store, bestUrl: best.url, savings: results.length > 1 ? results[results.length-1].price - best.price : 0, totalOffers: results.length } : null;
  return { productName, summary, results, errors };
}

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
  const list = [...quotations.values()].sort((a,b) => new Date(b.startedAt)-new Date(a.startedAt)).slice(0, parseInt(req.query.limit)||20).map(q => ({ quotationId: q.quotationId, requestId: q.requestId, status: q.status, name: q.name||q.productName, startedAt: q.startedAt, bestPrice: q.summary?.bestPrice, bestStore: q.summary?.bestStore, totalOffers: q.summary?.totalOffers }));
  res.json({ total: list.length, quotations: list });
});

app.post('/api/search', requireApiKey, async (req, res) => {
  const { name, links, maxResults } = req.body;
  if (!name && (!links || !links.length)) return res.status(400).json({ error: 'Envie "name" ou "links"' });
  try { const result = await runQuotation({ name, links, maxResults }); res.json({ status: 'done', ...result }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/savings', requireApiKey, (req, res) => {
  const { quotationId, requestId, productName, preApprovedValue, chosenPrice, chosenStore, chosenUrl, metadata } = req.body;
  if (!preApprovedValue || !chosenPrice) return res.status(400).json({ error: 'Envie "preApprovedValue" e "chosenPrice"' });
  const savedAmount = preApprovedValue - chosenPrice;
  const savingsPct  = ((savedAmount / preApprovedValue) * 100).toFixed(2);
  const choiceId    = crypto.randomUUID();
  const chosenAt    = new Date().toISOString();
  const record = { choiceId, quotationId, requestId, productName, preApprovedValue, chosenPrice, chosenStore, chosenUrl, savedAmount, savingsPct: parseFloat(savingsPct), chosenAt, metadata: metadata || {} };
  savingsStore.set(choiceId, record);
  res.status(201).json(record);
});

app.get('/api/savings/dashboard', requireApiKey, (req, res) => {
  let records = [...savingsStore.values()];
  if (req.query.from) { const from = new Date(req.query.from); records = records.filter(r => new Date(r.chosenAt) >= from); }
  if (req.query.to)   { const to   = new Date(req.query.to);   records = records.filter(r => new Date(r.chosenAt) <= to); }
  const totalSaved        = records.reduce((s, r) => s + r.savedAmount, 0);
  const totalSpent        = records.reduce((s, r) => s + r.chosenPrice, 0);
  const totalPreApproved  = records.reduce((s, r) => s + r.preApprovedValue, 0);
  const avgSavingsPct     = records.length ? (records.reduce((s,r) => s + r.savingsPct, 0) / records.length).toFixed(2) : 0;
  const byMonth = {};
  for (const r of records) {
    const month = r.chosenAt.substring(0, 7);
    if (!byMonth[month]) byMonth[month] = { month, totalSaved: 0, totalSpent: 0, count: 0 };
    byMonth[month].totalSaved += r.savedAmount;
    byMonth[month].totalSpent += r.chosenPrice;
    byMonth[month].count++;
  }
  const byStore = {};
  for (const r of records) {
    const s = r.chosenStore || 'Desconhecida';
    if (!byStore[s]) byStore[s] = { store: s, totalSaved: 0, count: 0 };
    byStore[s].totalSaved += r.savedAmount;
    byStore[s].count++;
  }
  res.json({ summary: { totalRecords: records.length, totalSaved: parseFloat(totalSaved.toFixed(2)), totalSpent: parseFloat(totalSpent.toFixed(2)), totalPreApproved: parseFloat(totalPreApproved.toFixed(2)), avgSavingsPct: parseFloat(avgSavingsPct) }, byMonth: Object.values(byMonth).sort((a,b) => a.month.localeCompare(b.month)), byStore: Object.values(byStore).sort((a,b) => b.totalSaved - a.totalSaved).slice(0,10), records: records.sort((a,b) => new Date(b.chosenAt) - new Date(a.chosenAt)) });
});

app.delete('/api/savings/:id', requireApiKey, (req, res) => {
  if (!savingsStore.has(req.params.id)) return res.status(404).json({ error: 'Registro não encontrado' });
  savingsStore.delete(req.params.id);
  res.json({ deleted: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()), quotations: quotations.size, cache: cache.size, savings: savingsStore.size, serp: SERP_KEY ? 'configurada' : 'ausente' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`PrecoBom na porta ${PORT} | SerpAPI: configurada`));
