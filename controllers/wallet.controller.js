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
  getTransferStatus,
  resolveBankCode,
  extractFlutterwaveError,
  shouldSimulateTransfer,
} = require('../utils/flutterwave');
const { toKobo, fromKobo, sumKobo } = require('../utils/money');

function generateTxRef(prefix) {
  return `RENTULO-${prefix}-${crypto.randomUUID()}`;
}

function isValidAmount(amount) {
  // Strict: a finite positive number with at most 2 decimal places.
  // Rejects strings, NaN, Infinity, scientific notation, and >2dp values.
  return typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount > 0 &&
    /^\d+(\.\d{1,2})?$/.test(String(amount));
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
    let transactions = await WalletTransactions.findAll({
      where: { user_id },
      order: [['createdAt', 'DESC']],
    });

    // Auto-reconcile any pending top-ups for this user with Flutterwave
    const pendingTopups = transactions.filter(t => t.type === 'topup' && t.status === 'pending');
    if (pendingTopups.length > 0) {
      let updated = false;
      for (const pendingTx of pendingTopups) {
        const result = await creditTopUpIfVerified(pendingTx);
        if (result && result.status !== 'pending') {
          updated = true;
        }
      }
      if (updated) {
        transactions = await WalletTransactions.findAll({
          where: { user_id },
          order: [['createdAt', 'DESC']],
        });
      }
    }

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
    const user_id = req.user?.userId || req.user?.id;
    if (!user_id) {
      return res.status(401).json({ success: false, message: "User authentication required" });
    }

    const { amount } = req.body;

    if (!isValidAmount(amount)) {
      return res.status(400).json({ success: false, message: "A valid amount is required" });
    }

    const user = await Users.findByPk(user_id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User account not found" });
    }

    const userEmail = req.user?.email || user.email;
    const userName = req.user?.currentUser || user.full_name;

    if (!userEmail) {
      return res.status(400).json({ success: false, message: "User email is required for payment initialization" });
    }

    let wallet = await Wallet.findOne({ where: { user_id } });
    if (!wallet) {
      wallet = await createWalletForUser(user);
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
      amount: fromKobo(toKobo(amount)),
      status: 'pending',
      narration: 'Wallet top-up',
      from_account_name: userName || null,
      to_account_number: wallet.accountNumber,
      to_account_name: wallet.accountName,
    });

    const host = req.get('host');
    const protocol = req.protocol;
    const defaultCallback = `${protocol}://${host}/wallet/topup/verify-callback`;
    
    // Ensure redirect_url points to backend callback route so Flutterwave callback reaches the server
    let redirect_url = process.env.FLW_CALLBACK_URL || defaultCallback;
    if (redirect_url.includes('rentulo.ng/wallet/topup/verify-callback') || redirect_url.includes('tenant/wallet')) {
      redirect_url = defaultCallback;
    }

    const flwResponse = await initializePayment({
      tx_ref,
      amount,
      email: userEmail,
      name: userName || wallet.accountName,
      redirect_url,
      meta: { user_id, wallet_id: wallet.id, type: 'topup' },
    });

    if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
      logger.error('Flutterwave initialize failed', { tx_ref, response: flwResponse });
      pendingTx.status = 'failed';
      pendingTx.meta = flwResponse;
      await pendingTx.save();
      return res.status(502).json({
        success: false,
        message: flwResponse.message || "Could not start payment. Please try again."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment initialization successful",
      link: flwResponse.data.link,
      tx_ref,
    });
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    logger.error('Error initializing top-up', {
      error: error.response ? JSON.stringify(error.response.data) : error.message,
      userId: req.user?.userId || req.user?.id,
    });
    if (pendingTx && pendingTx.status === 'pending') {
      pendingTx.status = 'failed';
      pendingTx.meta = { error: error.response ? error.response.data : error.message };
      await pendingTx.save().catch(() => {});
    }
    return res.status(500).json({
      success: false,
      message: errorMsg || "Server error during payment initialization"
    });
  }
}

/**
 * Re-verifies a charge with Flutterwave (never trusts the caller/webhook
 * payload alone) and credits the wallet exactly once.
 * Supports lookup by transactionId or fallback to tx_ref reference verification.
 */
