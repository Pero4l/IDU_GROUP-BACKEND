'use strict';
require('dotenv').config();

// One-off recovery for top-ups that were wrongly marked 'failed' by an earlier
// reconciliation/path while the charge was actually collected by Flutterwave
// (the "money left the user but wallet was never credited" bug).
//
// Rows still 'pending' are NOT touched here — use `npm run reconcile` for those.
// This script only revisits rows already flipped to 'failed'.
//
// It asks Flutterwave (the source of truth) whether the charge really succeeded
// and, if so, credits the wallet exactly once. Safe to re-run: credits happen
// inside a locked transaction that skips rows that already left 'failed'.
//
//   node scripts/recoverFailedTopUps.js            # credit genuinely-paid top-ups
//   node scripts/recoverFailedTopUps.js --dry-run  # report only

const { sequelize, Wallet, WalletTransactions } = require('../models');
const { withTransaction } = require('../utils/rollback');
const { verifyTransactionByRef, isForeignFlwEnvironment, getFlwEnvironment } = require('../utils/flutterwave');
const { fromKobo, sumKobo } = require('../utils/money');
const logger = require('../utils/logger');

const DRY_RUN = process.argv.includes('--dry-run');

async function creditIfGenuine(tx) {
  // The charge lives in the account that created it. With a key from another
  // environment Flutterwave answers "not found", which would wrongly confirm
  // the failure and keep real money out of the user's wallet. Skip the row —
  // re-run this with the same key the top-up was created with (check meta.flwEnv).
  if (isForeignFlwEnvironment(tx)) {
    console.log(`[TOP-SKIP-ENV] ${tx.tx_ref} — created in '${tx.meta?.flwEnv || 'unknown'}' but key is '${getFlwEnvironment()}'`);
    return;
  }

  let charge;
  try {
    const res = await verifyTransactionByRef(tx.tx_ref);
    if (res.status !== 'success' || !res.data) {
      throw new Error(res.message || `Verify failed (HTTP ${res.status})`);
    }
    charge = res.data;
  } catch (error) {
    const message = error?.response?.data?.message || error?.response?.data?.errors?.message || error?.message || 'Unknown error';
    if (/no transaction was found|not found/i.test(message)) {
      console.log(`[TOP-IGNORED] ${tx.tx_ref} — no charge at Flutterwave (truly abandoned); leaving failed`);
      return;
    }
    logger.error('Could not check failed top-up at Flutterwave — left failed for manual review', {
      tx_ref: tx.tx_ref, message,
    });
    return;
  }

  const isGenuine = charge.status === 'successful' &&
    charge.tx_ref === tx.tx_ref &&
    charge.currency === 'NGN' &&
    sumKobo(charge.amount, -tx.amount) >= 0;

  if (!isGenuine) {
    const definitiveFailed = typeof charge?.status === 'string' &&
      ['failed', 'abandoned'].includes(charge.status.toLowerCase());
    if (definitiveFailed || !charge?.status) {
      console.log(`[TOP-CONFIRM-FAILED] ${tx.tx_ref} — charge ${charge.status || 'unknown'}; leaving failed`);
    } else {
      console.log(`[TOP-UNSETTLED] ${tx.tx_ref} — charge ${charge.status}; not successful, not definitive failure; leaving failed for now`);
    }
    return;
  }

  const credited = await withTransaction(async (t) => {
    const fresh = await WalletTransactions.findOne({ where: { id: tx.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh) return false;
    // Only rows still 'failed' are eligible. Rows already 'success' (e.g. a
    // webhook snuck in first) or 'pending' (handled by reconciliation) are skipped.
    if (fresh.status !== 'failed') return false;

    const wallet = await Wallet.findOne({ where: { id: fresh.wallet_id }, transaction: t, lock: t.LOCK.UPDATE });
    wallet.balance = fromKobo(sumKobo(wallet.balance, fresh.amount));
    await wallet.save({ transaction: t });

    fresh.status = 'success';
    fresh.flw_ref = String(charge.id);
    fresh.meta = charge;
    fresh.from_account_number = charge.card ? `****${charge.card.last_4digits}` : fresh.from_account_number;
    fresh.from_account_name = charge.customer?.name || fresh.from_account_name;
    await fresh.save({ transaction: t });
    return true;
  }, { context: 'recoverFailedTopUp', tx_ref: tx.tx_ref });

  if (credited) {
    console.log(`[TOP-CREDITED] ${tx.tx_ref} (flw ${charge.id}) — wallet credited ₦${tx.amount}`);
  } else {
    console.log(`[TOP-SKIPPED] ${tx.tx_ref} — row no longer 'failed'; already handled`);
  }
}

async function main() {
  await sequelize.authenticate();

  const failed = await WalletTransactions.findAll({ where: { type: 'topup', status: 'failed' } });
  console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}Found ${failed.length} failed top-up(s) to re-check.\n`);

  for (const tx of failed) {
    if (DRY_RUN) {
      console.log(`[DRY-RUN] would re-check ${tx.tx_ref}`);
    } else {
      await creditIfGenuine(tx);
    }
  }

  console.log('\nRecovery pass complete.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Recovery crashed:', error);
      process.exit(1);
    });
}
