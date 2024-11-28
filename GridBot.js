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

// Place a LIMIT order (updated to return order details)
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
async function startGridBot(symbol, percentageDrop, percentageRise, investment, intervalMs) {
  console.log(`Starting GridBot for ${symbol}. Monitoring for a price drop of ${percentageDrop}% and upward trend of ${percentageRise}%...\n`);

  // Fetch LOT_SIZE info
  const { minQty, stepSize } = await getTradingPairInfo(symbol);

  // Fetch active orders from Binance on startup
  let activeOrders = await fetchActiveOrders(symbol);

  // Fetch initial price and set it as base price
  let basePrice = await getCurrentPrice(symbol);
  console.log(`Base price set to $${basePrice}\n`);

  // Monitor price at intervals
  setInterval(async () => {
    try {
      const currentPrice = await getCurrentPrice(symbol);
      const priceDrop = ((basePrice - currentPrice) / basePrice) * 100;
      const priceRise = ((currentPrice - basePrice) / basePrice) * 100;

      // Check active buy orders
      for (let i = activeOrders.length - 1; i >= 0; i--) {
        const order = activeOrders[i];
        const orderStatus = await checkOrderStatus(symbol, order.orderId);
        if (orderStatus.status === 'FILLED') {
          console.log(`[FILLED] Buy order ${order.orderId} filled for ${order.quantity} at price ${order.price}.`);

          // Remove filled order from tracking
          activeOrders.splice(i, 1);

          // Calculate sell price (3.012% above filled price)
          const sellPrice = order.price * 3.012;

          // Place sell order
          const sellOrder = await placeSpotOrder(symbol, 'SELL', order.quantity, sellPrice);
          console.log(`[SELL ORDER PLACED] Order ID: ${sellOrder.orderId}, Quantity: ${sellOrder.quantity}, Sell Price: $${sellPrice.toFixed(4)}`);
        }
      }

      if (priceDrop >= percentageDrop) {
        console.log(`[ALERT] Price dropped by ${priceDrop.toFixed(2)}% to $${currentPrice}. Placing order...`);

        // Calculate quantity for investment
        let quantity = investment / currentPrice;
        quantity = adjustQuantity(quantity, stepSize, minQty);

        // Ensure quantity is valid
        if (quantity < minQty) {
          console.error(`Quantity (${quantity}) is below the minimum allowed (${minQty}). Skipping order.`);
          return;
        }

        // Place a spot order
        const buyOrder = await placeSpotOrder(symbol, 'BUY', quantity, currentPrice * 0.99); // 1% below current price
        console.log(`Buy order placed successfully. Order ID: ${buyOrder.orderId}`);

        // Track the buy order
        activeOrders.push({ orderId: buyOrder.orderId, quantity: buyOrder.quantity, price: currentPrice * 0.99 });
        console.log('Updating base price to current price...');
        basePrice = currentPrice;
      } else if (priceRise >= percentageRise) {
        console.log(`[INFO] Price rose by ${priceRise.toFixed(2)}% to $${currentPrice}. Updating base price...`);
        basePrice = currentPrice;
      } else {
        console.log(`Price drop of ${priceDrop.toFixed(2)}% or rise of ${priceRise.toFixed(2)}% does not meet the threshold.`);
      }
    } catch (error) {
      console.error('Error during monitoring:', error.message);
    }
  }, intervalMs);
}

// Start the bot
(async () => {
  // Get the symbol from the command line argument or default to 'DOGEUSDT'
  const symbol = process.argv[2] || 'DOGEUSDT';
  console.log(`[INFO] Using trading pair: ${symbol}`);

  const percentageDrop = 0.60; // Percentage drop to trigger an order
  const percentageRise = 1.2; // Percentage rise to update the base price
  const investment = 2; // $2 investment for each order
  const intervalMs = 2 * 60 * 1000; // Monitor price every 2 minutes

  await startGridBot(symbol, percentageDrop, percentageRise, investment, intervalMs);
})();

// const axios = require('axios');
// require('dotenv').config();
// const crypto = require('crypto');

// const API_KEY = process.env.BINANCE_API_KEY;
// const API_SECRET = process.env.BINANCE_API_SECRET;
// const BASE_URL = 'https://api.binance.us';

// // Generate HMAC SHA256 signature
// function generateSignature(queryString) {
//   return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
// }

// // Create a signed request
// async function makeRequest(endpoint, method, params = {}) {
//   const queryString = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
//   const signature = generateSignature(queryString);
//   const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

//   try {
//     const response = await axios({
//       method,
//       url,
//       headers: {
//         'X-MBX-APIKEY': API_KEY,
//       },
//     });
//     return response.data;
//   } catch (error) {
//     console.error('API Error:', error.response?.data || error.message);
//     throw error;
//   }
// }

// // Fetch current price
// async function getCurrentPrice(symbol) {
//   const url = `${BASE_URL}/api/v3/ticker/price`;

//   try {
//     const response = await axios.get(url, {
//       params: { symbol },
//     });
//     const price = parseFloat(response.data.price);
//     console.log(`[${new Date().toISOString()}] Current price of ${symbol}: $${price}`);
//     return price;
//   } catch (error) {
//     console.error('Error fetching price:', error.response?.data || error.message);
//     throw error;
//   }
// }

// // Fetch trading pair info (to get LOT_SIZE filters)
// async function getTradingPairInfo(symbol) {
//   const url = `${BASE_URL}/api/v3/exchangeInfo`;
//   const response = await axios.get(url);
//   const pair = response.data.symbols.find((s) => s.symbol === symbol);

