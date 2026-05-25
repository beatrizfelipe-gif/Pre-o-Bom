const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Chave de API para autenticação dos sistemas externos ────────
// Defina no Railway: Settings > Variables > API_KEY=sua_chave_secreta
const API_KEY = process.env.API_KEY || 'precobom-dev-key-troque-em-producao';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MIDDLEWARE: valida API Key ──────────────────────────────────
function requireApiKey(req, res, next) {
  // Se API_KEY não estiver configurada no ambiente, aceita qualquer requisição
  if (!process.env.API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'API Key inválida ou ausente', hint: 'Envie o header: x-api-key: ' + API_KEY });
  }
  next();
}

// ─── CACHE em memória (TTL 5 min) ───────────────────────────────
const cache = new Map();
function getCache(key) {
  const h = cache.get(key);
  if (!h) return null;
  if (Date.now() - h.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return h.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── HISTÓRICO DE COTAÇÕES (em memória — use banco em produção) ──
const quotations = new Map();

// ─── MERCADO LIVRE: busca por nome ──────────────────────────────
async function searchMLByName(query, limit = 8) {
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const { data } = await axios.get(url, {
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Referer': 'https://www.mercadolivre.com.br/',
      'Origin': 'https://www.mercadolivre.com.br',
    }
  });
  return (data.results || []).map(formatMLItem);
}

// ─── MERCADO LIVRE: busca por ID ────────────────────────────────
async function searchMLById(itemId) {
  const url = `https://api.mercadolibre.com/items/${itemId}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  return [formatMLItemDetail(data)];
}

function formatMLItem(item) {
  return {
    store:      'Mercado Livre',
    storeKey:   'mercadolivre',
    title:      item.title,
    price:      item.price,
    oldPrice:   item.original_price || null,
    currency:   'BRL',
    freeShip:   item.shipping?.free_shipping || false,
    freight:    item.shipping?.free_shipping ? 'Frete grátis' : 'Calcular frete',
    freightCost: item.shipping?.free_shipping ? 0 : null,
    rating:     item.reviews?.rating_average || null,
    reviews:    item.reviews?.total || null,
    condition:  item.condition || 'new',
    thumbnail:  item.thumbnail || null,
    url:        item.permalink,
    itemId:     item.id,
  };
}

function formatMLItemDetail(item) {
  const freeShip = item.shipping?.free_shipping || false;
  return {
    store:      'Mercado Livre',
    storeKey:   'mercadolivre',
    title:      item.title,
    price:      item.price,
    oldPrice:   item.original_price || null,
    currency:   'BRL',
    freeShip,
    freight:    freeShip ? 'Frete grátis' : 'Calcular frete',
    freightCost: freeShip ? 0 : null,
    rating:     null,
    reviews:    null,
    condition:  item.condition || 'new',
    thumbnail:  item.thumbnail?.replace('I.jpg','O.jpg') || null,
    url:        item.permalink,
    itemId:     item.id,
    brand:      item.attributes?.find(a => a.id === 'BRAND')?.value_name || null,
    soldQty:    item.sold_quantity || null,
  };
}

// ─── EXTRAI ID DO ML DE UMA URL ─────────────────────────────────
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

function detectStoreFromUrl(url) {
  if (/mercadolivre\.com\.br|mercadolibre\.com/i.test(url)) return 'mercadolivre';
  if (/amazon\.com\.br/i.test(url))                          return 'amazon';
  if (/magazineluiza\.com\.br|magalu\.com\.br/i.test(url))   return 'magalu';
  if (/americanas\.com\.br/i.test(url))                      return 'americanas';
  if (/shopee\.com\.br/i.test(url))                          return 'shopee';
  return 'unknown';
}

// ─── MOTOR PRINCIPAL DE COTAÇÃO ─────────────────────────────────
async function runQuotation({ name, links, maxResults = 8 }) {
  const results   = [];
  const errors    = [];
  let productName = name || '';

  // 1. Busca por links
  if (links && links.length > 0) {
    for (const url of links.slice(0, 5)) {
      const store = detectStoreFromUrl(url);
      try {
        if (store === 'mercadolivre') {
          const id = extractMLId(url);
          if (!id) throw new Error('ID não encontrado na URL do Mercado Livre');
          const items = await searchMLById(id);
          results.push(...items);
          if (!productName && items[0]) productName = items[0].title;
        } else {
          errors.push({ url, store, error: `Loja "${store}" não integrada ainda. Use o link do Mercado Livre ou busque pelo nome.` });
        }
      } catch (err) {
        errors.push({ url, store, error: err.message });
      }
    }
  }

  // 2. Busca por nome (sempre roda se tiver nome)
  if (name && name.trim()) {
    const cacheKey = 'name:' + name.toLowerCase().trim();
    let mlResults  = getCache(cacheKey);
    if (!mlResults) {
      mlResults = await searchMLByName(name, maxResults);
      setCache(cacheKey, mlResults);
    }
    // Evita duplicar itens já buscados por link
    const existingIds = new Set(results.map(r => r.itemId));
    for (const r of mlResults) {
      if (!existingIds.has(r.itemId)) results.push(r);
    }
    if (!productName && mlResults[0]) productName = mlResults[0].title;
  }

  // Ordena por menor preço
  results.sort((a, b) => (a.price || 999999) - (b.price || 999999));

  const best = results[0] || null;
  const summary = best ? {
    bestPrice:  best.price,
    bestStore:  best.store,
    bestUrl:    best.url,
    savings:    results.length > 1 ? (results[results.length-1].price - best.price) : 0,
    totalOffers: results.length,
  } : null;

  return { productName, summary, results, errors };
}

// ════════════════════════════════════════════════════════════════
//  ROTAS DA API
// ════════════════════════════════════════════════════════════════

// ── POST /api/quote ──────────────────────────────────────────────
// Rota principal: recebe uma solicitação e retorna cotações
// Body: { requestId, name, links, webhookUrl, metadata }
app.post('/api/quote', requireApiKey, async (req, res) => {
  const { requestId, name, links, webhookUrl, metadata, maxResults } = req.body;

  // Validação
  if (!name && (!links || !links.length)) {
    return res.status(400).json({
      error: 'Envie pelo menos um: "name" (nome do produto) ou "links" (array de URLs)'
    });
  }

  const quotationId = requestId || crypto.randomUUID();
  const startedAt   = new Date().toISOString();

  // Salva status inicial
  quotations.set(quotationId, {
    quotationId, requestId, name, links, metadata,
    status: 'processing', startedAt, result: null
  });

  // Responde imediatamente (não bloqueia quem chamou)
  res.status(202).json({
    quotationId,
    status: 'processing',
    message: 'Cotação iniciada. Consulte GET /api/quote/:id ou aguarde o webhook.',
    pollUrl: `/api/quote/${quotationId}`,
    startedAt,
  });

  // Processa em background
  runQuotation({ name, links, maxResults }).then(async (result) => {
    const finishedAt = new Date().toISOString();
    const payload = {
      quotationId, requestId, status: 'done',
      startedAt, finishedAt, name, links, metadata,
      ...result,
    };
    quotations.set(quotationId, payload);

    // Dispara webhook se fornecido
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, payload, {
          headers: { 'Content-Type': 'application/json', 'x-precobom-event': 'quote.done' },
          timeout: 10000,
        });
        console.log(`Webhook enviado: ${webhookUrl}`);
      } catch (err) {
        console.error(`Falha no webhook ${webhookUrl}:`, err.message);
      }
    }
  }).catch(err => {
    const errPayload = {
      quotationId, requestId, status: 'error',
      startedAt, finishedAt: new Date().toISOString(),
      name, links, metadata,
      error: err.message,
    };
    quotations.set(quotationId, errPayload);
    if (webhookUrl) {
      axios.post(webhookUrl, errPayload, { timeout: 5000 }).catch(() => {});
    }
  });
});

// ── GET /api/quote/:id ───────────────────────────────────────────
// Consulta o resultado de uma cotação pelo ID (polling)
app.get('/api/quote/:id', requireApiKey, (req, res) => {
  const q = quotations.get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Cotação não encontrada' });
  res.json(q);
});

// ── GET /api/quote ───────────────────────────────────────────────
// Lista as últimas cotações (útil para dashboard)
app.get('/api/quote', requireApiKey, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const list  = [...quotations.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit)
    .map(q => ({
      quotationId: q.quotationId,
      requestId:   q.requestId,
      status:      q.status,
      name:        q.name || q.productName,
      startedAt:   q.startedAt,
      bestPrice:   q.summary?.bestPrice,
      bestStore:   q.summary?.bestStore,
      totalOffers: q.summary?.totalOffers,
    }));
  res.json({ total: list.length, quotations: list });
});

// ── POST /api/search (busca simples, sem histórico) ──────────────
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

// ── GET /api/health ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), quotations: quotations.size });
});

// ── Frontend ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PrecoBom API rodando na porta ${PORT}`);
  console.log(`API Key: ${API_KEY}`);
});
