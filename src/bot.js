const TelegramBot = require('node-telegram-bot-api');
// Import necessary modules
const TelegramBot = require('node-telegram-bot-api');
const { addWallet, removeWallet, getUserWallets } = require('./db/database'); // Database interaction functions
const { Connection, PublicKey } = require('@solana/web3.js'); // Solana web3 library
const { initMonitoring } = require('./monitor'); // Transaction monitoring service

// --- Configuration ---

// Telegram Bot Token: Acquired from BotFather on Telegram.
// It's crucial to use an environment variable for the token in a real deployment
// to avoid hardcoding sensitive information.
const token = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_PLACEHOLDER';

// Warn if using the placeholder token, as this will not work in production.
if (token === 'YOUR_TELEGRAM_BOT_TOKEN_PLACEHOLDER') {
  console.warn("[Bot] Warning: Using a placeholder Telegram Bot Token. Please set the TELEGRAM_BOT_TOKEN environment variable for the bot to function.");
}

// Initialize the Telegram Bot
// `polling: true` fetches updates from Telegram servers.
const bot = new TelegramBot(token, { polling: true });

// Solana RPC Endpoint: URL for connecting to a Solana node.
// This can be a public endpoint or your own private node.
// Configurable via the `SOLANA_RPC_ENDPOINT` environment variable.
// Defaults to Solana's mainnet-beta public RPC if not set.
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const solanaConnection = new Connection(SOLANA_RPC_ENDPOINT); // Solana connection instance

// In-memory state to track users who are currently in the process of adding a wallet.
// This set stores `userId`s that have clicked "Add Wallet" and are expected to send an address next.
const expectingWalletAddress = new Set();

// --- Helper Functions ---

/**
 * Validates if a given string is a syntactically correct Solana public key.
 * A Solana address is a Base58 encoded string, typically 32-44 characters long.
 * This function checks length, attempts to create a PublicKey, and verifies if it's on the Ed25519 curve.
 * @param {string} address The potential Solana wallet address string.
 * @returns {Promise<boolean>} True if the address is a valid Solana public key, false otherwise.
 */
async function isValidSolanaAddress(address) {
  if (!address || typeof address !== 'string') {
    return false; // Basic check for null, undefined, or non-string input
  }
  const trimmedAddress = address.trim(); // Remove leading/trailing whitespace
  // Solana addresses are typically between 32 and 44 characters long.
  if (trimmedAddress.length < 32 || trimmedAddress.length > 44) {
    return false;
  }
  try {
    // Attempt to create a PublicKey object. This will throw an error for invalid Base58 strings.
    const publicKey = new PublicKey(trimmedAddress);
    // Check if the public key is on the Ed25519 curve (standard for Solana addresses).
    // While `getAccountInfo` would be a more definitive check (does the account exist & have lamports/data),
    // `isOnCurve` is a good syntactic check without needing an async RPC call for simple validation.
    return PublicKey.isOnCurve(publicKey.toBuffer());
  } catch (error) {
    // Log the validation error for debugging, but return false to the caller.
    console.warn(`[Bot] Solana address validation error for address "${trimmedAddress}":`, error.message);
    return false;
  }
}

// --- User-Facing Messages & Constants ---

// Generic error message shown to users in Russian when an unexpected issue occurs.
const USER_ERROR_MESSAGE = "Произошла ошибка. Пожалуйста, попробуйте позже. 😔";

// --- Command Handlers ---

/**
 * Handles the /start command.
 * Sends a welcome message and an inline keyboard with options to add or remove wallets.
 * @param {TelegramBot.Message} msg The incoming message object from Telegram.
 */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  try {
    const welcomeMessage = `Добро пожаловать в Solana Wallet Tracker Bot! 🤖
Я помогу вам отслеживать ваши кошельки Solana.

Используйте кнопки ниже для управления кошельками:
- ➕ Добавить кошелек: Для начала отслеживания нового кошелька Solana.
- ➖ Удалить кошелек: Для прекращения отслеживания кошелька.
- /mywallets: Посмотреть ваши отслеживаемые кошельки.`;

    bot.sendMessage(chatId, welcomeMessage, {
      reply_markup: {
        inline_keyboard: [ // Defines the inline keyboard structure
          [{ text: '➕ Добавить кошелек', callback_data: 'add_wallet_prompt' }],
          [{ text: '➖ Удалить кошелек', callback_data: 'remove_wallet_prompt' }],
        ],
      },
    }).catch(err => console.error('[Bot] Error sending /start message:', err.message));
  } catch (error) {
    console.error('[Bot] Critical error in /start handler:', error);
    bot.sendMessage(chatId, USER_ERROR_MESSAGE).catch(err => console.error('[Bot] Error sending error message for /start:', err.message));
  }
});

