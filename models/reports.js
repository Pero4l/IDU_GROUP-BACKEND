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
    }
  }
  Reports.init({
    user_id: DataTypes.UUID,
    report_user_id: DataTypes.UUID,
    report_name: DataTypes.STRING,
    report_type: DataTypes.STRING,
    report_message: DataTypes.STRING,
    report_status: DataTypes.STRING
  }, {
    sequelize,
    modelName: 'Reports',
    tableName: 'reports',
  });
  return Reports;
};