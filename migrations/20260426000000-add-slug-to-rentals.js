'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('rentals', 'slug', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // Populate slugs for existing rentals
    const [rentals] = await queryInterface.sequelize.query('SELECT id, title FROM rentals');
    const slugify = require('../utils/slugify');

    const usedSlugs = new Set();

    for (const rental of rentals) {
      let baseSlug = slugify(rental.title);
      let slug = baseSlug;
      let count = 1;

      // Handle duplicates within the migration loop
      while (usedSlugs.has(slug)) {
        slug = slugify(rental.title, rental.id.split('-')[0] + (count > 1 ? `-${count}` : ""));
        count++;
      }

      usedSlugs.add(slug);
      
      await queryInterface.sequelize.query(
        `UPDATE rentals SET slug = :slug WHERE id = :id`,
        {
          replacements: { slug, id: rental.id },
          type: Sequelize.QueryTypes.UPDATE
        }
      );
    }

    // Now add unique constraint
    await queryInterface.addConstraint('rentals', {
      fields: ['slug'],
      type: 'unique',
      name: 'rentals_slug_unique_constraint'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('rentals', 'slug');
  }
};
