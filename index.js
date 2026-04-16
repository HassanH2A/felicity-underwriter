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
  'Turnkey':        0,
  'Light Cosmetic': 15,
  'Full Rehab':     35,
  'Torn':           55,
};
const DEFAULT_REHAB = 35;

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

async function appendBlocks(pageId, text) {
  const lines = text.split('\n');
  const blocks = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      blocks.push({ object: 'block', type: 'heading_1',
        heading_1: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] } });
    } else if (line.startsWith('## ')) {
      blocks.push({ object: 'block', type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: line.slice(3) } }] } });
    } else if (line.startsWith('### ')) {
      blocks.push({ object: 'block', type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: line.slice(4) } }] } });
    } else if (line.match(/^─+$/) || line.match(/^━+$/)) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    } else if (line.trim() === '') {
      blocks.push({ object: 'block', type: 'paragraph',
        paragraph: { rich_text: [] } });
    } else {
      blocks.push({ object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: line } }] } });
    }
  }

  for (let i = 0; i < blocks.length; i += 100) {
    await notionRequest(`/blocks/${pageId}/children`, 'PATCH', {
      children: blocks.slice(i, i + 100),
    });
  }
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

// ── UNDERWRITE (one consolidated call: property + comps + ARV) ─────────────────
async function underwrite(address) {
  console.log('    Researching property and comps...');
  await waitForTokenBudget(15000);

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1500,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3,
    }],
    messages: [{
      role: 'user',
      content: `You are underwriting a US real estate wholesale deal. Address: ${address}

This address could be anywhere in the United States. Do not assume a location.

Task 1 - Subject property on Zillow:
Find sqft, beds, baths, year built.

Task 2 - Find 3-5 SOLD comparable homes on Zillow Recently Sold:
- Within ~0.5 miles of subject
- Similar sqft (within 20%)
- Built BEFORE 2020 (exclude new construction)
- Single family only
- Sold in last 12 months
- Prefer renovated/updated homes

Task 3 - Compute ARV:
Average price per sqft across comps, multiplied by subject sqft.

Respond with ONLY JSON. No prose. Start with { and end with }.

Format:
{"sqft":0,"beds":0,"baths":0,"yearBuilt":0,"arv":0,"comps":[{"address":"...","salePrice":0,"sqft":0,"saleDate":"...","url":"..."}]}

If subject property cannot be found: {"error":"property not found"}
If fewer than 3 valid comps found: {"error":"insufficient comps","sqft":0,"beds":0,"baths":0,"yearBuilt":0}`
    }],
  });

  recordTokens(resp.usage?.input_tokens || 0);
  console.log(`    [tokens: ${resp.usage?.input_tokens || '?'} in / ${resp.usage?.output_tokens || '?'} out]`);

  const text = extractText(resp.content);
  return parseJSON(text);
}

// ── FORMULA ───────────────────────────────────────────────────────────────────
function runFormula(arv, sqft, rehabPerSqft) {
  const rehab    = sqft * rehabPerSqft;
  const closing  = arv * 0.06;
  const carrying = arv * 0.02;

  const flipC  = arv * 0.20;
  const feeC   = Math.max(10_000, arv * 0.10);
  const dispoC = arv - rehab - closing - carrying - flipC;
  const lowOffer = dispoC - feeC;

  const flipA  = arv * 0.10;
  const feeA   = 10_000;
  const dispoA = arv - rehab - closing - carrying - flipA;
  const highOffer = dispoA - feeA;

  return {
    arv:          Math.round(arv),
    rehab:        Math.round(rehab),
    closing:      Math.round(closing),
    carrying:     Math.round(carrying),
    flipC:        Math.round(flipC),
    flipA:        Math.round(flipA),
    feeC:         Math.round(feeC),
    feeA,
    dispoC:       Math.round(dispoC),
    dispoA:       Math.round(dispoA),
    lowOffer:     Math.round(lowOffer),
    highOffer:    Math.round(highOffer),
    offerArvRatio: arv > 0 ? highOffer / arv : 0,
  };
}

