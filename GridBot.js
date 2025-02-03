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

  try {
    const response = await axios.get(url, {
      params: { symbol },
    });
    const price = parseFloat(response.data.price);
    console.log(`[${new Date().toISOString()}] Current price of ${symbol}: $${price}`);
    return price;
  } catch (error) {
    console.error('Error fetching price:', error.response?.data || error.message);
    throw error;
  }
}

// Fetch trading pair info (to get filters)
async function getTradingPairInfo(symbol) {
  const url = `${BASE_URL}/api/v3/exchangeInfo`;
  const response = await axios.get(url);
  const pair = response.data.symbols.find((s) => s.symbol === symbol);

  const lotSize = pair.filters.find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = pair.filters.find((f) => f.filterType === 'PRICE_FILTER');
  const minNotional = pair.filters.find((f) => f.filterType === 'MIN_NOTIONAL');

  return {
    minQty: parseFloat(lotSize.minQty),
    maxQty: parseFloat(lotSize.maxQty),
    stepSize: parseFloat(lotSize.stepSize),
    tickSize: parseFloat(priceFilter.tickSize),
    minPrice: parseFloat(priceFilter.minPrice),
    maxPrice: parseFloat(priceFilter.maxPrice),
    minNotional: parseFloat(minNotional.minNotional),
  };
}

// Adjust quantity to meet LOT_SIZE requirements
function adjustQuantity(quantity, stepSize, minQty) {
  let adjustedQuantity = Math.floor(quantity / stepSize) * stepSize;
  if (adjustedQuantity < minQty) adjustedQuantity = minQty;
  return adjustedQuantity;
}

// Adjust price to match PRICE_FILTER rules
function adjustPrice(price, tickSize, minPrice) {
  let adjustedPrice = Math.floor(price / tickSize) * tickSize;
  if (adjustedPrice < minPrice) adjustedPrice = minPrice;
  return adjustedPrice;
}

// Check if order value meets MIN_NOTIONAL requirements
function isValidNotional(quantity, price, minNotional) {
  return quantity * price >= minNotional;
}

// Fetch all open orders for a symbol
async function fetchActiveOrders(symbol) {
  const params = {
    symbol,
    recvWindow: 5000,
    timestamp: Date.now(),
  };

  const queryString = new URLSearchParams(params).toString();
  const signature = generateSignature(queryString);
  const url = `${BASE_URL}/api/v3/openOrders?${queryString}&signature=${signature}`;

  try {
    const response = await axios({
      method: 'GET',
      url,
      headers: {
        'X-MBX-APIKEY': API_KEY,
      },
    });
    console.log(`[INFO] Successfully fetched active orders for ${symbol}`);
    return response.data.map(order => ({
      orderId: order.orderId,
      price: parseFloat(order.price),
      quantity: parseFloat(order.origQty),
    }));
  } catch (error) {
    console.error('Error fetching active orders:', error.response?.data || error.message);
    throw error;
  }
}

// Place a LIMIT order
async function placeSpotOrder(symbol, side, quantity, price) {
  const params = {
    symbol,
    side,
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: quantity.toFixed(6),
    price: price.toFixed(4),
    recvWindow: 5000,
  };

  console.log('Placing order with params:', params);

  const result = await makeRequest('/api/v3/order', 'POST', params);
  return { orderId: result.orderId, quantity, price };
}

// Check order status
async function checkOrderStatus(symbol, orderId) {
  const params = {
    symbol,
    orderId,
    recvWindow: 5000,
    timestamp: Date.now(),
  };

  const queryString = new URLSearchParams(params).toString();
  const signature = generateSignature(queryString);
  const url = `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`;

  try {
    const response = await axios({
      method: 'GET',
      url,
      headers: {
        'X-MBX-APIKEY': API_KEY,
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error checking order status:', error.response?.data || error.message);
    throw error;
  }
}

// GridBot logic
async function startGridBot(symbol, percentageDrop, percentageRise, investment, intervalMs, noBuys) {
  console.log(`Starting GridBot for ${symbol}. Monitoring for a price drop of ${percentageDrop}% and upward trend of ${percentageRise}%...`);
  if (noBuys) console.log(`[INFO] NoBuys mode enabled: Bot will not place new buy orders.`);

  const { minQty, stepSize, tickSize, minPrice, minNotional } = await getTradingPairInfo(symbol);

  let activeOrders = await fetchActiveOrders(symbol);
  let basePrice = await getCurrentPrice(symbol);
  console.log(`Base price set to $${basePrice}`);

  setInterval(async () => {
    try {
      const currentPrice = await getCurrentPrice(symbol);
      const priceDrop = ((basePrice - currentPrice) / basePrice) * 100;
      const priceRise = ((currentPrice - basePrice) / basePrice) * 100;

      for (let i = activeOrders.length - 1; i >= 0; i--) {
        const order = activeOrders[i];
        const orderStatus = await checkOrderStatus(symbol, order.orderId);
        if (orderStatus.status === 'FILLED') {
          console.log(`[FILLED] Buy order ${order.orderId} filled for ${order.quantity} at price ${order.price}.`);
          activeOrders.splice(i, 1);
          const sellPrice = adjustPrice(order.price * 1.03012, tickSize, minPrice);
          const sellOrder = await placeSpotOrder(symbol, 'SELL', order.quantity, sellPrice);
          console.log(`[SELL ORDER PLACED] Order ID: ${sellOrder.orderId}, Quantity: ${sellOrder.quantity}, Sell Price: $${sellPrice.toFixed(4)}`);
        }
      }

      if (!noBuys && priceDrop >= percentageDrop) {
        console.log(`[ALERT] Price dropped by ${priceDrop.toFixed(2)}% to $${currentPrice}. Placing buy order...`);
        let quantity = adjustQuantity(investment / currentPrice, stepSize, minQty);
        let price = adjustPrice(currentPrice * 0.99, tickSize, minPrice);
        if (isValidNotional(quantity, price, minNotional)) {
          const buyOrder = await placeSpotOrder(symbol, 'BUY', quantity, price);
          console.log(`Buy order placed successfully. Order ID: ${buyOrder.orderId}`);
          activeOrders.push({ orderId: buyOrder.orderId, quantity: buyOrder.quantity, price });
          basePrice = currentPrice;
        } else {
          console.error(`Order notional value does not meet the minimum requirement (${minNotional}). Skipping order.`);
        }
      } else if (priceRise >= percentageRise) {
        console.log(`[INFO] Price rose by ${priceRise.toFixed(2)}% to $${currentPrice}. Updating base price...`);
        basePrice = currentPrice;
      }
    } catch (error) {
      console.error('Error during monitoring:', error.message);
    }
  }, intervalMs);
}

// Start the bot
(async () => {
  const symbol = process.argv[2] || 'DOGEUSDT';
  const noBuys = process.argv.includes('--nobuys');
  console.log(`[INFO] Using trading pair: ${symbol}`);
  if (noBuys) console.log(`[INFO] NoBuys mode activated.`);

  const percentageDrop = 0.60;
  const percentageRise = 1.2;
  const investment = 2;
  const intervalMs = 2 * 60 * 1000;

  await startGridBot(symbol, percentageDrop, percentageRise, investment, intervalMs, noBuys);
})();

