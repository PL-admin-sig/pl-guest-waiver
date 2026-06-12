const { airtableGet, airtableCreate, escapeFormulaValue } = require('./utils/airtable');

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const TOKEN          = process.env.AIRTABLE_TOKEN;
  const BASE           = process.env.AIRTABLE_BASE;
  const ADDRESS_TABLE  = process.env.AIRTABLE_ADDRESS_MASTER_TABLE;
  const CHECKINS_TABLE = process.env.AIRTABLE_CHECKINS_TABLE;

  // ── GET: return full list of street addresses for dropdown ─────────────────
  if (event.httpMethod === 'GET') {
    try {
      let addresses = [];
      let offset;
      do {
        const r = await airtableGet(BASE, ADDRESS_TABLE, 'NOT({Street Address} = "")', TOKEN, offset);
        if (r.status !== 200) {
          console.error(`Address list fetch failed (${r.status}):`, r.body);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
        }
        const data = JSON.parse(r.body);
        addresses = addresses.concat(
          (data.records || []).map(rec => rec.fields['Street Address']).filter(Boolean)
        );
        offset = data.offset;
      } while (offset);

      console.log(`Address list fetched: ${addresses.length} addresses`);
      return { statusCode: 200, headers, body: JSON.stringify({ addresses }) };
    } catch (err) {
      console.error('Failed to fetch address list:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  // ── POST: process check-in submission ───────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let data;
    try { data = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    const { residentName, residentAddress, guestNames } = data;

    // ── Validate required fields ──────────────────────────────────────────────
    if (!residentName || !residentName.trim()) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', message: 'Resident name is required.' }) };
    }
    if (!residentAddress || !residentAddress.trim()) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', message: 'Resident address is required.' }) };
    }

    const submittedGuests = (Array.isArray(guestNames) ? guestNames : [])
      .map(n => (n || '').trim())
      .filter(Boolean);

    if (submittedGuests.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', message: 'At least one guest name is required.' }) };
    }

    // ── Look up address in Address Master (must match dropdown selection exactly) ─
    let addressRecord;
    try {
      const r = await airtableGet(BASE, ADDRESS_TABLE, `{Street Address} = "${escapeFormulaValue(residentAddress.trim())}"`, TOKEN);
      if (r.status !== 200) {
        console.error(`Address master lookup failed (${r.status}):`, r.body);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
      }
      const recs = JSON.parse(r.body).records || [];
      if (recs.length === 0) {
        console.log(`Check-in address not found: "${residentAddress.trim()}"`);
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'error', message: 'Address not found. Please select an address from the dropdown.' }) };
      }
      addressRecord = recs[0];
    } catch (err) {
      console.error('Address master lookup failed:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }

    // ── Exact, case-insensitive match of guest names against Guest Names ───────
    const existingNamesRaw = addressRecord.fields['Guest Names'] || '';
    const existingNames    = existingNamesRaw
      ? existingNamesRaw.split('; ').map(n => n.trim()).filter(Boolean)
      : [];
    const existingLower = existingNames.map(n => n.toLowerCase());

    const unmatched = submittedGuests.filter(g => !existingLower.includes(g.toLowerCase()));

    if (unmatched.length > 0) {
      console.log(`Check-in name mismatch at "${residentAddress.trim()}": unmatched=${JSON.stringify(unmatched)}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: 'name_error',
          message: 'Name not found — please enter it exactly as written on your waiver.',
          unmatched
        })
      };
    }

    // ── All guests matched — create check-in record ─────────────────────────────
    try {
      const checkinRes = await airtableCreate(BASE, CHECKINS_TABLE, {
        'Guests Checked In': submittedGuests.join('; '),
        'Resident Address':  residentAddress.trim(),
        'Resident Name':     residentName.trim(),
        'Check-in Date':     new Date().toISOString()
      }, TOKEN);

      if (checkinRes.status === 200 || checkinRes.status === 201) {
        console.log(`Check-in recorded: "${residentName.trim()}" at "${residentAddress.trim()}" — guests: ${submittedGuests.join('; ')}`);
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'success' }) };
      } else {
        console.error(`Guest check-in create failed (${checkinRes.status}):`, checkinRes.body);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to record check-in' }) };
      }
    } catch (err) {
      console.error('Failed to create guest check-in record:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

// Rate limit: 15 requests per 60s per IP. Covers the GET (page load, address
// list) plus a POST submission with a couple of retries after name-match
// errors, while limiting address-list scraping and automated check-in probing.
exports.config = {
  path: '/.netlify/functions/checkin',
  rateLimit: {
    windowSize: 60,
    windowLimit: 15,
    aggregateBy: ['ip', 'domain']
  }
};
