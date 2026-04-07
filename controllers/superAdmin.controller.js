const { Users } = require('../models');

async function getAllUsers(req, res) {
  try {
    const users = await Users.findAll({
      attributes: { exclude: ['password'] }
    });
    return res.status(200).json({ success: true, count: users.length, data: users });
  } catch (error) {
    console.error("Super Admin - getAllUsers error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function toggleUserStatus(req, res) {
  try {
    const { id } = req.params;
    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    // Safety check so admins do not block themselves accidentally
    if (user.id === req.user.userId) {
      return res.status(400).json({ success: false, message: "You cannot change your own status." });
    }

    user.is_active = !user.is_active;
    await user.save();
    
    return res.status(200).json({ 
      success: true, 
      message: `User status updated to ${user.is_active ? 'active' : 'blocked'}`, 
      data: user 
    });
  } catch (error) {
    console.error("Super Admin - toggleUserStatus error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.id === req.user.userId) {
      return res.status(400).json({ success: false, message: "You cannot delete your own account here." });
    }

    await Users.destroy({ where: { id } });
    return res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Super Admin - deleteUser error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// Temporary endpoint to create first admin or elevate an existing admin
async function makeSuperAdmin(req, res) {
  try {
    const { id } = req.params;
    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    user.is_superadmin = true;
    await user.save();
    return res.status(200).json({ success: true, message: "User elevated to super admin", data: user });
  } catch (error) {
    console.error("Super Admin - makeSuperAdmin error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { getAllUsers, toggleUserStatus, deleteUser, makeSuperAdmin };
