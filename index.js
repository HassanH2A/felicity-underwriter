const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

// ── ENV ──────────────────────────────────────────────────────────────────────
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const NOTION_DB     = (process.env.NOTION_DATABASE_ID || '').replace(/^=/, '').trim();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const POLL_MS       = 60_000;

const anthropic  = new Anthropic({ apiKey: ANTHROPIC_KEY });
const processing = new Set();

// ── REHAB RATES ───────────────────────────────────────────────────────────────
const REHAB_RATES = {
  'Turnkey':        5,
  'Light Cosmetic': 20,
  'Full Rehab':     45,
  'Torn':           70,
};
const DEFAULT_REHAB = 45;
const VALID_RATES   = [5, 20, 45, 70];

// ── RATE LIMIT TRACKING (Tier 1: 30k TPM, budget 25k) ─────────────────────────
const TPM_BUDGET = 25_000;
const tokenLog = [];

function recordTokens(n) {
  tokenLog.push({ time: Date.now(), tokens: n });
}

function tokensInLastMinute() {
  const cutoff = Date.now() - 60_000;
  while (tokenLog.length && tokenLog[0].time < cutoff) tokenLog.shift();
  return tokenLog.reduce((s, e) => s + e.tokens, 0);
}

async function waitForTokenBudget(estimatedTokens) {
  const used = tokensInLastMinute();
  if (used + estimatedTokens > TPM_BUDGET) {
    const oldest = tokenLog[0]?.time || Date.now();
    const waitMs = Math.max(5000, 60_000 - (Date.now() - oldest) + 1000);
    console.log(`    [Rate limit: used ${used}, waiting ${Math.round(waitMs/1000)}s]`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// ── NOTION HELPERS ────────────────────────────────────────────────────────────
async function notionRequest(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization':  `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.object === 'error') {
    console.error(`  Notion API error: ${json.message} (${json.code})`);
  }
  return json;
}

async function getUnderwritingCards() {
  const data = await notionRequest(`/databases/${NOTION_DB}/query`, 'POST', {
    filter: {
      and: [
        { property: 'Status', status: { equals: 'Underwriting' } },
        { property: 'ARV',    number: { is_empty: true } },
      ],
    },
  });
  return data.results || [];
}

function getTitle(card) {
  return card.properties?.Name?.title?.map(t => t.plain_text).join('') || '';
}

function getProp(card, name, type = 'rich_text') {
  const p = card.properties?.[name];
  if (!p) return null;
  if (type === 'rich_text') return p.rich_text?.map(t => t.plain_text).join('') || null;
  if (type === 'select')    return p.select?.name || null;
  if (type === 'number')    return p.number ?? null;
  if (type === 'checkbox')  return p.checkbox ?? false;
  return null;
}

async function patchCard(pageId, properties) {
  return notionRequest(`/pages/${pageId}`, 'PATCH', { properties });
}

async function setStatus(pageId, status) {
  return patchCard(pageId, { Status: { status: { name: status } } });
}

async function appendNote(pageId, text) {
  const blocks = text.split('\n').map(line => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: line.trim() ? [{ type: 'text', text: { content: line } }] : [] },
  }));
  await notionRequest(`/blocks/${pageId}/children`, 'PATCH', { children: blocks });
}

// ── JSON PARSING ──────────────────────────────────────────────────────────────
function extractText(content) {
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1].trim());

  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);

  let candidate = null;
  if (objMatch && arrMatch) {
    candidate = objMatch.index < arrMatch.index ? objMatch[0] : arrMatch[0];
  } else {
    candidate = (objMatch && objMatch[0]) || (arrMatch && arrMatch[0]);
  }

  if (candidate) return JSON.parse(candidate);
  return JSON.parse(text.trim());
}

// ── UNDERWRITE: find sqft, ARV, and comp URLs ─────────────────────────────────
async function underwrite(address) {
  console.log('    Researching property and comps...');
  await waitForTokenBudget(15000);

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1000,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3,
    }],
    messages: [{
      role: 'user',
      content: `You are underwriting a US real estate wholesale deal. Address: ${address}

This address could be anywhere in the United States. Do not assume a location.

Task 1 - Find subject property on Zillow: get sqft.

Task 2 - Find 1-3 SOLD comps on Zillow Recently Sold:
- Within ~0.5 miles
- Similar sqft (within 20%)
- Built BEFORE 2020 (exclude new construction)
- Single family only
- Sold in last 12 months

Task 3 - Compute ARV: average price per sqft across comps, multiplied by subject sqft.

Respond with ONLY JSON. No prose. Start with { and end with }.

Format:
{"sqft":0,"arv":0,"comps":["<zillow url 1>","<zillow url 2>","<zillow url 3>"]}

If subject property cannot be found: {"error":"property not found"}
If no comps found at all: {"error":"no comps","sqft":0}`
    }],
  });

  recordTokens(resp.usage?.input_tokens || 0);
  console.log(`    [tokens: ${resp.usage?.input_tokens || '?'} in / ${resp.usage?.output_tokens || '?'} out]`);

  const text = extractText(resp.content);
  return parseJSON(text);
}

