const axios = require('axios');
const logger = require('./logger');

const BASE_URL = 'https://api.flutterwave.com/v3';

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Starts a hosted-checkout charge. Returns the payment link to redirect the
 * user to; the actual result is confirmed later via webhook/verify, never
 * trusted from this call alone.
 */
async function initializePayment({ tx_ref, amount, email, name, redirect_url, meta }) {
  const response = await client().post('/payments', {
    tx_ref,
    amount,
    currency: 'NGN',
    redirect_url,
    customer: { email, name },
    meta,
  });
  return response.data;
}

/** Authoritative check of a charge's outcome — always call this before crediting a wallet. */
async function verifyTransactionById(transactionId) {
  const response = await client().get(`/transactions/${transactionId}/verify`);
  return response.data;
}

async function verifyTransactionByRef(tx_ref) {
  const response = await client().get('/transactions/verify_by_reference', {
    params: { tx_ref },
  });
  return response.data;
}

/** Sends money out to a bank account. Result is asynchronous — confirmed via the transfer webhook. */
async function initiateTransfer({ account_bank, account_number, amount, narration, reference }) {
  const response = await client().post('/transfers', {
    account_bank,
    account_number,
    amount,
    narration,
    currency: 'NGN',
    reference,
  });
  return response.data;
}

async function getTransferStatus(transferId) {
  const response = await client().get(`/transfers/${transferId}`);
  return response.data;
}

let bankListCache = { country: null, fetchedAt: 0, banks: [] };
const BANK_LIST_TTL_MS = 60 * 60 * 1000; // 1 hour — bank lists rarely change

async function getBanks(country = 'NG') {
  const isFresh = bankListCache.country === country &&
    (Date.now() - bankListCache.fetchedAt) < BANK_LIST_TTL_MS;
  if (isFresh) return bankListCache.banks;

  const response = await client().get(`/banks/${country}`);
  const banks = response.data.data || [];
  bankListCache = { country, fetchedAt: Date.now(), banks };
  return banks;
}

/** Matches a free-text bank name (as stored on the profile) to Flutterwave's bank code. */
async function resolveBankCode(bankName) {
  if (!bankName) return null;
  const banks = await getBanks('NG');
  const normalized = bankName.trim().toLowerCase();
  const match = banks.find((b) => b.name.trim().toLowerCase() === normalized) ||
    banks.find((b) => b.name.trim().toLowerCase().includes(normalized) || normalized.includes(b.name.trim().toLowerCase()));
  if (!match) {
    logger.warn('Could not resolve bank code from bank name', { bankName });
    return null;
  }
  return match.code;
}

module.exports = {
  initializePayment,
  verifyTransactionById,
  verifyTransactionByRef,
  initiateTransfer,
  getTransferStatus,
  getBanks,
  resolveBankCode,
};
