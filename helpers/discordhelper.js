const { 
  Client, 
  GatewayIntentBits, 
  ButtonBuilder, 
  ActionRowBuilder, 
  ButtonStyle, 
  PermissionsBitField, 
  Events 
} = require('discord.js');

// Load environment variables
require('dotenv').config();
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TRADING_CATEGORY_ID = process.env.TRADING_CATEGORY_ID;

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Store user trading data (API credentials and active trading sessions) in memory
const userTradingData = new Map();

/**
 * Send a message to a specific channel.
 * @param {object} channel - The Discord channel object.
 * @param {string} message - The message to send.
 */
function sendMessageToChannel(channel, message) {
  channel.send(message);
}

/**
 * Check message history for API credentials.
 * @param {object} guild - The Discord guild object.
 */
async function loadApiKeysFromHistory(guild) {
  try {
    const channels = await guild.channels.fetch();

    for (const [channelId, channel] of channels) {
      if (channel.type === 0 && channel.name.startsWith('grid-trading')) {
        const messages = await channel.messages.fetch({ limit: 50 });
        
        messages.forEach((message) => {
          if (message.content.startsWith('!setapikey')) {
            const [_, apiKey, apiSecret] = message.content.split(' ');

            if (apiKey && apiSecret) {
              userTradingData.set(message.author.id, { apiKey, apiSecret });
              console.log(`Loaded API credentials for user ${message.author.username} from message history.`);
            }
          }
        });
      }
    }
  } catch (error) {
    console.error(`Error loading API keys from history: ${error.message}`);
  }
}

/**
 * Initialize the Discord bot and handle interactions.
 * @param {function} startGridBot - The function to start the grid trading bot.
 */
function initializeDiscordBot(startGridBot) {
  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const guild = await client.guilds.fetch(GUILD_ID);
    await loadApiKeysFromHistory(guild);
  });

  // Event: Handle button interactions for creating private channels
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'create_private_channel') {
      const guild = interaction.guild;
      const user = interaction.user;

      try {
        // Create a private channel for the user
        const channel = await guild.channels.create({
          name: `grid-trading-${user.username}`,
          parent: TRADING_CATEGORY_ID,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          ],
        });

        await interaction.reply({ content: `Private channel created: ${channel}`, ephemeral: true });
        await channel.send('Please provide your Binance API key and secret using `!setapikey <api_key> <api_secret>`.');
      } catch (error) {
        console.error(`Error creating private channel: ${error.message}`);
        await interaction.reply({ content: 'Error creating private channel. Please try again.', ephemeral: true });
      }
    }
  });

  // Event: Handle messages for setting API keys and starting the grid bot
  client.on('messageCreate', async (message) => {
    if (message.content.startsWith('!setapikey')) {
      const [_, apiKey, apiSecret] = message.content.split(' ');

      if (!apiKey || !apiSecret) {
        message.reply('Usage: `!setapikey <api_key> <api_secret>`');
        return;
      }

      userTradingData.set(message.author.id, { apiKey, apiSecret });
      message.reply('API credentials set successfully. Now set the trading pair with `!setpair <symbol>`.');
    }

    if (message.content.startsWith('!setpair')) {
      const [_, symbol] = message.content.split(' ');
      const userData = userTradingData.get(message.author.id);

      if (!userData) {
        message.reply('Set your API credentials first using `!setapikey <api_key> <api_secret>`.');
        return;
      }

      message.reply(`Trading pair set to ${symbol}. Starting the GridBot...`);
      await startGridBot(userData.apiKey, userData.apiSecret, symbol, message.channel);
    }
  });

  // Log in to Discord
  client.login(DISCORD_BOT_TOKEN);
}

// Export the helper functions
module.exports = {
  initializeDiscordBot,
  sendMessageToChannel,
};
