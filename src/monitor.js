// Import necessary Solana web3.js objects and database functions.
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAllWallets, getUsersForWallet } = require('./db/database');

// --- Configuration ---

// Solana RPC Endpoint: URL for connecting to a Solana node.
// Configurable via the `SOLANA_RPC_ENDPOINT` environment variable.
// Defaults to Solana's mainnet-beta public RPC if not set (same as in bot.js).
// TODO: Ensure SOLANA_RPC_ENDPOINT is documented in README. (Already done in previous step)
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const solanaConnection = new Connection(SOLANA_RPC_ENDPOINT); // Solana connection instance.

// In-memory store for the last processed signature for each wallet.
// Structure: { walletAddress: "lastSignatureString" }
// This helps in preventing duplicate notifications for the same transaction.
// On startup, this is populated with the latest signature for each tracked wallet to set a baseline.
const lastProcessedSignatures = {};

// Polling interval in milliseconds: How often to check for new transactions.
// Default is 60 seconds. This value can be adjusted based on desired responsiveness
// and considerations for RPC rate limits.
const POLLING_INTERVAL_MS = 60 * 1000; // 60 seconds

// Variable to hold the TelegramBot instance, initialized by `initMonitoring`.
// This allows this module to send messages via the bot.
let telegramBotInstance;

// --- Helper Functions ---

/**
 * Formats transaction information into a user-friendly, Markdown-formatted string for Telegram messages.
 * Displays key details like signature, timestamp, memo, status, SOL balance change, and a link to Solscan.
 * @param {string} walletAddress The wallet address for which the transaction occurred.
 * @param {import('@solana/web3.js').ConfirmedSignatureInfo} signatureInfo Basic info about the signature (timestamp, memo, error status).
 * @param {import('@solana/web3.js').ParsedTransactionWithMeta | null} transactionDetail Detailed parsed transaction data, including account balances.
 * @returns {string} A formatted message string in Russian, ready for Telegram.
 */
function formatTransactionMessage(walletAddress, signatureInfo, transactionDetail) {
  const { signature, blockTime, memo, err } = signatureInfo;
  const explorerLink = `https://solscan.io/tx/${signature}`; // Link to the transaction on Solscan.

  // Start building the message with Markdown.
  // Using backticks for monospaced font for wallet address and signature for better readability.
  let message = `🔔 *Новая транзакция по кошельку:* \`${walletAddress}\`\n\n`;
  message += `✍️ **Сигнатура:** [${signature.slice(0, 10)}...](${explorerLink})\n`; // Display first 10 chars of signature as link.

  if (blockTime) {
    // Convert Unix timestamp (seconds) to a human-readable date/time string in Russian locale.
    message += `⏱️ **Время:** ${new Date(blockTime * 1000).toLocaleString('ru-RU')}\n`;
  }

  if (memo) {
    message += `📝 **Заметка (Memo):** ${memo}\n`;
  }

  // Indicate transaction status (success or error).
  if (err) {
    message += `⚠️ **Статус:** Ошибка транзакции!\n`;
  } else {
    message += `✅ **Статус:** Успешно\n`;
  }

  // If detailed transaction info is available, try to extract more insights.
  if (transactionDetail) {
    const { meta, transaction } = transactionDetail;
    const preBalances = meta?.preBalances || [];   // Balances before the transaction.
    const postBalances = meta?.postBalances || []; // Balances after the transaction.
    // Get account public keys involved in the transaction as strings.
    const accountKeys = transaction.message.accountKeys.map(acc => acc.pubkey.toString());

    // Heuristic to find the change in SOL balance for the tracked wallet.
    // This finds the index of our tracked wallet in the transaction's account list.
    const primaryAccountIndex = accountKeys.indexOf(walletAddress);
    if (primaryAccountIndex !== -1 && preBalances.length > primaryAccountIndex && postBalances.length > primaryAccountIndex) {
      const solChange = (postBalances[primaryAccountIndex] - preBalances[primaryAccountIndex]) / LAMPORTS_PER_SOL;
      if (solChange !== 0) { // Only show SOL change if it's non-zero.
        message += `💰 **Изменение SOL:** ${solChange.toFixed(6)} SOL\n`;
      }
    }

    // Provide a simplified interpretation of instruction types.
    // This can be expanded with more known program IDs for better descriptions.
    if (transaction.message.instructions.length > 0) {
      const instructionTypes = transaction.message.instructions.map(instr => {
        const programId = instr.programId.toString();
        if (programId === '11111111111111111111111111111111') { // System Program
          return 'Системная операция';
        } else if (programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') { // SPL Token Program
          return 'Операция с токеном (SPL)';
        }
        return `Взаимодействие с программой (${programId.slice(0,6)}...)`; // Generic interaction
      }).join(', ');
      message += `📜 **Инструкции:** ${instructionTypes}\n`;
    } else {
      message += `ℹ️ **Тип:** Общая транзакция\n`; // Fallback if no specific instructions found
    }
  } else {
     message += `ℹ️ **Детали:** Не удалось получить полные детали транзакции.\n`; // If getParsedTransaction failed
  }

  message += `\n🔗 [Посмотреть на Solscan](${explorerLink})`;
  return message;
}


