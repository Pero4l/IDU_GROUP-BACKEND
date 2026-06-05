'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Update users table
    await queryInterface.addColumn('users', 'full_name', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    // Copy existing names to full_name
    await queryInterface.sequelize.query(
      "UPDATE users SET full_name = TRIM(first_name || ' ' || last_name)"
    );

    // Make full_name allowNull: false
    await queryInterface.changeColumn('users', 'full_name', {
      type: Sequelize.STRING,
      allowNull: false
    });

    await queryInterface.removeColumn('users', 'first_name');
    await queryInterface.removeColumn('users', 'last_name');


    // 2. Update pending_registrations table
    await queryInterface.addColumn('pending_registrations', 'full_name', {
      type: Sequelize.STRING,
      allowNull: true
    });

    // Copy existing names to full_name if there are any
    await queryInterface.sequelize.query(
      "UPDATE pending_registrations SET full_name = TRIM(first_name || ' ' || last_name)"
    );

    // Make full_name allowNull: false
    await queryInterface.changeColumn('pending_registrations', 'full_name', {
      type: Sequelize.STRING,
      allowNull: false
    });

    await queryInterface.removeColumn('pending_registrations', 'first_name');
    await queryInterface.removeColumn('pending_registrations', 'last_name');
  },

  async down(queryInterface, Sequelize) {
    // Revert users table
    await queryInterface.addColumn('users', 'first_name', {
      type: Sequelize.STRING,
      allowNull: true
    });
    await queryInterface.addColumn('users', 'last_name', {
      type: Sequelize.STRING,
      allowNull: true
    });

    // Extract first_name and last_name back
    await queryInterface.sequelize.query(
      "UPDATE users SET first_name = split_part(full_name, ' ', 1), last_name = substr(full_name, strpos(full_name, ' ') + 1)"
    );

    await queryInterface.changeColumn('users', 'first_name', {
      type: Sequelize.STRING,
      allowNull: false
    });
    await queryInterface.changeColumn('users', 'last_name', {
      type: Sequelize.STRING,
      allowNull: false
    });

    await queryInterface.removeColumn('users', 'full_name');


    // Revert pending_registrations table
    await queryInterface.addColumn('pending_registrations', 'first_name', {
      type: Sequelize.STRING,
      allowNull: true
    });
    await queryInterface.addColumn('pending_registrations', 'last_name', {
      type: Sequelize.STRING,
      allowNull: true
    });

    await queryInterface.sequelize.query(
      "UPDATE pending_registrations SET first_name = split_part(full_name, ' ', 1), last_name = substr(full_name, strpos(full_name, ' ') + 1)"
    );

    await queryInterface.changeColumn('pending_registrations', 'first_name', {
      type: Sequelize.STRING,
      allowNull: false
    });
    await queryInterface.changeColumn('pending_registrations', 'last_name', {
      type: Sequelize.STRING,
      allowNull: false
    });

    await queryInterface.removeColumn('pending_registrations', 'full_name');
  }
};
