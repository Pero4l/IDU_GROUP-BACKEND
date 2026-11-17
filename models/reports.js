'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Reports extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
      Reports.belongsTo(models.Users, {
        foreignKey: "user_id",
        as: "user"
      });

      Reports.belongsTo(models.Users, {
        foreignKey: "report_user_id",
        as: "report_user"
      });

      Reports.belongsTo(models.WalletTransactions, {
        foreignKey: "wallet_transaction_id",
        as: "wallet_transaction"
      });
    }
  }
  Reports.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false
    },
    user_id: DataTypes.UUID,
    report_user_id: DataTypes.UUID,
    report_name: DataTypes.STRING,
    report_number: DataTypes.STRING,
    // 'user' = about another user (report_user_id set); 'wallet' = a wallet problem
    report_category: {
      type: DataTypes.ENUM('user', 'wallet'),
      allowNull: false,
      defaultValue: 'user',
    },
    wallet_transaction_id: DataTypes.UUID,
    transaction_ref: DataTypes.STRING,
    report_type: DataTypes.ENUM(
      'spam', 'harassment', 'fraud', 'other',
      'failed_transaction', 'missing_funds', 'wrong_charge', 'refund_issue', 'withdrawal_issue'
    ),
    report_message: DataTypes.TEXT,
    report_status: DataTypes.ENUM('pending', 'resolved', 'rejected')
  }, {
    sequelize,
    modelName: 'Reports',
    tableName: 'reports',
  });
  return Reports;
};