// Rent pricing rules for long-term rentals.
//
// First payment ("initial"): price + legalFee + cautionFee + brokeFee + mgtServiceCharge.
// Every later payment ("renewal"): the basic rent only — `rentals.price` —
// and it extends the tenancy by one rent period (month or year).

const money = (v) => parseFloat(v) || 0;

function addRentPeriod(date, priceType) {
  if (priceType !== 'monthly' && priceType !== 'yearly') return null;
  const d = new Date(date);
  if (priceType === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

function initialBreakdown(rental) {
  const breakdown = {
    basicRent: money(rental.price),
    legalFee: money(rental.legalFee),
    cautionFee: money(rental.cautionFee),
    brokeFee: money(rental.brokeFee),
    mgtServiceCharge: money(rental.mgtServiceCharge),
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { breakdown, total };
}

/**
 * Works out what `userId` would pay right now for `rental`, given its active
 * tenancy (or null). Returns { kind, amount, breakdown } or { error, code }.
 */
function quoteRent(rental, activeTenancy, userId, now = new Date()) {
  const isOccupied = rental.status === 'rented' || !!activeTenancy;

  if (!isOccupied) {
    const { breakdown, total } = initialBreakdown(rental);
    return { kind: 'initial', amount: total, breakdown };
  }

  if (!activeTenancy || activeTenancy.tenant_id !== userId) {
    return { error: 'This property has already been rented', code: 'ALREADY_RENTED' };
  }
  if (!addRentPeriod(now, rental.priceType)) {
    return { error: 'This property was a one-time payment, so there is no rent to renew', code: 'NOT_RENEWABLE' };
  }
  if (!canRenewNow(activeTenancy, rental.priceType, now)) {
    return { error: 'Your rent is already paid more than one period ahead', code: 'RENEWAL_TOO_EARLY' };
  }

  const basicRent = money(rental.price);
  return { kind: 'renewal', amount: basicRent, breakdown: { basicRent } };
}

// A tenant may pay at most one period ahead: renewing is allowed while the
// current end date is no further out than one period from now. This also
// stops a double-click from charging two renewals.
function canRenewNow(tenancy, priceType, now = new Date()) {
  const limit = addRentPeriod(now, priceType);
  return !!limit && (!tenancy.end_date || new Date(tenancy.end_date) <= limit);
}

// Renewals continue from the current end date, or from today if it lapsed.
function renewedEndDate(tenancy, priceType, now = new Date()) {
  const end = tenancy.end_date ? new Date(tenancy.end_date) : now;
  return addRentPeriod(end > now ? end : now, priceType);
}

// What the landlord dashboard shows: 'active', 'expired' (end date passed,
// not renewed yet), or 'ended'.
function tenancyDisplayStatus(tenancy, now = new Date()) {
  if (!tenancy) return 'unknown';
  if (tenancy.status === 'ended') return 'ended';
  return tenancy.end_date && new Date(tenancy.end_date) < now ? 'expired' : 'active';
}

module.exports = { addRentPeriod, initialBreakdown, quoteRent, canRenewNow, renewedEndDate, tenancyDisplayStatus };
