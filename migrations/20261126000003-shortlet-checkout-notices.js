'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Makes the post-checkout notifications send exactly once per booking:
  //   checkout_notified_at    — host "was any damage incurred?" prompt + guest review invite
  //   review_reminder_sent_at — guest review reminder before the 14-day deadline
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('shortlet_bookings', 'checkout_notified_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'review_reminder_sent_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addIndex('shortlet_bookings', ['checkout_notified_at', 'check_out']);
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('shortlet_bookings', 'review_reminder_sent_at');
    await queryInterface.removeColumn('shortlet_bookings', 'checkout_notified_at');
  },
};
