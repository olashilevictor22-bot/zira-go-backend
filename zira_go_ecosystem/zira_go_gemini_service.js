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

      // Support Gemini 1.5 Flash
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

module.exports = { generateReleaseSummary };
