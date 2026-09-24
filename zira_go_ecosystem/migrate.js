// migrate.js — Database migration runner for Zira Go
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL is not set in .env');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
});

const migrationFiles = [
    '00_base_schema.sql',
    'zira_go_schema.sql',
    'zira_go_telegram_schema.sql',
    'zira_go_auth_bank_schema.sql',
    'zira_go_payment_schema.sql'
];

// Existing deployments created before the schema was made idempotent can run
// this focused upgrade without replaying every CREATE TABLE statement.
async function runVehicleCapacityUpgrade() {
    const client = await pool.connect();
    try {
        const sql = fs.readFileSync(path.join(__dirname, '01_vehicle_capacity_upgrade.sql'), 'utf8');
        await client.query(sql);
        console.log('✅ Vehicle-capacity upgrade applied.');
    } finally {
        client.release();
        await pool.end();
    }
}

async function runSecurityUpgrade() {
    const client = await pool.connect();
    try {
        const sql = fs.readFileSync(path.join(__dirname, '02_security_upgrade.sql'), 'utf8');
        await client.query(sql);
        console.log('✅ Security and notification upgrade applied.');
    } finally {
        client.release();
        await pool.end();
    }
}

async function runPinLockoutUpgrade() {
    const client = await pool.connect();
    try {
        const sql = fs.readFileSync(path.join(__dirname, '03_pin_lockout_upgrade.sql'), 'utf8');
        await client.query(sql);
        console.log('✅ Tiered PIN-lockout upgrade applied.');
    } finally {
        client.release();
        await pool.end();
    }
}

async function runMigrations() {
    const client = await pool.connect();
    console.log('🔗 Connected to database.');

    try {
        for (const file of migrationFiles) {
            const filePath = path.join(__dirname, file);
            if (!fs.existsSync(filePath)) {
                console.warn(`⚠️ Migration file not found: ${file}, skipping.`);
                continue;
            }

            console.log(`⏳ Applying ${file}...`);
            const sql = fs.readFileSync(filePath, 'utf8');
            await client.query(sql);
            console.log(`✅ Applied ${file} successfully.`);
        }
        console.log('\n🎉 All migrations completed successfully!');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        console.error(err);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

if (process.argv.includes('--security-upgrade')) runSecurityUpgrade();
else if (process.argv.includes('--vehicle-capacity-upgrade')) runVehicleCapacityUpgrade();
else if (process.argv.includes('--pin-lockout-upgrade')) runPinLockoutUpgrade();
else runMigrations();