/**
 * Handles callback queries from inline keyboard interactions.
 * Differentiates actions based on `callback_data`.
 * - `add_wallet_prompt`: Prompts the user to send a wallet address.
 * - `remove_wallet_prompt`: Shows a list of wallets to remove.
 * - `remove_wallet_[ADDRESS]`: Removes the specified wallet.
 * - `cancel_remove`: Cancels the wallet removal process.
 * @param {TelegramBot.CallbackQuery} callbackQuery The incoming callback query object.
 */
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;    // Original message the keyboard was attached to.
  const userId = callbackQuery.from.id; // User who interacted with the keyboard.
  const chatId = msg.chat.id;           // Chat where the interaction happened.
  const data = callbackQuery.data;      // `callback_data` string from the button.

  try {
    if (data === 'add_wallet_prompt') {
      // User wants to add a wallet. Set state to expect an address.
      expectingWalletAddress.add(userId);
      bot.sendMessage(chatId, 'Пожалуйста, отправьте адрес кошелька Solana, который вы хотите отслеживать.').catch(err => console.error('[Bot] Error sending add_wallet_prompt message:', err.message));
      bot.answerCallbackQuery(callbackQuery.id).catch(err => console.error('[Bot] Error answering add_wallet_prompt callbackQuery:', err.message));
    } else if (data === 'remove_wallet_prompt') {
      // User wants to remove a wallet. Fetch their wallets and display them as buttons.
      const userWallets = await getUserWallets(userId);
      if (userWallets.length === 0) {
        bot.sendMessage(chatId, 'У вас нет кошельков для удаления.').catch(err => console.error('[Bot] Error sending no wallets to remove message:', err.message));
      } else {
        // Create an inline button for each wallet.
        const walletButtons = userWallets.map(wallet => ([{
          text: wallet, // Display the wallet address on the button
          callback_data: `remove_wallet_${wallet}`, // Data includes the address to remove
        }]));
        // Add a "Cancel" button.
        walletButtons.push([{ text: '❌ Отмена', callback_data: 'cancel_remove' }]);

        bot.sendMessage(chatId, 'Выберите кошелек для удаления:', {
          reply_markup: {
            inline_keyboard: walletButtons,
          },
        }).catch(err => console.error('[Bot] Error sending remove_wallet_prompt selection message:', err.message));
      }
      bot.answerCallbackQuery(callbackQuery.id).catch(err => console.error('[Bot] Error answering remove_wallet_prompt callbackQuery:', err.message));
    } else if (data.startsWith('remove_wallet_')) {
      // User selected a specific wallet to remove.
      const walletAddressToRemove = data.substring('remove_wallet_'.length);
      const removed = await removeWallet(userId, walletAddressToRemove); // Attempt to remove from DB
      if (removed) {
        bot.editMessageText(`Кошелек ${walletAddressToRemove} успешно удален!`, {
          chat_id: chatId,
          message_id: msg.message_id, // Edit the original message
          reply_markup: null // Remove the inline keyboard
        }).catch(err => console.error('[Bot] Error editing message for successful wallet removal:', err.message));
      } else {
        bot.editMessageText(`Не удалось удалить кошелек ${walletAddressToRemove}. Возможно, он уже был удален или не найден.`, {
          chat_id: chatId,
          message_id: msg.message_id,
          reply_markup: null
        }).catch(err => console.error('[Bot] Error editing message for failed wallet removal:', err.message));
      }
      bot.answerCallbackQuery(callbackQuery.id).catch(err => console.error('[Bot] Error answering remove_wallet_ wallet callbackQuery:', err.message));
    } else if (data === 'cancel_remove') {
      // User cancelled the removal process.
      bot.editMessageText('Удаление кошелька отменено.', {
          chat_id: chatId,
          message_id: msg.message_id,
          reply_markup: null // Remove the inline keyboard
      }).catch(err => console.error('[Bot] Error editing message for cancel_remove:', err.message));
      bot.answerCallbackQuery(callbackQuery.id).catch(err => console.error('[Bot] Error answering cancel_remove callbackQuery:', err.message));
    }
  } catch (error) {
    console.error('[Bot] Error in callback_query handler:', error);
    bot.sendMessage(chatId, USER_ERROR_MESSAGE).catch(err => console.error('[Bot] Error sending error message for callback_query:', err.message));
    // Attempt to answer callback query even on error to dismiss loading animation on client.
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Произошла ошибка' }).catch(err => console.error('[Bot] Error answering callbackQuery on error:', err.message));
  }
});


