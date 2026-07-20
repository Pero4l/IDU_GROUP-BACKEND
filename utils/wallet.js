const crypto = require('crypto');
const { Wallet, WalletTransactions } = require('../models');
const { withTransaction } = require('./rollback');

const ACCOUNT_PREFIX = 'RentULO-';

class InsufficientBalanceError extends Error {
  constructor(message = 'Insufficient wallet balance. Please top up your wallet to continue.') {
    super(message);
    this.name = 'InsufficientBalanceError';
    this.code = 'INSUFFICIENT_BALANCE';
  }
}

function randomFiveDigits() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

/**
 * Keeps generating "RentULO-XXXXX" numbers and checking the wallets table
 * until one is found that isn't already taken.
 */
async function generateUniqueAccountNumber(transaction) {
  let accountNumber;
  let existing;
  do {
    accountNumber = `${ACCOUNT_PREFIX}${randomFiveDigits()}`;
    existing = await Wallet.findOne({ where: { accountNumber }, transaction });
  } while (existing);
  return accountNumber;
}

/**
 * Creates a wallet for a newly created/verified user with a guaranteed-unique
 * account number. Meant to be called inside the same transaction as the
 * user's creation.
 */
async function createWalletForUser(user, transaction) {
  const accountNumber = await generateUniqueAccountNumber(transaction);
  return Wallet.create({
    user_id: user.id,
    accountName: user.full_name,
    accountNumber,
    balance: 0,
    status: 'ACTIVE',
  }, { transaction });
}

/**
 * Debits a payer's wallet for a marketplace payment (lock fee, rent, or
 * inspection fee) and splits it between the landlord and the platform.
 * `commissionPercent` is the % the platform keeps — the rest goes to the
 * landlord's wallet. Throws InsufficientBalanceError if the payer can't
 * afford it; nothing is debited in that case.
 *
 * If the landlord has no wallet (or theirs is inactive), their share simply
 * isn't credited to anyone — it's logged, not blocking, rather than failing
 * the payer's payment over an unrelated account problem.
 *
 * `applyEffects(t)`, if given, runs inside the SAME database transaction as
 * the charge, right before it commits — e.g. marking a house locked, a
 * rental rented, or creating the inspection row. If it throws, the whole
 * transaction (charge included) rolls back, so a caller can never end up
 * charged with nothing to show for it.
 */
async function chargeMarketplacePayment({ payerUserId, landlordUserId, amount, commissionPercent, type, narration, applyEffects }) {
  const roundedAmount = Math.round(Number(amount) * 100) / 100;
  const pct = Math.min(100, Math.max(0, Number(commissionPercent)));

  return withTransaction(async (t) => {
    // Lock payer & landlord wallets in a fixed order (by user id) so two
    // marketplace payments crossing the same pair of users can't deadlock.
    const userIds = [...new Set([payerUserId, landlordUserId].filter(Boolean))].sort();
    const walletsByUser = {};
    for (const uid of userIds) {
      walletsByUser[uid] = await Wallet.findOne({ where: { user_id: uid }, transaction: t, lock: t.LOCK.UPDATE });
    }

    const payerWallet = walletsByUser[payerUserId];
    if (!payerWallet) {
      const err = new Error('Wallet not found');
      err.code = 'WALLET_NOT_FOUND';
      throw err;
    }
    if (payerWallet.status !== 'ACTIVE') {
      const err = new Error('Wallet is not active');
      err.code = 'WALLET_INACTIVE';
      throw err;
    }
    if (Number(payerWallet.balance) < roundedAmount) {
      throw new InsufficientBalanceError();
    }

    const landlordWallet = landlordUserId ? walletsByUser[landlordUserId] : null;
    const landlordIsPayable = !!landlordWallet && landlordWallet.status === 'ACTIVE' && landlordUserId !== payerUserId;
    const share = landlordIsPayable ? Math.round((roundedAmount * (100 - pct) / 100) * 100) / 100 : 0;
    const platformShare = roundedAmount - share;

    payerWallet.balance = Number(payerWallet.balance) - roundedAmount;
    await payerWallet.save({ transaction: t });

    if (landlordIsPayable && share > 0) {
      landlordWallet.balance = Number(landlordWallet.balance) + share;
      await landlordWallet.save({ transaction: t });
    }

    const splitMeta = { commissionPercent: pct, landlordShare: share, platformShare };

    await WalletTransactions.create({
      wallet_id: payerWallet.id,
      user_id: payerUserId,
      tx_ref: `RENTULO-${type.replace(/\s+/g, '').toUpperCase()}-${crypto.randomUUID()}`,
      type,
      role: 'payer',
      amount: roundedAmount,
      status: 'success',
      narration,
      from_account_number: payerWallet.accountNumber,
      from_account_name: payerWallet.accountName,
      to_account_number: landlordIsPayable ? landlordWallet.accountNumber : null,
      to_account_name: landlordIsPayable ? landlordWallet.accountName : null,
      meta: splitMeta,
    }, { transaction: t });

    if (landlordIsPayable && share > 0) {
      await WalletTransactions.create({
        wallet_id: landlordWallet.id,
        user_id: landlordUserId,
        tx_ref: `RENTULO-${type.replace(/\s+/g, '').toUpperCase()}-${crypto.randomUUID()}`,
        type,
        role: 'landlord',
        amount: share,
        status: 'success',
        narration: `${narration} (received)`,
        from_account_number: payerWallet.accountNumber,
        from_account_name: payerWallet.accountName,
        to_account_number: landlordWallet.accountNumber,
        to_account_name: landlordWallet.accountName,
        meta: splitMeta,
      }, { transaction: t });
    }

    const effects = typeof applyEffects === 'function' ? await applyEffects(t) : undefined;

    return {
      payerBalance: payerWallet.balance,
      landlordBalance: landlordIsPayable ? landlordWallet.balance : null,
      landlordShare: share,
      platformShare,
      amount: roundedAmount,
      effects,
    };
  }, { context: 'chargeMarketplacePayment', payerUserId, landlordUserId, type, amount: roundedAmount });
}

module.exports = { generateUniqueAccountNumber, createWalletForUser, chargeMarketplacePayment, InsufficientBalanceError };