/**
 * Checks a single Solana wallet for new transactions since the last check.
 * If new transactions are found, it formats a message and triggers notifications
 * to all users tracking this wallet.
 * @param {string} walletAddress The public key of the Solana wallet to check.
 */
async function checkWalletForTransactions(walletAddress) {
  console.log(`[Monitor] Checking wallet: ${walletAddress}`);
  try {
    const publicKey = new PublicKey(walletAddress);
    // Fetch recent transaction signatures for the address. Limit can be adjusted.
    // `getSignaturesForAddress` returns signatures in reverse chronological order (newest first).
    const signatures = await solanaConnection.getSignaturesForAddress(publicKey, { limit: 15 });

    // If no transactions are found for the wallet at all.
    if (signatures.length === 0) {
      // If this is the first time checking this wallet (it's not in `lastProcessedSignatures`),
      // mark it as checked (null means no transactions found yet).
      if (lastProcessedSignatures[walletAddress] === undefined) {
        lastProcessedSignatures[walletAddress] = null;
        console.log(`[Monitor] No transactions found for ${walletAddress} on initial check. Baseline set to null.`);
      }
      return; // No transactions to process.
    }

    const currentLatestSignatureInChain = signatures[0].signature;

    // If this is the very first time we're seeing this wallet (e.g., after bot restart and this wallet
    // was added while bot was down, or a new wallet added by a user).
    // Set the baseline to the newest signature found and do not notify for past transactions.
    // `undefined` indicates it's not yet in our `lastProcessedSignatures` map.
    if (lastProcessedSignatures[walletAddress] === undefined) {
      lastProcessedSignatures[walletAddress] = currentLatestSignatureInChain;
      console.log(`[Monitor] Initialized baseline for ${walletAddress} to signature ${currentLatestSignatureInChain}. Subsequent transactions will be notified.`);
      return; // Avoid notifying for all historical transactions on first sight.
    }

    let newSignaturesToNotify = [];
    // Iterate through fetched signatures to find ones newer than the last processed one.
    for (const sigInfo of signatures) {
      // If we encounter the signature that was last processed for this wallet,
      // all subsequent signatures in the `signatures` array (which are older) have been processed.
      if (sigInfo.signature === lastProcessedSignatures[walletAddress]) {
        break;
      }
      newSignaturesToNotify.push(sigInfo); // This signature is new.
    }

    if (newSignaturesToNotify.length > 0) {
      // Signatures are currently newest first. Reverse to process oldest new transaction first,
      // ensuring `lastProcessedSignatures` is updated sequentially.
      newSignaturesToNotify.reverse();

      for (const sigInfo of newSignaturesToNotify) {
        console.log(`[Monitor] New transaction detected for ${walletAddress}: ${sigInfo.signature}`);
        let transactionDetail = null;
        try {
          // Fetch detailed transaction info for richer notifications.
          // `maxSupportedTransactionVersion: 0` is often needed for compatibility with parsed transactions.
          transactionDetail = await solanaConnection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        } catch (txError) {
          console.error(`[Monitor] Error fetching full transaction details for ${sigInfo.signature}:`, txError.message);
          // Proceed to notify even if full details couldn't be fetched.
        }

        const message = formatTransactionMessage(walletAddress, sigInfo, transactionDetail);
        const userIds = await getUsersForWallet(walletAddress); // Get all users tracking this wallet.

        if (telegramBotInstance && userIds.length > 0) {
          userIds.forEach(userId => {
            telegramBotInstance.sendMessage(userId, message, { parse_mode: 'Markdown', disable_web_page_preview: true })
              .catch(err => console.error(`[Monitor] Failed to send notification to user ${userId} for wallet ${walletAddress}, signature ${sigInfo.signature}:`, err.message));
          });
        }
      }
      // After processing all new transactions in this batch, update the last processed signature
      // to the newest one from this batch (which is the last element after reversing).
      lastProcessedSignatures[walletAddress] = newSignaturesToNotify[newSignaturesToNotify.length - 1].signature;
    } else {
      // No new signatures found.
      // If `lastProcessedSignatures[walletAddress]` was `null` (meaning no tx previously found),
      // and now we *do* have signatures, update it to the latest one. This handles the case where a wallet
      // had no transactions on its first check, but now has some.
      if (lastProcessedSignatures[walletAddress] === null && signatures.length > 0) {
         lastProcessedSignatures[walletAddress] = currentLatestSignatureInChain;
      }
    }
  } catch (error) {
    // Catch errors from `getSignaturesForAddress` or other general errors within this function.
    console.error(`[Monitor] Error processing wallet ${walletAddress}:`, error.message);
    if (error.message && (error.message.includes("429 Too Many Requests") || error.message.includes("rate limited"))) {
      console.warn(`[Monitor] Rate limited while checking wallet ${walletAddress}. Consider increasing POLLING_INTERVAL_MS or reducing wallets per cycle.`);
    }
    // Depending on the error, one might implement more sophisticated retry logic
    // or temporary suspension of monitoring for this specific wallet.
  }
}

