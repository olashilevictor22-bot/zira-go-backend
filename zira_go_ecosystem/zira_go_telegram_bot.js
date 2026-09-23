// zira_go_telegram_bot.js
// Standalone bot process, same pattern as the ZionBites bots: long-polling via
// node-telegram-bot-api, talking to the same PostgreSQL pool as the API server.
// Swap the require below for whichever library ZionBites' bots already use if
// it's not node-telegram-bot-api — the flows here don't depend on the library.
//
// Responsibilities (deliberately thin — no wallet/PIN logic lives here):
//   1. Link a Telegram account to a ZiraPay student OR driver via a short-lived
//      code generated in the web app / driver panel (see zira_go_telegram_schema.sql).
//      Both link flows share one code table and one attemptLink() — the code
//      row itself says which side it belongs to, so the bot never needs to ask.
//   2. /code — student generates a one-time ride code on demand (writes to the
//      existing one_time_codes table from zira_go_schema.sql), no need to open the app.
//   3. notifyStudent / notifyDriver — called by zira_go_trip_routes.js after a
//      charge succeeds, so both sides get an instant Telegram push.
//
// Env vars expected: TELEGRAM_BOT_TOKEN, DATABASE_URL (or reuse the app's pool).

const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')))
        ? false
        : { rejectUnauthorized: false }
});

const hasBotToken = process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.startsWith('your_');
const bot = hasBotToken ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true }) : null;

if (!hasBotToken) {
    console.warn('⚠️ [Telegram Bot] TELEGRAM_BOT_TOKEN not provided or placeholder. Bot polling is inactive.');
}

const LINK_CODE_TTL_MINUTES = 10;
const RIDE_CODE_TTL_MINUTES = 30;

function hashCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

function generateNumericCode(length = 6) {
    return crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
}

const STUDENT_MENU = [['🚖 Get ride code', '💳 Check balance'], ['➕ Add money', '🆘 Support'], ['🏠 Main menu']];
const DRIVER_MENU = [['💳 Check earnings', '🆘 Support'], ['🏠 Main menu']];

async function sendHome(chatId, greeting = 'What would you like to do?') {
    const linked = await alreadyLinked(chatId);
    if (!linked) return bot.sendMessage(chatId, 'Your Telegram is not linked yet. Open Zira Go, choose Telegram Bot, and tap “Link my Telegram account”.');
    const isStudent = linked.type === 'student';
    return bot.sendMessage(chatId, `${greeting}\n\nChoose an option below — no commands to memorise.`, {
        reply_markup: { keyboard: isStudent ? STUDENT_MENU : DRIVER_MENU, resize_keyboard: true, is_persistent: true }
    });
}

async function sendRideCode(chatId) {
    const student = await pool.query('SELECT id FROM students WHERE telegram_chat_id = $1', [chatId]);
    if (!student.rows.length) return bot.sendMessage(chatId, 'Ride codes are available for linked student accounts.');
    const studentId = student.rows[0].id;
    await pool.query(`UPDATE one_time_codes SET status='expired'
        WHERE student_id=$1 AND status='active' AND expires_at <= now()`, [studentId]);
    const existing = await pool.query(`SELECT id,raw_code,expires_at FROM one_time_codes WHERE student_id=$1 AND status='active' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, [studentId]);
    let rawCode, expiresAt, existingCode = false;
    if (existing.rows[0]?.raw_code) {
        rawCode = existing.rows[0].raw_code;
        expiresAt = new Date(existing.rows[0].expires_at);
        existingCode = true;
        // Repair any duplicate active rows from earlier bot versions; the most
        // recent readable code remains the single valid pass.
        await pool.query(`UPDATE one_time_codes SET status='expired' WHERE student_id=$1 AND status='active' AND id <> $2`, [studentId, existing.rows[0].id]);
    } else {
        // Hash-only passes created by the old bot cannot be displayed; clear
        // only those unusable records, never a readable active pass.
        if (existing.rows.length) await pool.query(`UPDATE one_time_codes SET status='expired' WHERE student_id=$1 AND status='active'`, [studentId]);
        rawCode = generateNumericCode();
        expiresAt = new Date(Date.now() + RIDE_CODE_TTL_MINUTES * 60 * 1000);
        await pool.query(`INSERT INTO one_time_codes (student_id, code_hash, raw_code, expires_at) VALUES ($1, $2, $3, $4)`, [studentId, hashCode(rawCode), rawCode, expiresAt]);
    }
    const minutesLeft = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60000));
    return bot.sendMessage(chatId, `🎟️ *Your ride code*\n\n\`${rawCode.slice(0, 3)} ${rawCode.slice(3)}\`\n\n${existingCode ? `This pass is still active — ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} remaining.` : `Valid for ${RIDE_CODE_TTL_MINUTES} minutes.`}\nShow it to your driver when boarding.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💳 Check balance', callback_data: 'student_balance' }]] } });
}

async function sendBalance(chatId) {
    try {
        const student = await pool.query('SELECT wallet_balance,reg_no FROM students WHERE telegram_chat_id=$1', [chatId]);
        if (student.rows.length) return bot.sendMessage(chatId, `💳 *Wallet balance*\n\n${student.rows[0].reg_no || 'Student account'}\nAvailable: *₦${Number(student.rows[0].wallet_balance || 0).toLocaleString()}*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚖 Get ride code', callback_data: 'student_ride' }, { text: '➕ Add money', callback_data: 'student_fund' }]] } });
        const driver = await pool.query('SELECT wallet_balance,full_name FROM drivers WHERE telegram_chat_id=$1', [chatId]);
        if (driver.rows.length) return bot.sendMessage(chatId, `🚖 *Driver earnings*\n\n${driver.rows[0].full_name || 'Driver'}\nAvailable: *₦${Number(driver.rows[0].wallet_balance || 0).toLocaleString()}*\n\nUse the Driver Panel to request a payout.`, { parse_mode: 'Markdown' });
        return bot.sendMessage(chatId, 'Your Telegram account is not linked yet. Open Zira Go → Telegram Bot → Link my Telegram account.');
    } catch (err) {
        console.error('Balance lookup failed:', err.message);
        return bot.sendMessage(chatId, 'I could not load your balance right now. Please tap Check balance again in a moment.');
    }
}

