const { Inspections, Rentals, Users, Profile } = require('../models');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────
// POST /inspection/create
// ─────────────────────────────────────────────
async function createInspection(req, res) {
  try {
    const user_id = req.user.userId;
    const { rental_id, date, time } = req.body;

    if (!rental_id || !date || !time) {
      return res.status(400).json({ success: false, message: 'rental_id, date and time are required' });
    }

    const rental = await Rentals.findByPk(rental_id);
    if (!rental) {
      return res.status(404).json({ success: false, message: 'Rental not found' });
    }

    const existing = await Inspections.findOne({ where: { user_id, rental_id, date } });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You already have an inspection scheduled for this property on that date',
      });
    }

    // Single write — no multi-step transaction needed for the create itself
    const inspection = await Inspections.create({ user_id, rental_id, date, time, is_paid: false });

    logger.info('Inspection created', { user_id, rental_id, date });

    // Non-critical notifications
    const user = await Users.findByPk(user_id);
    await logAndEmailUser(user_id, user?.email, 'Inspection Scheduled',
      `Your inspection for "${rental.title}" has been scheduled for ${date} at ${time}.`
    );

    if (rental.UserId) {
      const landlord = await Users.findByPk(rental.UserId);
      if (landlord) {
        await logAndEmailUser(landlord.id, landlord.email, 'New Inspection Request',
          `${user?.full_name ?? 'A tenant'} has scheduled an inspection for your property "${rental.title}" on ${date} at ${time}.`
        );
      }
    }

    await notifySuperAdmins(`Inspection scheduled by user ${user_id} for rental ${rental_id} on ${date}`, 'inspection');

    return res.status(201).json({ success: true, message: 'Inspection scheduled successfully', data: inspection });
  } catch (error) {
    logger.error('Error creating inspection', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}

// ─────────────────────────────────────────────
// GET /inspection/all
// ─────────────────────────────────────────────
async function getMyInspections(req, res) {
  try {
    const user_id = req.user.userId;
    const inspections = await Inspections.findAll({
      where: { user_id },
      include: [{
        model: Rentals, as: 'rental',
        attributes: ['id', 'slug', 'title', 'location', 'price', 'priceType', 'images', 'status'],
      }],
      order: [['date', 'ASC'], ['time', 'ASC']],
    });
    return res.status(200).json({ success: true, message: 'Inspections retrieved successfully', data: inspections });
  } catch (error) {
    logger.error('Error fetching inspections', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}

// ─────────────────────────────────────────────
// GET /inspection/:id
// ─────────────────────────────────────────────
async function getInspection(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.userId;

    const inspection = await Inspections.findOne({
      where: { id, user_id },
      include: [{
        model: Rentals, as: 'rental',
        attributes: ['id', 'slug', 'title', 'location', 'price', 'priceType', 'images', 'status'],
        include: [{
          model: Users,
          attributes: ['id', 'full_name', 'phone_no'],
          include: [{ model: Profile, attributes: ['image', 'verified'] }],
        }],
      }],
    });

    if (!inspection) {
      return res.status(404).json({ success: false, message: 'Inspection not found' });
    }

    const dataJson = inspection.toJSON();
    if (dataJson.rental && dataJson.rental.User) {
      const parts = (dataJson.rental.User.full_name || '').split(' ');
      dataJson.rental.User.first_name = parts[0] || '';
      dataJson.rental.User.last_name = parts.slice(1).join(' ') || '';
    }

    return res.status(200).json({ success: true, message: 'Inspection retrieved successfully', data: dataJson });
  } catch (error) {
    logger.error('Error fetching inspection', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}

// ─────────────────────────────────────────────
// PUT /inspection/update/:id
// ─────────────────────────────────────────────
async function updateInspection(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.userId;
    const { date, time, is_paid } = req.body;

    const inspection = await Inspections.findOne({ where: { id, user_id } });
    if (!inspection) {
      return res.status(404).json({ success: false, message: 'Inspection not found' });
    }

    const prevIsPaid = inspection.is_paid;

    await inspection.update({
      date: date ?? inspection.date,
      time: time ?? inspection.time,
      is_paid: is_paid !== undefined ? is_paid : inspection.is_paid,
    });

    logger.info('Inspection updated', { id, user_id });

    if (is_paid !== undefined && is_paid !== prevIsPaid) {
      const user = await Users.findByPk(user_id);
      const rental = await Rentals.findByPk(inspection.rental_id);
      await logAndEmailUser(user_id, user?.email, 'Inspection Payment Updated',
        `Payment status for your inspection of "${rental?.title}" has been updated to ${is_paid ? 'paid' : 'unpaid'}.`
      );
    }

    return res.status(200).json({ success: true, message: 'Inspection updated successfully', data: inspection });
  } catch (error) {
    logger.error('Error updating inspection', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}

// ─────────────────────────────────────────────
// GET /inspection/rental/:rental_id  (landlord)
// ─────────────────────────────────────────────
async function getInspectionsForRental(req, res) {
  try {
    const { rental_id } = req.params;
    const landlord_id = req.user.userId;

    const rental = await Rentals.findOne({ where: { id: rental_id, UserId: landlord_id } });
    if (!rental) {
      return res.status(404).json({ success: false, message: 'Rental not found or you are not the owner' });
    }

    const inspections = await Inspections.findAll({
      where: { rental_id },
      include: [{
        model: Users, as: 'tenant',
        attributes: ['id', 'full_name', 'phone_no', 'email'],
        include: [{ model: Profile, attributes: ['image', 'verified'] }],
      }],
      order: [['date', 'ASC'], ['time', 'ASC']],
    });

    const dataJson = inspections.map(insp => {
      const item = insp.toJSON();
      if (item.tenant) {
        const parts = (item.tenant.full_name || '').split(' ');
        item.tenant.first_name = parts[0] || '';
        item.tenant.last_name = parts.slice(1).join(' ') || '';
      }
      return item;
    });

    return res.status(200).json({ success: true, message: 'Inspections for rental retrieved successfully', data: dataJson });
  } catch (error) {
    logger.error('Error fetching inspections for rental', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}

module.exports = { createInspection, getMyInspections, getInspection, updateInspection, getInspectionsForRental };
