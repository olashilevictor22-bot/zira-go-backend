// seed_admin.js — Create initial admin user
require('dotenv').config();
const bcrypt = require('bcrypt');
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

const BCRYPT_ROUNDS = 12;

async function seedAdmin() {
    const email = process.argv[2] || process.env.ADMIN_EMAIL;
    const password = process.argv[3] || process.env.ADMIN_PASSWORD;
    const fullName = process.argv[4] || process.env.ADMIN_NAME || 'ZiraPay System Admin';

    if (!email || !password) {
        console.error('❌ Error: ADMIN_EMAIL and ADMIN_PASSWORD must be set (env or CLI args). No default credentials will be used.');
        process.exit(1);
    }
    if (password.length < 10) {
        console.error('❌ Error: ADMIN_PASSWORD is too weak (min 10 characters).');
        process.exit(1);
    }

    console.log(`🔐 Seeding admin user: ${email}...`);

    try {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const res = await pool.query(
            `INSERT INTO admins (email, password_hash, full_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE
             SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name
             RETURNING id, email, full_name`,
            [email, passwordHash, fullName]
        );

        console.log(`✅ Admin user configured successfully!`);
        console.log(`   ID: ${res.rows[0].id}`);
        console.log(`   Email: ${res.rows[0].email}`);
        console.log(`   Name: ${res.rows[0].full_name}`);
        console.log(`   Password: [set — not printed]`);
    } catch (err) {
        console.error('❌ Failed to seed admin:', err.message);
    } finally {
        await pool.end();
    }
}

seedAdmin();
