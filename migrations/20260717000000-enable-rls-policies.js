'use strict';
/**
 * Documents Row Level Security state that already exists live on the
 * database — this migration is already recorded as applied in
 * SequelizeMeta (dated 2026-07-17, applied directly against the DB, not
 * through this repo). It is committed here purely so the repo's migration
 * history matches reality; running `db:migrate` will NOT re-execute it,
 * since Sequelize skips any migration name already present in
 * SequelizeMeta regardless of whether the file exists locally.
 *
 * The app's own DB role (avnadmin) has BYPASSRLS, so none of this affects
 * app behavior today — these policies only matter for other roles that
 * might connect without that privilege.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Enable + force RLS on every table that has it live today.
    await queryInterface.sequelize.query(`ALTER TABLE "Conversations" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "Conversations" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "Messages" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "Messages" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "Transactions" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "Transactions" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "inspections" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "inspections" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "pending_registrations" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "pending_registrations" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "profiles" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "progresses" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "progresses" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "rentals" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "rentals" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "reports" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "testimonials" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "testimonials" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "users" FORCE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "waitlists" ENABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "waitlists" FORCE ROW LEVEL SECURITY;`);

    // Policies, in the exact form they exist in the database today.
    await queryInterface.sequelize.query(`CREATE POLICY conversations_insert ON "Conversations" FOR INSERT TO public WITH CHECK ((((tenant_id)::text = current_setting('app.current_user_id'::text, true)) OR ((landlord_id)::text = current_setting('app.current_user_id'::text, true)) OR (current_setting('app.current_user_role'::text, true) = 'admin'::text)));`);
    await queryInterface.sequelize.query(`CREATE POLICY conversations_select_admin ON "Conversations" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY conversations_select_landlord ON "Conversations" FOR SELECT TO public USING (((landlord_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY conversations_select_tenant ON "Conversations" FOR SELECT TO public USING (((tenant_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY messages_insert_admin ON "Messages" FOR INSERT TO public WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY messages_insert_participant ON "Messages" FOR INSERT TO public WITH CHECK ((((sender_id)::text = current_setting('app.current_user_id'::text, true)) AND (conversation_id IN ( SELECT "Conversations".id
   FROM "Conversations"
  WHERE ((("Conversations".tenant_id)::text = current_setting('app.current_user_id'::text, true)) OR (("Conversations".landlord_id)::text = current_setting('app.current_user_id'::text, true)))))));`);
    await queryInterface.sequelize.query(`CREATE POLICY messages_select_admin ON "Messages" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY messages_select_participant ON "Messages" FOR SELECT TO public USING ((conversation_id IN ( SELECT "Conversations".id
   FROM "Conversations"
  WHERE ((("Conversations".tenant_id)::text = current_setting('app.current_user_id'::text, true)) OR (("Conversations".landlord_id)::text = current_setting('app.current_user_id'::text, true))))));`);
    await queryInterface.sequelize.query(`CREATE POLICY transactions_insert_own ON "Transactions" FOR INSERT TO public WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY transactions_select_admin ON "Transactions" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY transactions_select_own ON "Transactions" FOR SELECT TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY transactions_update_admin ON "Transactions" FOR UPDATE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY transactions_update_own ON "Transactions" FOR UPDATE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true))) WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY inspections_insert_own ON "inspections" FOR INSERT TO public WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY inspections_select_admin ON "inspections" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY inspections_select_landlord ON "inspections" FOR SELECT TO public USING ((rental_id IN ( SELECT rentals.id
   FROM rentals
  WHERE ((rentals."UserId")::text = current_setting('app.current_user_id'::text, true)))));`);
    await queryInterface.sequelize.query(`CREATE POLICY inspections_select_tenant ON "inspections" FOR SELECT TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY inspections_update_admin ON "inspections" FOR UPDATE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY inspections_update_landlord ON "inspections" FOR UPDATE TO public USING ((rental_id IN ( SELECT rentals.id
   FROM rentals
  WHERE ((rentals."UserId")::text = current_setting('app.current_user_id'::text, true))))) WITH CHECK (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY inspections_update_own ON "inspections" FOR UPDATE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true))) WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY notifications_delete_own ON "notifications" FOR DELETE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY notifications_insert ON "notifications" FOR INSERT TO public WITH CHECK (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY notifications_select_admin ON "notifications" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY notifications_select_own ON "notifications" FOR SELECT TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY notifications_update_own ON "notifications" FOR UPDATE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true))) WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY pending_registrations_all_admin ON "pending_registrations" FOR ALL TO public USING (((current_setting('app.current_user_role'::text, true) = 'admin'::text) OR (current_setting('app.current_user_id'::text, true) = ''::text))) WITH CHECK (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY profiles_insert ON "profiles" FOR INSERT TO public WITH CHECK (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY profiles_select_public ON "profiles" FOR SELECT TO public USING (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY profiles_update_admin ON "profiles" FOR UPDATE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY profiles_update_own ON "profiles" FOR UPDATE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true))) WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY progresses_delete_own ON "progresses" FOR DELETE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY progresses_insert_own ON "progresses" FOR INSERT TO public WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY progresses_select_admin ON "progresses" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY progresses_select_own ON "progresses" FOR SELECT TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY progresses_update_admin ON "progresses" FOR UPDATE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY progresses_update_own ON "progresses" FOR UPDATE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true))) WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY rentals_delete_admin ON "rentals" FOR DELETE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY rentals_delete_own ON "rentals" FOR DELETE TO public USING (((("UserId")::text = current_setting('app.current_user_id'::text, true)) AND (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['landlord'::text, 'admin'::text]))));`);
    await queryInterface.sequelize.query(`CREATE POLICY rentals_insert_landlord ON "rentals" FOR INSERT TO public WITH CHECK (((("UserId")::text = current_setting('app.current_user_id'::text, true)) AND (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['landlord'::text, 'admin'::text]))));`);
    await queryInterface.sequelize.query(`CREATE POLICY rentals_select_public ON "rentals" FOR SELECT TO public USING (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY rentals_update_admin ON "rentals" FOR UPDATE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY rentals_update_own ON "rentals" FOR UPDATE TO public USING (((("UserId")::text = current_setting('app.current_user_id'::text, true)) AND (current_setting('app.current_user_role'::text, true) = ANY (ARRAY['landlord'::text, 'admin'::text])))) WITH CHECK ((("UserId")::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY reports_insert ON "reports" FOR INSERT TO public WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY reports_select_admin ON "reports" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY reports_select_against_user ON "reports" FOR SELECT TO public USING (((report_user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY reports_select_filed_by_user ON "reports" FOR SELECT TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY reports_update_admin ON "reports" FOR UPDATE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY testimonials_all_admin ON "testimonials" FOR ALL TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY testimonials_delete_own ON "testimonials" FOR DELETE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY testimonials_insert_own ON "testimonials" FOR INSERT TO public WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY testimonials_select_public ON "testimonials" FOR SELECT TO public USING (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY testimonials_update_own ON "testimonials" FOR UPDATE TO public USING (((user_id)::text = current_setting('app.current_user_id'::text, true))) WITH CHECK (((user_id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY users_insert_anon ON "users" FOR INSERT TO public WITH CHECK ((current_setting('app.current_user_id'::text, true) = ''::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY users_insert_auth ON "users" FOR INSERT TO public WITH CHECK (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY users_select_admin ON "users" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY users_select_own ON "users" FOR SELECT TO public USING (((id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY users_update_admin ON "users" FOR UPDATE TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text)) WITH CHECK ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
    await queryInterface.sequelize.query(`CREATE POLICY users_update_own ON "users" FOR UPDATE TO public USING (((id)::text = current_setting('app.current_user_id'::text, true))) WITH CHECK (((id)::text = current_setting('app.current_user_id'::text, true)));`);
    await queryInterface.sequelize.query(`CREATE POLICY waitlists_insert_anon ON "waitlists" FOR INSERT TO public WITH CHECK (true);`);
    await queryInterface.sequelize.query(`CREATE POLICY waitlists_select_admin ON "waitlists" FOR SELECT TO public USING ((current_setting('app.current_user_role'::text, true) = 'admin'::text));`);
  },

  async down(queryInterface, Sequelize) {
    // Drop policies first, then disable RLS.
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS conversations_insert ON "Conversations";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS conversations_select_admin ON "Conversations";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS conversations_select_landlord ON "Conversations";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS conversations_select_tenant ON "Conversations";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS messages_insert_admin ON "Messages";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS messages_insert_participant ON "Messages";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS messages_select_admin ON "Messages";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS messages_select_participant ON "Messages";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS transactions_insert_own ON "Transactions";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS transactions_select_admin ON "Transactions";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS transactions_select_own ON "Transactions";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS transactions_update_admin ON "Transactions";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS transactions_update_own ON "Transactions";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS inspections_insert_own ON "inspections";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS inspections_select_admin ON "inspections";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS inspections_select_landlord ON "inspections";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS inspections_select_tenant ON "inspections";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS inspections_update_admin ON "inspections";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS inspections_update_landlord ON "inspections";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS inspections_update_own ON "inspections";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS notifications_delete_own ON "notifications";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS notifications_insert ON "notifications";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS notifications_select_admin ON "notifications";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS notifications_select_own ON "notifications";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS notifications_update_own ON "notifications";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS pending_registrations_all_admin ON "pending_registrations";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS profiles_insert ON "profiles";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS profiles_select_public ON "profiles";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS profiles_update_admin ON "profiles";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS profiles_update_own ON "profiles";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS progresses_delete_own ON "progresses";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS progresses_insert_own ON "progresses";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS progresses_select_admin ON "progresses";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS progresses_select_own ON "progresses";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS progresses_update_admin ON "progresses";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS progresses_update_own ON "progresses";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS rentals_delete_admin ON "rentals";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS rentals_delete_own ON "rentals";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS rentals_insert_landlord ON "rentals";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS rentals_select_public ON "rentals";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS rentals_update_admin ON "rentals";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS rentals_update_own ON "rentals";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS reports_insert ON "reports";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS reports_select_admin ON "reports";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS reports_select_against_user ON "reports";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS reports_select_filed_by_user ON "reports";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS reports_update_admin ON "reports";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS testimonials_all_admin ON "testimonials";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS testimonials_delete_own ON "testimonials";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS testimonials_insert_own ON "testimonials";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS testimonials_select_public ON "testimonials";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS testimonials_update_own ON "testimonials";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS users_insert_anon ON "users";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS users_insert_auth ON "users";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS users_select_admin ON "users";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS users_select_own ON "users";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS users_update_admin ON "users";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS users_update_own ON "users";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS waitlists_insert_anon ON "waitlists";`);
    await queryInterface.sequelize.query(`DROP POLICY IF EXISTS waitlists_select_admin ON "waitlists";`);

    await queryInterface.sequelize.query(`ALTER TABLE "Conversations" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "Messages" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "Transactions" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "inspections" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "notifications" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "pending_registrations" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "profiles" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "progresses" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "rentals" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "reports" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "testimonials" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;`);
    await queryInterface.sequelize.query(`ALTER TABLE "waitlists" DISABLE ROW LEVEL SECURITY;`);
  },
};
