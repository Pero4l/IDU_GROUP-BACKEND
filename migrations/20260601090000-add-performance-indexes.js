'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. rentals table indexes
    await queryInterface.addIndex('rentals', ['UserId'], { name: 'rentals_user_id_idx' });
    await queryInterface.addIndex('rentals', ['slug'], { name: 'rentals_slug_idx' });

    // 2. progresses table indexes
    await queryInterface.addIndex('progresses', ['user_id', 'rental_id'], { name: 'progresses_user_id_rental_id_idx' });
    await queryInterface.addIndex('progresses', ['rental_id', 'locked'], { name: 'progresses_rental_id_locked_idx' });

    // 3. notifications table indexes
    await queryInterface.addIndex('notifications', ['user_id'], { name: 'notifications_user_id_idx' });

    // 4. Conversations table indexes
    await queryInterface.addIndex('Conversations', ['tenant_id'], { name: 'conversations_tenant_id_idx' });
    await queryInterface.addIndex('Conversations', ['landlord_id'], { name: 'conversations_landlord_id_idx' });

    // 5. Messages table indexes
    await queryInterface.addIndex('Messages', ['conversation_id'], { name: 'messages_conversation_id_idx' });

    // 6. Transactions table indexes
    await queryInterface.addIndex('Transactions', ['reference'], { name: 'transactions_reference_idx' });
  },
  
  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('rentals', 'rentals_user_id_idx');
    await queryInterface.removeIndex('rentals', 'rentals_slug_idx');
    await queryInterface.removeIndex('progresses', 'progresses_user_id_rental_id_idx');
    await queryInterface.removeIndex('progresses', 'progresses_rental_id_locked_idx');
    await queryInterface.removeIndex('notifications', 'notifications_user_id_idx');
    await queryInterface.removeIndex('Conversations', 'conversations_tenant_id_idx');
    await queryInterface.removeIndex('Conversations', 'conversations_landlord_id_idx');
    await queryInterface.removeIndex('Messages', 'messages_conversation_id_idx');
    await queryInterface.removeIndex('Transactions', 'transactions_reference_idx');
  }
};