/**
 * Handles generic text messages.
 * If a user is expected to send a wallet address (after 'add_wallet_prompt'),
 * this handler will process the received text as a potential Solana wallet address.
 * @param {TelegramBot.Message} msg The incoming message object.
 */
bot.on('message', async (msg) => {
  // Ignore messages that are not from a user (e.g., service messages, channel posts if bot is in a channel).
  if (!msg.from || !msg.chat) {
    return;
  }
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text;

  // Ignore commands (e.g., /start, /mywallets) in this handler, as they have dedicated handlers.
  if (text && text.startsWith('/')) {
    return;
  }

  // Check if this user is in the 'expectingWalletAddress' state.
  if (expectingWalletAddress.has(userId)) {
    try {
      const potentialAddress = text.trim(); // Trim whitespace from user input.
      const isValid = await isValidSolanaAddress(potentialAddress);

      if (isValid) {
        const added = await addWallet(userId, potentialAddress); // Attempt to add to DB
        if (added) {
          bot.sendMessage(chatId, `✅ Кошелек ${potentialAddress} успешно добавлен!`).catch(err => console.error('[Bot] Error sending success message for wallet add:', err.message));
        } else {
          // Wallet was not added, likely because it's already in the DB for this user.
          bot.sendMessage(chatId, `⚠️ Кошелек ${potentialAddress} уже отслеживается или произошла ошибка при добавлении.`).catch(err => console.error('[Bot] Error sending already_added/error message for wallet add:', err.message));
        }
      } else {
        // Address is not valid.
        bot.sendMessage(chatId, '❌ Неверный адрес кошелька Solana. Пожалуйста, предоставьте действительный адрес (обычно 32-44 символа, в кодировке base58).').catch(err => console.error('[Bot] Error sending invalid address message:', err.message));
      }
    } catch (error) {
      console.error('[Bot] Error processing wallet address message:', error);
      bot.sendMessage(chatId, USER_ERROR_MESSAGE).catch(err => console.error('[Bot] Error sending error message for wallet processing:', err.message));
    } finally {
      // Always remove user from the 'expecting' state, whether successful or not,
      // to prevent subsequent messages from being misinterpreted as wallet addresses.
      expectingWalletAddress.delete(userId);
    }
  }
  // If not expecting a wallet address, non-command messages are currently ignored.
});

/**
 * Handles the /mywallets command.
 * Fetches and displays the list of wallets currently tracked by the user.
 * @param {TelegramBot.Message} msg The incoming message object.
 */
bot.onText(/\/mywallets/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  try {
    const wallets = await getUserWallets(userId); // Fetch from DB
    if (wallets.length === 0) {
      bot.sendMessage(chatId, 'Вы еще не отслеживаете ни одного кошелька. Используйте "➕ Добавить кошелек", чтобы начать.').catch(err => console.error('[Bot] Error sending no wallets message for /mywallets:', err.message));
    } else {
      let messageText = 'Ваши отслеживаемые кошельки Solana:\n';
      // Format each wallet address on a new line, numbered, using Markdown for monospaced font.
      wallets.forEach((wallet, index) => {
        messageText += `${index + 1}. \`${wallet}\`\n`;
      });
      bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' }).catch(err => console.error('[Bot] Error sending wallets list for /mywallets:', err.message));
    }
  } catch (error) {
    console.error('[Bot] Error in /mywallets handler:', error);
    bot.sendMessage(chatId, USER_ERROR_MESSAGE).catch(err => console.error('[Bot] Error sending error message for /mywallets:', err.message));
  }
});

// --- Bot Error Handling & Startup ---

// Listen for polling errors (e.g., network issues, Telegram API issues).
bot.on('polling_error', (error) => {
  console.error(`[Bot] Polling error: ${error.code} - ${error.message}`);
  // More sophisticated error handling could be added here, e.g., re-initializing the bot
  // or notifying an administrator, depending on the error type.
});

// Listen for webhook errors (if using webhooks instead of polling).
bot.on('webhook_error', (error) => {
  console.error(`[Bot] Webhook error: ${error.code} - ${error.message}`);
});

// Log that the bot has started.
console.log('[Bot] Solana Wallet Tracker Bot started...');

// Initialize and start the transaction monitoring service, passing the bot instance.
// This allows the monitor to send messages via this bot.
initMonitoring(bot);

// Optional: Keep the process alive.
// This is not strictly necessary when using `polling: true`, as the polling loop keeps the process alive.
// However, it might be useful in some environments or if other asynchronous tasks are added.
// process.stdin.resume();
