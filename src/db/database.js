const sqlite3 = require('sqlite3').verbose();
const path = path = require('path'); // Corrected: path = require('path')

// Define the path for the database file.
// It's placed in the same directory as this script.
const dbPath = path.resolve(__dirname, 'bot_data.db');

// Initialize the database connection.
// The database is a single file (`bot_data.db`).
// sqlite3.Database will create the file if it doesn't exist upon first write.
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[DB] Error opening database:', err.message);
    // If the database cannot be opened, the bot might not function correctly.
    // Further error handling (e.g., exiting the process) could be added here if critical.
  } else {
    console.log('[DB] Connected to the SQLite database.');
    // Create tables if they don't exist upon successful connection.
    createTable();
  }
});

/**
 * Creates the `user_wallets` table if it doesn't already exist.
 * This table stores the mapping between Telegram user IDs and the Solana wallet addresses they are tracking.
 * - `user_id`: The Telegram user's unique ID.
 * - `wallet_address`: The Solana wallet address (base58 encoded string).
 * A composite primary key on (user_id, wallet_address) ensures that a user cannot track the same wallet multiple times.
 */
function createTable() {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS user_wallets (
      user_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      PRIMARY KEY (user_id, wallet_address)
    );
  `;
  db.run(createTableSql, (err) => {
    if (err) {
      console.error('[DB] Error creating table "user_wallets":', err.message);
    } else {
      console.log('[DB] Table "user_wallets" created or already exists.');
    }
  });
}

/**
 * Adds a new wallet address to be tracked for a given user.
 * @param {number} userId The Telegram user's ID.
 * @param {string} walletAddress The Solana wallet address to track.
 * @returns {Promise<boolean>} A promise that resolves to `true` if the wallet was added successfully,
 *                             or `false` if the wallet was already being tracked by the user.
 *                             Rejects on database error.
 */
function addWallet(userId, walletAddress) {
  return new Promise((resolve, reject) => {
    const insertSql = 'INSERT INTO user_wallets (user_id, wallet_address) VALUES (?, ?)';
    db.run(insertSql, [userId, walletAddress], function(err) { // `this` context is important here for `lastID`, `changes`
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          // This is an expected case: the user is trying to add a wallet they already track.
          console.log(`[DB] Wallet ${walletAddress} already exists for user ${userId}.`);
          resolve(false); // Indicate that the wallet was not added because it's a duplicate for this user.
        } else {
          console.error(`[DB] Error adding wallet for user ${userId}, wallet ${walletAddress}:`, err.message);
          reject(err); // Propagate other database errors.
        }
      } else {
        console.log(`[DB] Wallet ${walletAddress} added for user ${userId}.`);
        resolve(true); // Wallet added successfully.
      }
    });
  });
}

/**
 * Removes a tracked wallet address for a given user.
 * @param {number} userId The Telegram user's ID.
 * @param {string} walletAddress The Solana wallet address to stop tracking.
 * @returns {Promise<boolean>} A promise that resolves to `true` if the wallet was successfully removed,
 *                             or `false` if the wallet was not found for that user.
 *                             Rejects on database error.
 */
function removeWallet(userId, walletAddress) {
  return new Promise((resolve, reject) => {
    const deleteSql = 'DELETE FROM user_wallets WHERE user_id = ? AND wallet_address = ?';
    db.run(deleteSql, [userId, walletAddress], function(err) { // `this` context for `changes`
      if (err) {
        console.error(`[DB] Error removing wallet ${walletAddress} for user ${userId}:`, err.message);
        reject(err);
      } else {
        if (this.changes > 0) {
          console.log(`[DB] Wallet ${walletAddress} removed for user ${userId}.`);
          resolve(true); // Wallet successfully removed.
        } else {
          // This means the DELETE query executed but didn't affect any rows.
          console.log(`[DB] Wallet ${walletAddress} not found for user ${userId} during removal attempt.`);
          resolve(false); // Wallet not found for this user.
        }
      }
    });
  });
}

/**
 * Retrieves all wallet addresses tracked by a specific user.
 * @param {number} userId The Telegram user's ID.
 * @returns {Promise<string[]>} A promise that resolves to an array of wallet address strings.
 *                              Rejects on database error.
 */
function getUserWallets(userId) {
  return new Promise((resolve, reject) => {
    const selectSql = 'SELECT wallet_address FROM user_wallets WHERE user_id = ?';
    db.all(selectSql, [userId], (err, rows) => {
      if (err) {
        console.error(`[DB] Error fetching wallets for user ${userId}:`, err.message);
        reject(err);
      } else {
        // `rows` is an array of objects, e.g., [{ wallet_address: '...' }, ...].
        // We need to map it to an array of strings.
        const wallets = rows.map(row => row.wallet_address);
        resolve(wallets);
      }
    });
  });
}

// Module exports: making the db instance and functions available to other parts of the application.
module.exports = {
  db, // Exporting the database connection instance (rarely needed directly by other modules)
  addWallet,
  removeWallet,
  getUserWallets,
  getAllWallets,
  getUsersForWallet,
};

/**
 * Retrieves all unique wallet addresses currently being tracked by any user.
 * This is used by the monitor service to know which wallets to check for transactions.
 * @returns {Promise<string[]>} A promise that resolves to an array of unique wallet address strings.
 *                              Rejects on database error.
 */
function getAllWallets() {
  return new Promise((resolve, reject) => {
    const selectSql = 'SELECT DISTINCT wallet_address FROM user_wallets';
    db.all(selectSql, [], (err, rows) => {
      if (err) {
        console.error('[DB] Error fetching all unique wallets:', err.message);
        reject(err);
      } else {
        const wallets = rows.map(row => row.wallet_address);
        resolve(wallets);
      }
    });
  });
}

/**
 * Retrieves all Telegram user IDs that are tracking a specific wallet address.
 * This is used by the monitor service to send notifications to the correct users.
 * @param {string} walletAddress The Solana wallet address.
 * @returns {Promise<number[]>} A promise that resolves to an array of user IDs.
 *                             Rejects on database error.
 */
function getUsersForWallet(walletAddress) {
  return new Promise((resolve, reject) => {
    const selectSql = 'SELECT user_id FROM user_wallets WHERE wallet_address = ?';
    db.all(selectSql, [walletAddress], (err, rows) => {
      if (err) {
        console.error(`[DB] Error fetching users for wallet ${walletAddress}:`, err.message);
        reject(err);
      } else {
        const userIds = rows.map(row => row.user_id);
        resolve(userIds);
      }
    });
  });
}
