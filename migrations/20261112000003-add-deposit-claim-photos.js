'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Photo evidence (Cloudinary URLs) attached to a host's security deposit claim.
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('shortlet_bookings', 'deposit_claim_photos', {
      type: Sequelize.JSON, allowNull: false, defaultValue: [],
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('shortlet_bookings', 'deposit_claim_photos');
  },
};
