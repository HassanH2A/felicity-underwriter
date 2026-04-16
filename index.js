const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

// ── ENV ──────────────────────────────────────────────────────────────────────
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const NOTION_DB     = (process.env.NOTION_DATABASE_ID || '').replace(/^=/, '').trim();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const POLL_MS       = 60_000;

const anthropic  = new Anthropic({ apiKey: ANTHROPIC_KEY });
const processing = new Set(); // cards currently in flight

// ── REHAB RATES ───────────────────────────────────────────────────────────────
const REHAB_RATES = {
  'Turnkey':       0,
  'Light Cosmetic': 15,
  'Full Rehab':    35,
  'Torn':          55,
};
const DEFAULT_REHAB = 35;

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
  const lines  = text.split('\n');
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

// ── CLAUDE WEB SEARCH HELPERS ─────────────────────────────────────────────────
function extractText(content) {
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

function parseJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

// ── PROPERTY LOOKUP (Claude + web search) ─────────────────────────────────────
async function lookupProperty(address) {
  try {
    console.log('    Searching the web for property data...');

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Look up property details for: ${address}

Search Redfin, Zillow, Realtor.com, or county tax records to find this property.

Return ONLY a JSON object with no other text:
{"sqft":<number or null>,"yearBuilt":<number or null>,"beds":<number or null>,"baths":<number or null>,"lat":<number or null>,"lng":<number or null>,"sourceUrl":"<url>"}

If you cannot find this property, return: {"error":"not found"}`
      }],
    });

    const text = extractText(resp.content);
    const data = parseJSON(text);

    if (data.error) {
      console.log(`    Property not found: ${data.error}`);
      return null;
    }

    console.log(`    Found: ${data.sqft} sqft, ${data.beds}bd/${data.baths}ba, built ${data.yearBuilt}`);

    return {
      address,
      sqft:         data.sqft ? parseInt(data.sqft) : null,
      yearBuilt:    data.yearBuilt ? parseInt(data.yearBuilt) : null,
      beds:         data.beds ? parseInt(data.beds) : null,
      baths:        data.baths ? parseFloat(data.baths) : null,
      propertyType: 'Single Family Residential',
      lat:          data.lat ? parseFloat(data.lat) : null,
      lng:          data.lng ? parseFloat(data.lng) : null,
      sourceUrl:    data.sourceUrl || null,
      source:       'Web Search',
    };
  } catch (err) {
    console.error('  Property lookup error:', err.message);
    return null;
  }
}

// ── COMP SEARCH (Claude + web search) ──────────────────────────────────────────
async function findComps(property, daysBack = 180) {
  try {
    const { address, sqft, yearBuilt } = property;
    if (!sqft) return [];

    const sqftMin = Math.round(sqft * 0.8);
    const sqftMax = Math.round(sqft * 1.2);
    const months  = Math.round(daysBack / 30);

    console.log(`    Searching the web for comps (${months} months)...`);

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Find recently SOLD comparable properties near: ${address}

Search Redfin sold homes, Zillow recently sold, or Realtor.com for SOLD single-family homes near this address.

Criteria:
- Within 0.5 miles of the subject
- Sold within last ${months} months
- Between ${sqftMin} and ${sqftMax} sqft
- Subject was built ${yearBuilt || 'unknown year'}, prefer similar age
- Single family homes only
- Prefer renovated/updated homes (these represent after-repair value)

Find 3 to 5 comps with verified sale prices.

Return ONLY a JSON array with no other text:
[{"address":"<full address>","salePrice":<number>,"sqft":<number>,"saleDate":"<date>","url":"<listing url>"}]

If you cannot find any comps, return: []`
      }],
    });

    const text = extractText(resp.content);
    const comps = parseJSON(text);
    if (!Array.isArray(comps)) return [];

    const valid = comps
      .filter(c => c.salePrice && c.sqft)
      .map(c => ({
        address:   c.address || 'Unknown',
        salePrice: parseInt(c.salePrice),
        sqft:      parseInt(c.sqft),
        psf:       Math.round(parseInt(c.salePrice) / parseInt(c.sqft)),
        saleDate:  c.saleDate || 'Unknown',
        url:       c.url || '',
      }))
      .slice(0, 5);

    console.log(`    Found ${valid.length} valid comps`);
    return valid;
  } catch (err) {
    console.error('  Comp search error:', err.message);
    return [];
  }
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
    offerArvRatio: highOffer / arv,
  };
}

