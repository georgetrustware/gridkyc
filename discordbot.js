require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { initializeDiscordBot, sendMessageToChannel } = require('./helpers/discordhelper');

const BASE_URL = 'https://api.binance.us';

// Generate HMAC SHA256 signature
function generateSignature(queryString, apiSecret) {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// Create a signed request
async function makeRequest(apiKey, apiSecret, endpoint, method, params = {}) {
  const queryString = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const signature = generateSignature(queryString, apiSecret);
  const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

  try {
    console.log(`Making request to URL: ${url}`);
    const response = await axios({
      method,
      url,
      headers: {
        'X-MBX-APIKEY': apiKey,
      },
    });
    return response.data;
  } catch (error) {
    console.error('API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Fetch current price
async function getCurrentPrice(apiKey, apiSecret, symbol) {
  try {
    const url = `${BASE_URL}/api/v3/ticker/price`;
    const response = await axios.get(url, { params: { symbol } });
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
  try {
    const url = `${BASE_URL}/api/v3/exchangeInfo`;
    const response = await axios.get(url);
    const pair = response.data.symbols.find((s) => s.symbol === symbol);

    if (!pair) {
      throw new Error(`Trading pair ${symbol} not found.`);
    }

    const lotSize = pair.filters.find((f) => f.filterType === 'LOT_SIZE');
    const priceFilter = pair.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const minNotional = pair.filters.find((f) => f.filterType === 'MIN_NOTIONAL');

    return {
      minQty: parseFloat(lotSize.minQty),
      stepSize: parseFloat(lotSize.stepSize),
      tickSize: parseFloat(priceFilter.tickSize),
      minPrice: parseFloat(priceFilter.minPrice),
      minNotional: parseFloat(minNotional.minNotional),
    };
  } catch (error) {
    console.error('Error fetching trading pair info:', error.response?.data || error.message);
    throw error;
  }
}

// Adjust quantity to meet LOT_SIZE requirements
function adjustQuantity(quantity, stepSize, minQty) {
  let adjustedQuantity = Math.floor(quantity / stepSize) * stepSize;
  return adjustedQuantity < minQty ? minQty : adjustedQuantity;
}

// Adjust price to match PRICE_FILTER rules
function adjustPrice(price, tickSize, minPrice) {
  let adjustedPrice = Math.floor(price / tickSize) * tickSize;
  return adjustedPrice < minPrice ? minPrice : adjustedPrice;
}

// Fetch all open orders for a symbol
async function fetchActiveOrders(apiKey, apiSecret, symbol) {
  return await makeRequest(apiKey, apiSecret, '/api/v3/openOrders', 'GET', { symbol });
}

// Place a LIMIT order
async function placeSpotOrder(apiKey, apiSecret, symbol, side, quantity, price) {
  return await makeRequest(apiKey, apiSecret, '/api/v3/order', 'POST', {
    symbol,
    side,
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: quantity.toFixed(6),
    price: price.toFixed(4),
  });
}

// GridBot logic
// GridBot logic
async function startGridBot(apiKey, apiSecret, symbol, channel) {
  const percentageDrop = 0.60; // 0.6% drop to trigger a buy order
  const percentageRise = 1.2;  // 1.2% rise to reset base price
  const investment = 2;        // $2 investment for each buy order
  const intervalMs = 2 * 60 * 1000; // Check price every 2 minutes

  try {
    const { minQty, stepSize, tickSize, minPrice, minNotional } = await getTradingPairInfo(symbol);
    let basePrice = await getCurrentPrice(apiKey, apiSecret, symbol);

    sendMessageToChannel(channel, `GridBot started for ${symbol}. Base price set to $${basePrice.toFixed(4)}`);

    // Fetch active orders at the start
    let activeOrders = await fetchActiveOrders(apiKey, apiSecret, symbol);
    sendMessageToChannel(channel, `Fetched ${activeOrders.length} active orders.`);

    setInterval(async () => {
      try {
        const currentPrice = await getCurrentPrice(apiKey, apiSecret, symbol);
        sendMessageToChannel(channel, `Current price of ${symbol}: $${currentPrice.toFixed(4)}`);

        const priceDrop = ((basePrice - currentPrice) / basePrice) * 100;
        const priceRise = ((currentPrice - basePrice) / basePrice) * 100;

        // Check if any buy orders have been filled and place corresponding sell orders
        for (let i = activeOrders.length - 1; i >= 0; i--) {
          const order = activeOrders[i];
          const orderStatus = await checkOrderStatus(apiKey, apiSecret, symbol, order.orderId);

          if (orderStatus.status === 'FILLED') {
            sendMessageToChannel(channel, `[FILLED] Buy order ${order.orderId} filled at price ${order.price}.`);

            // Calculate sell price for 3% profit
            const sellPrice = adjustPrice(order.price * 1.03, tickSize, minPrice);
            await placeSpotOrder(apiKey, apiSecret, symbol, 'SELL', order.quantity, sellPrice);
            sendMessageToChannel(channel, `[SELL ORDER PLACED] Selling ${order.quantity} ${symbol} at $${sellPrice.toFixed(4)}`);

            activeOrders.splice(i, 1); // Remove the filled order from active orders
          }
        }

        // Place a new buy order if the price drops by the specified percentage
        if (priceDrop >= percentageDrop) {
          let quantity = adjustQuantity(investment / currentPrice, stepSize, minQty);
          let price = adjustPrice(currentPrice * 0.99, tickSize, minPrice);

          if (quantity * price >= minNotional) {
            const buyOrder = await placeSpotOrder(apiKey, apiSecret, symbol, 'BUY', quantity, price);
            sendMessageToChannel(channel, `Buy order placed: ${quantity} ${symbol} at $${price.toFixed(4)}`);

            activeOrders.push({ orderId: buyOrder.orderId, quantity, price });
            basePrice = currentPrice;
          } else {
            sendMessageToChannel(channel, 'Order does not meet the minimum notional requirement.');
          }
        } else if (priceRise >= percentageRise) {
          sendMessageToChannel(channel, `Price rose by ${priceRise.toFixed(2)}%. Updating base price to $${currentPrice.toFixed(4)}`);
          basePrice = currentPrice;
        }
      } catch (error) {
        sendMessageToChannel(channel, `Error during grid trading: ${error.message}`);
      }
    }, intervalMs);
  } catch (error) {
    sendMessageToChannel(channel, `Error starting GridBot: ${error.message}`);
  }
}

// Start the Discord bot and handle commands
initializeDiscordBot(startGridBot);