// ── ASSESSMENT ────────────────────────────────────────────────────────────────
async function generateNotes(address, subject, comps, formula, condition, askingPrice, rehabRate) {
  const $ = n => n != null ? '$' + Math.round(n).toLocaleString() : 'N/A';
  const pct = n => (n * 100).toFixed(1) + '%';
  const avgPsf = comps.length ? Math.round(comps.reduce((s, c) => s + (c.salePrice / c.sqft), 0) / comps.length) : 0;

  const prompt = `You are the underwriting AI for Felicity Capital, a real estate wholesaler.

SUBJECT: ${address}
Sqft: ${subject.sqft} | Beds: ${subject.beds} | Baths: ${subject.baths} | Built: ${subject.yearBuilt}
Condition: ${condition || 'Full Rehab (default)'} -> $${rehabRate}/sqft
Asking: ${askingPrice ? $(askingPrice) : 'N/A'}

COMPS (${comps.length}):
${comps.map((c, i) => `${i + 1}. ${c.address} | ${$(c.salePrice)} | ${c.sqft} sqft | ${c.saleDate}`).join('\n')}
Avg PSF: $${avgPsf} -> ARV: ${$(formula.arv)}

OFFER: ${$(formula.lowOffer)} - ${$(formula.highOffer)} | Offer/ARV: ${pct(formula.offerArvRatio)}
${askingPrice ? `Asking vs MAO: ${askingPrice > formula.highOffer ? 'ABOVE by ' + $(askingPrice - formula.highOffer) : 'BELOW by ' + $(formula.highOffer - askingPrice)}` : ''}

Write 3-4 sharp sentences: comp quality, neighbourhood signal, flags, verdict. This is read by a wholesaler about to call the seller.`;

  await waitForTokenBudget(2000);

  const resp = await anthropic.messages.create({
    model:      'claude-sonnet-4-5-20250929',
    max_tokens: 400,
    messages:   [{ role: 'user', content: prompt }],
  });
  recordTokens(resp.usage?.input_tokens || 0);
  return resp.content[0].text.trim();
}

