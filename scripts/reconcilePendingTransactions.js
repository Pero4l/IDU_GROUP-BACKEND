'use strict';
require('dotenv').config();

const { sequelize, Wallet, WalletTransactions } = require('../models');
const { withTransaction } = require('../utils/rollback');
const { getTransferStatus, verifyTransactionByRef } = require('../utils/flutterwave');
const { fromKobo, sumKobo } = require('../utils/money');
const logger = require('../utils/logger');

// Settles wallet_transactions stuck in 'pending' by asking Flutterwave
// (the source of truth) what actually happened, instead of relying only on
// the transfer/charge webhook — which can be missed (unregistered webhook
// URL, secret-hash mismatch, environment change, downtime).
//
// Safe to re-run: every settlement re-checks the row inside a locked
// transaction and skips rows that already left 'pending'.
//
//   node scripts/reconcilePendingTransactions.js          # settle everything
//   node scripts/reconcilePendingTransactions.js --dry-run  # report only

const DRY_RUN = process.argv.includes('--dry-run');

async function settleWithdrawal(tx) {
  if (!tx.flw_ref) {
    logger.warn('Withdrawal has no flw_ref — cannot confirm transfer; left pending for manual review', { tx_ref: tx.tx_ref });
    return;
  }

  let transfer;
  try {
    const res = await getTransferStatus(tx.flw_ref);
    if (res.status !== 'success' || !res.data) {
      throw new Error(res.message || `Transfer lookup failed (HTTP ${res.status})`);
    }
    transfer = res.data;
  } catch (error) {
    const message = extractApiMessage(error);
    if (/not found/i.test(message)) {
      // The transfer no longer exists on the Flutterwave account that holds
      // this key — treat as never paid out and reverse the debit hold.
      console.log(`[WD:NOT-FOUND] ${tx.tx_ref} (flw ${tx.flw_ref}) — transfer does not exist, refunding hold`);
      if (!DRY_RUN) await refundWithdrawal(tx, { notFound: true, message });
      return;
    }
    logger.error('Could not check withdrawal status at Flutterwave — left pending', { tx_ref: tx.tx_ref, flw_ref: tx.flw_ref, message });
    return;
  }

  const status = transfer.status;
  if (status === 'SUCCESSFUL') {
    console.log(`[WD:SUCCESS] ${tx.tx_ref} (flw ${tx.flw_ref})`);
    if (!DRY_RUN) await markWithdrawalSuccess(tx, transfer);
  } else if (status === 'FAILED') {
    console.log(`[WD:FAILED] ${tx.tx_ref} (flw ${tx.flw_ref}) — refunding hold`);
    if (!DRY_RUN) await refundWithdrawal(tx, transfer);
  } else {
    // NEW / PENDING / PROCESSING — not settled on Flutterwave's side yet.
    logger.info('Withdrawal still in progress at Flutterwave — left pending', { tx_ref: tx.tx_ref, flw_ref: tx.flw_ref, status });
  }
}

async function settleTopUp(tx) {
  let charge;
  try {
    const res = await verifyTransactionByRef(tx.tx_ref);
    if (res.status !== 'success' || !res.data) {
      throw new Error(res.message || `Verify failed (HTTP ${res.status})`);
    }
    charge = res.data;
  } catch (error) {
    const message = extractApiMessage(error);
    if (/no transaction was found|not found/i.test(message)) {
      // The user opened the checkout but never completed the charge — it
      // never reached Flutterwave, so nothing was paid and nothing to credit.
      console.log(`[TOP:ABANDONED] ${tx.tx_ref} — no charge at Flutterwave, marking failed`);
      if (!DRY_RUN) await markTopUpFailed(tx, { abandoned: true, message });
      return;
    }
    logger.error('Could not check top-up status at Flutterwave — left pending', { tx_ref: tx.tx_ref, message });
    return;
  }

  const isGenuine = charge.status === 'successful' &&
    charge.tx_ref === tx.tx_ref &&
    charge.currency === 'NGN' &&
    sumKobo(charge.amount, -tx.amount) >= 0;

  if (isGenuine) {
    // The user WAS charged but the callback/webhook never settled the row —
    // credit the wallet exactly once.
    console.log(`[TOP:SUCCESS] ${tx.tx_ref} (flw ${charge.id}) — crediting wallet`);
    if (!DRY_RUN) await markTopUpSuccess(tx, charge);
  } else {
    console.log(`[TOP:FAILED] ${tx.tx_ref} — charge ${charge.status}, marking failed`);
    if (!DRY_RUN) await markTopUpFailed(tx, charge);
  }
}

async function markWithdrawalSuccess(tx, transfer) {
  await withTransaction(async (t) => {
    const fresh = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh || fresh.status !== 'pending') return;
    fresh.status = 'success';
    fresh.meta = transfer;
    await fresh.save({ transaction: t });
  }, { context: 'reconcileWithdrawalSuccess', tx_ref: tx.tx_ref });
}

async function refundWithdrawal(tx, reason) {
  await withTransaction(async (t) => {
    const fresh = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh || fresh.status !== 'pending') return;

    const wallet = await Wallet.findOne({ where: { id: fresh.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
    wallet.balance = fromKobo(sumKobo(wallet.balance, fresh.amount));
    await wallet.save({ transaction: t });

    fresh.status = 'failed';
    fresh.meta = reason;
    await fresh.save({ transaction: t });
  }, { context: 'reconcileWithdrawalRefund', tx_ref: tx.tx_ref });
}

async function markTopUpSuccess(tx, charge) {
  await withTransaction(async (t) => {
    const fresh = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh || fresh.status !== 'pending') return;

    const wallet = await Wallet.findOne({ where: { id: fresh.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
    wallet.balance = fromKobo(sumKobo(wallet.balance, fresh.amount));
    await wallet.save({ transaction: t });

    fresh.status = 'success';
    fresh.flw_ref = String(charge.id);
    fresh.meta = charge;
    fresh.from_account_number = charge.card ? `****${charge.card.last_4digits}` : fresh.from_account_number;
    fresh.from_account_name = charge.customer?.name || fresh.from_account_name;
    await fresh.save({ transaction: t });
  }, { context: 'reconcileTopUpCredit', tx_ref: tx.tx_ref });
}

async function markTopUpFailed(tx, reason) {
  await withTransaction(async (t) => {
    const fresh = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh || fresh.status !== 'pending') return;
    fresh.status = 'failed';
    fresh.meta = reason;
    await fresh.save({ transaction: t });
  }, { context: 'reconcileTopUpFailed', tx_ref: tx.tx_ref });
}

function extractApiMessage(error) {
  return error?.response?.data?.message || error?.response?.data?.errors?.message || error?.message || 'Unknown error';
}

async function main() {
  await sequelize.authenticate();

  const pending = await WalletTransactions.findAll({ where: { status: 'pending' } });
  console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}Found ${pending.length} pending transaction(s).\n`);

  for (const tx of pending) {
    if (tx.type === 'withdrawal') {
      await settleWithdrawal(tx);
    } else if (tx.type === 'topup') {
      await settleTopUp(tx);
    } else {
      logger.warn('Skipping non-topup/non-withdrawal pending transaction', { tx_ref: tx.tx_ref, type: tx.type });
    }
  }

  console.log('\nReconciliation complete.');
}

// Run directly only when invoked as a script (`npm run reconcile`). When this
// file is required by the server (for the scheduled cron), `main` is exported
// and driven externally so the process stays alive.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Reconciliation crashed:', error);
      process.exit(1);
    });
}

module.exports = { reconcilePendingTransactions: main };
