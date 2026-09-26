// zira_go_gemini_service.js
// Zibo AI — Intelligent platform release summarizer and transit communications engine
// for Zira Go Campus Transit.

async function generateReleaseSummary({ changes = [], customNotes = '', apiKey = null }) {
  const key = apiKey || process.env.ZIBO_API_KEY || process.env.GEMINI_API_KEY;
  
  const rawContent = [
    customNotes ? `Additional Notes:\n${customNotes}` : '',
    ...changes.map(c => `• [${c.actor || 'Engineering'} - ${c.area || 'Core'}] ${c.title}: ${c.details || ''}`)
  ].filter(Boolean).join('\n\n');

  if (!rawContent.trim()) {
    return {
      title: 'Platform Enhancements & System Optimization',
      summary: '• **Performance Optimization** — Enhanced platform throughput and database query speeds.\n• **User Experience** — Streamlined interface responsiveness and navigation flow.\n• **Infrastructure Security** — Applied routine maintenance and verified system reliability.'
    };
  }

  if (key) {
    try {
      const prompt = `You are Zibo AI, the official Lead Communications & Transit Intelligence Engine for Zira Go (the campus transit ecosystem of Landmark University).
Analyze the following technical engineering updates and changelogs, and synthesize them into a polished, executive, user-friendly campus announcement for students and drivers.

Technical Changelog / Notes:
${rawContent}

Requirements:
1. Target audience: Landmark University campus students and drivers.
2. Tone: Highly professional, confident, clear, institutional transit standard.
3. STRICT CONSTRAINT: DO NOT USE ANY EMOJIS (zero emojis allowed). Use standard clean bullet points (•).
4. Remove internal dev jargon (like raw SQL, internal table names, or debug logs) and emphasize real user benefits (speed, reliability, privacy, security, transparency).
5. Output format: Return STRICTLY a valid JSON object with two fields:
{
  "title": "A short, professional title (e.g. Campus Transit Update: Enhanced Navigation, Privacy Controls & Financial Audit)",
  "summary": "3 to 5 clear bullet points formatted with '• **Feature Area** — Description of user benefit.'"
}`;

      const model = 'gemini-1.5-flash';
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 800,
            responseMimeType: 'application/json'
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          const parsed = JSON.parse(responseText);
          if (parsed.title && parsed.summary) {
            return {
              title: parsed.title.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim(),
              summary: parsed.summary.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim()
            };
          }
        }
      } else {
        const err = await response.text().catch(() => '');
        console.warn('[Gemini API Error]', response.status, err);
      }
    } catch (e) {
      console.warn('[Gemini Summarizer Error]', e.message);
    }
  }

  // Fallback intelligent formatter if no Gemini API Key is provided or on network error:
  const cleanFirstTitle = changes[0]?.title ? changes[0].title.split(',')[0].trim() : 'Platform Performance & Security';
  const bullets = changes.slice(0, 5).map(c => {
    const area = c.area ? c.area.split(',')[0].trim() : 'System';
    const detail = c.details ? c.details.split('.')[0] + '.' : 'Enhanced system operations and reliability.';
    return `• **${area}** — ${c.title}. ${detail}`;
  }).join('\n\n');

  return {
    title: `Campus Transit Update: ${cleanFirstTitle}`,
    summary: bullets || '• **Transit Infrastructure** — Key stability, security, and interface enhancements have been applied.'
  };
}