// ── SUMMARY BUILDER ───────────────────────────────────────────────────────────
function buildSummary({ address, subject, comps, formula, condition, avgPsf, askingPrice, notes, rehabRate }) {
  const $   = n => n != null ? '$' + Math.round(n).toLocaleString() : 'N/A';
  const pct = n => (n * 100).toFixed(1) + '%';
  const flags = [];

  if (askingPrice && askingPrice > formula.arv)
    flags.push('Warning: Seller asking ABOVE ARV -- property may be overpriced');
  if (askingPrice && askingPrice > formula.highOffer)
    flags.push(`Warning: Seller asking ${$(askingPrice - formula.highOffer)} above MAO -- tough negotiation ahead`);
  if (formula.offerArvRatio > 0.85)
    flags.push('Warning: Offer/ARV > 85% -- thin margin, push for lower price');
  if (comps.length < 5)
    flags.push(`Note: Only ${comps.length} comps found -- ARV estimate less certain`);
  if (formula.offerArvRatio <= 0.72 && formula.highOffer > 0)
    flags.push('Strong spread -- excellent deal if numbers hold');

  return `# Underwriting Report
Auto-generated by Felicity Capital Underwriter

## Property Details
Address: ${address}
Sqft: ${subject.sqft?.toLocaleString()} | Beds: ${subject.beds} | Baths: ${subject.baths} | Built: ${subject.yearBuilt}
Condition: ${condition || 'Full Rehab (default)'} > $${rehabRate}/sqft rehab rate

## Comparable Sales
${comps.map((c, i) =>
  `${i + 1}. ${c.address}
   Sold: ${$(c.salePrice)} | ${c.sqft?.toLocaleString()} sqft | $${Math.round(c.salePrice/c.sqft)}/sqft | ${c.saleDate}
   ${c.url}`
).join('\n\n')}

Average PSF: $${Math.round(avgPsf)}/sqft across ${comps.length} comps

## Formula Breakdown
ARV:                      ${$(formula.arv)}
Rehab Cost:               ${$(formula.rehab)}  (${subject.sqft?.toLocaleString()} sqft x $${rehabRate})
Closing Costs:            ${$(formula.closing)}  (6% of ARV)
Carrying Costs:           ${$(formula.carrying)}  (2% of ARV)

Conservative offer (anchor):
  Flip Profit:            ${$(formula.flipC)}  (20% of ARV)
  Assignment Fee:         ${$(formula.feeC)}  (10% of ARV)
  = Low Offer:            ${$(formula.lowOffer)}

Aggressive offer (MAO):
  Flip Profit:            ${$(formula.flipA)}  (10% of ARV)
  Assignment Fee:         $10,000  (minimum)
  = High Offer / MAO:     ${$(formula.highOffer)}

## Offer Range
Anchor (start here on the phone):   ${$(formula.lowOffer)}
MAO (never go above this):          ${$(formula.highOffer)}
Offer / ARV:                        ${pct(formula.offerArvRatio)}
${askingPrice ? `Asking Price:                       ${$(askingPrice)}` : ''}

## Flags
${flags.length ? flags.join('\n') : 'No flags -- numbers look clean'}

## Assessment
${notes}`;
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
    const askingRaw   = getProp(card, 'Asking Price', 'rich_text');
    const askingPrice = askingRaw ? parseFloat(String(askingRaw).replace(/[^0-9.]/g, '')) || null : null;

    // Determine rehab rate NOW (from condition, or default to Full Rehab)
    const rehabRate = REHAB_RATES[condition] ?? DEFAULT_REHAB;
    console.log(`    Rehab rate: $${rehabRate}/sqft (${condition || 'Full Rehab default'})`);

    // Write rehab rate to card immediately, before any web search
    await patchCard(card.id, {
      'Rehab per Sqft': { select: { name: String(rehabRate) } }
    });

    // ── Consolidated underwrite: property + comps + ARV in one call
    const result = await underwrite(address);

    // Handle errors
    if (result.error === 'property not found') {
      await setStatus(card.id, 'Gathering Info');
      await appendBlocks(card.id,
        `Underwriting paused\n\nCould not find this property on Zillow. Please verify the address is correct, then manually add: Sqft, Year Built, Beds, Baths, ARV.`);
      console.log('    > Gathering Info (property not found)');
      return;
    }

    if (result.error === 'insufficient comps') {
      // Save whatever property details we got
      if (result.sqft) await patchCard(card.id, { Sqft: { number: parseInt(result.sqft) } });
      await setStatus(card.id, 'Gathering Info');
      await appendBlocks(card.id,
        `Underwriting paused -- insufficient comps\n\n` +
        `Found the property but could not find 3+ valid comps on Zillow (excluding post-2020 builds).\n\n` +
        `Manual comp pull needed. Search criteria:\n` +
        `- Half mile radius\n` +
        `- Sqft within 20% of subject\n` +
        `- Built BEFORE 2020 (exclude new construction)\n` +
        `- Single family, sold within 12 months\n\n` +
        `Paste 3+ comp prices into the Comp #1/2/3 fields, add ARV manually, then re-run.`);
      console.log('    > Gathering Info (insufficient comps)');
      return;
    }

    // Validate required fields
    if (!result.sqft || !result.arv || !Array.isArray(result.comps) || result.comps.length < 3) {
      await setStatus(card.id, 'Gathering Info');
      await appendBlocks(card.id,
        `Underwriting paused -- incomplete data from web search.\n\nReceived: sqft=${result.sqft}, arv=${result.arv}, comps=${result.comps?.length || 0}\n\nPlease check the address and retry, or fill in details manually.`);
      console.log('    > Gathering Info (incomplete data)');
      return;
    }

    const subject = {
      sqft:      parseInt(result.sqft),
      beds:      result.beds || null,
      baths:     result.baths || null,
      yearBuilt: result.yearBuilt || null,
    };

    const comps = result.comps
      .filter(c => c.salePrice && c.sqft)
      .slice(0, 5)
      .map(c => ({
        address:   c.address || 'Unknown',
        salePrice: parseInt(c.salePrice),
        sqft:      parseInt(c.sqft),
        saleDate:  c.saleDate || 'Unknown',
        url:       c.url || '',
      }));

    console.log(`    > ${subject.sqft} sqft | ARV: $${result.arv.toLocaleString()} | ${comps.length} comps`);

    // Run formula using Claude's ARV estimate
    const formula = runFormula(parseInt(result.arv), subject.sqft, rehabRate);
    const avgPsf  = comps.reduce((s, c) => s + (c.salePrice / c.sqft), 0) / comps.length;

    // Generate assessment
    console.log('    Generating assessment...');
    const notes = await generateNotes(address, subject, comps, formula, condition, askingPrice, rehabRate);

    // Write all results back
    const updates = {
      ARV:                      { number: formula.arv },
      Sqft:                     { number: subject.sqft },
      'Max Offer':              { number: formula.highOffer },
      'Desired Assignment Fee': { number: formula.feeA },
    };
    try {
      if (comps[0]?.url) updates['Comp #1'] = { url: comps[0].url };
      if (comps[1]?.url) updates['Comp #2'] = { url: comps[1].url };
      if (comps[2]?.url) updates['Comp #3'] = { url: comps[2].url };
    } catch (_) {}

    await patchCard(card.id, updates);

    const summary = buildSummary({ address, subject, comps, formula, condition, avgPsf, askingPrice, notes, rehabRate });
    await appendBlocks(card.id, summary);

    // Status decision
    const $ = n => '$' + Math.round(n).toLocaleString();
    const newStatus = formula.highOffer > 0 ? 'Ready to Offer' : 'Pass';
    await setStatus(card.id, newStatus);

    console.log(`    > Done: ${newStatus} | ${$(formula.lowOffer)} - ${$(formula.highOffer)} | Offer/ARV ${(formula.offerArvRatio * 100).toFixed(1)}%`);

  } catch (err) {
    console.error(`    > Error: ${err.message}`);
    try {
      await appendBlocks(card.id, `Underwriting error: ${err.message}\n\nPlease process this card manually.`);
    } catch (_) {}
  }
}

// ── POLL ─────────────────────────────────────────────────────────────────────
async function poll() {
  process.stdout.write(`[${new Date().toISOString()}] Polling... `);
  try {
    const cards = await getUnderwritingCards();
    console.log(`${cards.length} card(s) to process`);

    // Process cards sequentially to stay under rate limits
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
