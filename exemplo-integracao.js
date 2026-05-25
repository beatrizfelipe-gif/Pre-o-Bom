// ═══════════════════════════════════════════════════════════════
//  EXEMPLO DE INTEGRAÇÃO COM O PRECOBOM
//  Cole este código no seu sistema de solicitações
// ═══════════════════════════════════════════════════════════════

const axios = require('axios'); // npm install axios

const PRECOBOM_URL = 'https://SEU-APP.up.railway.app'; // URL do seu deploy
const PRECOBOM_KEY = 'sua-api-key-aqui';               // API Key configurada no Railway

// ── Função principal: envia uma solicitação para cotação ─────────
async function solicitarCotacao({ requestId, nome, links, webhookUrl, dadosExtras }) {
  const response = await axios.post(`${PRECOBOM_URL}/api/quote`, {
    requestId,                // ID da solicitação no seu sistema
    name:     nome,           // Nome do produto (opcional se tiver links)
    links:    links || [],    // Array de URLs (opcional se tiver nome)
    webhookUrl,               // URL do seu sistema para receber o resultado
    metadata: dadosExtras,    // Qualquer dado extra que queira receber de volta
  }, {
    headers: { 'x-api-key': PRECOBOM_KEY }
  });

  console.log('Cotação iniciada:', response.data);
  return response.data; // { quotationId, status: 'processing', pollUrl }
}

// ── Consultar resultado por polling (sem webhook) ────────────────
async function consultarCotacao(quotationId) {
  const response = await axios.get(`${PRECOBOM_URL}/api/quote/${quotationId}`, {
    headers: { 'x-api-key': PRECOBOM_KEY }
  });
  return response.data;
}

// ── Aguardar resultado (polling automático) ──────────────────────
async function aguardarCotacao(quotationId, timeoutMs = 30000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const resultado = await consultarCotacao(quotationId);
    if (resultado.status === 'done' || resultado.status === 'error') {
      return resultado;
    }
    await new Promise(r => setTimeout(r, 2000)); // espera 2s entre tentativas
  }
  throw new Error('Timeout aguardando cotação');
}

// ════════════════════════════════════════════════════════════════
//  EXEMPLOS DE USO
// ════════════════════════════════════════════════════════════════

// EXEMPLO 1: Beatriz abriu solicitação com link
async function exemploComLink() {
  console.log('\n=== EXEMPLO 1: Cotação por link ===');

  const { quotationId } = await solicitarCotacao({
    requestId:  'SOLIC-001',
    nome:       null, // sem nome, só link
    links:      ['https://www.mercadolivre.com.br/cadeira-escritorio-gamer-ergonomica/p/MLB4624939179'],
    webhookUrl: 'https://seu-sistema.com/webhook/cotacoes', // seu endpoint
    dadosExtras: { solicitante: 'Beatriz', departamento: 'TI', prioridade: 'alta' }
  });

  // Aguarda e imprime resultado
  const resultado = await aguardarCotacao(quotationId);
  imprimirResultado(resultado);
}

// EXEMPLO 2: Solicitação com nome do produto
async function exemploComNome() {
  console.log('\n=== EXEMPLO 2: Cotação por nome ===');

  const { quotationId } = await solicitarCotacao({
    requestId:  'SOLIC-002',
    nome:       'Nespresso Essenza Mini',
    links:      [],
    webhookUrl: 'https://seu-sistema.com/webhook/cotacoes',
    dadosExtras: { solicitante: 'Carlos', departamento: 'Financeiro' }
  });

  const resultado = await aguardarCotacao(quotationId);
  imprimirResultado(resultado);
}

// EXEMPLO 3: Nome + link juntos (mais completo)
async function exemploCompleto() {
  console.log('\n=== EXEMPLO 3: Nome + links combinados ===');

  const { quotationId } = await solicitarCotacao({
    requestId:  'SOLIC-003',
    nome:       'cadeira gamer ergonomica reclinavel',
    links:      ['https://www.mercadolivre.com.br/cadeira-escritorio-gamer/p/MLB4624939179'],
    dadosExtras: { solicitante: 'Beatriz', ticket: 'REQ-2024-089' }
  });

  const resultado = await aguardarCotacao(quotationId);
  imprimirResultado(resultado);
}

// EXEMPLO 4: Webhook — o PrecoBom chama seu sistema quando terminar
// No seu sistema, crie um endpoint assim:
function exemploWebhookEndpoint(app) {
  app.post('/webhook/cotacoes', (req, res) => {
    const cotacao = req.body;
    res.status(200).send('ok'); // responda rápido

    if (cotacao.status === 'done' && cotacao.results?.length > 0) {
      const requestId = cotacao.requestId;
      const melhor    = cotacao.results[0];
      const opcoes    = cotacao.results.slice(0, 5).map(r => ({
        loja:   r.store,
        preco:  r.price,
        frete:  r.freight,
        link:   r.url,
      }));

      // Atualiza a solicitação no seu sistema com as opções
      atualizarSolicitacao(requestId, {
        status:       'cotado',
        melhorPreco:  melhor.price,
        melhorLoja:   melhor.store,
        opcoes,
        cotadoEm:     cotacao.finishedAt,
      });
    }
  });
}

// Simula atualização no sistema de solicitações
function atualizarSolicitacao(requestId, dados) {
  console.log(`\n✅ Solicitação ${requestId} atualizada:`);
  console.log(`   Melhor: ${dados.melhorLoja} — R$ ${dados.melhorPreco?.toFixed(2)}`);
  console.log(`   Opções disponíveis: ${dados.opcoes?.length}`);
  dados.opcoes?.forEach((o, i) => {
    console.log(`   ${i+1}. ${o.loja}: R$ ${o.preco?.toFixed(2)} (${o.frete})`);
  });
}

// Formata e imprime resultado de cotação
function imprimirResultado(resultado) {
  console.log(`\nProduto: ${resultado.productName}`);
  console.log(`Status: ${resultado.status}`);
  if (resultado.summary) {
    console.log(`Melhor preço: R$ ${resultado.summary.bestPrice?.toFixed(2)} — ${resultado.summary.bestStore}`);
    console.log(`Economia potencial: R$ ${resultado.summary.savings?.toFixed(2)}`);
    console.log(`Total de ofertas: ${resultado.summary.totalOffers}`);
  }
  if (resultado.results) {
    console.log('\nTodas as ofertas:');
    resultado.results.forEach((r, i) => {
      console.log(`  ${i+1}. ${r.store}: R$ ${r.price?.toFixed(2)} | ${r.freight} | ${r.url}`);
    });
  }
  if (resultado.errors?.length) {
    console.log('\nErros:');
    resultado.errors.forEach(e => console.log(`  - ${e.store}: ${e.error}`));
  }
}

// Executa os exemplos
(async () => {
  try {
    await exemploComNome();
    await exemploCompleto();
  } catch (err) {
    console.error('Erro:', err.message);
  }
})();
