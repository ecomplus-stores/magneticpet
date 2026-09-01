#!/usr/bin/env node
'use strict'

/**
 * Marca como "entregue" na E-Com Plus os pedidos cujo objeto já consta
 * como entregue no rastreamento dos Correios (CWS / SRO Rastro).
 *
 * Roda pelo GitHub Actions (.github/workflows/sync-correios.yml), sem
 * dependências externas — usa o fetch nativo do Node >= 18.
 *
 * Variáveis de ambiente (secrets do repositório):
 *   ECOM_STORE_ID            ID da loja (Magnetic Pet = 51495)
 *   ECOM_AUTH_ID             _id da autenticação da Store API
 *   ECOM_API_KEY             api_key da mesma autenticação
 *   DRY_RUN=true             só relata, não grava nada na loja
 *
 * As credenciais dos Correios são lidas da configuração do app "Correios
 * (novos contratos)" já instalado na loja. Para sobrescrever, defina
 * CORREIOS_USUARIO, CORREIOS_CODIGO_ACESSO e CORREIOS_CARTAO_POSTAGEM.
 */

const {
  ECOM_STORE_ID,
  ECOM_AUTH_ID,
  ECOM_API_KEY,
  CORREIOS_USUARIO,
  CORREIOS_CODIGO_ACESSO,
  CORREIOS_CARTAO_POSTAGEM,
  DRY_RUN
} = process.env

const isDryRun = DRY_RUN === 'true'
const ECOM_API = 'https://api.e-com.plus/v1'
const CORREIOS_API = 'https://api.correios.com.br'

// Status de fulfillment em que ainda faz sentido procurar por entrega
const STATUS_EM_TRANSITO = ['shipped', 'partially_shipped', 'partially_delivered']

// Eventos de entrega dos Correios: BDE/BDI/BDR com tipo 01 = entrega efetuada
const EVENTOS_ENTREGA = ['BDE', 'BDI', 'BDR']
const TIPO_ENTREGA = '01'

const log = (...args) => console.log(...args)

async function parse (res, contexto) {
  const texto = await res.text()
  let corpo
  try {
    corpo = texto ? JSON.parse(texto) : null
  } catch (e) {
    corpo = texto
  }
  if (!res.ok) {
    const erro = new Error(`${contexto} falhou (HTTP ${res.status}): ${typeof corpo === 'string' ? corpo : JSON.stringify(corpo)}`)
    erro.status = res.status
    throw erro
  }
  return corpo
}

/* ----------------------------- E-Com Plus ----------------------------- */

async function autenticarEcom () {
  // atalho para testes locais: usar direto a sessão do link de login do painel
  if (!ECOM_AUTH_ID && process.env.ECOM_MY_ID && process.env.ECOM_ACCESS_TOKEN) {
    return { myId: process.env.ECOM_MY_ID, accessToken: process.env.ECOM_ACCESS_TOKEN }
  }
  const res = await fetch(`${ECOM_API}/_authenticate.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Store-ID': ECOM_STORE_ID
    },
    body: JSON.stringify({ _id: ECOM_AUTH_ID, api_key: ECOM_API_KEY })
  })
  const { my_id: myId, access_token: accessToken } = await parse(res, 'Autenticação na E-Com Plus')
  return { myId, accessToken }
}

function ecomRequest ({ myId, accessToken }) {
  return async (method, endpoint, body) => {
    const res = await fetch(`${ECOM_API}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': ECOM_STORE_ID,
        'X-My-ID': myId,
        'X-Access-Token': accessToken
      },
      body: body ? JSON.stringify(body) : undefined
    })
    return parse(res, `${method} ${endpoint}`)
  }
}

async function listarPedidosEmTransito (ecom) {
  const porId = new Map()
  for (const status of STATUS_EM_TRANSITO) {
    const query = [
      `fulfillment_status.current=${status}`,
      'fields=_id,number,shipping_lines,fulfillment_status',
      'sort=-number',
      'limit=200'
    ].join('&')
    const { result } = await ecom('GET', `/orders.json?${query}`)
    if (!Array.isArray(result)) continue
    for (const pedido of result) {
      // não confiamos no filtro da query: conferimos o status aqui também,
      // e deduplicamos porque as três consultas podem devolver os mesmos pedidos
      if (STATUS_EM_TRANSITO.includes(pedido.fulfillment_status && pedido.fulfillment_status.current)) {
        porId.set(pedido._id, pedido)
      }
    }
  }
  return [...porId.values()]
}

function extrairRastreios (pedido) {
  const rastreios = []
  for (const linha of pedido.shipping_lines || []) {
    for (const rastreio of linha.tracking_codes || []) {
      const code = rastreio.code && rastreio.code.trim().toUpperCase()
      // só objetos dos Correios: AA123456789BR
      if (code && /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(code)) {
        rastreios.push({ code, shippingLineId: linha._id })
      }
    }
  }
  return rastreios
}

async function marcarComoEntregue (ecom, pedido, shippingLineId, dataEvento) {
  const fulfillment = {
    status: 'delivered',
    date_time: dataEvento,
    flags: ['correios-sync']
  }
  if (shippingLineId) fulfillment.shipping_line_id = shippingLineId
  await ecom('POST', `/orders/${pedido._id}/fulfillments.json`, fulfillment)
}

/* ------------------------------ Correios ------------------------------ */

const APP_CORREIOS_ID = 126334

/**
 * As credenciais do CWS já estão configuradas no app "Correios (novos contratos)"
 * da própria loja — lemos de lá para não duplicar segredo no GitHub. As variáveis
 * de ambiente, se existirem, têm precedência.
 */
