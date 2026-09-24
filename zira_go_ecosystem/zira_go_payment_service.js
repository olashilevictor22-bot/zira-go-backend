// zira_go_payment_service.js
// Unified Korapay and Flutterwave service for wallet funding, bank resolution,
// driver payout disbursements, and strict name-match verification.

const crypto = require('crypto');

const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || '';
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY || '';
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

function hostedReturnUrl(reference, gateway) {
    if (!APP_BASE_URL) throw new Error('APP_BASE_URL must be configured for hosted payments.');
    return `${APP_BASE_URL}/zira_go_student_wallet.html?paymentRef=${encodeURIComponent(reference)}&gateway=${gateway}`;
}

// =========================================================================
// 1. Strict Name Matching Helper
// =========================================================================
/**
 * Normalizes and compares a registered user's full name against the name
 * returned from bank account resolution (NIBSS / CBN).
 * Enforces that payouts can ONLY be sent to an account belonging to the registered driver.
 *
 * @param {string} registeredName - e.g. "Adeyemi Victor Oluwaseun"
 * @param {string} bankAccountName - e.g. "ADEYEMI VICTOR O." or "VICTOR ADEYEMI"
 * @returns {{ matched: boolean, registeredName: string, bankAccountName: string, reason?: string }}
 */
function verifyNameMatch(registeredName, bankAccountName) {
    if (!registeredName || !bankAccountName) {
        return {
            matched: false,
            registeredName: registeredName || '',
            bankAccountName: bankAccountName || '',
            reason: 'Missing registered name or bank account name for verification.'
        };
    }

    const clean = (str) =>
        str
            .toUpperCase()
            .replace(/[^A-Z\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 0);

    const regTokens = clean(registeredName);
    const bankTokens = clean(bankAccountName);

    if (regTokens.length === 0 || bankTokens.length === 0) {
        return {
            matched: false,
            registeredName,
            bankAccountName,
            reason: 'Name tokens could not be parsed.'
        };
    }

    // Count matching tokens (full match or prefix/initial match of length 1)
    let matchCount = 0;
    const usedBankIndices = new Set();

    for (const rWord of regTokens) {
        for (let j = 0; j < bankTokens.length; j++) {
            if (usedBankIndices.has(j)) continue;
            const bWord = bankTokens[j];

            if (rWord === bWord) {
                matchCount++;
                usedBankIndices.add(j);
                break;
            } else if (
                (rWord.length === 1 && bWord.startsWith(rWord)) ||
                (bWord.length === 1 && rWord.startsWith(bWord))
            ) {
                // Initial match (e.g. 'O.' for 'Oluwaseun')
                matchCount += 0.8;
                usedBankIndices.add(j);
                break;
            }
        }
    }

    // Need at least 2 name tokens matched or full match if only 1 token registered
    const requiredMatches = Math.min(2, Math.min(regTokens.length, bankTokens.length));
    const isMatched = matchCount >= requiredMatches;

    return {
        matched: isMatched,
        registeredName,
        bankAccountName,
        matchCount,
        requiredMatches,
        reason: isMatched
            ? 'Account name verified successfully.'
            : `Bank account name (${bankAccountName}) does not match your registered full name (${registeredName}). Withdrawals must be sent to an account in your own legal name.`
    };
}

// =========================================================================
// 2. Korapay Payment Integration
// =========================================================================
async function initializeKorapayFunding({ email, amount, reference, customerName, redirectUrl }) {
    const hasLiveKey = KORAPAY_SECRET_KEY && !KORAPAY_SECRET_KEY.startsWith('your_') && KORAPAY_SECRET_KEY !== 'mock';

    if (hasLiveKey) {
        try {
            const res = await fetch('https://api.korapay.com/merchant/api/v1/charges/initialize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    amount: Number(amount),
                    currency: 'NGN',
                    customer: {
                        name: customerName || 'Zira Go Student',
                        email
                    },
                    reference,
                    redirect_url: redirectUrl || hostedReturnUrl(reference, 'korapay'),
                    merchant_bears_cost: false,
                    channels: ['card', 'bank_transfer'],
                    metadata: {
                        platform: 'Zira Go Transport',
                        purpose: 'Student Wallet Funding'
                    }
                })
            });

            const data = await res.json();
            if (data.status && data.data?.checkout_url) {
                return {
                    gateway: 'korapay',
                    checkoutUrl: data.data.checkout_url,
                    reference: data.data.reference || reference,
                    mode: 'live'
                };
            }
        } catch (err) {
            console.warn('[Korapay Init Warning]', err.message);
            throw new Error('Korapay could not start checkout. Check the live secret key and merchant account configuration.');
        }
        throw new Error('Korapay rejected checkout initialization. Check the key, account status, and allowed payment channels.');
    }

    throw new Error('Korapay is not configured. Wallet funding is unavailable.');
}