function sendFundGuide(chatId) { return bot.sendMessage(chatId, '➕ *Add money*\n\nFor your security, wallet funding is completed in the Zira Go app through Korapay or Flutterwave. Open your wallet, choose “Fund wallet”, then complete payment there.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💳 Check balance', callback_data: 'student_balance' }]] } }); }
function sendSupport(chatId) { return bot.sendMessage(chatId, '🆘 *Zira Go Support*\n\nFor payment, PIN, or ride issues, use the Live Agent option inside the Zira Go app. Include your registration number so the team can assist quickly.', { parse_mode: 'Markdown' }); }

// ------------------------------------------------------------------
// /start <linkCode>  — supports the deep link BOTH the web app and the driver
// panel generate (t.me/YourBot?start=ABC123), as well as typing /start then
// the code raw. Which account gets linked depends entirely on whether the
// code row belongs to a student or a driver — see attemptLink below.
// ------------------------------------------------------------------
if (bot) {
    bot.onText(/\/start(?:\s+(\w+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const codeArg = match[1];

        if (String(chatId) === String(process.env.TELEGRAM_ADMIN_CHAT_ID || '')) {
            return bot.sendMessage(chatId, '🛡️ *Zira Go Admin Console*\n\nManage the platform or preview what students and drivers see.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📊 Platform summary', callback_data: 'admin_summary' }, { text: '📨 Support queue', callback_data: 'admin_support' }], [{ text: '📌 PIN reviews', callback_data: 'admin_pin_reviews' }], [{ text: '👁 Preview student mode', callback_data: 'admin_preview_student' }, { text: '👁 Preview driver mode', callback_data: 'admin_preview_driver' }]] } });
        }

        const already = await alreadyLinked(chatId);
        if (already) {
            return sendHome(chatId, `Welcome back — your ${already.type} account is linked.`);
        }

        if (!codeArg) {
            return bot.sendMessage(
                chatId,
                "Welcome to Zira Go 👋\n\nTo link your account, open the Zira app (students) or the driver panel (drivers), tap 'Link Telegram', and either tap the button there or send me the code it shows you."
            );
        }

        return attemptLink(chatId, codeArg);
    });

    // Fallback: pasting the raw code as a plain message instead of via deep link
    bot.onText(/^\d{6}$/, async (msg) => {
        const chatId = msg.chat.id;
        const already = await alreadyLinked(chatId);
        if (already) return; // ignore stray 6-digit messages once linked, either side
        return attemptLink(chatId, msg.text.trim());
    });
}

