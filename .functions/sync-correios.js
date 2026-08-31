const functions = require('firebase-functions');
const axios = require('axios');

// Definindo suas chaves diretamente para garantir que não falhem
const MEU_STORE_ID = "51495";
const MEU_TOKEN_CORREIOS = "gqQlFdM4VNARZgvoWuVlUtD0MlZL4Csm46eJPq26";

exports.syncCorreiosTracking = functions.pubsub.schedule('every 2 hours').onRun(async (context) => {
  const ECOM_STORE_ID = MEU_STORE_ID || process.env.ECOM_STORE_ID || functions.config().ecom.store_id;
  const ECOM_API_TOKEN = process.env.ECOM_API_TOKEN || functions.config().ecom.api_token;
  const CORREIOS_API_TOKEN = MEU_TOKEN_CORREIOS || process.env.CORREIOS_API_TOKEN || functions.config().correios.api_token;

  if (!ECOM_STORE_ID || !ECOM_API_TOKEN) {
    console.log('Credenciais da E-Com Plus não configuradas.');
    return null;
  }

  const ecomApi = axios.create({
    baseURL: `https://api.e-com.plus/v1`,
    headers: {
      'Content-Type': 'application/json',
      'X-Store-ID': ECOM_STORE_ID,
      'X-My-App-Token': ECOM_API_TOKEN
    }
  });

  try {
    const response = await ecomApi.get('/orders.json?financial_status.current=paid&fulfillment_status.current=in_production');
    const orders = response.data.result;

    if (!orders || orders.length === 0) return null;

    for (const order of orders) {
      const trackingCode = order.shipping_lines && order.shipping_lines[0]?.tracking_code;
      if (!trackingCode) continue;

      const novoStatus = await consultarStatusCorreios(trackingCode, CORREIOS_API_TOKEN);

      if (novoStatus === 'delivered') {
        await ecomApi.patch(`/orders/${order._id}.json`, {
          fulfillment_status: { current: 'delivered' }
        });
      }
    }
  } catch (error) {
    console.error('Erro na sincronização:', error.response?.data || error.message);
  }
});

async function consultarStatusCorreios(codigoRastreio, tokenCorreios) {
  try {
    const response = await axios.get(`https://api.correios.com.br/sror/v1/rastreamentos/${codigoRastreio}`, {
      headers: {
        'Authorization': `Bearer ${tokenCorreios}`,
        'Accept': 'application/json'
      }
    });

    const eventos = response.data.eventos;
    if (!eventos || eventos.length === 0) return null;

    if (eventos[0].codigo === 'BDE') {
      return 'delivered';
    }

    return 'in_transit';
  } catch (error) {
    return null;
  }
}