/**
 * The main monitoring cycle.
 * Fetches all unique wallets from the database and checks each for new transactions.
 * This function is intended to be called periodically by `setInterval`.
 */
async function runMonitoringCycle() {
  console.log('[Monitor] Starting new monitoring cycle...');
  try {
    const wallets = await getAllWallets(); // Fetch all unique wallet addresses from the DB.
    if (wallets.length === 0) {
      // console.log('[Monitor] No wallets in the database to monitor currently.'); // Can be verbose, commented out.
      return; // No wallets to monitor.
    }

    console.log(`[Monitor] Starting monitoring cycle for ${wallets.length} unique wallet(s).`);
    for (const walletAddress of wallets) {
      try {
        await checkWalletForTransactions(walletAddress);
        // Introduce a small delay between checking each wallet to stagger RPC requests,
        // helping to avoid hitting rate limits if monitoring many wallets.
        await new Promise(resolve => setTimeout(resolve, 300)); // 300ms delay.
      } catch (loopError) {
        // This catch is primarily for unexpected errors not caught within checkWalletForTransactions itself.
        console.error(`[Monitor] Unhandled error in monitoring loop for wallet ${walletAddress}:`, loopError.message);
      }
    }
  } catch (error) {
    // Errors from `getAllWallets` or other general setup issues before the loop.
    console.error('[Monitor] Critical error in runMonitoringCycle setup:', error);
  }
  // console.log('[Monitor] Monitoring cycle finished.'); // Can be verbose, commented out.
}

/**
 * Initializes and starts the transaction monitoring service.
 * This function should be called once when the bot starts.
 * It sets up the baseline for last processed signatures and starts the polling interval.
 * @param {import('node-telegram-bot-api')} botInstance The initialized Telegram bot instance, used for sending messages.
 */
function initMonitoring(botInstance) {
  if (!botInstance) {
    console.error('[Monitor] Telegram Bot instance is required for monitoring! Notifications will not be sent.');
    return;
  }
  telegramBotInstance = botInstance; // Store the bot instance for use in sending messages.
  console.log('[Monitor] Initializing transaction monitoring service...');

  // Initial population of `lastProcessedSignatures` for all wallets already in the database.
  // This crucial step establishes a "baseline" for each wallet by fetching its most recent transaction signature.
  // Transactions older than this baseline will not trigger notifications, preventing a flood of old transaction
  // notifications when the bot starts or restarts.
  getAllWallets()
    .then(wallets => {
      if (wallets.length > 0) {
        console.log(`[Monitor] Pre-fetching latest signatures for ${wallets.length} wallet(s) to establish baseline...`);
        // Create an array of promises, one for each wallet, to fetch its latest signature.
        const baselinePromises = wallets.map(async (walletAddress) => {
          try {
            const publicKey = new PublicKey(walletAddress);
            // Fetch only the single latest signature to set as the baseline.
            const signatures = await solanaConnection.getSignaturesForAddress(publicKey, { limit: 1 });
            if (signatures.length > 0) {
              lastProcessedSignatures[walletAddress] = signatures[0].signature;
              // console.log(`[Monitor] Baseline for ${walletAddress} set to: ${signatures[0].signature}`); // Verbose
            } else {
              // If a wallet has no transactions, its baseline is `null`.
              lastProcessedSignatures[walletAddress] = null;
              // console.log(`[Monitor] No transactions found for ${walletAddress}, baseline set to null.`); // Verbose
            }
          } catch (err) {
            console.error(`[Monitor] Error pre-fetching signature for ${walletAddress} during init:`, err.message);
            // If an error occurs (e.g., RPC issue), set baseline to `null`.
            // The wallet will be processed normally in subsequent cycles.
            lastProcessedSignatures[walletAddress] = null;
          }
        });
        // Wait for all baseline fetches to complete.
        return Promise.all(baselinePromises);
      }
      return Promise.resolve(); // No wallets to process.
    })
    .then(() => {
      console.log('[Monitor] Baseline signatures established. Starting polling.');
      // Start the periodic monitoring cycle.
      setInterval(runMonitoringCycle, POLLING_INTERVAL_MS);
      // Optionally, run one cycle immediately after initialization to catch up quickly.
      runMonitoringCycle();
    })
    .catch(err => {
      // This catches errors from the initial `getAllWallets` call or critical errors in Promise.all setup.
      console.error('[Monitor] Critical error during monitoring initialization (fetching all wallets):', err);
      // Even if baseline establishment fails, attempt to start polling.
      // New wallets added later will still get their baselines set correctly.
      console.warn('[Monitor] Polling will start, but initial baseline might be incomplete due to error.');
      setInterval(runMonitoringCycle, POLLING_INTERVAL_MS);
    });

  console.log(`[Monitor] Transaction monitoring initialized. Polling every ${POLLING_INTERVAL_MS / 1000} seconds. RPC Endpoint: ${SOLANA_RPC_ENDPOINT}`);
}

// Export the `initMonitoring` function to be called from the main bot script.
module.exports = {
  initMonitoring,
};
