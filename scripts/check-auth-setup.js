// Diagnostic script to check authentication setup
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

console.log('🔍 Checking Authentication Setup...\n');

// Check JWT secrets
const jwtSecret = process.env.JWT_SECRET;
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;

console.log('1. JWT Secrets:');
if (!jwtSecret) {
  console.log('   ❌ JWT_SECRET is missing!');
  console.log('   Generated secret:', crypto.randomBytes(32).toString('hex'));
} else if (jwtSecret.length < 32) {
  console.log('   ⚠️  JWT_SECRET is too short (must be at least 32 characters)');
  console.log('   Current length:', jwtSecret.length);
} else {
  console.log('   ✅ JWT_SECRET is set (length:', jwtSecret.length + ')');
}

if (!jwtRefreshSecret) {
  console.log('   ❌ JWT_REFRESH_SECRET is missing!');
  console.log('   Generated secret:', crypto.randomBytes(32).toString('hex'));
} else if (jwtRefreshSecret.length < 32) {
  console.log('   ⚠️  JWT_REFRESH_SECRET is too short (must be at least 32 characters)');
  console.log('   Current length:', jwtRefreshSecret.length);
} else {
  console.log('   ✅ JWT_REFRESH_SECRET is set (length:', jwtRefreshSecret.length + ')');
}

// Check database connection
console.log('\n2. Database Configuration:');
const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = process.env.DB_PORT || '5432';
const dbName = process.env.DB_NAME || 'apci_db';
const dbUser = process.env.DB_USER || 'user';
console.log('   Host:', dbHost);
console.log('   Port:', dbPort);
console.log('   Database:', dbName);
console.log('   User:', dbUser);
console.log('   Password:', process.env.DB_PASSWORD ? '***' : 'NOT SET');

// Check API configuration
console.log('\n3. API Configuration:');
console.log('   PORT:', process.env.PORT || '3001');
console.log('   FRONTEND_URL:', process.env.FRONTEND_URL || 'http://localhost:3000');
console.log('   API_BASE_URL:', process.env.API_BASE_URL || 'http://localhost:3001');

// Check .env file location
console.log('\n4. Environment File:');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  console.log('   ✅ .env file found at:', envPath);
} else {
  console.log('   ❌ .env file NOT found at:', envPath);
  console.log('   Please create a .env file in the backend directory');
}

console.log('\n✅ Diagnostic complete!');
console.log('\nIf JWT secrets are missing, add them to your .env file:');
if (!jwtSecret || !jwtRefreshSecret) {
  console.log('JWT_SECRET=' + crypto.randomBytes(32).toString('hex'));
  console.log('JWT_REFRESH_SECRET=' + crypto.randomBytes(32).toString('hex'));
}

