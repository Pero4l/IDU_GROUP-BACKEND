'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // A tenancy is one tenant's occupation of a long-term rental. The first rent
  // payment creates it (price + all fees); each renewal charges only the basic
  // rent (`rentals.price`) and pushes `end_date` forward by one rent period.
  // Rent payments link to it through wallet_transactions.meta.tenancy_id.
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tenancies', {
      id: { allowNull: false, primaryKey: true, type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()') },
      rental_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'rentals', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      start_date: { type: Sequelize.DATE, allowNull: false },
      // null for 'one-time' rentals, which have no rent period
      end_date: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.ENUM('active', 'ended'), allowNull: false, defaultValue: 'active' },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });
    await queryInterface.addIndex('tenancies', ['rental_id', 'status']);
    await queryInterface.addIndex('tenancies', ['tenant_id']);

    const q = queryInterface.sequelize;

    // Backfill: one active tenancy per already-rented rental, from its latest
    // successful rent payment (matched by meta.rental_id, or by the narration
    // older payments were written with).
    await q.query(`
      INSERT INTO tenancies (id, rental_id, tenant_id, start_date, end_date, status, "createdAt", "updatedAt")
      SELECT gen_random_uuid(), r.id, p.user_id, p."createdAt",
             CASE r."priceType"
               WHEN 'monthly' THEN p."createdAt" + INTERVAL '1 month'
               WHEN 'yearly'  THEN p."createdAt" + INTERVAL '1 year'
               ELSE NULL END,
             'active', NOW(), NOW()
      FROM rentals r
      JOIN LATERAL (
        SELECT wt.user_id, wt."createdAt"
        FROM wallet_transactions wt
        WHERE wt.type = 'house rent' AND wt.role = 'payer' AND wt.status = 'success'
          AND (wt.meta->>'rental_id' = r.id::text OR wt.narration = 'Rent payment for "' || r.title || '"')
        ORDER BY wt."createdAt" DESC
        LIMIT 1
      ) p ON TRUE
      WHERE r.status = 'rented';
    `);

    // Link each tenant's payment row to its new tenancy.
    await q.query(`
      UPDATE wallet_transactions wt
      SET meta = COALESCE(wt.meta, '{}'::jsonb)
                 || jsonb_build_object('rental_id', t.rental_id::text, 'tenancy_id', t.id::text, 'payment_kind', 'initial')
      FROM tenancies t
      JOIN rentals r ON r.id = t.rental_id
      WHERE wt.type = 'house rent' AND wt.role = 'payer' AND wt.status = 'success'
        AND wt.user_id = t.tenant_id AND wt."createdAt" = t.start_date
        AND (wt.meta->>'rental_id' = r.id::text OR wt.narration = 'Rent payment for "' || r.title || '"');
    `);

    // Rented rentals with no payment on record (very old data): fall back to
    // the tenant's booked progress row.
    await q.query(`
      INSERT INTO tenancies (id, rental_id, tenant_id, start_date, end_date, status, "createdAt", "updatedAt")
      SELECT gen_random_uuid(), r.id, p.user_id, p."updatedAt",
             CASE r."priceType"
               WHEN 'monthly' THEN p."updatedAt" + INTERVAL '1 month'
               WHEN 'yearly'  THEN p."updatedAt" + INTERVAL '1 year'
               ELSE NULL END,
             'active', NOW(), NOW()
      FROM rentals r
      JOIN LATERAL (
        SELECT pr.user_id, pr."updatedAt" FROM progresses pr
        WHERE pr.rental_id = r.id AND pr.booked = TRUE
        ORDER BY pr."updatedAt" DESC LIMIT 1
      ) p ON TRUE
      WHERE r.status = 'rented'
        AND NOT EXISTS (SELECT 1 FROM tenancies t WHERE t.rental_id = r.id);
    `);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('tenancies');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_tenancies_status";');
  },
};
