const axios = require('axios');
require('dotenv').config();
const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://api.binance.us';

// Generate HMAC SHA256 signature
function generateSignature(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

// Create a signed request
async function makeRequest(endpoint, method, params = {}) {
  const queryString = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const signature = generateSignature(queryString);
  const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

  try {
    const response = await axios({
      method,
      url,
      headers: {
        'X-MBX-APIKEY': API_KEY,
      },
    });
    return response.data;
  } catch (error) {
    console.error('API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Fetch current price
async function getCurrentPrice(symbol) {
  const url = `${BASE_URL}/api/v3/ticker/price`;
  const response = await axios.get(url, {
    params: { symbol },
  });
  return parseFloat(response.data.price);
}

// Fetch trading pair info (to get LOT_SIZE filters)
async function getTradingPairInfo(symbol) {
  const url = `${BASE_URL}/api/v3/exchangeInfo`;
  const response = await axios.get(url);
  const pair = response.data.symbols.find((s) => s.symbol === symbol);

  const lotSize = pair.filters.find((f) => f.filterType === 'LOT_SIZE');
  return {
    minQty: parseFloat(lotSize.minQty),
    maxQty: parseFloat(lotSize.maxQty),
    stepSize: parseFloat(lotSize.stepSize),
  };
}

// Adjust quantity to meet LOT_SIZE requirements
function adjustQuantity(quantity, stepSize, minQty) {
  let adjustedQuantity = Math.floor(quantity / stepSize) * stepSize;
  if (adjustedQuantity < minQty) adjustedQuantity = minQty;
  return adjustedQuantity;
}

// Place a LIMIT order
async function placeLimitOrder(symbol, side, quantity, price) {
  const params = {
    symbol,
    side,
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: quantity.toFixed(6), // Adjust precision for quantity
    price: price.toFixed(2), // Adjust precision for price
    recvWindow: 5000, // Optional: Request validity
  };

  console.log('Placing order with params:', params);

  return await makeRequest('/api/v3/order', 'POST', params);
}

// Main function
(async () => {
  try {
    const symbol = 'DOGEUSDT';
    const side = 'BUY';
    const investment = 2; // $2 investment

    // Fetch current price
    const currentPrice = await getCurrentPrice(symbol);

    // Fetch LOT_SIZE info
    const { minQty, stepSize } = await getTradingPairInfo(symbol);

    // Calculate quantity and adjust to LOT_SIZE
    let quantity = investment / currentPrice;
    quantity = adjustQuantity(quantity, stepSize, minQty);

    // Ensure quantity is valid
    if (quantity < minQty) {
      console.error(`Quantity (${quantity}) is below the minimum allowed (${minQty}).`);
      return;
    }

    // Place order
    const result = await placeLimitOrder(symbol, side, quantity, currentPrice * 0.95); // 5% below current price
    console.log('Order placed successfully:', result);
  } catch (error) {
    console.error('Failed to place order:', error.message);
  }
})();