if (bot) bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    // Student/driver action buttons must work even when the linked Telegram
    // account is also the platform-admin chat. Route these before the admin
    // console check; otherwise the buttons appear to do nothing while slash
    // commands still work.
    if (['student_ride', 'student_balance', 'student_fund'].includes(query.data)) {
        try {
            if (query.data === 'student_ride') await sendRideCode(chatId);
            else if (query.data === 'student_balance') await sendBalance(chatId);
            else if (query.data === 'student_fund') await sendFundGuide(chatId);
            return bot.answerCallbackQuery(query.id);
        } catch (err) { console.error('Student bot action:', err.message); return bot.answerCallbackQuery(query.id, { text: 'Please try again.' }); }
    }
    if (String(chatId) !== String(process.env.TELEGRAM_ADMIN_CHAT_ID || '')) return bot.answerCallbackQuery(query.id, { text: 'This action is unavailable.' });
    try {
        if (query.data === 'admin_summary') { const stats = await pool.query('SELECT (SELECT COUNT(*) FROM students) students, (SELECT COUNT(*) FROM drivers) drivers'); await bot.sendMessage(query.message.chat.id, `📊 Students: ${stats.rows[0].students}\n🚖 Drivers: ${stats.rows[0].drivers}`); }
        if (query.data === 'admin_support') { const rows = await pool.query("SELECT user_name, message FROM support_tickets WHERE status <> 'resolved' ORDER BY created_at DESC LIMIT 5"); await bot.sendMessage(query.message.chat.id, rows.rows.length ? rows.rows.map(x => `💬 ${x.user_name}: ${x.message}`).join('\n\n') : 'No open support messages.'); }
        if (query.data === 'admin_pin_reviews') { const rows = await pool.query("SELECT COUNT(*) FROM pin_change_requests WHERE status='pending'"); await bot.sendMessage(query.message.chat.id, `📌 Pending PIN identity reviews: ${rows.rows[0].count}`); }
        if (query.data === 'admin_preview_student') await bot.sendMessage(query.message.chat.id, '👁 *Student mode preview*\n\nThis is the menu a linked student sees. Preview actions do not create a ride code or access any student wallet.', { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[{text:'🚖 Get ride code',callback_data:'preview_student_ride'},{text:'💳 Check balance',callback_data:'preview_student_balance'}],[{text:'➕ Add money',callback_data:'preview_student_fund'},{text:'🆘 Support',callback_data:'preview_student_support'}],[{text:'↩ Back to Admin Console',callback_data:'admin_home'}]] } });
        if (query.data === 'admin_preview_driver') await bot.sendMessage(query.message.chat.id, '👁 *Driver mode preview*\n\nThis is the menu a linked driver sees. Preview actions do not access or change a driver account.', { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[{text:'💳 Check earnings',callback_data:'preview_driver_earnings'},{text:'🆘 Support',callback_data:'preview_driver_support'}],[{text:'↩ Back to Admin Console',callback_data:'admin_home'}]] } });
        if (query.data === 'preview_student_ride') await bot.sendMessage(query.message.chat.id, '🎟️ *Ride code preview*\n\nA student receives a six-digit ride code here, valid for 30 minutes. In preview mode, no code is generated.', { parse_mode:'Markdown' });
        if (query.data === 'preview_student_balance') await bot.sendMessage(query.message.chat.id, '💳 *Wallet balance preview*\n\nA student sees their registration number and available wallet balance here. No account data is shown in preview mode.', { parse_mode:'Markdown' });
        if (query.data === 'preview_student_fund') await bot.sendMessage(query.message.chat.id, '➕ *Add money preview*\n\nStudents are directed to secure Korapay or Flutterwave checkout in the Zira Go wallet.', { parse_mode:'Markdown' });
        if (query.data === 'preview_student_support' || query.data === 'preview_driver_support') await bot.sendMessage(query.message.chat.id, '🆘 *Support preview*\n\nUsers are directed to the in-app Live Agent desk for payment, ride, and account issues.', { parse_mode:'Markdown' });
        if (query.data === 'preview_driver_earnings') await bot.sendMessage(query.message.chat.id, '💳 *Driver earnings preview*\n\nA driver sees their available earnings here and uses the Driver Panel to request a payout.', { parse_mode:'Markdown' });
        if (query.data === 'admin_home') return bot.sendMessage(query.message.chat.id, '🛡️ *Zira Go Admin Console*', { parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:'📊 Platform summary',callback_data:'admin_summary'},{text:'📨 Support queue',callback_data:'admin_support'}],[{text:'📌 PIN reviews',callback_data:'admin_pin_reviews'}],[{text:'👁 Preview student mode',callback_data:'admin_preview_student'},{text:'👁 Preview driver mode',callback_data:'admin_preview_driver'}]]} });
        await bot.answerCallbackQuery(query.id);
    } catch (err) { console.error('Admin bot action:', err.message); await bot.answerCallbackQuery(query.id, { text: 'Could not load that right now.' }); }
});