async function verifyKorapayFunding(reference) {
    const hasLiveKey = KORAPAY_SECRET_KEY && !KORAPAY_SECRET_KEY.startsWith('your_') && KORAPAY_SECRET_KEY !== 'mock';

    if (hasLiveKey) {
        try {
            const res = await fetch(`https://api.korapay.com/merchant/api/v1/charges/${encodeURIComponent(reference)}`, {
                headers: { Authorization: `Bearer ${KORAPAY_SECRET_KEY}` }
            });
            const data = await res.json();
            if (data.status && data.data?.status === 'success') {
                return {
                    success: true,
                    amount: Number(data.data.amount),
                    reference: data.data.reference,
                    paidAt: data.data.paid_at || new Date().toISOString(),
                    channel: data.data.payment_method || 'Korapay Gateway',
                    mode: 'live'
                };
            }
        } catch (err) {
            console.warn('[Korapay Verify Warning]', err.message);
        }
    }

    return { success: false, reference, message: 'Korapay is not configured.' };
}

// =========================================================================
// 3. Flutterwave Payment Integration
// =========================================================================
async function initializeFlutterwaveFunding({ email, amount, reference, customerName, redirectUrl }) {
    const hasLiveKey = FLW_SECRET_KEY && !FLW_SECRET_KEY.startsWith('your_') && FLW_SECRET_KEY !== 'mock';

    if (hasLiveKey) {
        try {
            const res = await fetch('https://api.flutterwave.com/v3/payments', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    tx_ref: reference,
                    amount: Number(amount),
                    currency: 'NGN',
                    redirect_url: redirectUrl || hostedReturnUrl(reference, 'flutterwave'),
                    customer: {
                        email,
                        name: customerName || 'Zira Go Student'
                    },
                    customizations: {
                        title: 'Zira Go Student Wallet Funding',
                        description: 'Campus Tap & Move Transport Top-Up',
                        logo: APP_BASE_URL ? `${APP_BASE_URL}/zira_go_logo.png` : undefined
                    }
                })
            });

            const data = await res.json();
            if (data.status === 'success' && data.data?.link) {
                return {
                    gateway: 'flutterwave',
                    checkoutUrl: data.data.link,
                    reference,
                    mode: 'live'
                };
            }
        } catch (err) {
            console.warn('[Flutterwave Init Warning]', err.message);
            throw new Error('Flutterwave could not start checkout. Check the live secret key and merchant account configuration.');
        }
        throw new Error('Flutterwave rejected checkout initialization. Check the key and merchant account status.');
    }

    throw new Error('Flutterwave is not configured. Wallet funding is unavailable.');
}

