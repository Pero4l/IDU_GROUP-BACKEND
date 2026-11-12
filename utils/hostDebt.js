'use strict';

// Host debts — money a host owes back to the platform.
//
// Created when a guest ends a stay early AFTER the host was paid, and the
// host's wallet can't cover the refund for the unused nights. The guest is
// always refunded in full straight away; the shortfall becomes a debt here.
//
// Recovery is automatic and always comes FIRST:
//   - before the host withdraws, transfers or pays for anything
//     (withdraw / transfer / chargeMarketplacePayment call recoverHostDebt
//     right after locking the wallet, so the debt can't be dodged), and
//   - from any money that lands in the wallet (shortlet payouts here, and the
//     settlement job sweeps everything else: top-ups, rent/lock income, …).
//
// All functions take the caller's transaction and an already-LOCKED wallet,
// so recovery is part of the same atomic operation as the money movement.

const crypto = require('crypto');
const { HostDebts, WalletTransactions } = require('../models');
const { toKobo, fromKobo } = require('./money');

async function openDebts(userId, t) {
  return HostDebts.findAll({
    where: { host_id: userId, status: 'open' },
    order: [['createdAt', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

/** Total still owed by a user, in kobo (read-only, no lock). */
async function outstandingDebtKobo(userId, transaction) {
  const debts = await HostDebts.findAll({ where: { host_id: userId, status: 'open' }, attributes: ['amount', 'recovered_amount'], transaction });
  return debts.reduce((sum, d) => sum + toKobo(d.amount) - toKobo(d.recovered_amount), 0);
}

/**
 * Takes as much of the user's open debts as their (locked) wallet balance
 * allows, oldest debt first. Writes one ledger row per debt touched.
 * Returns the kobo recovered.
 */
async function recoverHostDebt(userId, wallet, t) {
  if (!userId || !wallet || wallet.status !== 'ACTIVE') return 0;
  const debts = await openDebts(userId, t);
  if (!debts.length) return 0;
  const { applyKoboDelta } = require('./wallet'); // lazy: wallet.js also requires this file

  let recovered = 0;
  for (const debt of debts) {
    const available = toKobo(wallet.balance);
    if (available <= 0) break;
    const owed = toKobo(debt.amount) - toKobo(debt.recovered_amount);
    const take = Math.min(available, owed);
    if (take <= 0) continue;

    await applyKoboDelta(wallet, -take, t);
    await WalletTransactions.create({
      wallet_id: wallet.id,
      user_id: userId,
      tx_ref: `RENTULO-DEBTRECOVERY-${crypto.randomUUID()}`,
      type: 'shortlet booking',
      role: 'payer',
      amount: fromKobo(take),
      status: 'success',
      narration: 'Recovered: amount owed for a guest refund (stay ended early)',
      from_account_number: wallet.accountNumber,
      from_account_name: wallet.accountName,
      to_account_name: 'RentULO',
      meta: { reason: 'debt_recovery', host_debt_id: debt.id, booking_id: debt.booking_id },
    }, { transaction: t });

    debt.recovered_amount = fromKobo(toKobo(debt.recovered_amount) + take);
    if (toKobo(debt.recovered_amount) >= toKobo(debt.amount)) {
      debt.status = 'settled';
      debt.settled_at = new Date();
    }
    await debt.save({ transaction: t });
    recovered += take;
  }
  return recovered;
}

/** Records a new debt (inside the cancellation's transaction). */
async function createHostDebt({ hostId, bookingId, amountKobo, reason }, t) {
  if (!hostId || amountKobo <= 0) return null;
  return HostDebts.create({
    host_id: hostId,
    booking_id: bookingId || null,
    amount: fromKobo(amountKobo),
    reason: reason || null,
  }, { transaction: t });
}

/**
 * Recovers a user's debt in its OWN committed transaction. Call this before
 * a money movement (withdraw / transfer / payment): if that movement then
 * fails (e.g. insufficient balance), the debt recovery still stands instead
 * of being rolled back with it. Cheap no-op when nothing is owed.
 */
async function settleHostDebtNow(userId) {
  if (!userId) return 0;
  const owed = await HostDebts.count({ where: { host_id: userId, status: 'open' } });
  if (!owed) return 0;
  const { withTransaction } = require('./rollback');
  const { Wallet } = require('../models');
  return withTransaction(async (t) => {
    const wallet = await Wallet.findOne({ where: { user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
    return recoverHostDebt(userId, wallet, t);
  }, { context: 'settleHostDebtNow', userId });
}

/** Hosts that currently owe something (for the settlement job sweep). */
async function hostsWithOpenDebts(limit = 200) {
  const rows = await HostDebts.findAll({
    where: { status: 'open' },
    attributes: ['host_id'],
    group: ['host_id'],
    limit,
    raw: true,
  });
  return rows.map((r) => r.host_id);
}

module.exports = { outstandingDebtKobo, recoverHostDebt, settleHostDebtNow, createHostDebt, hostsWithOpenDebts };
