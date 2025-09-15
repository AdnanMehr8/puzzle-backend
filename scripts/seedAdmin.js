const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

async function seedAdmin() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('Connected to MongoDB');

    // Admin credentials from environment variables
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@puzzleplatform.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!@#';
    const adminFirstName = process.env.ADMIN_FIRST_NAME || 'Platform';
    const adminLastName = process.env.ADMIN_LAST_NAME || 'Administrator';

    // Check if admin already exists
    const existingAdmin = await User.findByEmail(adminEmail);
    if (existingAdmin) {
      console.log('Admin user already exists:', adminEmail);
      console.log('Admin ID:', existingAdmin._id);
      console.log('Admin Role:', existingAdmin.role);
      return;
    }

    // Create admin user
    const admin = await User.createAdmin(
      adminEmail,
      adminPassword,
      adminFirstName,
      adminLastName
    );

    console.log('✅ Admin user created successfully!');
    console.log('📧 Email:', admin.email);
    console.log('🆔 ID:', admin._id);
    console.log('👤 Name:', `${admin.profile.firstName} ${admin.profile.lastName}`);
    console.log('💰 Initial Balance:', `$${admin.wallet.balance}`);
    console.log('🔐 Role:', admin.role);
    console.log('');
    console.log('⚠️  IMPORTANT: Please change the default password after first login!');
    console.log('🔑 Default Password:', adminPassword);

  } catch (error) {
    console.error('❌ Error seeding admin user:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

// Run the seeding function
seedAdmin();