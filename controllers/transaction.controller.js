const { Transactions, Users, Rentals, Profile, Wallet } = require("../models");
const { Op } = require("sequelize");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────
// GET /admin/transactions/stats
// ─────────────────────────────────────────────
async function getTransactionStats(req, res) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const todayTransactions = await Transactions.findAll({
      where: {
        status: "completed",
        createdAt: { [Op.between]: [todayStart, todayEnd] },
      },
      attributes: ["amount"],
    });
    const totalToday = todayTransactions.reduce(
      (sum, t) => sum + (t.amount || 0),
      0,
    );

    const completed = await Transactions.count({
      where: { status: "completed" },
    });
    const pending = await Transactions.count({ where: { status: "pending" } });
    const failed = await Transactions.count({ where: { status: "failed" } });

    return res.status(200).json({
      success: true,
      message: "Transaction stats fetched successfully",
      data: { totalToday, completed, pending, failed },
    });
  } catch (error) {
    logger.error("Error fetching transaction stats", { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/transactions
// ─────────────────────────────────────────────
async function getAllTransactions(req, res) {
  try {
    const {
      status,
      search,
      method,
      dateFrom,
      dateTo,
      page = 1,
      limit = 10,
    } = req.query;

    const where = {};

    if (status) where.status = status.toLowerCase();
    if (method) where.payment_type = method;

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt[Op.gte] = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = end;
      }
    }

    if (search) {
      where[Op.or] = [{ reference: { [Op.iLike]: `%${search}%` } }];
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows } = await Transactions.findAndCountAll({
      where,
      include: [
        {
          model: Users,
          attributes: ["id", "full_name", "email", "phone_no"],
          include: [
            { model: Profile, attributes: ["image"] },
            {
              model: Wallet,
              attributes: ["accountName", "accountNumber"],
            },
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
                {
                  model: Wallet,
                  attributes: ["accountName", "accountNumber"],
                },
              ],
            },
          ],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit: parseInt(limit),
      offset,
    });

    const data = rows.map((t) => {
      const json = t.toJSON();

      // Tenant
      if (json.User) {
        const parts = (json.User.full_name || "").split(" ");
        json.User.first_name = parts[0] || "";
        json.User.last_name = parts.slice(1).join(" ") || "";
        json.User.accountNumber = json.User.Wallet?.accountNumber || null;
        json.User.accountName = json.User.Wallet?.accountName || null;
        delete json.User.Wallet;
      }

      // Landlord
      if (json.Rental && json.Rental.User) {
        const parts = (json.Rental.User.full_name || "").split(" ");
        json.Rental.User.first_name = parts[0] || "";
        json.Rental.User.last_name = parts.slice(1).join(" ") || "";
        json.Rental.User.accountNumber =
          json.Rental.User.Wallet?.accountNumber || null;
        json.Rental.User.accountName =
          json.Rental.User.Wallet?.accountName || null;
        delete json.Rental.User.Wallet;
      }

      return json;
    });

    return res.status(200).json({
      success: true,
      message: "Transactions fetched successfully",
      data,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / parseInt(limit)),
      },
    });
  } catch (error) {
    logger.error("Error fetching transactions", { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/transactions/:id
// ─────────────────────────────────────────────
async function getTransaction(req, res) {
  try {
    const { id } = req.params;

    const transaction = await Transactions.findOne({
      where: { id },
      include: [
        {
          model: Users,
          attributes: ["id", "full_name", "email", "phone_no"],
          include: [
            { model: Profile, attributes: ["image", "verified"] },
            {
              model: Wallet,
              attributes: ["accountName", "accountNumber", "balance", "status"],
            },
          ],
        },
        {
          model: Rentals,
          attributes: [
            "id",
            "title",
            "location",
            "slug",
            "price",
            "priceType",
            "images",
          ],
          include: [
            {
              model: Users,
              attributes: ["id", "full_name", "phone_no"],
              include: [
                { model: Profile, attributes: ["image"] },
                {
                  model: Wallet,
                  attributes: ["accountName", "accountNumber"],
                },
              ],
            },
          ],
        },
      ],
    });

    if (!transaction) {
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });
    }

    const data = transaction.toJSON();

    // Tenant
    if (data.User) {
      const parts = (data.User.full_name || "").split(" ");
      data.User.first_name = parts[0] || "";
      data.User.last_name = parts.slice(1).join(" ") || "";
      data.User.accountNumber = data.User.Wallet?.accountNumber || null;
      data.User.accountName = data.User.Wallet?.accountName || null;
      data.User.walletBalance = data.User.Wallet?.balance || null;
      data.User.walletStatus = data.User.Wallet?.status || null;
      delete data.User.Wallet;
    }

    // Landlord
    if (data.Rental && data.Rental.User) {
      const parts = (data.Rental.User.full_name || "").split(" ");
      data.Rental.User.first_name = parts[0] || "";
      data.Rental.User.last_name = parts.slice(1).join(" ") || "";
      data.Rental.User.accountNumber =
        data.Rental.User.Wallet?.accountNumber || null;
      data.Rental.User.accountName =
        data.Rental.User.Wallet?.accountName || null;
      delete data.Rental.User.Wallet;
    }

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
