'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Guest reviews of a completed shortlet stay: one overall 1–5 rating and a
  // written review per booking, plus one public host response.
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('shortlet_reviews', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      // UNIQUE: one review per booking, enforced by the database.
      booking_id: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: { model: 'shortlet_bookings', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      shortlet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'shortlets', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      guest_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      host_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      rating: { type: Sequelize.SMALLINT, allowNull: false },
      comment: { type: Sequelize.TEXT, allowNull: false },
      // The stay being reviewed (shown as "Stayed in <month>")
      stay_check_in: { type: Sequelize.DATEONLY, allowNull: false },
      stay_check_out: { type: Sequelize.DATEONLY, allowNull: false },
      host_response: { type: Sequelize.TEXT, allowNull: true },
      host_responded_at: { type: Sequelize.DATE, allowNull: true },
      host_response_updated_at: { type: Sequelize.DATE, allowNull: true },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });
    await queryInterface.sequelize.query(
      'ALTER TABLE "shortlet_reviews" ADD CONSTRAINT "shortlet_reviews_rating_1_to_5" CHECK (rating BETWEEN 1 AND 5);'
    );
    await queryInterface.addIndex('shortlet_reviews', ['shortlet_id', 'createdAt']);
    await queryInterface.addIndex('shortlet_reviews', ['host_id']);
    await queryInterface.addIndex('shortlet_reviews', ['guest_id']);

    // Cached on the listing (kept in step inside the review transaction) so
    // listing and search pages don't need to aggregate reviews.
    await queryInterface.addColumn('shortlets', 'ratingAverage', { type: Sequelize.DECIMAL(3, 2), allowNull: true });
    await queryInterface.addColumn('shortlets', 'reviewCount', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('shortlets', 'reviewCount');
    await queryInterface.removeColumn('shortlets', 'ratingAverage');
    await queryInterface.dropTable('shortlet_reviews');
  },
};