async function credenciaisCorreios (ecom) {
  if (CORREIOS_USUARIO && CORREIOS_CODIGO_ACESSO) {
    return {
      usuario: CORREIOS_USUARIO,
      codigoAcesso: CORREIOS_CODIGO_ACESSO,
      cartao: CORREIOS_CARTAO_POSTAGEM
    }
  }
  const { result } = await ecom('GET', `/applications.json?app_id=${APP_CORREIOS_ID}&fields=_id&limit=1`)
  if (!result || !result.length) {
    throw new Error(`App Correios (${APP_CORREIOS_ID}) não encontrado na loja e nenhuma credencial informada por env`)
  }
  const config = await ecom('GET', `/applications/${result[0]._id}/hidden_data.json`)
  const contrato = config && config.correios_contract
  if (!contrato || !contrato.username || !contrato.access_code) {
    throw new Error('App Correios instalado, mas sem contrato configurado (correios_contract)')
  }
  log('Credenciais do CWS lidas da configuração do app Correios da loja.')
  return {
    usuario: contrato.username,
    codigoAcesso: contrato.access_code,
    cartao: contrato.post_card_number
  }
}

async function autenticarCorreios ({ usuario, codigoAcesso, cartao }) {
  const basic = Buffer.from(`${usuario}:${codigoAcesso}`).toString('base64')
  const comCartao = Boolean(cartao)
  const res = await fetch(`${CORREIOS_API}/token/v1/autentica${comCartao ? '/cartaopostagem' : ''}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: comCartao ? JSON.stringify({ numero: cartao }) : undefined
  })
  const { token } = await parse(res, 'Autenticação nos Correios')
  return token
}

async function consultarUltimoEvento (token, codigo) {
  const res = await fetch(`${CORREIOS_API}/srorastro/v1/objetos/${codigo}?resultado=U`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      // sem Accept-Language a API responde SRO-018
      'Accept-Language': 'pt-BR'
    }
  })
  const dados = await parse(res, `Rastreamento ${codigo}`)
  const objeto = (dados.objetos || [])[0]
  if (!objeto || objeto.mensagem) {
    log(`  ${codigo}: ${(objeto && objeto.mensagem) || 'sem retorno dos Correios'}`)
    return null
  }
  return (objeto.eventos || [])[0] || null
}

function foiEntregue (evento) {
  return Boolean(evento) && EVENTOS_ENTREGA.includes(evento.codigo) && evento.tipo === TIPO_ENTREGA
}

function dataDoEvento (evento) {
  // dtHrCriado vem sem fuso ("2026-08-30T14:22:00") e em horário de Brasília
  const data = evento && evento.dtHrCriado
  if (!data) return new Date().toISOString()
  const comFuso = /(Z|[+-]\d{2}:?\d{2})$/.test(data) ? data : `${data}-03:00`
  const parsed = new Date(comFuso)
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
}

/* -------------------------------- main -------------------------------- */

async function main () {
  const temSessaoLocal = process.env.ECOM_MY_ID && process.env.ECOM_ACCESS_TOKEN
  const faltando = ['ECOM_STORE_ID', 'ECOM_AUTH_ID', 'ECOM_API_KEY']
    .filter((nome) => !process.env[nome])
    .filter((nome) => !(temSessaoLocal && (nome === 'ECOM_AUTH_ID' || nome === 'ECOM_API_KEY')))
  if (faltando.length) {
    throw new Error(`Variáveis de ambiente ausentes: ${faltando.join(', ')}`)
  }
  if (isDryRun) log('*** DRY RUN: nenhuma alteração será gravada na loja ***')

  const ecom = ecomRequest(await autenticarEcom())
  const tokenCorreios = await autenticarCorreios(await credenciaisCorreios(ecom))

  const pedidos = await listarPedidosEmTransito(ecom)
  log(`Pedidos em trânsito: ${pedidos.length}`)

  let atualizados = 0
  let semRastreio = 0

  for (const pedido of pedidos) {
    // a listagem pode vir com campos reduzidos; nesse caso lemos o pedido inteiro
    const completo = pedido.shipping_lines
      ? pedido
      : await ecom('GET', `/orders/${pedido._id}.json`)
    const rastreios = extrairRastreios(completo)
    if (!rastreios.length) {
      semRastreio++
      continue
    }

    const consultas = []
    for (const { code, shippingLineId } of rastreios) {
      const evento = await consultarUltimoEvento(tokenCorreios, code)
      log(`  #${pedido.number} ${code}: ${evento ? `${evento.codigo}/${evento.tipo} - ${evento.descricao}` : 'sem eventos'}`)
      consultas.push({ shippingLineId, evento })
    }

    // só marca entregue quando todos os objetos do pedido foram entregues
    const entregues = consultas.filter(({ evento }) => foiEntregue(evento))
    if (entregues.length !== consultas.length) continue

    const maisRecente = entregues
      .map(({ evento, shippingLineId }) => ({ data: dataDoEvento(evento), shippingLineId }))
      .sort((a, b) => (a.data < b.data ? 1 : -1))[0]

    if (isDryRun) {
      log(`  -> #${pedido.number} SERIA marcado como entregue (${maisRecente.data})`)
    } else {
      await marcarComoEntregue(ecom, pedido, maisRecente.shippingLineId, maisRecente.data)
      log(`  -> #${pedido.number} marcado como entregue (${maisRecente.data})`)
    }
    atualizados++
  }

  log(`Concluído: ${atualizados} pedido(s) entregue(s), ${semRastreio} sem código de rastreio dos Correios.`)
}

main().catch((erro) => {
  console.error('Falha na sincronização:', erro.message)
  process.exit(1)
})
