const { Transactions, Users, Rentals, Profile, Wallet, WalletTransactions } = require("../models");
const { Op } = require("sequelize");
const logger = require("../utils/logger");

// Wallet payment types that bring money into a user's wallet (used to compute
// "money in" for today's revenue figure; internal transfers are excluded).
const WALLET_INFLOW_TYPES = ["topup", "lock house", "house rent", "inspection fee"];

// The wallet ledger stores successful payouts as 'success', while the legacy
// rent `transactions` table uses 'completed'. Normalise admin filters so a
// single status value behaves the same across both sources.
function normalizeStatus(status) {
  if (!status) return undefined;
  const s = status.toLowerCase();
  if (["completed", "success", "pending", "failed"].includes(s)) {
    return s === "completed" ? "success" : s;
  }
  return undefined;
}

function personRows(user) {
  const name = user?.full_name || "";
  const first = name.split(" ")[0] || "";
  const last = name.split(" ").slice(1).join(" ") || "";
  return { first, last };
}

// ─────────────────────────────────────────────
// GET /admin/transactions/stats
// ─────────────────────────────────────────────
async function getTransactionStats(req, res) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // ── Legacy rent transactions ──
    const [rentCompleted, rentPending, rentFailed, rentToday] = await Promise.all([
      Transactions.count({ where: { status: "completed" } }),
      Transactions.count({ where: { status: "pending" } }),
      Transactions.count({ where: { status: "failed" } }),
      Transactions.findAll({
        where: { status: "completed", createdAt: { [Op.between]: [todayStart, todayEnd] } },
        attributes: ["amount"],
      }),
    ]);
    const rentTodaySum = rentToday.reduce((sum, t) => sum + (t.amount || 0), 0);

    // ── Wallet ledger ──
    const [walletSuccess, walletPending, walletFailed, walletToday] = await Promise.all([
      WalletTransactions.count({ where: { status: "success" } }),
      WalletTransactions.count({ where: { status: "pending" } }),
      WalletTransactions.count({ where: { status: "failed" } }),
      WalletTransactions.findAll({
        where: { status: "success", createdAt: { [Op.between]: [todayStart, todayEnd] } },
        attributes: ["type", "amount"],
      }),
    ]);
    const walletTodaySum = walletToday.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const walletTodayInflow = walletToday
      .filter((t) => WALLET_INFLOW_TYPES.includes(t.type))
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    return res.status(200).json({
      success: true,
      message: "Transaction stats fetched successfully",
      data: {
        totalToday: rentTodaySum + walletTodaySum,
        revenueToday: rentTodaySum + walletTodayInflow,
        completed: rentCompleted + walletSuccess,
        pending: rentPending + walletPending,
        failed: rentFailed + walletFailed,
      },
    });
  } catch (error) {
    logger.error("Error fetching transaction stats", { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/transactions
// Searchable, filterable, paginated feed across BOTH ledgers — the legacy
// `transactions` table (rent-era payments) and the `wallet_transactions`
// ledger (top-ups, withdrawals, transfers, lock/rent/inspection fees).
// A single SQL UNION gives correct chronological pagination across the two.
// ─────────────────────────────────────────────
async function getAllTransactions(req, res) {
  const { sequelize } = require("../models");
  const {
    status,
    search,
    method,
    dateFrom,
    dateTo,
    page = 1,
    limit = 10,
  } = req.query;

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const statusFilter = normalizeStatus(status);
  const hasDate = !!(dateFrom || dateTo);

  // ── Build per-source WHERE clauses for the UNION ──
  const rentClauses = [];
  const rentParams = {};
  if (statusFilter) {
    rentClauses.push('"status" = :rent_status');
    rentParams.rent_status = statusFilter === "success" ? "completed" : statusFilter;
  }
  if (method) {
    rentClauses.push('"payment_type" = :rent_method');
    rentParams.rent_method = method;
  }
  if (hasDate) {
    rentClauses.push('"createdAt" BETWEEN :date_from AND :date_to');
  }
  if (search) {
    rentClauses.push('"reference" ILIKE :search');
    rentParams.search = `%${search}%`;
  }
  const rentWhere = rentClauses.length ? `WHERE ${rentClauses.join(' AND ')}` : '';

  const walletClauses = [];
  const walletParams = {};
  if (statusFilter && ["success", "pending", "failed"].includes(statusFilter)) {
    walletClauses.push('"status" = :wallet_status');
    walletParams.wallet_status = statusFilter;
  }
  if (method) {
    walletClauses.push('"type" = :wallet_method');
    walletParams.wallet_method = method;
  }
  if (hasDate) {
    walletClauses.push('"createdAt" BETWEEN :date_from AND :date_to');
  }
  if (search) {
    walletClauses.push('("tx_ref" ILIKE :search OR "narration" ILIKE :search)');
    walletParams.search = `%${search}%`;
  }
  const walletWhere = walletClauses.length ? `WHERE ${walletClauses.join(' AND ')}` : '';

  const replacements = {
    rent_status: null, rent_method: null,
    wallet_status: null, wallet_method: null,
    search: null,
    date_from: dateFrom ? new Date(dateFrom) : null,
    date_to: dateTo ? (() => { const d = new Date(dateTo); d.setHours(23, 59, 59, 999); return d; })() : null,
    limit: safeLimit,
    offset,
  };
  Object.assign(replacements, rentParams, walletParams);

  try {
    const unionSql = `
      (SELECT 'rent' AS source, id::text AS id, "createdAt" AS created_at
         FROM transactions
         ${rentWhere})
      UNION ALL
      (SELECT 'wallet' AS source, id::text AS id, "createdAt" AS created_at
         FROM wallet_transactions
         ${walletWhere})
      ORDER BY created_at DESC, id DESC
      LIMIT :limit OFFSET :offset`;

    const pageRows = await sequelize.query(unionSql, {
      replacements,
      type: sequelize.QueryTypes.SELECT,
    });

    const countSql = `
      SELECT COUNT(*) AS total FROM (
        SELECT id::text AS id FROM transactions ${rentWhere}
        UNION ALL
        SELECT id::text AS id FROM wallet_transactions ${walletWhere}
      ) AS combined`;

    const [{ total }] = await sequelize.query(countSql, {
      replacements,
      type: sequelize.QueryTypes.SELECT,
    });

    const rentIds = pageRows.filter((r) => r.source === "rent").map((r) => r.id);
    const walletIds = pageRows.filter((r) => r.source === "wallet").map((r) => r.id);

    const [rentRows, walletRows] = await Promise.all([
      rentIds.length
        ? Transactions.findAll({
            where: { id: { [Op.in]: rentIds } },
            include: [
              {
                model: Users,
                attributes: ["id", "full_name", "email", "phone_no"],
                include: [
                  { model: Profile, attributes: ["image"] },
                  { model: Wallet, attributes: ["accountName", "accountNumber"] },
                ],
              },
              {
                model: Rentals,
                attributes: ["id", "title", "location", "slug"],
                include: [
                  {
                    model: Users,
                    attributes: ["id", "full_name"],
                    include: [
                      { model: Wallet, attributes: ["accountName", "accountNumber"] },
                    ],
                  },
                ],
              },
            ],
          })
        : [],
      walletIds.length
        ? WalletTransactions.findAll({
            where: { id: { [Op.in]: walletIds } },
            include: [
              { model: Wallet, attributes: ["accountName", "accountNumber"] },
              {
                model: Users,
                attributes: ["id", "full_name", "email", "phone_no"],
                include: [{ model: Profile, attributes: ["image"] }],
              },
            ],
          })
        : [],
    ]);

    const data = [];

    for (const t of rentRows) {
      const json = t.toJSON();
      json.source = "rent";
      if (json.User) {
        const { first, last } = personRows(json.User);
        json.User.first_name = first;
        json.User.last_name = last;
        json.User.accountNumber = json.User.Wallet?.accountNumber || null;
        json.User.accountName = json.User.Wallet?.accountName || null;
        delete json.User.Wallet;
      }
      if (json.Rental && json.Rental.User) {
        const { first, last } = personRows(json.Rental.User);
        json.Rental.User.first_name = first;
        json.Rental.User.last_name = last;
        json.Rental.User.accountNumber = json.Rental.User.Wallet?.accountNumber || null;
        json.Rental.User.accountName = json.Rental.User.Wallet?.accountName || null;
        delete json.Rental.User.Wallet;
      }
      data.push(json);
    }

    for (const wtx of walletRows) {
      const u = wtx.User;
      const { first, last } = personRows(u);
      data.push({
        id: wtx.id,
        source: "wallet",
        user_id: wtx.user_id,
        amount: Number(wtx.amount),
        payment_type: wtx.type,
        status: wtx.status,
        reference: wtx.tx_ref,
        flw_ref: wtx.flw_ref,
        narration: wtx.narration,
        role: wtx.role,
        from_account_number: wtx.from_account_number,
        from_account_name: wtx.from_account_name,
        to_account_number: wtx.to_account_number,
        to_account_name: wtx.to_account_name,
        meta: wtx.meta,
        createdAt: wtx.createdAt,
        updatedAt: wtx.updatedAt,
        User: {
          id: u ? u.id : wtx.user_id,
          full_name: u ? u.full_name : null,
          email: u ? u.email : null,
          phone_no: u ? u.phone_no : null,
          first_name: first,
          last_name: last,
          accountNumber: wtx.Wallet?.accountNumber || null,
          accountName: wtx.Wallet?.accountName || null,
        },
        Rental: null,
      });
    }

    // The UNION already returned the page in global order — sort the merged
    // rows the same way so the array matches the SQL ordering exactly.
    data.sort((a, b) => {
      const byDate = new Date(b.createdAt) - new Date(a.createdAt);
      if (byDate !== 0) return byDate;
      return String(a.id) < String(b.id) ? 1 : -1;
    });

    return res.status(200).json({
      success: true,
      message: "Transactions fetched successfully",
      data,
      pagination: {
        total: Number(total),
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(Number(total) / safeLimit),
      },
    });
  } catch (error) {
    logger.error("Error fetching transactions", { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/transactions/:id
// Looks up the id in both the rent transactions and the wallet ledger.
// ─────────────────────────────────────────────
async function getTransaction(req, res) {
  try {
    const { id } = req.params;
    const raw = String(id).trim();

    // The legacy `transactions` table uses integer ids while wallet
    // transactions use UUIDs. Postgres rejects a value of the wrong shape at
    // the query level, so only query each table when the id matches its type.
    const isIntegerId = /^\d+$/.test(raw);
    const isUuidId = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw);

    let rentTransaction = null;
    if (isIntegerId) {
      rentTransaction = await Transactions.findOne({
        where: { id: parseInt(id, 10) },
      include: [
        {
          model: Users,
          attributes: ["id", "full_name", "email", "phone_no"],
          include: [
            { model: Profile, attributes: ["image", "verified"] },
            { model: Wallet, attributes: ["accountName", "accountNumber", "balance", "status"] },
          ],
        },
        {
          model: Rentals,
          attributes: ["id", "title", "location", "slug", "price", "priceType", "images"],
          include: [
            {
              model: Users,
              attributes: ["id", "full_name", "phone_no"],
              include: [
                { model: Profile, attributes: ["image"] },
                { model: Wallet, attributes: ["accountName", "accountNumber"] },
              ],
            },
          ],
        },
      ],
    });
    }

    if (rentTransaction) {
      const data = rentTransaction.toJSON();
      data.source = "rent";

      if (data.User) {
        const { first, last } = personRows(data.User);
        data.User.first_name = first;
        data.User.last_name = last;
        data.User.accountNumber = data.User.Wallet?.accountNumber || null;
        data.User.accountName = data.User.Wallet?.accountName || null;
        data.User.walletBalance = data.User.Wallet?.balance || null;
        data.User.walletStatus = data.User.Wallet?.status || null;
        delete data.User.Wallet;
      }

      if (data.Rental && data.Rental.User) {
        const { first, last } = personRows(data.Rental.User);
        data.Rental.User.first_name = first;
        data.Rental.User.last_name = last;
        data.Rental.User.accountNumber = data.Rental.User.Wallet?.accountNumber || null;
        data.Rental.User.accountName = data.Rental.User.Wallet?.accountName || null;
        delete data.Rental.User.Wallet;
      }

      return res.status(200).json({
        success: true,
        message: "Transaction fetched successfully",
        data,
      });
    }

    let walletTransaction = null;
    if (isUuidId) {
      walletTransaction = await WalletTransactions.findOne({
        where: { id: raw },
        include: [
          { model: Wallet, attributes: ["accountName", "accountNumber", "balance", "status"] },
          {
            model: Users,
            attributes: ["id", "full_name", "email", "phone_no"],
            include: [{ model: Profile, attributes: ["image", "verified"] }],
          },
        ],
      });
    }

    if (!walletTransaction) {
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }

    const u = walletTransaction.User;
    const { first, last } = personRows(u);

    const data = {
      id: walletTransaction.id,
      source: "wallet",
      user_id: walletTransaction.user_id,
      amount: Number(walletTransaction.amount),
      payment_type: walletTransaction.type,
      status: walletTransaction.status,
      reference: walletTransaction.tx_ref,
      flw_ref: walletTransaction.flw_ref,
      narration: walletTransaction.narration,
      role: walletTransaction.role,
      from_account_number: walletTransaction.from_account_number,
      from_account_name: walletTransaction.from_account_name,
      to_account_number: walletTransaction.to_account_number,
      to_account_name: walletTransaction.to_account_name,
      meta: walletTransaction.meta,
      createdAt: walletTransaction.createdAt,
      updatedAt: walletTransaction.updatedAt,
      User: {
        id: u ? u.id : walletTransaction.user_id,
        full_name: u ? u.full_name : null,
        email: u ? u.email : null,
        phone_no: u ? u.phone_no : null,
        first_name: first,
        last_name: last,
        accountNumber: walletTransaction.Wallet?.accountNumber || null,
        accountName: walletTransaction.Wallet?.accountName || null,
        walletBalance: walletTransaction.Wallet?.balance || null,
        walletStatus: walletTransaction.Wallet?.status || null,
      },
      Rental: null,
    };

    return res.status(200).json({
      success: true,
      message: "Transaction fetched successfully",
      data,
    });
  } catch (error) {
    logger.error("Error fetching transaction", { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { getTransactionStats, getAllTransactions, getTransaction };