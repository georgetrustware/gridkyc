const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.BINANCE_API_KEY;
const BASE_URL = 'https://api.binance.us';

// Function to fetch the current price
async function getCurrentPrice(symbol) {
  const url = `${BASE_URL}/api/v3/ticker/price`;

  try {
    const response = await axios.get(url, {
      params: { symbol },
      headers: {
        'X-MBX-APIKEY': API_KEY,
      },
    });
    const price = parseFloat(response.data.price);
    console.log(`[${new Date().toISOString()}] Current price of ${symbol}: $${price}`);
    return price;
  } catch (error) {
    console.error('Error fetching price:', error.response?.data || error.message);
    throw error;
  }
}

// Function to monitor price
function startPriceMonitoring(symbol, intervalMs) {
  console.log(`Starting price monitoring for ${symbol} every ${intervalMs / 1000 / 60} minutes...\n`);
  
  // Fetch price immediately
  getCurrentPrice(symbol);

  // Set an interval to fetch price repeatedly
  setInterval(() => {
    getCurrentPrice(symbol);
  }, intervalMs);
}

// Start the monitoring
const symbol = 'BTCUSDT'; // Trading pair
const intervalMs = 2 * 60 * 1000; // 2 minutes in milliseconds

startPriceMonitoring(symbol, intervalMs);
