# Solana Wallet Tracker Telegram Bot - Manual Testing Plan

This document outlines the manual testing steps to ensure the Solana Wallet Tracker Telegram Bot functions as expected.

**Pre-requisites:**
*   Telegram account(s).
*   A valid Telegram Bot Token.
*   Access to a Solana RPC endpoint (either default mainnet-beta or a custom one).
*   A Solana wallet (or multiple) that can be used for sending/receiving transactions on the chosen network.
*   The bot application deployed and configured.

---

**I. Setup & Basic Commands**

1.  **Bot Startup:**
    *   **Test Case 1.1.1 (Correct Configuration):**
        *   **Action:** Configure `.env` with a valid `TELEGRAM_BOT_TOKEN`. Optionally, set `SOLANA_RPC_ENDPOINT`. Start the bot (e.g., `node src/bot.js`).
        *   **Expected Result:** The bot starts without any critical error messages in the console. Console logs show `[Bot] Solana Wallet Tracker Bot started...` and `[Monitor] Transaction monitoring initialized. Polling every X seconds...`.
    *   **Test Case 1.1.2 (Missing Token):**
        *   **Action:** Start the bot without `TELEGRAM_BOT_TOKEN` set or with an empty value.
        *   **Expected Result:** The bot should log an error related to the missing token and likely fail to start or connect to Telegram. (Exact behavior depends on `node-telegram-bot-api` handling).

2.  **`/start` Command:**
    *   **Test Case 1.2.1 (Send /start):**
        *   **Action:** In Telegram, send the `/start` command to your bot.
        *   **Expected Result:**
            *   The bot replies with the welcome message in Russian.
            *   The message includes two inline buttons: "➕ Добавить кошелек" and "➖ Удалить кошелек".

---

**II. Wallet Management**

1.  **Add Wallet - Happy Path:**
    *   **Test Case 2.1.1:**
        *   **Action:**
            1.  Click the "➕ Добавить кошелек" button (from `/start` or by itself).
            2.  Verify the bot responds with "Пожалуйста, отправьте адрес кошелька Solana, который вы хотите отслеживать."
            3.  Send a known valid Solana wallet address (e.g., `So11111111111111111111111111111111111111112`).
        *   **Expected Result:**
            *   The bot replies with a success message like "✅ Кошелек `[ADDRESS]` успешно добавлен!".
            *   Send `/mywallets`. The newly added wallet should be listed.

2.  **Add Wallet - Invalid Address:**
    *   **Test Case 2.2.1 (Too Short):**
        *   **Action:** Click "➕ Добавить кошелек", then send an invalid address (e.g., `123`).
        *   **Expected Result:** Bot replies with "❌ Неверный адрес кошелька Solana. Пожалуйста, предоставьте действительный адрес (обычно 32-44 символа, в кодировке base58)."
    *   **Test Case 2.2.2 (Incorrect Characters):**
        *   **Action:** Click "➕ Добавить кошелек", then send an invalid address (e.g., `ThisIsNotASolanaAddress!`).
        *   **Expected Result:** Same error message as above.

