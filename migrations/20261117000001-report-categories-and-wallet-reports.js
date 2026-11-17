'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Reports can now be about a wallet problem (not only about another user).
  //  - report_category: 'user' (default, existing rows) | 'wallet'
  //  - wallet_transaction_id / transaction_ref: the reporter's own wallet
  //    transaction the report is about (optional)
  //  - new report_type values for wallet problems
  async up(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;
    for (const v of ['failed_transaction', 'missing_funds', 'wrong_charge', 'refund_issue', 'withdrawal_issue']) {
      await q.query(`ALTER TYPE "enum_reports_report_type" ADD VALUE IF NOT EXISTS '${v}'`);
    }
    await queryInterface.addColumn('reports', 'report_category', {
      type: Sequelize.ENUM('user', 'wallet'), allowNull: false, defaultValue: 'user',
    });
    await queryInterface.addColumn('reports', 'wallet_transaction_id', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'wallet_transactions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('reports', 'transaction_ref', { type: Sequelize.STRING, allowNull: true });
    // Messages were VARCHAR(255): longer reports failed with a 500.
    await queryInterface.changeColumn('reports', 'report_message', { type: Sequelize.TEXT });
    await queryInterface.addIndex('reports', ['report_category']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('reports', ['report_category']);
    await queryInterface.removeColumn('reports', 'transaction_ref');
    await queryInterface.removeColumn('reports', 'wallet_transaction_id');
    await queryInterface.removeColumn('reports', 'report_category');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_reports_report_category"');
    // Postgres can't drop enum values; the extra report_type values stay (unused).
    await queryInterface.changeColumn('reports', 'report_message', { type: Sequelize.STRING });
  },
};