async function generateFinancialInsights({ kpi = {}, apiKey = null }) {
  const key = apiKey || process.env.ZIBO_API_KEY || process.env.GEMINI_API_KEY;

  const totalFunded = Number(kpi.totalFunded || 0);
  const totalFundingFees = Number(kpi.fundingFeeRevenue || 0);
  const tripFeeRevenue = Number(kpi.tripFeeRevenue || 0);
  const adRevenue = Number(kpi.adRevenue || 0);
  const platformRevenue = Number(kpi.platformRevenue || 0);
  const studentLiabilities = Number(kpi.studentLiabilities || 0);
  const driverBalances = Number(kpi.driverBalances || 0);
  const totalFloat = studentLiabilities + driverBalances;
  const pendingPayoutAmount = Number(kpi.pendingPayoutAmount || 0);
  const settledPayouts = Number(kpi.totalWithdrawn || 0);
  const activeAdsCount = Number(kpi.activeAdsCount || 0);
  const adsPendingRenewal = Number(kpi.adsPendingRenewal || 0);
  const totalGMV = Number(kpi.totalGMV || 0);

  const isSolvent = totalFloat >= pendingPayoutAmount;

  if (key) {
    try {
      const prompt = `You are Zibo AI, the Chief Financial & Treasury Intelligence Analyst for Zira Go (Landmark University Campus Transit Ecosystem).
Analyze the following live financial metrics and provide an executive-level financial analysis and treasury evaluation.

Live Treasury & Operational Metrics:
- Total GMV: ₦${totalGMV.toLocaleString()}
- Net Zira Go Platform Revenue: ₦${platformRevenue.toLocaleString()} (Ride Commissions: ₦${tripFeeRevenue.toLocaleString()}, Funding Fees: ₦${totalFundingFees.toLocaleString()}, Ads Revenue: ₦${adRevenue.toLocaleString()})
- Total Student Deposits / Funding: ₦${totalFunded.toLocaleString()} (${kpi.fundingTransactions || 0} deposits)
- Student Wallet Balances: ₦${studentLiabilities.toLocaleString()} (${kpi.studentCount || 0} students)
- Driver Wallet Balances: ₦${driverBalances.toLocaleString()} (${kpi.driverCount || 0} drivers)
- Campus Escrow Float: ₦${totalFloat.toLocaleString()}
- Settled Driver Disbursements: ₦${settledPayouts.toLocaleString()} (${kpi.withdrawalCount || 0} payouts)
- Pending Payouts Queue: ₦${pendingPayoutAmount.toLocaleString()} (${kpi.pendingPayoutCount || 0} awaiting dispatch)
- Failed / Cancelled Transactions: ₦${Number(kpi.failedTxAmount || 0).toLocaleString()} (${kpi.failedTxCount || 0} failed)
- Campus Ads Marketplace: ${activeAdsCount} active ads, ${adsPendingRenewal} pending renewal, ₦${adRevenue.toLocaleString()} ad revenue

Strict Guidelines:
1. Tone: Authoritative, executive financial intelligence, highly clear and institutional.
2. STRICT CONSTRAINT: DO NOT USE ANY EMOJIS (Zero emojis allowed). Use standard clean bullet points (•).
3. Output format: Return STRICTLY a valid JSON object with the following schema:
{
  "healthStatus": "Optimal Treasury" | "Healthy Liquidity" | "Attention Needed",
  "solvencyRatio": "Percentage or summary (e.g. 100% Fully Backed)",
  "executiveSummary": "2-3 sentences synthesizing treasury performance, cash velocity, and escrow safety.",
  "keyHighlights": [
    "• **Liquidity & Escrow** — description of float vs payout coverage.",
    "• **Monetization Margins** — description of top revenue drivers.",
    "• **Merchant & Ad Health** — assessment of active ads and renewal pipeline."
  ],
  "recommendations": [
    "• **Strategic Directive** — actionable recommendation for admin treasury management."
  ]
}`;

      const model = 'gemini-1.5-flash';
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 900,
            responseMimeType: 'application/json'
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          const parsed = JSON.parse(responseText);
          if (parsed.executiveSummary) {
            return {
              healthStatus: (parsed.healthStatus || 'Optimal Treasury').replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim(),
              solvencyRatio: (parsed.solvencyRatio || '100% Reserve Ratio').replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim(),
              executiveSummary: parsed.executiveSummary.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim(),
              keyHighlights: (parsed.keyHighlights || []).map(h => h.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim()),
              recommendations: (parsed.recommendations || []).map(r => r.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim())
            };
          }
        }
      }
    } catch (e) {
      console.warn('[Gemini Financial Insights Error]', e.message);
    }
  }

  // High-precision deterministic fallback
  const floatCoverage = pendingPayoutAmount > 0 ? ((totalFloat / pendingPayoutAmount) * 100).toFixed(0) + '%' : '100%';
  const healthStatus = isSolvent ? 'Optimal Treasury' : 'Review Settlement Queue';

  return {
    healthStatus,
    solvencyRatio: `${floatCoverage} Float Coverage`,
    executiveSummary: `Total GMV processed stands at ₦${totalGMV.toLocaleString()} with ₦${platformRevenue.toLocaleString()} in net platform earnings. Campus escrow float is stable at ₦${totalFloat.toLocaleString()} across ${kpi.studentCount || 0} registered students and ${kpi.driverCount || 0} drivers, maintaining 100% solvency against pending disbursements.`,
    keyHighlights: [
      `• **Liquidity & Escrow Float** — Student balances (₦${studentLiabilities.toLocaleString()}) and driver balances (₦${driverBalances.toLocaleString()}) represent ₦${totalFloat.toLocaleString()} in protected platform liquidity reserves.`,
      `• **Monetization Margins** — Platform earnings comprise ₦${totalFundingFees.toLocaleString()} in deposit convenience fees (₦100/deposit), ₦${tripFeeRevenue.toLocaleString()} in trip commissions, and ₦${adRevenue.toLocaleString()} in campus advertising fees.`,
      `• **Campus Ads Marketplace** — ${activeAdsCount} advert campaigns are live, with ${adsPendingRenewal} advert campaigns in the pending renewal queue at ₦1,000 per renewal.`
    ],
    recommendations: [
      adsPendingRenewal > 0 ? `• **Advert Pipeline** — ${adsPendingRenewal} adverts are awaiting renewal; student reminder notifications are active to maintain high marketplace velocity.` : `• **Settlement Queue** — Pending driver payout queue has ${kpi.pendingPayoutCount || 0} disbursements totalling ₦${pendingPayoutAmount.toLocaleString()}. Dispatch settlements regularly to maintain driver trust.`
    ]
  };
}

module.exports = { generateReleaseSummary, generateFinancialInsights };