async function verifyFlutterwaveFunding(reference) {
    const hasLiveKey = FLW_SECRET_KEY && !FLW_SECRET_KEY.startsWith('your_') && FLW_SECRET_KEY !== 'mock';

    if (hasLiveKey) {
        try {
            const res = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
                headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` }
            });
            const data = await res.json();
            if (data.status === 'success' && data.data?.status === 'successful') {
                return {
                    success: true,
                    amount: Number(data.data.amount),
                    reference: data.data.tx_ref,
                    paidAt: data.data.created_at || new Date().toISOString(),
                    channel: data.data.payment_type || 'Flutterwave Card',
                    mode: 'live'
                };
            }
        } catch (err) {
            console.warn('[Flutterwave Verify Warning]', err.message);
        }
    }

    return { success: false, reference, message: 'Flutterwave is not configured.' };
}

// =========================================================================
// 4. Bank Account Name Resolution (NIBSS / Gateway lookup)
// =========================================================================
// fetch with a hard timeout so a stalled provider can never leave the UI hanging
async function fetchWithTimeout(url, options = {}, ms = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

async function resolveAccountName(accountNumber, bankCode) {
    const reasons = [];

    // 1. Flutterwave first — the bank list (and its codes) comes from Flutterwave,
    //    so these codes are guaranteed to be valid here.
    if (FLW_SECRET_KEY && FLW_SECRET_KEY !== 'mock') {
        try {
            const res = await fetchWithTimeout('https://api.flutterwave.com/v3/accounts/resolve', {
                method: 'POST',
                headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode })
            });
            const data = await res.json().catch(() => ({}));
            if (data.status === 'success' && data.data?.account_name) {
                return { accountName: data.data.account_name, provider: 'flutterwave' };
            }
            const why = `Flutterwave ${res.status}: ${data.message || 'no account name returned'}`;
            console.warn('[Resolve] ' + why);
            reasons.push(why);
        } catch (e) {
            const why = `Flutterwave ${e.name === 'AbortError' ? 'timed out' : 'error: ' + e.message}`;
            console.warn('[Resolve] ' + why);
            reasons.push(why);
        }
    }

    // 2. Korapay fallback
    if (KORAPAY_SECRET_KEY && KORAPAY_SECRET_KEY !== 'mock') {
        try {
            const res = await fetchWithTimeout('https://api.korapay.com/merchant/api/v1/misc/banks/resolve', {
                method: 'POST',
                headers: { Authorization: `Bearer ${KORAPAY_SECRET_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ account: accountNumber, bank: bankCode, currency: 'NGN' })
            });
            const data = await res.json().catch(() => ({}));
            if (data.status && data.data?.account_name) {
                return { accountName: data.data.account_name, provider: 'korapay' };
            }
            const why = `Korapay ${res.status}: ${data.message || 'no account name returned'}`;
            console.warn('[Resolve] ' + why);
            reasons.push(why);
        } catch (e) {
            const why = `Korapay ${e.name === 'AbortError' ? 'timed out' : 'error: ' + e.message}`;
            console.warn('[Resolve] ' + why);
            reasons.push(why);
        }
    }

    const err = new Error('Live account verification is unavailable. Check the Flutterwave/Korapay live credentials and bank code.');
    err.reasons = reasons;
    throw err;
}

async function getNigerianBanks() {
    const hasLiveKey = FLW_SECRET_KEY && !FLW_SECRET_KEY.startsWith('your_') && FLW_SECRET_KEY !== 'mock';
    if (!hasLiveKey) throw new Error('Flutterwave live credentials are required to load banks.');
    const res = await fetch('https://api.flutterwave.com/v3/banks/NG', { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'success' || !Array.isArray(data.data)) throw new Error(data.message || 'Could not load the live Nigerian bank list.');
    return data.data.filter(bank => bank.code && bank.name).map(bank => ({ code: String(bank.code), name: String(bank.name) })).sort((a,b) => a.name.localeCompare(b.name));
}

// A transfer acceptance is distinct from a completed bank settlement. The
// caller records this as processing and only marks it completed from a trusted
// provider status update.
async function initiateDriverPayout({ accountNumber, bankCode, amount, reference, narration }) {
    const hasLiveKey = FLW_SECRET_KEY && !FLW_SECRET_KEY.startsWith('your_') && FLW_SECRET_KEY !== 'mock';
    if (!hasLiveKey) {
        throw new Error('Flutterwave payouts are not configured. Set FLW_SECRET_KEY before enabling withdrawals.');
    }
    const res = await fetch('https://api.flutterwave.com/v3/transfers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            account_bank: bankCode, account_number: accountNumber, amount: Number(amount),
            narration: narration || 'Zira Go driver earnings payout', currency: 'NGN',
            reference, debit_currency: 'NGN'
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || `Flutterwave transfer request failed (${res.status}).`);
    }
    return {
        provider: 'flutterwave',
        providerTransferId: String(data.data?.id || ''),
        providerReference: data.data?.reference || reference,
        status: String(data.data?.status || 'processing').toLowerCase()
    };
}

module.exports = {
    verifyNameMatch,
    initializeKorapayFunding,
    verifyKorapayFunding,
    initializeFlutterwaveFunding,
    verifyFlutterwaveFunding,
    resolveAccountName,
    getNigerianBanks,
    initiateDriverPayout
};