//   const lotSize = pair.filters.find((f) => f.filterType === 'LOT_SIZE');
//   return {
//     minQty: parseFloat(lotSize.minQty),
//     maxQty: parseFloat(lotSize.maxQty),
//     stepSize: parseFloat(lotSize.stepSize),
//   };
// }

// // Adjust quantity to meet LOT_SIZE requirements
// function adjustQuantity(quantity, stepSize, minQty) {
//   let adjustedQuantity = Math.floor(quantity / stepSize) * stepSize;
//   if (adjustedQuantity < minQty) adjustedQuantity = minQty;
//   return adjustedQuantity;
// }

// // Place a LIMIT order (updated to return order details)
// async function placeSpotOrder(symbol, side, quantity, price) {
//   const params = {
//     symbol,
//     side,
//     type: 'LIMIT',
//     timeInForce: 'GTC',
//     quantity: quantity.toFixed(6),
//     price: price.toFixed(4),
//     recvWindow: 5000,
//   };

//   console.log('Placing order with params:', params);

//   const result = await makeRequest('/api/v3/order', 'POST', params);
//   return { orderId: result.orderId, quantity, price };
// }

// // Check order status
// async function checkOrderStatus(symbol, orderId) {
//   const params = {
//     symbol,
//     orderId,
//     recvWindow: 5000,
//     timestamp: Date.now(),
//   };

//   const queryString = new URLSearchParams(params).toString();
//   const signature = generateSignature(queryString);
//   const url = `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`;

//   try {
//     const response = await axios({
//       method: 'GET',
//       url,
//       headers: {
//         'X-MBX-APIKEY': API_KEY,
//       },
//     });
//     return response.data;
//   } catch (error) {
//     console.error('Error checking order status:', error.response?.data || error.message);
//     throw error;
//   }
// }

// // GridBot logic
// async function startGridBot(symbol, percentageDrop, percentageRise, investment, intervalMs) {
//   console.log(`Starting GridBot for ${symbol}. Monitoring for a price drop of ${percentageDrop}% and upward trend of ${percentageRise}%...\n`);

//   // Fetch LOT_SIZE info
//   const { minQty, stepSize } = await getTradingPairInfo(symbol);

//   // Fetch initial price and set it as base price
//   let basePrice = await getCurrentPrice(symbol);
//   console.log(`Base price set to $${basePrice}\n`);

//   // Track active orders
//   const activeOrders = [];

//   // Monitor price at intervals
//   setInterval(async () => {
//     try {
//       const currentPrice = await getCurrentPrice(symbol);
//       const priceDrop = ((basePrice - currentPrice) / basePrice) * 100;
//       const priceRise = ((currentPrice - basePrice) / basePrice) * 100;

//       // Check active buy orders
//       for (let i = activeOrders.length - 1; i >= 0; i--) {
//         const order = activeOrders[i];
//         const orderStatus = await checkOrderStatus(symbol, order.orderId);
//         if (orderStatus.status === 'FILLED') {
//           console.log(`[FILLED] Buy order ${order.orderId} filled for ${order.quantity} at price ${order.price}.`);

//           // Remove filled order from tracking
//           activeOrders.splice(i, 1);

//           // Calculate sell price (1.2% above filled price)
//           const sellPrice = order.price * 3.012;

//           // Place sell order
//           const sellOrder = await placeSpotOrder(symbol, 'SELL', order.quantity, sellPrice);
//           console.log(`[SELL ORDER PLACED] Order ID: ${sellOrder.orderId}, Quantity: ${sellOrder.quantity}, Sell Price: $${sellPrice.toFixed(4)}`);
//         }
//       }

//       if (priceDrop >= percentageDrop) {
//         console.log(`[ALERT] Price dropped by ${priceDrop.toFixed(2)}% to $${currentPrice}. Placing order...`);

//         // Calculate quantity for investment
//         let quantity = investment / currentPrice;
//         quantity = adjustQuantity(quantity, stepSize, minQty);

//         // Ensure quantity is valid
//         if (quantity < minQty) {
//           console.error(`Quantity (${quantity}) is below the minimum allowed (${minQty}). Skipping order.`);
//           return;
//         }

//         // Place a spot order
//         const buyOrder = await placeSpotOrder(symbol, 'BUY', quantity, currentPrice * 0.99); // 1% below current price
//         console.log(`Buy order placed successfully. Order ID: ${buyOrder.orderId}`);

//         // Track the buy order
//         activeOrders.push({ orderId: buyOrder.orderId, quantity: buyOrder.quantity, price: currentPrice * 0.99 });
//         console.log('Updating base price to current price...');
//         basePrice = currentPrice;
//       } else if (priceRise >= percentageRise) {
//         console.log(`[INFO] Price rose by ${priceRise.toFixed(2)}% to $${currentPrice}. Updating base price...`);
//         basePrice = currentPrice;
//       } else {
//         console.log(`Price drop of ${priceDrop.toFixed(2)}% or rise of ${priceRise.toFixed(2)}% does not meet the threshold.`);
//       }
//     } catch (error) {
//       console.error('Error during monitoring:', error.message);
//     }
//   }, intervalMs);
// }

// // Start the bot
// (async () => {
//   const symbol = 'DOGEUSDT'; // Trading pair for Dogecoin
//   const percentageDrop = 0.60; // Percentage drop to trigger an order
//   const percentageRise = 1.2; // Percentage rise to update the base price
//   const investment = 2; // $2 investment for each order
//   const intervalMs = 2 * 60 * 1000; // Monitor price every 2 minutes

//   await startGridBot(symbol, percentageDrop, percentageRise, investment, intervalMs);
// })();