3.  **Add Wallet - Already Added:**
    *   **Test Case 2.3.1:**
        *   **Action:**
            1.  Add a valid wallet address successfully.
            2.  Attempt to add the *same* wallet address again.
        *   **Expected Result:** Bot replies with "⚠️ Кошелек `[ADDRESS]` уже отслеживается или произошла ошибка при добавлении." (or a similar message indicating it's a duplicate).

4.  **`/mywallets` Command - With Wallets:**
    *   **Test Case 2.4.1:**
        *   **Action:**
            1.  Add 2-3 different valid wallet addresses.
            2.  Send the `/mywallets` command.
        *   **Expected Result:** The bot lists all added wallets, numbered, with their addresses in backticks (monospaced).

5.  **`/mywallets` Command - No Wallets:**
    *   **Test Case 2.5.1:**
        *   **Action:**
            1.  Ensure no wallets are currently tracked (remove any existing ones).
            2.  Send the `/mywallets` command.
        *   **Expected Result:** Bot replies with "Вы еще не отслеживаете ни одного кошелька. Используйте "➕ Добавить кошелек", чтобы начать."

6.  **Remove Wallet - Happy Path:**
    *   **Test Case 2.6.1:**
        *   **Action:**
            1.  Add a valid wallet address.
            2.  Click the "➖ Удалить кошелек" button.
            3.  Verify the bot displays the added wallet as an inline button for removal, along with a "❌ Отмена" button.
            4.  Click the button corresponding to the wallet address to remove it.
        *   **Expected Result:**
            *   The bot updates the message to "Кошелек `[ADDRESS]` успешно удален!".
            *   Send `/mywallets`. The removed wallet should no longer be listed. The inline keyboard should be gone.

7.  **Remove Wallet - Wallet Not Found (Conceptual):**
    *   **Test Case 2.7.1:**
        *   **Action:** (This is hard to test perfectly without direct DB manipulation or a race condition).
            1. User A has wallet W1 listed for removal.
            2. Before User A clicks remove, somehow W1 is removed from DB (e.g. another bot instance or direct action).
            3. User A clicks "remove W1".
        *   **Expected Result:** The bot should handle this gracefully, e.g., by saying "Не удалось удалить кошелек `[ADDRESS]`. Возможно, он уже был удален или не найден." and not crash.

8.  **Remove Wallet - No Wallets to Remove:**
    *   **Test Case 2.8.1:**
        *   **Action:**
            1.  Ensure no wallets are tracked.
            2.  Click the "➖ Удалить кошелек" button.
        *   **Expected Result:** Bot replies with "У вас нет кошельков для удаления."

9.  **Remove Wallet - Cancel:**
    *   **Test Case 2.9.1:**
        *   **Action:**
            1.  Add a wallet.
            2.  Click "➖ Удалить кошелек".
            3.  Verify the wallet and a "❌ Отмена" button appear.
            4.  Click "❌ Отмена".
        *   **Expected Result:** The message updates to "Удаление кошелька отменено." and the inline keyboard is removed.

---

**III. Transaction Monitoring & Notifications**

*(Requires a configurable Solana wallet and ability to make transactions on the chosen network)*

1.  **New Transaction Notification:**
    *   **Test Case 3.1.1 (Incoming Transaction):**
        *   **Action:**
            1.  Add a wallet (Wallet A) to the bot.
            2.  Send a small amount of SOL (or an SPL token) *to* Wallet A from another wallet.
            3.  Wait for the bot's monitoring cycle (default ~60 seconds).
        *   **Expected Result:**
            *   A notification message is received in Russian.
            *   The notification correctly identifies Wallet A.
            *   Includes a Solscan link to the transaction signature.
            *   Shows a human-readable timestamp.
            *   Indicates transaction status (e.g., "Успешно").
            *   Shows SOL change (e.g., "+0.01 SOL").
            *   Mentions basic instruction type.
    *   **Test Case 3.1.2 (Outgoing Transaction):**
        *   **Action:**
            1.  Add a wallet (Wallet B) to the bot (ensure it has some SOL).
            2.  Send a small amount of SOL *from* Wallet B to another wallet.
            3.  Wait for the bot's monitoring cycle.
        *   **Expected Result:** Similar to 3.1.1, but the SOL change should be negative (e.g., "-0.005 SOL").

2.  **Multiple Users, Same Wallet:**
    *   **Test Case 3.2.1:**
        *   **Action:**
            1.  Using Telegram Account 1, add Wallet X.
            2.  Using Telegram Account 2, add Wallet X.
            3.  Perform a transaction on Wallet X.
            4.  Wait for the monitoring cycle.
        *   **Expected Result:** Both Telegram Account 1 and Telegram Account 2 receive the notification for Wallet X.

3.  **Multiple Wallets, Single User:**
    *   **Test Case 3.3.1:**
        *   **Action:**
            1.  Using your Telegram account, add Wallet X and Wallet Y.
            2.  Perform a transaction on Wallet X. Wait for notification.
            3.  Perform a transaction on Wallet Y. Wait for notification.
        *   **Expected Result:**
            *   A notification is received specifically for Wallet X after its transaction.
            *   A notification is received specifically for Wallet Y after its transaction.
            *   No cross-notifications (e.g., Wallet Y transaction triggering a Wallet X notification).

4.  **No Duplicate Notifications:**
    *   **Test Case 3.4.1:**
        *   **Action:**
            1.  Add a wallet.
            2.  Perform one transaction.
            3.  Receive the notification.
            4.  Wait for several monitoring cycles (e.g., 3-5 minutes).
        *   **Expected Result:** Only one notification is received for that single transaction. No duplicates arrive in subsequent cycles.

5.  **Bot Restart & Monitoring:**
    *   **Test Case 3.5.1:**
        *   **Action:**
            1.  Add Wallet Z.
            2.  Perform Transaction T1 on Wallet Z. Wait for and verify notification N1.
            3.  Restart the bot application (`node src/bot.js`). Ensure it logs startup messages.
            4.  Perform a *new* Transaction T2 on Wallet Z.
            5.  Wait for the monitoring cycle.
        *   **Expected Result:**
            *   A notification N2 is received for the new transaction T2.
            *   No duplicate notification for T1 is received after the restart. This tests that `lastProcessedSignatures` logic correctly prevents re-notification of old transactions based on the baseline established on startup.

---

**IV. Error Handling (General)**

1.  **RPC Node Down (Simulated):**
    *   **Test Case 4.1.1:**
        *   **Action:**
            1.  If possible, temporarily change `SOLANA_RPC_ENDPOINT` in `.env` to an invalid or unreachable URL. Restart bot.
            2.  Or, if using a local node, stop it.
        *   **Expected Result:**
            *   The bot should continue running (Telegram part).
            *   Console logs should show errors from `[Monitor]` like "Error processing wallet..." or "Rate limited..." or connection errors.
            *   Wallet management commands (`/start`, `/mywallets`, add/remove) should still function if they don't require immediate RPC validation for the action itself (address validation might fail, which is okay).
            *   Once the RPC endpoint is restored (or corrected), new transactions should eventually be picked up and notified.

2.  **Invalid Bot Token:**
    *   **Test Case 4.2.1:**
        *   **Action:** Start the bot with an invalid `TELEGRAM_BOT_TOKEN` in `.env` (e.g., `123:ABC`).
        *   **Expected Result:** The bot logs a critical error regarding Telegram authentication (e.g., "401 Unauthorized") and likely exits or fails to respond to any Telegram commands.

---

This testing plan provides a structured approach to verifying the bot's functionality. Note any deviations or unexpected behaviors.Okay, I have created the `MANUAL_TESTING_PLAN.md` file with the comprehensive testing plan as you've outlined.
