const crypto = require('crypto');
const { Wallet, WalletTransactions, Profile, Users } = require('../models');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { buildPropertyEmailHtml } = require('../utils/emailTemplates');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');
const {
  initializePayment,
  verifyTransactionById,
  initiateTransfer,
  resolveBankCode,
} = require('../utils/flutterwave');

function generateTxRef(prefix) {
  return `RENTULO-${prefix}-${crypto.randomUUID()}`;
}

function isValidAmount(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
}

// Constant-time comparison that never throws on mismatched lengths — the
// signature header is attacker-controlled, so an arbitrary-length string
// must not be able to crash the check (crypto.timingSafeEqual requires
// equal-length buffers and throws otherwise).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// ─────────────────────────────────────────────────────────────
// GET /wallet — balance, status, account name/number
// ─────────────────────────────────────────────────────────────
async function getWallet(req, res) {
  try {
    const user_id = req.user.userId;
    const wallet = await Wallet.findOne({ where: { user_id } });
    if (!wallet) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    return res.status(200).json({
      success: true,
      data: {
        accountName: wallet.accountName,
        accountNumber: wallet.accountNumber,
        balance: wallet.balance,
        status: wallet.status,
      },
    });
  } catch (error) {
    logger.error('Error fetching wallet', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────────────────────
// GET /wallet/transactions — top-up / withdrawal history
// ─────────────────────────────────────────────────────────────
async function getWalletTransactions(req, res) {
  try {
    const user_id = req.user.userId;
    const transactions = await WalletTransactions.findAll({
      where: { user_id },
      order: [['createdAt', 'DESC']],
    });
    return res.status(200).json({ success: true, data: transactions });
  } catch (error) {
    logger.error('Error fetching wallet transactions', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /wallet/topup/initialize — start a Flutterwave hosted checkout
// ─────────────────────────────────────────────────────────────
async function initializeTopUp(req, res) {
  let pendingTx = null;
  try {
    const user_id = req.user.userId;
    const userEmail = req.user.email;
    const { amount } = req.body;

    if (!isValidAmount(amount)) {
      return res.status(400).json({ success: false, message: "A valid amount is required" });
    }

    const wallet = await Wallet.findOne({ where: { user_id } });
    if (!wallet) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }
    if (wallet.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: "Wallet is not active" });
    }

    const tx_ref = generateTxRef('TOPUP');

    pendingTx = await WalletTransactions.create({
      wallet_id: wallet.id,
      user_id,
      tx_ref,
      type: 'topup',
      amount,
      status: 'pending',
      narration: 'Wallet top-up',
      // Funding source is external (card/bank) and only known once Flutterwave
      // confirms the charge — filled in by creditTopUpIfVerified.
      from_account_name: req.user.currentUser || null,
      to_account_number: wallet.accountNumber,
      to_account_name: wallet.accountName,
    });

    const host = req.get('host');
    const protocol = req.protocol;
    const defaultCallback = `${protocol}://${host}/wallet/topup/verify-callback`;
    const redirect_url = process.env.FLW_CALLBACK_URL || defaultCallback;

    const flwResponse = await initializePayment({
      tx_ref,
      amount,
      email: userEmail,
      name: wallet.accountName,
      redirect_url,
      meta: { user_id, wallet_id: wallet.id, type: 'topup' },
    });

    if (flwResponse.status !== 'success') {
      logger.error('Flutterwave initialize failed', { tx_ref, response: flwResponse });
      pendingTx.status = 'failed';
      pendingTx.meta = flwResponse;
      await pendingTx.save();
      return res.status(502).json({ success: false, message: "Could not start payment. Please try again." });
    }

    return res.status(200).json({
      success: true,
      message: "Payment initialization successful",
      link: flwResponse.data.link,
      tx_ref,
    });
  } catch (error) {
    logger.error('Error initializing top-up', {
      error: error.response ? JSON.stringify(error.response.data) : error.message,
      userId: req.user?.userId,
    });
    // A row was already opened for this attempt — don't leave it pending forever.
    if (pendingTx && pendingTx.status === 'pending') {
      pendingTx.status = 'failed';
      pendingTx.meta = { error: error.response ? error.response.data : error.message };
      await pendingTx.save().catch(() => {});
    }
    return res.status(500).json({ success: false, message: "Server error during payment initialization" });
  }
}

/**
 * Re-verifies a charge with Flutterwave (never trusts the caller/webhook
 * payload alone) and credits the wallet exactly once.
 */
async function creditTopUpIfVerified(tx, flwTransactionId) {
  const verified = await verifyTransactionById(flwTransactionId);
  const data = verified.data;

  const isGenuine = verified.status === 'success' &&
    data &&
    data.status === 'successful' &&
    data.tx_ref === tx.tx_ref &&
    data.currency === 'NGN' &&
    Number(data.amount) >= Number(tx.amount);

  let didTransitionSuccess = false;
  let didTransitionFailed = false;

  const result = await withTransaction(async (t) => {
    const freshTx = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!freshTx || freshTx.status !== 'pending') {
      return freshTx; // already processed — idempotent no-op
    }

    if (!isGenuine) {
      freshTx.status = 'failed';
      freshTx.flw_ref = data ? String(data.id) : freshTx.flw_ref;
      freshTx.meta = data || null;
      await freshTx.save({ transaction: t });
      didTransitionFailed = true;
      return freshTx;
    }

    const wallet = await Wallet.findOne({ where: { id: freshTx.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
    wallet.balance = Number(wallet.balance) + Number(freshTx.amount);
    await wallet.save({ transaction: t });

    freshTx.status = 'success';
    freshTx.flw_ref = String(data.id);
    freshTx.meta = data;
    freshTx.from_account_number = data.card ? `****${data.card.last_4digits}` : freshTx.from_account_number;
    freshTx.from_account_name = data.customer?.name || freshTx.from_account_name;
    await freshTx.save({ transaction: t });

    didTransitionSuccess = true;
    return freshTx;
  }, { context: 'creditTopUp', tx_ref: tx.tx_ref });

  if (result) {
    if (didTransitionSuccess && result.status === 'success') {
      try {
        const user = await Users.findByPk(result.user_id);
        const amountFormatted = Number(result.amount).toLocaleString();

        // 1. Send receipt/notification to the user
        const tenantHtml = buildPropertyEmailHtml({
          heading: 'Wallet Top-up Successful',
          subheading: 'Payment Receipt Confirmation',
          bodyText: `You have successfully topped up your wallet with <strong>₦${amountFormatted}</strong>.`,
          recipientName: user?.full_name,
          transaction: {
            amount: result.amount,
            reference: result.tx_ref,
            payment_type: 'topup',
            status: 'Success',
          },
        });
        await logAndEmailUser(result.user_id, user?.email, 'Wallet Top-up Successful', tenantHtml);

        // 2. Send receipt/notification to the admin
        const message = `A wallet top-up payment of ₦${amountFormatted} was successfully made by ${user ? user.full_name : 'Unknown User'}.`;
        await notifySuperAdmins(
          message,
          'system',
          {
            heading: 'Wallet Top-up Payment Successful',
            tenant: user || undefined,
            transaction: {
              amount: result.amount,
              reference: result.tx_ref,
              payment_type: 'topup',
              status: 'Success',
            },
          }
        );
      } catch (err) {
        logger.error('Error sending top-up success notifications', { error: err.message });
      }
    } else if (didTransitionFailed && result.status === 'failed') {
      try {
        const user = await Users.findByPk(result.user_id);
        const amountFormatted = Number(result.amount).toLocaleString();

        // 1. Send failure notification/email to the user
        const tenantHtml = buildPropertyEmailHtml({
          heading: 'Wallet Top-up Failed',
          subheading: 'Payment Failed Notification',
          bodyText: `Your attempt to top up your wallet with <strong>₦${amountFormatted}</strong> failed or was rejected. If you were debited, please contact support.`,
          recipientName: user?.full_name,
          transaction: {
            amount: result.amount,
            reference: result.tx_ref,
            payment_type: 'topup',
            status: 'Failed',
          },
        });
        await logAndEmailUser(result.user_id, user?.email, 'Wallet Top-up Failed', tenantHtml);

        // 2. Send failure notification/email to the admin
        const message = `A wallet top-up payment of ₦${amountFormatted} failed for ${user ? user.full_name : 'Unknown User'}.`;
        await notifySuperAdmins(
          message,
          'system',
          {
            heading: 'Wallet Top-up Payment Failed',
            tenant: user || undefined,
            transaction: {
              amount: result.amount,
              reference: result.tx_ref,
              payment_type: 'topup',
              status: 'Failed',
            },
          }
        );
      } catch (err) {
        logger.error('Error sending top-up failure notifications', { error: err.message });
      }
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// GET /wallet/topup/verify-callback — browser redirect after checkout
// ─────────────────────────────────────────────────────────────
async function verifyTopUpCallback(req, res) {
  const successUrl = process.env.FLW_REDIRECT_URL || "https://rentulo.ng/tenant/wallet";
  const failureUrl = process.env.FLW_FAILURE_URL || "https://rentulo.ng/tenant/wallet";

  try {
    const { tx_ref, transaction_id, status } = req.query;

    if (!tx_ref || status === 'cancelled') {
      return res.redirect(failureUrl);
    }

    const tx = await WalletTransactions.findOne({ where: { tx_ref, type: 'topup' } });
    if (!tx) {
      return res.redirect(failureUrl);
    }

    if (tx.status === 'success') {
      return res.redirect(successUrl);
    }

    if (!transaction_id) {
      return res.redirect(failureUrl);
    }

    const finalTx = await creditTopUpIfVerified(tx, transaction_id);
    return res.redirect(finalTx.status === 'success' ? successUrl : failureUrl);
  } catch (error) {
    logger.error('Error in verifyTopUpCallback', {
      error: error.response ? JSON.stringify(error.response.data) : error.message,
    });
    return res.redirect(failureUrl);
  }
}

// ─────────────────────────────────────────────────────────────
// POST /wallet/withdraw — pay out to the user's saved bank account
// ─────────────────────────────────────────────────────────────
async function withdraw(req, res) {
  try {
    const user_id = req.user.userId;
    const { amount } = req.body;

    if (!isValidAmount(amount)) {
      return res.status(400).json({ success: false, message: "A valid amount is required" });
    }

    const profile = await Profile.findOne({ where: { user_id } });
    if (!profile || !profile.withdrawalAccountNumber || !profile.withdrawalBankName || !profile.withdrawalAccountName) {
      return res.status(400).json({
        success: false,
        message: "Please add your withdrawal bank details on your profile before withdrawing",
      });
    }

    const bankCode = await resolveBankCode(profile.withdrawalBankName);
    if (!bankCode) {
      return res.status(400).json({
        success: false,
        message: "We couldn't recognize your saved bank name. Please update it on your profile.",
      });
    }

    // Debit first (holds the funds) inside a locked transaction, then attempt the transfer.
    const tx_ref = generateTxRef('WD');
    let wallet;
    try {
      wallet = await withTransaction(async (t) => {
        const w = await Wallet.findOne({ where: { user_id }, transaction: t, lock: t.LOCK.UPDATE });
        if (!w) {
          const err = new Error('Wallet not found');
          err.status = 404;
          throw err;
        }
        if (w.status !== 'ACTIVE') {
          const err = new Error('Wallet is not active');
          err.status = 400;
          throw err;
        }
        if (Number(w.balance) < Number(amount)) {
          const err = new Error('Insufficient balance');
          err.status = 400;
          throw err;
        }

        w.balance = Number(w.balance) - Number(amount);
        await w.save({ transaction: t });

        await WalletTransactions.create({
          wallet_id: w.id,
          user_id,
          tx_ref,
          type: 'withdrawal',
          amount,
          status: 'pending',
          narration: `Withdrawal to ${profile.withdrawalBankName} - ${profile.withdrawalAccountNumber}`,
          from_account_number: w.accountNumber,
          from_account_name: w.accountName,
          to_account_number: profile.withdrawalAccountNumber,
          to_account_name: profile.withdrawalAccountName,
        }, { transaction: t });

        return w;
      }, { context: 'withdrawDebit', user_id, tx_ref });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({ success: false, message: error.message || "Server error" });
    }

    // Attempt the actual payout. Any failure here must refund the hold we just placed.
    try {
      const transfer = await initiateTransfer({
        account_bank: bankCode,
        account_number: profile.withdrawalAccountNumber,
        amount,
        narration: `RentULO wallet withdrawal - ${profile.withdrawalAccountName}`,
        reference: tx_ref,
      });

      if (transfer.status !== 'success') {
        throw new Error(transfer.message || 'Transfer initiation failed');
      }

      await WalletTransactions.update(
        { flw_ref: String(transfer.data.id), meta: transfer.data },
        { where: { tx_ref } }
      );

      logger.info('Withdrawal transfer initiated', { user_id, tx_ref, amount });

      return res.status(200).json({
        success: true,
        message: "Withdrawal is being processed",
        tx_ref,
        balance: wallet.balance,
      });
    } catch (error) {
      // Flutterwave responding with an explicit error means the transfer was
      // never created on their side — safe to refund immediately.
      // A network/timeout error (no response received) is ambiguous: the
      // request may have reached Flutterwave and be processing anyway.
      // Auto-refunding here would risk a double payout (wallet refunded AND
      // the bank transfer still lands), so we leave it pending instead and
      // let the transfer.completed webhook — or manual reconciliation —
      // resolve it once we actually know the outcome.
      const isDefiniteRejection = !!error.response;

      if (isDefiniteRejection) {
        await withTransaction(async (t) => {
          const freshTx = await WalletTransactions.findOne({ where: { tx_ref }, transaction: t, lock: t.LOCK.UPDATE });
          if (!freshTx || freshTx.status !== 'pending') return;

          const w = await Wallet.findOne({ where: { id: freshTx.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
          w.balance = Number(w.balance) + Number(freshTx.amount);
          await w.save({ transaction: t });

          freshTx.status = 'failed';
          freshTx.meta = { error: error.response.data };
          await freshTx.save({ transaction: t });
        }, { context: 'withdrawRefund', user_id, tx_ref });

        logger.error('Withdrawal transfer rejected by Flutterwave, refunded wallet', {
          error: JSON.stringify(error.response.data),
          user_id,
          tx_ref,
        });

        return res.status(502).json({
          success: false,
          message: "Withdrawal could not be processed. Your wallet balance has been restored.",
        });
      }

      logger.error('Withdrawal transfer response unknown (network error) — left pending for reconciliation, NOT refunded', {
        error: error.message,
        user_id,
        tx_ref,
      });

      return res.status(202).json({
        success: true,
        message: "Your withdrawal is being processed. It may take a few minutes to confirm — contact support if it doesn't complete.",
        tx_ref,
      });
    }
  } catch (error) {
    logger.error('Error processing withdrawal', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /wallet/transfer — instant wallet-to-wallet transfer, no gateway involved
// ─────────────────────────────────────────────────────────────
async function transferToUser(req, res) {
  try {
    const user_id = req.user.userId;
    const { accountNumber, amount } = req.body;

    if (!accountNumber) {
      return res.status(400).json({ success: false, message: "Recipient accountNumber is required" });
    }
    if (!isValidAmount(amount)) {
      return res.status(400).json({ success: false, message: "A valid amount is required" });
    }

    const senderWallet = await Wallet.findOne({ where: { user_id } });
    if (!senderWallet) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    const recipientWallet = await Wallet.findOne({ where: { accountNumber } });
    if (!recipientWallet) {
      return res.status(404).json({ success: false, message: "Recipient account number not found" });
    }

    if (recipientWallet.id === senderWallet.id) {
      return res.status(400).json({ success: false, message: "You cannot transfer to your own wallet" });
    }

    try {
      const result = await withTransaction(async (t) => {
        // Lock both wallets in a fixed order (by id) regardless of who is
        // sender/recipient, so two transfers crossing the same pair of
        // wallets in opposite directions can never deadlock on each other.
        const [firstId, secondId] = [senderWallet.id, recipientWallet.id].sort();
        const first = await Wallet.findOne({ where: { id: firstId }, transaction: t, lock: t.LOCK.UPDATE });
        const second = await Wallet.findOne({ where: { id: secondId }, transaction: t, lock: t.LOCK.UPDATE });
        const sender = first.id === senderWallet.id ? first : second;
        const recipient = first.id === recipientWallet.id ? first : second;

        if (sender.status !== 'ACTIVE') {
          const err = new Error('Wallet is not active');
          err.status = 400;
          throw err;
        }
        if (recipient.status !== 'ACTIVE') {
          const err = new Error('Recipient wallet is not active');
          err.status = 400;
          throw err;
        }
        if (Number(sender.balance) < Number(amount)) {
          const err = new Error('Insufficient balance');
          err.status = 400;
          throw err;
        }

        sender.balance = Number(sender.balance) - Number(amount);
        recipient.balance = Number(recipient.balance) + Number(amount);
        await sender.save({ transaction: t });
        await recipient.save({ transaction: t });

        // Two rows, one per party, sharing a pair id — an internal transfer
        // settles immediately so both land as 'success' with no gateway round trip.
        const pairId = crypto.randomUUID();
        await WalletTransactions.create({
          wallet_id: sender.id,
          user_id: sender.user_id,
          tx_ref: `RENTULO-XFER-${pairId}-OUT`,
          type: 'transfer_out',
          amount,
          status: 'success',
          narration: `Transfer to ${recipient.accountName} (${recipient.accountNumber})`,
          from_account_number: sender.accountNumber,
          from_account_name: sender.accountName,
          to_account_number: recipient.accountNumber,
          to_account_name: recipient.accountName,
        }, { transaction: t });

        await WalletTransactions.create({
          wallet_id: recipient.id,
          user_id: recipient.user_id,
          tx_ref: `RENTULO-XFER-${pairId}-IN`,
          type: 'transfer_in',
          amount,
          status: 'success',
          narration: `Transfer from ${sender.accountName} (${sender.accountNumber})`,
          from_account_number: sender.accountNumber,
          from_account_name: sender.accountName,
          to_account_number: recipient.accountNumber,
          to_account_name: recipient.accountName,
        }, { transaction: t });

        return { balance: sender.balance };
      }, { context: 'walletTransfer', user_id, accountNumber });

      logger.info('Wallet transfer completed', { user_id, accountNumber, amount });

      return res.status(200).json({
        success: true,
        message: "Transfer successful",
        balance: result.balance,
      });
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) {
        logger.error('Error processing wallet transfer', { error: error.message, user_id, accountNumber });
      }
      return res.status(status).json({ success: false, message: status === 500 ? "Server error" : error.message });
    }
  } catch (error) {
    logger.error('Error initiating wallet transfer', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /wallet/webhook — Flutterwave event notifications
// Source of truth for both top-ups and withdrawal outcomes; the
// browser-redirect callback is only a best-effort shortcut.
// ─────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  try {
    const signature = req.headers['verif-hash'];
    if (!process.env.FLW_SECRET_HASH || !safeEqual(signature, process.env.FLW_SECRET_HASH)) {
      return res.status(401).end();
    }

    const event = req.body;
    const data = event.data;

    if (event.event === 'charge.completed' && data) {
      const tx = await WalletTransactions.findOne({ where: { tx_ref: data.tx_ref, type: 'topup' } });
      if (tx) {
        await creditTopUpIfVerified(tx, data.id);
      }
    } else if (event.event === 'transfer.completed' && data) {
      await withTransaction(async (t) => {
        const tx = await WalletTransactions.findOne({ where: { tx_ref: data.reference, type: 'withdrawal' }, transaction: t, lock: t.LOCK.UPDATE });
        if (!tx || tx.status !== 'pending') return;

        if (data.status === 'SUCCESSFUL') {
          tx.status = 'success';
          tx.meta = data;
          await tx.save({ transaction: t });
        } else if (data.status === 'FAILED') {
          const wallet = await Wallet.findOne({ where: { id: tx.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
          wallet.balance = Number(wallet.balance) + Number(tx.amount);
          await wallet.save({ transaction: t });

          tx.status = 'failed';
          tx.meta = data;
          await tx.save({ transaction: t });
        }
      }, { context: 'webhookTransferCompleted', tx_ref: data.reference });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error handling Flutterwave webhook', { error: error.message });
    // Still 200 — Flutterwave retries aggressively on non-2xx, and we've logged for manual follow-up.
    return res.status(200).json({ success: false });
  }
}

module.exports = {
  getWallet,
  getWalletTransactions,
  initializeTopUp,
  verifyTopUpCallback,
  withdraw,
  transferToUser,
  handleWebhook,
};