// ── CLAUDE ASSESSMENT ────────────────────────────────────────────────────────
async function generateNotes(address, property, comps, formula, condition, askingPrice) {
  const $ = n => n != null ? '$' + Math.round(n).toLocaleString() : 'N/A';
  const pct = n => (n * 100).toFixed(1) + '%';
  const avgPsf = Math.round(comps.reduce((s, c) => s + c.psf, 0) / comps.length);

  const prompt = `You are the underwriting AI for Felicity Capital, a real estate wholesaling company that assigns contracts to fix-and-flip investors.

SUBJECT PROPERTY
Address: ${address}
Sqft: ${property.sqft} | Beds: ${property.beds} | Baths: ${property.baths} | Year Built: ${property.yearBuilt}
Condition: ${condition || 'Full Rehab (assumed)'}
Asking Price: ${askingPrice ? $(askingPrice) : 'Not provided'}

COMPS (${comps.length} found)
${comps.map((c, i) => `${i + 1}. ${c.address} | Sold ${$(c.salePrice)} | ${c.sqft} sqft | $${c.psf}/sqft | ${c.saleDate}`).join('\n')}
Average PSF: $${avgPsf}/sqft -> ARV: ${$(formula.arv)}

RESULTS
Offer range: ${$(formula.lowOffer)} - ${$(formula.highOffer)}
Offer/ARV: ${pct(formula.offerArvRatio)}
${askingPrice ? `Asking vs MAO: ${askingPrice > formula.highOffer ? 'ABOVE MAO by ' + $(askingPrice - formula.highOffer) : 'BELOW MAO by ' + $(formula.highOffer - askingPrice)}` : ''}

Write 3-4 sharp sentences covering: comp quality and consistency, neighbourhood signal, any deal flags, and a clear verdict. Be direct -- this is read by a wholesaler about to make a phone call.`;

  const resp = await anthropic.messages.create({
    model:      'claude-sonnet-4-5-20250929',
    max_tokens: 400,
    messages:   [{ role: 'user', content: prompt }],
  });
  return resp.content[0].text.trim();
}

