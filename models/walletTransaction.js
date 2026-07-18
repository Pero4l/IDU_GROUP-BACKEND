'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class WalletTransactions extends Model {
    static associate(models) {
      WalletTransactions.belongsTo(models.Wallet, { foreignKey: 'wallet_id' });
      WalletTransactions.belongsTo(models.Users, { foreignKey: 'user_id' });
    }
  }
  WalletTransactions.init({
    id: {
      primaryKey: true,
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
    },
    wallet_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    tx_ref: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    flw_ref: DataTypes.STRING,
    type: {
      type: DataTypes.ENUM(
        'topup',
        'withdrawal',
        'transfer_in',
        'transfer_out',
        'lock house',
        'house rent',
        'inspection fee',
        'refund_payment'
      ),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'success', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    narration: DataTypes.STRING,
    // Distinguishes the two ledger rows a marketplace-split payment writes
    // (lock house / house rent / inspection fee): 'payer' is the tenant's
    // debit for the full amount, 'landlord' is their share of the credit.
    // null for topup/withdrawal/transfer, which aren't split payments.
    role: DataTypes.ENUM('payer', 'landlord'),
    from_account_number: DataTypes.STRING,
    from_account_name: DataTypes.STRING,
    to_account_number: DataTypes.STRING,
    to_account_name: DataTypes.STRING,
    meta: DataTypes.JSONB,
  }, {
    sequelize,
    modelName: 'WalletTransactions',
    tableName: 'wallet_transactions',
  });
  return WalletTransactions;
};