if (bot) {
    bot.onText(/^🚖 Get ride code$/, msg => sendRideCode(msg.chat.id));
    bot.onText(/^💳\s*(Check balance|Check earnings)\s*$/i, msg => sendBalance(msg.chat.id).catch(err => console.error('Balance menu error:', err.message)));
    bot.onText(/^➕ Add money$/, msg => sendFundGuide(msg.chat.id));
    bot.onText(/^🆘 Support$/, msg => sendSupport(msg.chat.id));
    bot.onText(/^🏠 Main menu$/, msg => sendHome(msg.chat.id));
    bot.onText(/^\/balance(?:@\w+)?$/i, msg => sendBalance(msg.chat.id).catch(err => console.error('Balance command error:', err.message)));
}

async function alreadyLinked(chatId) {
    const student = await pool.query('SELECT id FROM students WHERE telegram_chat_id = $1', [chatId]);
    if (student.rows.length) return { type: 'student', id: student.rows[0].id };
    const driver = await pool.query('SELECT id FROM drivers WHERE telegram_chat_id = $1', [chatId]);
    if (driver.rows.length) return { type: 'driver', id: driver.rows[0].id };
    return null;
}

async function attemptLink(chatId, rawCode) {
    const codeHash = hashCode(rawCode);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const row = await client.query(
            `SELECT id, student_id, driver_id FROM telegram_link_codes
             WHERE code_hash = $1 AND status = 'active' AND expires_at > now()
             FOR UPDATE`,
            [codeHash]
        );

        if (!row.rows.length) {
            await client.query('ROLLBACK');
            return bot.sendMessage(chatId, "That code is invalid or has expired. Generate a fresh one and try again.");
        }

        const { id: linkCodeId, student_id: studentId, driver_id: driverId } = row.rows[0];
        const isDriver = driverId !== null;
        const table = isDriver ? 'drivers' : 'students';
        const ownerId = isDriver ? driverId : studentId;

        // Guard against a chat ID that got linked to someone else between the read above and now.
        // Check both tables — a chat ID must never end up linked to a student AND a driver.
        const chatTaken = await alreadyLinked(chatId);
        if (chatTaken) {
            await client.query('ROLLBACK');
            return bot.sendMessage(chatId, "This Telegram account is already linked to a different Zira account.");
        }

        await client.query(
            `UPDATE ${table} SET telegram_chat_id = $1, telegram_linked_at = now() WHERE id = $2`,
            [chatId, ownerId]
        );
        await client.query(`UPDATE telegram_link_codes SET status = 'redeemed' WHERE id = $1`, [linkCodeId]);

        await client.query('COMMIT');

        return sendHome(chatId, isDriver ? "Linked ✅ You’ll receive ride-payment alerts here." : "Linked ✅ Your Zira wallet is now connected.");
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Telegram link failed:', err);
        return bot.sendMessage(chatId, "Something went wrong linking your account — try again in a moment.");
    } finally {
        client.release();
    }
}

