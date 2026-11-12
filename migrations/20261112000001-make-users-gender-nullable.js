'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Google sign-in creates users without a gender (gender: null). The original
  // column was NOT NULL with a 'male' default, which either rejects those
  // sign-ups or would silently mark everyone 'male'. Users now set it via
  // PUT /profile/update. Existing rows are untouched.
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "users" ALTER COLUMN "gender" DROP NOT NULL;');
    await queryInterface.sequelize.query('ALTER TABLE "users" ALTER COLUMN "gender" DROP DEFAULT;');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`UPDATE "users" SET "gender" = 'male' WHERE "gender" IS NULL;`);
    await queryInterface.sequelize.query(`ALTER TABLE "users" ALTER COLUMN "gender" SET DEFAULT 'male';`);
    await queryInterface.sequelize.query('ALTER TABLE "users" ALTER COLUMN "gender" SET NOT NULL;');
  },
};
