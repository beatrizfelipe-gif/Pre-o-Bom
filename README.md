# PrecoBom API v2 — Cotações Automáticas

API REST para cotação automática de preços. Integre com qualquer sistema de solicitações.

## Fluxo automático

```
Beatriz abre solicitação
       ↓
Seu sistema chama POST /api/quote
       ↓
PrecoBom busca preços (ML, Amazon, Magalu...)
       ↓
PrecoBom chama seu webhook com os resultados
       ↓
Seu sistema atualiza a solicitação com as cotações
       ↓
Beatriz escolhe a melhor opção
```

## Estrutura

```
precobom-api/
├── server.js               ← API completa (backend)
├── package.json
├── .gitignore
├── exemplo-integracao.js   ← Código de exemplo para seu sistema
└── public/
    └── index.html          ← Dashboard + docs interativas
```

## Deploy no Railway (via GitHub)

### 1. Criar repositório no GitHub
1. github.com → **New repository** → nome `precobom-api`
2. Clique em **"uploading an existing file"**
3. Arraste todos os arquivos (incluindo pasta `public/`)
4. Commit

### 2. Deploy no Railway
1. railway.app → **New Project** → **Deploy from GitHub repo**
2. Selecione `precobom-api`
3. Railway detecta Node.js automaticamente

### 3. Configurar API Key (IMPORTANTE)
No Railway: **Settings → Variables → Add Variable**
```
API_KEY = minha-chave-super-secreta-2024
```

### 4. Gerar URL pública
Railway: **Settings → Networking → Generate Domain**
Sua URL: `https://precobom-api-production.up.railway.app`

---

## Endpoints

### POST /api/quote — Cotação assíncrona (recomendado)
```bash
curl -X POST https://SEU-APP.railway.app/api/quote \
  -H "Content-Type: application/json" \
  -H "x-api-key: sua-api-key" \
  -d '{
    "requestId":  "SOLIC-001",
    "name":       "Nespresso Essenza Mini",
    "links":      ["https://www.mercadolivre.com.br/..."],
    "webhookUrl": "https://seu-sistema.com/webhook/cotacoes",
    "metadata":   { "solicitante": "Beatriz", "dept": "TI" }
  }'
```

Resposta imediata (202):
```json
{
  "quotationId": "abc-123",
  "status": "processing",
  "pollUrl": "/api/quote/abc-123"
}
```

### GET /api/quote/:id — Consultar resultado
```bash
curl https://SEU-APP.railway.app/api/quote/abc-123 \
  -H "x-api-key: sua-api-key"
```

### POST /api/search — Busca síncrona (aguarda resultado)
```bash
curl -X POST https://SEU-APP.railway.app/api/search \
  -H "Content-Type: application/json" \
  -H "x-api-key: sua-api-key" \
  -d '{ "name": "iPhone 15 128GB" }'
```

### GET /api/health — Health check
```bash
curl https://SEU-APP.railway.app/api/health
```

---

## Resposta de cotação (payload completo)

```json
{
  "quotationId":  "abc-123",
  "requestId":    "SOLIC-001",
  "status":       "done",
  "productName":  "Nespresso Essenza Mini Preta",
  "metadata":     { "solicitante": "Beatriz" },
  "summary": {
    "bestPrice":   289.00,
    "bestStore":   "Mercado Livre",
    "bestUrl":     "https://...",
    "savings":     64.00,
    "totalOffers": 5
  },
  "results": [
    {
      "store":       "Mercado Livre",
      "storeKey":    "mercadolivre",
      "title":       "Cafeteira Nespresso Essenza Mini...",
      "price":       289.00,
      "oldPrice":    349.00,
      "currency":    "BRL",
      "freeShip":    true,
      "freight":     "Frete grátis",
      "freightCost": 0,
      "rating":      4.8,
      "reviews":     2100,
      "condition":   "new",
      "thumbnail":   "https://...",
      "url":         "https://..."
    }
  ],
  "errors": []
}
```

---

## Desenvolvimento local

```bash
npm install
API_KEY=minha-chave node server.js
# Acesse http://localhost:3000
```

## Próximas integrações

- Amazon via PA-API (afiliados)
- Magalu via Lomadee
- Shopee via API parceira
- Alertas de preço por e-mail
- Banco de dados para histórico