// ------------------------------------------------------------------
// /code — generate a fresh one-time ride code without opening the app.
// Writes into the SAME one_time_codes table the driver panel checks against.
// ------------------------------------------------------------------
if (bot) {
    // ------------------------------------------------------------------
    // /code or /ride — generate a fresh one-time ride code
    // ------------------------------------------------------------------
    bot.onText(/\/(?:code|ride)/, async (msg) => {
        return sendRideCode(msg.chat.id);
    });

    // ------------------------------------------------------------------
    // /balance — check current wallet balance
    // ------------------------------------------------------------------
    bot.onText(/\/balance/, async (msg) => {
        const chatId = msg.chat.id;

        const student = await pool.query('SELECT id, wallet_balance, reg_no FROM students WHERE telegram_chat_id = $1', [chatId]);
        if (student.rows.length) {
            const bal = Number(student.rows[0].wallet_balance || 0).toLocaleString();
            return bot.sendMessage(
                chatId,
                `💳 *Zira Go Student Wallet*\n\n` +
                `👤 *ID:* ${student.rows[0].reg_no || 'Student'}\n` +
                `💰 *Balance:* ₦${bal}\n\n` +
                `• Send /ride to get a ride code\n` +
                `• Send /fund 1000 to top up`,
                { parse_mode: 'Markdown' }
            );
        }

        const driver = await pool.query('SELECT id, wallet_balance, full_name FROM drivers WHERE telegram_chat_id = $1', [chatId]);
        if (driver.rows.length) {
            const bal = Number(driver.rows[0].wallet_balance || 0).toLocaleString();
            return bot.sendMessage(
                chatId,
                `🚖 *Zira Go Driver Earnings*\n\n` +
                `👤 *Driver:* ${driver.rows[0].full_name || 'Driver'}\n` +
                `💰 *Available Balance:* ₦${bal}\n\n` +
                `Use the driver panel web app to request payouts.`,
                { parse_mode: 'Markdown' }
            );
        }

        return bot.sendMessage(chatId, "⚠️ This Telegram account is not yet linked. Open the Zira Go app to connect.");
    });

    // ------------------------------------------------------------------
    // /fund [amount] — top up wallet directly from Telegram
    // ------------------------------------------------------------------
    bot.onText(/\/fund(?:\s+(\d+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const amount = match[1] ? parseInt(match[1], 10) : null;

        const student = await pool.query('SELECT id, wallet_balance FROM students WHERE telegram_chat_id = $1', [chatId]);
        if (!student.rows.length) {
            return bot.sendMessage(chatId, "⚠️ Your Telegram isn't linked to a student account yet.");
        }

        if (!amount || amount < 250) {
            return bot.sendMessage(
                chatId,
                `💡 *How to fund your wallet on Telegram:*\n\n` +
                `Send \`/fund <amount>\` (minimum ₦250).\n\n` +
                `*Examples:*\n` +
                `• \`/fund 500\`\n` +
                `• \`/fund 1000\`\n` +
                `• \`/fund 2500\``,
                { parse_mode: 'Markdown' }
            );
        }

        return bot.sendMessage(
            chatId,
            `🔐 *Secure funding required*\n\n` +
            `To fund ₦${amount.toLocaleString()}, open the Zira Go wallet and complete checkout with Korapay or Flutterwave. Telegram never credits a wallet directly.`,
            { parse_mode: 'Markdown' }
        );
    });

    // ------------------------------------------------------------------
    // /support — campus helpdesk contact info
    // ------------------------------------------------------------------
    bot.onText(/\/support/, async (msg) => {
        const chatId = msg.chat.id;
        return bot.sendMessage(
            chatId,
            `📞 *Zira Go Campus Support Desk*\n\n` +
            `Need help with ride payments, PIN changes, or lost items?\n\n` +
            `💬 *WhatsApp:* [Chat with Support](https://wa.me/2348000000000)\n` +
            `✉️ *Email:* support@zirapay.com\n` +
            `🏢 *Campus Office:* Student Union Transport Secretariat\n\n` +
            `_Always provide your student matric / reg number when contacting us._`,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
    });

    // ------------------------------------------------------------------
    // /help — command reference
    // ------------------------------------------------------------------
    bot.onText(/\/help/, async (msg) => {
        return sendHome(msg.chat.id, 'Use the buttons below to manage your Zira Go account.');
    });
}

// ------------------------------------------------------------------
// Notification helpers — call these from zira_go_trip_routes.js after a
// successful charge. Both are no-ops if the student/driver has no linked chat.
// ------------------------------------------------------------------
async function notifyStudent(studentId, { fareAmount, newBalance }) {
    if (!bot) return;
    const row = await pool.query('SELECT telegram_chat_id FROM students WHERE id = $1', [studentId]);
    const chatId = row.rows[0]?.telegram_chat_id;
    if (!chatId) return;
    return bot.sendMessage(chatId, `Ride payment of ₦${fareAmount} confirmed. New balance: ₦${newBalance}.`);
}

async function notifyDriver(driverId, { fareAmount, driverCredit }) {
    if (!bot) return;
    const row = await pool.query('SELECT telegram_chat_id FROM drivers WHERE id = $1', [driverId]);
    const chatId = row.rows[0]?.telegram_chat_id;
    if (!chatId) return; // no-op until this driver has linked Telegram
    return bot.sendMessage(chatId, `Passenger paid ₦${fareAmount}. You received ₦${driverCredit} after fees.`);
}

// Not wired into trip_routes.js yet — call this from the code-guess endpoint's
// flag branch if you want the driver to hear about it here instead of (or in
// addition to) the in-app "contact support" screen.
async function notifyDriverFlagged(driverId) {
    if (!bot) return;
    const row = await pool.query('SELECT telegram_chat_id FROM drivers WHERE id = $1', [driverId]);
    const chatId = row.rows[0]?.telegram_chat_id;
    if (!chatId) return;
    return bot.sendMessage(chatId, "Your account has been flagged for too many wrong ride codes in a row. Contact support to get it reviewed.");
}

module.exports = { bot, notifyStudent, notifyDriver, notifyDriverFlagged };