// ── REHAB RATE EVALUATION ─────────────────────────────────────────────────────
// Uses both condition and description when available. Claude combines them
// and picks the best rate. Falls back to Full Rehab ($45) if nothing's set.
async function evaluateRehabRate(condition, description) {
  const hasCondition   = condition && REHAB_RATES[condition] !== undefined;
  const hasDescription = description && description.trim().length > 0;

  // Neither available: default to Full Rehab
  if (!hasCondition && !hasDescription) {
    return DEFAULT_REHAB;
  }

  // Only condition, no description: use lookup (saves a Claude call)
  if (hasCondition && !hasDescription) {
    return REHAB_RATES[condition];
  }

  // Description present (with or without condition): ask Claude to evaluate both together
  await waitForTokenBudget(1500);

  const prompt = `Pick a rehab rate ($/sqft) for a fix-and-flip deal.

${hasCondition ? `Condition tag on card: ${condition} (base rate $${REHAB_RATES[condition]}/sqft)` : 'No condition tag set.'}
Property description: "${description}"

Use BOTH the condition tag and the description together. If the description reveals issues worse or better than the condition tag suggests, adjust accordingly.

Options:
- 5  = Turnkey (essentially move-in ready, minor touch-ups only)
- 20 = Light Cosmetic (paint, fixtures, flooring refresh)
- 45 = Full Rehab (kitchen, baths, flooring, paint, some systems)
- 70 = Torn (full gut, structural issues, major systems, roof, foundation)

If uncertain, pick 45. Respond with ONLY a single number: 5, 20, 45, or 70.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });

  recordTokens(resp.usage?.input_tokens || 0);
  const text = resp.content[0]?.text?.trim() || '45';
  const num  = parseInt(text.match(/\d+/)?.[0] || '45');
  return VALID_RATES.includes(num) ? num : DEFAULT_REHAB;
}

// ── PROCESS ONE CARD ─────────────────────────────────────────────────────────
async function processCard(card) {
  const address = getTitle(card);
  if (!address || address.toLowerCase() === 'new page') {
    console.log(`\n  [Skipped: "${address || '(empty)'}" - not a valid address]`);
    return;
  }

  console.log(`\n  Processing: ${address}`);

  try {
    const condition   = getProp(card, 'Condition', 'select') || '';
    // Description field may or may not exist; pull it if present
    const description = getProp(card, 'Description', 'rich_text') || '';

    // ── 1. Rehab rate (from condition + description, evaluated by Claude)
    const rehabRate = await evaluateRehabRate(condition, description);
    const rateSource = condition && description ? `${condition} + description`
                     : condition ? condition
                     : description ? 'from description'
                     : 'default';
    console.log(`    Rehab rate: $${rehabRate}/sqft (${rateSource})`);

    await patchCard(card.id, {
      'Rehab per Sqft': { select: { name: String(rehabRate) } }
    });

    // ── 2. Underwrite: get sqft, ARV, comp URLs
    const result = await underwrite(address);

    if (result.error === 'property not found') {
      await setStatus(card.id, 'Gathering Info');
      await appendNote(card.id,
        `Underwriting paused\n\nCould not find this property on Zillow. Please verify the address, then fill in Sqft and ARV manually.`);
      console.log('    > Gathering Info (property not found)');
      return;
    }

    if (result.error === 'no comps') {
      if (result.sqft) await patchCard(card.id, { Sqft: { number: parseInt(result.sqft) } });
      await setStatus(card.id, 'Gathering Info');
      await appendNote(card.id,
        `Underwriting paused -- no comps found\n\nFound property (${result.sqft} sqft) but could not find any sold comps on Zillow matching the criteria. Please add ARV manually.`);
      console.log('    > Gathering Info (no comps)');
      return;
    }

    if (!result.sqft || !result.arv) {
      await setStatus(card.id, 'Gathering Info');
      await appendNote(card.id,
        `Underwriting paused -- incomplete data.\n\nReceived: sqft=${result.sqft}, arv=${result.arv}\n\nPlease fill in missing fields manually.`);
      console.log('    > Gathering Info (incomplete data)');
      return;
    }

    // ── 3. Write sqft, ARV, and comp URLs to card
    const updates = {
      Sqft: { number: parseInt(result.sqft) },
      ARV:  { number: parseInt(result.arv) },
    };

    const comps = Array.isArray(result.comps) ? result.comps.filter(Boolean) : [];
    if (comps[0]) updates['Comp #1'] = { url: comps[0] };
    if (comps[1]) updates['Comp #2'] = { url: comps[1] };
    if (comps[2]) updates['Comp #3'] = { url: comps[2] };

    await patchCard(card.id, updates);

    // ── 4. Status
    await setStatus(card.id, 'Ready to Offer');

    console.log(`    > Done: Sqft ${result.sqft} | ARV $${parseInt(result.arv).toLocaleString()} | Rehab $${rehabRate}/sqft | ${comps.length} comps`);

  } catch (err) {
    console.error(`    > Error: ${err.message}`);
    try {
      await appendNote(card.id, `Underwriting error: ${err.message}\n\nPlease process this card manually.`);
    } catch (_) {}
  }
}

// ── POLL ─────────────────────────────────────────────────────────────────────
async function poll() {
  process.stdout.write(`[${new Date().toISOString()}] Polling... `);
  try {
    const cards = await getUnderwritingCards();
    console.log(`${cards.length} card(s) to process`);

    for (const card of cards) {
      if (processing.has(card.id)) continue;
      processing.add(card.id);
      try {
        await processCard(card);
      } finally {
        processing.delete(card.id);
      }
      if (cards.length > 1) await new Promise(r => setTimeout(r, 5000));
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('Felicity Capital Underwriter');
console.log(`Database: ${NOTION_DB}`);
console.log(`Polling every ${POLL_MS / 1000}s\n`);

if (!NOTION_DB)     { console.error('ERROR: NOTION_DATABASE_ID not set.'); process.exit(1); }
if (!NOTION_TOKEN)  { console.error('ERROR: NOTION_TOKEN not set.');       process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set.');  process.exit(1); }

poll();
setInterval(poll, POLL_MS);