async function creditTopUpIfVerified(tx, flwTransactionId) {
  let verified;
  try {
    if (flwTransactionId) {
      verified = await verifyTransactionById(flwTransactionId);
    } else {
      verified = await verifyTransactionByRef(tx.tx_ref);
    }
  } catch (error) {
    // If lookup by ID failed (or wasn't provided), try lookup by reference as fallback
    if (flwTransactionId) {
      try {
        logger.warn('Flutterwave verify by transactionId failed, falling back to verifyByRef', {
          tx_ref: tx.tx_ref, flwTransactionId, error: error.message,
        });
        verified = await verifyTransactionByRef(tx.tx_ref);
      } catch (refError) {
        const message = refError?.response?.data?.message || refError?.message || '';
        if (/no transaction was found|not found/i.test(message)) {
          logger.warn('Flutterwave verify call: transaction not found at Flutterwave yet', {
            tx_ref: tx.tx_ref, message,
          });
        } else {
          logger.warn('Flutterwave verify call failed — leaving pending for retry', {
            tx_ref: tx.tx_ref, error: refError.message,
          });
        }
        return null;
      }
    } else {
      const message = error?.response?.data?.message || error?.message || '';
      if (/no transaction was found|not found/i.test(message)) {
        logger.warn('Flutterwave verify call: transaction not found at Flutterwave yet', {
          tx_ref: tx.tx_ref, message,
        });
      } else {
        logger.warn('Flutterwave verify call failed — leaving pending for retry', {
          tx_ref: tx.tx_ref, error: error.message,
        });
      }
      return null;
    }
  }

  const data = verified?.data;

  // If Flutterwave's API itself returned an error status (not a definitive
  // charge outcome), treat it as transient and leave pending.
  if (verified?.status !== 'success' || !data) {
    logger.warn('Flutterwave verify returned non-success status — leaving pending', {
      tx_ref: tx.tx_ref, flwTransactionId, flwStatus: verified?.status, message: verified?.message,
    });
    return null;
  }

  const isGenuine =
    data &&
    typeof data.status === 'string' &&
    data.status.toLowerCase() === 'successful' &&
    data.tx_ref === tx.tx_ref &&
    data.currency === 'NGN' &&
    toKobo(data.amount) >= toKobo(tx.amount);

  // Definitive charge failure — safe to mark as failed ONLY when Flutterwave
  // explicitly reports failed/abandoned.
  const isDefinitiveFailure = data && typeof data.status === 'string' &&
    ['failed', 'abandoned'].includes(data.status.toLowerCase());

  let didTransitionSuccess = false;
  let didTransitionFailed = false;

  const result = await withTransaction(async (t) => {
    const freshTx = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!freshTx || freshTx.status !== 'pending') {
      return freshTx; // already processed — idempotent no-op
    }

    if (!isGenuine && isDefinitiveFailure) {
      freshTx.status = 'failed';
      freshTx.flw_ref = data ? String(data.id) : freshTx.flw_ref;
      freshTx.meta = data || null;
      await freshTx.save({ transaction: t });
      didTransitionFailed = true;
      return freshTx;
    }

    if (!isGenuine) {
      // Ambiguous state — Flutterwave returned 200 OK but no definitive
      // charge status. Leave pending for reconciliation to re-check.
      logger.warn('Charge verification ambiguous — leaving pending', {
        tx_ref: tx.tx_ref, flwTransactionId, dataStatus: data?.status,
      });
      return freshTx;
    }

    const wallet = await Wallet.findOne({ where: { id: freshTx.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
    wallet.balance = fromKobo(sumKobo(wallet.balance, freshTx.amount));
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
  const defaultFrontendUrl = "https://rentulo.ng/tenant/wallet";
  const successUrlBase = process.env.FLW_REDIRECT_URL || defaultFrontendUrl;
  const failureUrlBase = process.env.FLW_FAILURE_URL || defaultFrontendUrl;

  const buildRedirectUrl = (baseUrl, params) => {
    try {
      const urlObj = new URL(baseUrl);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) urlObj.searchParams.set(k, v);
      });
      return urlObj.toString();
    } catch (_) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${sep}status=${params.status || 'processed'}&tx_ref=${params.tx_ref || ''}`;
    }
  };

  try {
    const rawTxRef = req.query.tx_ref || req.query.txref || req.query.reference;
    const rawFlwId = req.query.transaction_id || req.query.id || req.query.flw_ref || req.query.tx_id;
    const status = req.query.status ? String(req.query.status).toLowerCase() : null;

    if (!rawTxRef || status === 'cancelled') {
      return res.redirect(buildRedirectUrl(failureUrlBase, { status: 'cancelled', tx_ref: rawTxRef }));
    }

    const tx = await WalletTransactions.findOne({ where: { tx_ref: rawTxRef, type: 'topup' } });
    if (!tx) {
      return res.redirect(buildRedirectUrl(failureUrlBase, { status: 'not_found', tx_ref: rawTxRef }));
    }

    if (tx.status === 'success') {
      return res.redirect(buildRedirectUrl(successUrlBase, { status: 'success', tx_ref: rawTxRef, amount: tx.amount }));
    }

    const finalTx = await creditTopUpIfVerified(tx, rawFlwId);
    const definitelyFailed = finalTx && finalTx.status === 'failed';
    const redirectUrl = definitelyFailed
      ? buildRedirectUrl(failureUrlBase, { status: 'failed', tx_ref: rawTxRef })
      : buildRedirectUrl(successUrlBase, { status: 'success', tx_ref: rawTxRef, amount: tx.amount });

    return res.redirect(redirectUrl);
  } catch (error) {
    logger.error('Error in verifyTopUpCallback', {
      error: error.response ? JSON.stringify(error.response.data) : error.message,
    });
    return res.redirect(buildRedirectUrl(failureUrlBase, { status: 'error', message: 'Verification error' }));
  }
}

// ─────────────────────────────────────────────────────────────
// GET /wallet/topup/verify/:tx_ref — REST API endpoint for mobile/frontend app
// ─────────────────────────────────────────────────────────────
async function verifyTopUpStatus(req, res) {
  try {
    const user_id = req.user.userId;
    const tx_ref = req.params.tx_ref || req.query.tx_ref;

    if (!tx_ref) {
      return res.status(400).json({ success: false, message: "Transaction reference is required" });
    }

    let tx = await WalletTransactions.findOne({ where: { tx_ref, user_id, type: 'topup' } });
    if (!tx) {
      return res.status(404).json({ success: false, message: "Top-up transaction not found" });
    }

    if (tx.status === 'pending') {
      const rawFlwId = req.query.transaction_id || req.query.id || req.query.flw_ref;
      await creditTopUpIfVerified(tx, rawFlwId);
      tx = await WalletTransactions.findOne({ where: { id: tx.id } });
    }

    const wallet = await Wallet.findOne({ where: { user_id } });

    if (tx.status === 'success') {
      return res.status(200).json({
        success: true,
        message: "Top-up confirmed successfully",
        data: {
          status: 'success',
          amount: tx.amount,
          tx_ref: tx.tx_ref,
          balance: wallet ? wallet.balance : undefined,
          transaction: tx,
        },
      });
    }

    if (tx.status === 'failed') {
      return res.status(200).json({
        success: false,
        message: "Top-up failed or was rejected",
        data: {
          status: 'failed',
          amount: tx.amount,
          tx_ref: tx.tx_ref,
          transaction: tx,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Top-up is pending confirmation from Flutterwave",
      data: {
        status: 'pending',
        amount: tx.amount,
        tx_ref: tx.tx_ref,
        transaction: tx,
      },
    });
  } catch (error) {
    logger.error('Error verifying top-up status', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error during top-up verification" });
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
        if (toKobo(w.balance) < toKobo(amount)) {
          const err = new Error('Insufficient balance');
          err.status = 400;
          throw err;
        }

        w.balance = fromKobo(sumKobo(w.balance, -amount));
        await w.save({ transaction: t });

        await WalletTransactions.create({
          wallet_id: w.id,
          user_id,
          tx_ref,
          type: 'withdrawal',
          amount: fromKobo(toKobo(amount)),
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
      const simulate = shouldSimulateTransfer() && process.env.NODE_ENV !== 'production';
      if (shouldSimulateTransfer() && process.env.NODE_ENV === 'production') {
        // Never let a stray env flag fake a payout on real funds — log loudly
        // and proceed with the real transfer path instead.
        logger.error('FLW_SIMULATE_TRANSFERS is set but NODE_ENV=production — ignoring it; using the real transfer path', { user_id, tx_ref });
      }

      if (simulate) {
        await WalletTransactions.update(
          {
            status: 'success',
            flw_ref: 'simulated',
            meta: { simulated: true, provider: 'flutterwave-simulated' },
          },
          { where: { tx_ref } }
        );

        logger.info('Withdrawal transfer simulated successfully', { user_id, tx_ref, amount });

        return res.status(200).json({
          success: true,
          message: "Withdrawal completed successfully",
          tx_ref,
          balance: wallet.balance,
        });
      }

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
      const flwError = extractFlutterwaveError(error);

      if (isDefiniteRejection) {
        await withTransaction(async (t) => {
          const freshTx = await WalletTransactions.findOne({ where: { tx_ref }, transaction: t, lock: t.LOCK.UPDATE });
          if (!freshTx || freshTx.status !== 'pending') return;

          const w = await Wallet.findOne({ where: { id: freshTx.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
          w.balance = fromKobo(sumKobo(w.balance, freshTx.amount));
          await w.save({ transaction: t });

          freshTx.status = 'failed';
          freshTx.meta = { error: flwError.raw || flwError.message };
          await freshTx.save({ transaction: t });
        }, { context: 'withdrawRefund', user_id, tx_ref });

        logger.error('Withdrawal transfer rejected by Flutterwave, refunded wallet', {
          error: flwError.message,
          raw: flwError.raw,
          user_id,
          tx_ref,
        });

        const userMessage = flwError.isIpWhitelistError
          ? "Withdrawal could not be processed because your Flutterwave account is not configured to allow transfers from this server IP. Please enable IP whitelisting in the Flutterwave dashboard or contact support."
          : "Withdrawal could not be processed. Your wallet balance has been restored.";

        return res.status(502).json({
          success: false,
          message: userMessage,
        });
      }

      logger.error('Withdrawal transfer response unknown (network error) — left pending for reconciliation, NOT refunded', {
        error: flwError.message,
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

    let accountName = recipientWallet.accountName;
    if (!accountName) {
      const recipientUser = await Users.findOne({ where: { id: recipientWallet.user_id } });
      accountName = recipientUser ? recipientUser.full_name : 'Unknown User';
    }

    logger.info('Initiating wallet transfer', { user_id, accountNumber, amount });

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
        if (toKobo(sender.balance) < toKobo(amount)) {
          const err = new Error('Insufficient balance');
          err.status = 400;
          throw err;
        }

        sender.balance = fromKobo(sumKobo(sender.balance, -amount));
        recipient.balance = fromKobo(sumKobo(recipient.balance, amount));
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
          amount: fromKobo(toKobo(amount)),
          status: 'success',
          narration: `Transfer to ${accountName} (${recipient.accountNumber})`,
          from_account_number: sender.accountNumber,
          from_account_name: sender.accountName,
          to_account_number: recipient.accountNumber,
          to_account_name: accountName,
        }, { transaction: t });

        await WalletTransactions.create({
          wallet_id: recipient.id,
          user_id: recipient.user_id,
          tx_ref: `RENTULO-XFER-${pairId}-IN`,
          type: 'transfer_in',
          amount: fromKobo(toKobo(amount)),
          status: 'success',
          narration: `Transfer from ${sender.accountName} to ${accountName} (${recipient.accountNumber})`,
          from_account_number: sender.accountNumber,
          from_account_name: sender.accountName,
          to_account_number: recipient.accountNumber,
          to_account_name: accountName,
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
      logger.warn('Webhook signature verification failed', {
        hasHash: !!process.env.FLW_SECRET_HASH,
        hasSignature: !!signature,
        ip: req.ip,
      });
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
      // Never settle a withdrawal from the webhook body alone — a forged or
      // replayed event (compromised secret hash) must not be able to mark a
      // payout success or trigger a refund. Re-verify with Flutterwave first.
      const tx = await WalletTransactions.findOne({ where: { tx_ref: data.reference, type: 'withdrawal' } });
      if (tx && tx.status === 'pending') {
        await settleWithdrawalFromWebhook(tx, data);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error handling Flutterwave webhook', { error: error.message });
    // Return 500 so Flutterwave retries. The endpoint is idempotent (checks
    // status inside a locked transaction) so retries are safe.
    return res.status(500).json({ success: false });
  }
}

/**
 * Finalizes a pending withdrawal based on Flutterwave's authoritative transfer
 * status, cross-checked against the webhook payload. Returns false if the
 * transfer cannot be confirmed, leaving the row pending for reconciliation.
 */
async function settleWithdrawalFromWebhook(tx, webhookData) {
  let transfer;
  try {
    const res = await getTransferStatus(tx.flw_ref);
    if (res.status !== 'success' || !res.data) {
      throw new Error(res.message || 'Transfer lookup failed');
    }
    transfer = res.data;
  } catch (error) {
    const flwError = extractFlutterwaveError(error);
    if (flwError.message && /not found/i.test(flwError.message)) {
      // The transfer doesn't exist on the Flutterwave account holding this
      // key — it was never paid out, so the debit hold must be reversed.
      logger.warn('Withdrawal webhook: transfer not found at Flutterwave — refunding hold', {
        tx_ref: tx.tx_ref, flw_ref: tx.flw_ref,
      });
      return refundPendingWithdrawal(tx, { notFound: true, message: flwError.message });
    }
    logger.error('Withdrawal webhook: could not verify transfer with Flutterwave — left pending for reconciliation', {
      tx_ref: tx.tx_ref, flw_ref: tx.flw_ref, error: flwError.message,
    });
    return false;
  }

  const flwStatus = transfer.status;

  if (flwStatus === 'SUCCESSFUL') {
    // Cross-check the payload: reference, transfer id, currency and amount
    // must all match our row before we accept the payout as genuine.
    const payloadOk = webhookData &&
      String(webhookData.reference) === tx.tx_ref &&
      (webhookData.id == null || String(webhookData.id) === String(tx.flw_ref)) &&
      webhookData.currency === 'NGN' &&
      toKobo(webhookData.amount) >= toKobo(tx.amount);
    if (!payloadOk) {
      logger.error('Withdrawal webhook: payload mismatch on successful transfer — leaving pending', {
        tx_ref: tx.tx_ref, flw_ref: tx.flw_ref,
      });
      return false;
    }
    await withTransaction(async (t) => {
      const fresh = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
      if (!fresh || fresh.status !== 'pending') return;
      fresh.status = 'success';
      fresh.meta = transfer;
      await fresh.save({ transaction: t });
    }, { context: 'webhookTransferSuccess', tx_ref: tx.tx_ref });
    return true;
  }

  if (flwStatus === 'FAILED') {
    logger.warn('Withdrawal webhook: transfer failed at Flutterwave — refunding hold', {
      tx_ref: tx.tx_ref, flw_ref: tx.flw_ref,
    });
    return refundPendingWithdrawal(tx, transfer);
  }

  // NEW / PENDING / PROCESSING — not settled on Flutterwave's side yet.
  logger.info('Withdrawal webhook: transfer still in progress at Flutterwave — left pending', {
    tx_ref: tx.tx_ref, flw_ref: tx.flw_ref, status: flwStatus,
  });
  return false;
}

/** Reverses a pending withdrawal's debit hold and marks it failed (exact kobo). */
async function refundPendingWithdrawal(tx, reason) {
  return withTransaction(async (t) => {
    const fresh = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh || fresh.status !== 'pending') return fresh;

    const wallet = await Wallet.findOne({ where: { id: fresh.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
    wallet.balance = fromKobo(sumKobo(wallet.balance, fresh.amount));
    await wallet.save({ transaction: t });

    fresh.status = 'failed';
    fresh.meta = reason;
    await fresh.save({ transaction: t });
    return fresh;
  }, { context: 'webhookTransferRefund', tx_ref: tx.tx_ref });
}

module.exports = {
  getWallet,
  getWalletTransactions,
  initializeTopUp,
  verifyTopUpCallback,
  verifyTopUpStatus,
  withdraw,
  transferToUser,
  handleWebhook,
};
