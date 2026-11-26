'use strict';
const { Model } = require('sequelize');

// A guest's review of a completed shortlet stay (one per booking).
module.exports = (sequelize, DataTypes) => {
  class ShortletReviews extends Model {
    static associate(models) {
      ShortletReviews.belongsTo(models.ShortletBookings, { foreignKey: 'booking_id', as: 'booking' });
      ShortletReviews.belongsTo(models.Shortlets, { foreignKey: 'shortlet_id', as: 'shortlet' });
      ShortletReviews.belongsTo(models.Users, { foreignKey: 'guest_id', as: 'guest' });
      ShortletReviews.belongsTo(models.Users, { foreignKey: 'host_id', as: 'host' });
    }
  }

  ShortletReviews.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    booking_id: { type: DataTypes.UUID, allowNull: false, unique: true },
    shortlet_id: { type: DataTypes.UUID, allowNull: false },
    guest_id: { type: DataTypes.UUID, allowNull: false },
    host_id: { type: DataTypes.UUID, allowNull: true },
    rating: { type: DataTypes.SMALLINT, allowNull: false, validate: { min: 1, max: 5 } },
    comment: { type: DataTypes.TEXT, allowNull: false },
    stay_check_in: { type: DataTypes.DATEONLY, allowNull: false },
    stay_check_out: { type: DataTypes.DATEONLY, allowNull: false },
    host_response: { type: DataTypes.TEXT, allowNull: true },
    host_responded_at: { type: DataTypes.DATE, allowNull: true },
    host_response_updated_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    sequelize,
    modelName: 'ShortletReviews',
    tableName: 'shortlet_reviews',
    timestamps: true,
  });

  return ShortletReviews;
};