// ── SUMMARY BUILDER ───────────────────────────────────────────────────────────
function buildSummary({ address, property, comps, formula, condition, avgPsf, askingPrice, notes, rehabRate }) {
  const $   = n => n != null ? '$' + Math.round(n).toLocaleString() : 'N/A';
  const pct = n => (n * 100).toFixed(1) + '%';
  const flags = [];

  if (askingPrice && askingPrice > formula.arv)
    flags.push('Warning: Seller asking ABOVE ARV -- property may be overpriced');
  if (askingPrice && askingPrice > formula.highOffer)
    flags.push(`Warning: Seller asking ${$(askingPrice - formula.highOffer)} above MAO -- tough negotiation ahead`);
  if (formula.offerArvRatio > 0.85)
    flags.push('Warning: Offer/ARV > 85% -- thin margin for your buyer, push for lower price');
  if (comps.length < 5)
    flags.push(`Note: Only ${comps.length} comps found -- ARV estimate less certain`);
  if (formula.offerArvRatio <= 0.72 && formula.highOffer > 0)
    flags.push('Strong spread -- excellent deal if numbers hold');

  return `# Underwriting Report
Auto-generated by Felicity Capital Underwriter

## Property Details
Address: ${address}
Source: ${property.source}
Sqft: ${property.sqft?.toLocaleString()} | Beds: ${property.beds} | Baths: ${property.baths} | Year Built: ${property.yearBuilt}
Condition: ${condition || 'Full Rehab (default)'} > $${rehabRate}/sqft rehab rate

## Comparable Sales
${comps.map((c, i) =>
  `${i + 1}. ${c.address}
   Sold: ${$(c.salePrice)} | ${c.sqft?.toLocaleString()} sqft | $${c.psf}/sqft | ${c.saleDate}
   ${c.url}`
).join('\n\n')}

Average PSF: $${Math.round(avgPsf)}/sqft across ${comps.length} comps

## Formula Breakdown
ARV:                      ${$(formula.arv)}
Rehab Cost:               ${$(formula.rehab)}  (${property.sqft?.toLocaleString()} sqft x $${rehabRate})
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

    // ── Step 2: Property lookup
    console.log('    Looking up property...');
    const property = await lookupProperty(address);

    if (!property?.sqft) {
      await setStatus(card.id, 'Gathering Info');
      const missing = !property
        ? 'address not found -- please verify it is correct'
        : 'square footage could not be retrieved';
      await appendBlocks(card.id,
        `Underwriting paused\n\nCould not retrieve property details: ${missing}.\n\nPlease add manually: Sqft, Year Built, Beds, Baths.`);
      console.log('    > Gathering Info (property not found)');
      return;
    }

    console.log(`    > ${property.sqft} sqft | ${property.beds}bd/${property.baths}ba | built ${property.yearBuilt}`);
    await patchCard(card.id, { Sqft: { number: property.sqft } });

    // ── Step 3: Comps
    console.log('    Searching comps (6 months)...');
    let comps = await findComps(property, 180);

    if (comps.length < 3) {
      console.log(`    > Only ${comps.length}, expanding to 12 months...`);
      comps = await findComps(property, 365);
    }

    if (comps.length < 3) {
      await setStatus(card.id, 'Gathering Info');
      const sqftMin = Math.round(property.sqft * 0.8);
      const sqftMax = Math.round(property.sqft * 1.2);
      const yrMin   = (property.yearBuilt || 1985) - 10;
      const yrMax   = (property.yearBuilt || 1985) + 10;
      await appendBlocks(card.id,
        `Underwriting paused -- insufficient comps\n\n` +
        `Only ${comps.length} comp(s) found within 12 months.\n\n` +
        `Manual comp pull needed. Search criteria:\n` +
        `- Half mile radius\n` +
        `- Sqft: ${sqftMin.toLocaleString()} - ${sqftMax.toLocaleString()}\n` +
        `- Year built: ${yrMin} - ${yrMax}\n` +
        `- Single family homes, sold within 12 months\n\n` +
        `Paste 3+ comp prices into the Comp #1 / #2 / #3 fields then manually re-trigger.`);
      console.log('    > Gathering Info (insufficient comps)');
      return;
    }

    console.log(`    > ${comps.length} comps found`);

    // ── Step 4-6: ARV + formula
    const avgPsf    = comps.reduce((s, c) => s + c.psf, 0) / comps.length;
    const arv       = Math.round(avgPsf * property.sqft);
    const rehabRate = REHAB_RATES[condition] ?? DEFAULT_REHAB;
    const formula   = runFormula(arv, property.sqft, rehabRate);

    // ── Claude assessment
    console.log('    Generating assessment...');
    const notes = await generateNotes(address, property, comps, formula, condition, askingPrice);

    // ── Step 7: Write back to Notion (only writable properties)
    const updates = {
      ARV:                    { number: formula.arv },
      'Max Offer':            { number: formula.highOffer },
      'Rehab per Sqft':       { select: { name: String(rehabRate) } },
      'Desired Assignment Fee': { number: formula.feeA },
    };

    try {
      if (comps[0]?.url) updates['Comp #1'] = { url: comps[0].url };
      if (comps[1]?.url) updates['Comp #2'] = { url: comps[1].url };
      if (comps[2]?.url) updates['Comp #3'] = { url: comps[2].url };
    } catch (_) {}

    await patchCard(card.id, updates);

    const summary = buildSummary({ address, property, comps, formula, condition, avgPsf, askingPrice, notes, rehabRate });
    await appendBlocks(card.id, summary);

    // ── Step 8: Status
    const $ = n => '$' + Math.round(n).toLocaleString();
    let newStatus = 'Ready to Offer';
    if (formula.highOffer <= 0) newStatus = 'Pass';

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

    for (const card of cards) {
      if (processing.has(card.id)) continue;
      processing.add(card.id);
      processCard(card).finally(() => processing.delete(card.id));
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('Felicity Capital Underwriter');
console.log(`Database: ${NOTION_DB}`);
console.log(`Polling every ${POLL_MS / 1000}s\n`);

if (!NOTION_DB) {
  console.error('ERROR: NOTION_DATABASE_ID is not set or empty.');
  process.exit(1);
}
if (!NOTION_TOKEN) {
  console.error('ERROR: NOTION_TOKEN is not set.');
  process.exit(1);
}
if (!ANTHROPIC_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

poll();
setInterval(poll, POLL_MS);
