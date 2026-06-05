const https = require('https');
const crypto = require('crypto');

// ── Airtable helper ──────────────────────────────────────────────────────────

function airtableRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.airtable.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr && { 'Content-Length': Buffer.byteLength(bodyStr) })
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function airtableGet(baseId, table, filterFormula, token) {
  const encoded = encodeURIComponent(filterFormula);
  const path = `/v0/${baseId}/${encodeURIComponent(table)}?filterByFormula=${encoded}`;
  return airtableRequest('GET', path, null, token);
}

function airtableCreate(baseId, table, fields, token) {
  const path = `/v0/${baseId}/${encodeURIComponent(table)}`;
  return airtableRequest('POST', path, { fields }, token);
}

function airtableUpdate(baseId, table, recordId, fields, token) {
  const path = `/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`;
  return airtableRequest('PATCH', path, { fields }, token);
}

// ── SendGrid helper ──────────────────────────────────────────────────────────

function sendEmail(to, from, subject, text, html, sendgridKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'Prosperity Lakes Club' },
      subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }]
    });
    const options = {
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sendgridKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function logSendGridResponse(label, status, body) {
  if (status >= 200 && status < 300) {
    console.log(`[SendGrid] ${label} — OK (${status})`);
  } else {
    console.error(`[SendGrid] ${label} — FAILED (${status}): ${body}`);
  }
}

// ── Fuzzy street matching ────────────────────────────────────────────────────

const STREET_SUFFIXES = [
  'terrace','trail','way','cove','place','court','lane',
  'drive','run','boulevard','blvd','street','st','ave',
  'avenue','rd','road','dr','ct','pl','ln','ter','trl'
];

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNumber(str) {
  return str.replace(/^\d+\s*/, '').trim();
}

function extractNumber(str) {
  const match = str.match(/^(\d+)/);
  return match ? match[1] : '';
}

function removeSuffixes(str) {
  const words = str.split(' ');
  return words.filter(w => !STREET_SUFFIXES.includes(w)).join(' ').trim();
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[a.length][b.length];
}

function wordSimilarity(word, target) {
  if (word === target) return 1;
  if (target.includes(word) || word.includes(target)) return 0.9;
  const dist = editDistance(word, target);
  return Math.max(0, 1 - dist / Math.max(word.length, target.length));
}

function matchStreetName(submittedAddress, streetNames) {
  const norm     = normalize(stripNumber(submittedAddress));
  const noSuffix = removeSuffixes(norm);
  const subWords = noSuffix.split(' ').filter(w => w.length > 1);

  let bestMatch  = null;
  let bestScore  = 0;

  for (const street of streetNames) {
    const streetNorm     = normalize(street);
    const streetNoSuffix = removeSuffixes(streetNorm);
    const streetWords    = streetNoSuffix.split(' ').filter(w => w.length > 1);

    let matchedCount = 0;
    for (const sw of streetWords) {
      const best = Math.max(...subWords.map(w => wordSimilarity(w, sw)));
      if (best >= 0.75) matchedCount++;
    }

    const score = streetWords.length > 0 ? matchedCount / streetWords.length : 0;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = street;
    }
  }

  return { matched: bestScore >= 0.5, bestMatch, score: bestScore };
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // CORS headers for preflight
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Top-level safety net — catches any unhandled exception so we ALWAYS return JSON
  try {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const {
    guestName, memberName, memberAddress, additionalGuests,
    submissionDate, submissionDateISO, guestSignature, residentSignature
  } = data;

  const TOKEN          = process.env.AIRTABLE_TOKEN;
  const BASE           = process.env.AIRTABLE_BASE;
  const WAIVER_TABLE   = process.env.AIRTABLE_TABLE;
  const STREETS_TABLE  = process.env.AIRTABLE_STREET_NAMES_TABLE;
  const ADDRESS_TABLE  = process.env.AIRTABLE_ADDRESS_MASTER_TABLE;
  const PENDING_TABLE  = process.env.AIRTABLE_PENDING_TABLE;
  const SENDGRID_KEY   = process.env.SENDGRID_API_KEY;
  const TO_EMAIL       = process.env.TO_EMAIL;
  const FROM_EMAIL     = process.env.FROM_EMAIL;
  const SITE_URL       = process.env.URL || 'https://pl-guestwaiver.netlify.app';

  // ── 1. Fetch all street names ──
  let streetNames = [];
  try {
    const streetsRes = await airtableGet(BASE, STREETS_TABLE, 'NOT({Street Name} = "")', TOKEN);
    const streetsData = JSON.parse(streetsRes.body);
    streetNames = (streetsData.records || []).map(r => r.fields['Street Name']).filter(Boolean);
  } catch (err) {
    console.error('Failed to fetch street names:', err);
  }

  // ── 2. Run fuzzy match ──
  const safeAddress = typeof memberAddress === 'string' ? memberAddress : '';
  const { matched, bestMatch } = matchStreetName(safeAddress, streetNames);

  if (!matched) {
    // ── 3a. No match — create pending submission ──
    const pendingId = crypto.randomBytes(16).toString('hex');
    const approveToken = crypto
      .createHmac('sha256', TOKEN)
      .update(pendingId + 'approve')
      .digest('hex');
    const denyToken = crypto
      .createHmac('sha256', TOKEN)
      .update(pendingId + 'deny')
      .digest('hex');

    // Store form data (no signatures) for restoration
    const formData = JSON.stringify({
      title:            data.title || '',
      guestName,
      memberName,
      memberAddress,
      additionalGuests,
      addrCity:         data.addrCity  || '',
      addrState:        data.addrState || '',
      addrZip:          data.addrZip   || ''
    });

    try {
      const pendingRes  = await airtableCreate(BASE, PENDING_TABLE, {
        'Pending ID':     pendingId,
        'Guest Name':     guestName,
        'Member Name':    memberName,
        'Full Address':   memberAddress,
        'Additional Guests': additionalGuests || 'None',
        'Submission Date': submissionDateISO,
        'Status':         'pending',
        'Form Data':      formData
      }, TOKEN);
      const pendingData = JSON.parse(pendingRes.body);
      if (pendingRes.status === 200 || pendingRes.status === 201) {
        console.log(`Pending record created: ${pendingData.id}`);
      } else {
        console.error(`Pending record FAILED (${pendingRes.status}):`, pendingRes.body);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to process submission' }) };
      }
    } catch (err) {
      console.error('Failed to create pending record:', err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to process submission' })
      };
    }

    // ── 4. Send admin notification email ──
    const approveUrl = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=approve&token=${approveToken}`;
    const denyUrl    = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=deny&token=${denyToken}`;

    const additionalGuestsDisplay = additionalGuests && additionalGuests !== 'None'
      ? additionalGuests
      : 'None';

    const emailHtml = `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#21465e;border-bottom:2px solid #4b9cd3;padding-bottom:10px;">
          Prosperity Lakes Club — Address Verification Required
        </h2>
        <p style="color:#444;font-size:15px;">
          A guest waiver submission could not be matched to a known street address and requires your review.
        </p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          <tr style="background:#f8f5ef;">
            <td style="padding:10px 14px;font-weight:bold;color:#21465e;width:40%;">Guest Name</td>
            <td style="padding:10px 14px;color:#333;">${guestName}</td>
          </tr>
          <tr>
            <td style="padding:10px 14px;font-weight:bold;color:#21465e;">Additional Guests</td>
            <td style="padding:10px 14px;color:#333;">${additionalGuestsDisplay}</td>
          </tr>
          <tr style="background:#f8f5ef;">
            <td style="padding:10px 14px;font-weight:bold;color:#21465e;">Submitted Address</td>
            <td style="padding:10px 14px;color:#333;">${memberAddress}</td>
          </tr>
        </table>
        <div style="margin:28px 0;text-align:center;">
          <a href="${approveUrl}"
             style="background:#2d6a4f;color:white;padding:14px 32px;text-decoration:none;
                    border-radius:4px;font-family:Georgia,serif;font-size:15px;
                    font-weight:bold;margin-right:16px;">
            ✓ Approve
          </a>
          <a href="${denyUrl}"
             style="background:#c0392b;color:white;padding:14px 32px;text-decoration:none;
                    border-radius:4px;font-family:Georgia,serif;font-size:15px;font-weight:bold;">
            ✗ Deny
          </a>
        </div>
        <p style="color:#999;font-size:12px;text-align:center;">
          Prosperity Lakes Club · Guest Waiver System
        </p>
      </div>
    `;

    const emailText = `Address Verification Required\n\nGuest: ${guestName}\nAdditional Guests: ${additionalGuestsDisplay}\nAddress: ${memberAddress}\n\nApprove: ${approveUrl}\nDeny: ${denyUrl}`;

    try {
      const emailResult = await sendEmail(
        TO_EMAIL, FROM_EMAIL,
        `Address Verification Required — ${guestName}`,
        emailText, emailHtml, SENDGRID_KEY
      );
      logSendGridResponse('admin notification', emailResult.status, emailResult.body);
    } catch (err) {
      console.error('Failed to send admin email:', err.message);
    }

    return {
      statusCode: 202,
      headers,
      body: JSON.stringify({ status: 'pending', pendingId })
    };
  }

  // ── 3b. Street matched — proceed with full submission ──

  // Find or create address in Address Master
  let addressRecordId = null;
  try {
    const addrRes  = await airtableGet(
      BASE, ADDRESS_TABLE,
      `{Street Address} = "${memberAddress}"`,
      TOKEN
    );
    const addrData = JSON.parse(addrRes.body);

    if (addrData.records && addrData.records.length > 0) {
      addressRecordId = addrData.records[0].id;
    } else {
      // New address on a known street — create it and notify
      const newAddr = await airtableCreate(BASE, ADDRESS_TABLE, {
        'Street Address': memberAddress
      }, TOKEN);
      const newAddrData = JSON.parse(newAddr.body);
      addressRecordId = newAddrData.id;

      // Send notification for new address
      const notifyHtml = `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#21465e;border-bottom:2px solid #4b9cd3;padding-bottom:10px;">
            New Address Added — Prosperity Lakes Club
          </h2>
          <p style="color:#444;font-size:15px;">
            A new address has been automatically added to the Address Master.
            Please verify this was intentional.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr style="background:#f8f5ef;">
              <td style="padding:10px 14px;font-weight:bold;color:#21465e;">New Address</td>
              <td style="padding:10px 14px;color:#333;">${memberAddress}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;font-weight:bold;color:#21465e;">Guest Name</td>
              <td style="padding:10px 14px;color:#333;">${guestName}</td>
            </tr>
            <tr style="background:#f8f5ef;">
              <td style="padding:10px 14px;font-weight:bold;color:#21465e;">Member Name</td>
              <td style="padding:10px 14px;color:#333;">${memberName}</td>
            </tr>
          </table>
          <p style="color:#999;font-size:12px;text-align:center;">
            Prosperity Lakes Club · Guest Waiver System
          </p>
        </div>
      `;
      const notifyText = `New Address Added: ${memberAddress}\nGuest: ${guestName}\nMember: ${memberName}`;
      try {
        const notifyResult = await sendEmail(
          TO_EMAIL, FROM_EMAIL,
          `New Address Added — ${memberAddress}`,
          notifyText, notifyHtml, SENDGRID_KEY
        );
        logSendGridResponse('new address notification', notifyResult.status, notifyResult.body);
      } catch (err) {
        console.error('Failed to send new address notification:', err.message);
      }
    }
  } catch (err) {
    console.error('Address master lookup failed:', err);
  }

  // ── Submit to Airtable Waivers table ──
  try {
    const waiverFields = {
      'Guest Name':         guestName,
      'Member Name':        memberName,
      'Member Address':     memberAddress,
      'Additional Guests':  additionalGuests || 'None',
      'Submission Date':    submissionDateISO,
      'Guest Signature':    guestSignature,
      'Resident Signature': residentSignature,
      'Waiver Text':        `Assumption of Risk & Indemnity Agreement - Guest confirmed reading and voluntary agreement on ${submissionDate}`
    };
    const waiverRes  = await airtableCreate(BASE, WAIVER_TABLE, waiverFields, TOKEN);
    const waiverData = JSON.parse(waiverRes.body);
    if (waiverRes.status !== 200) {
      throw new Error(waiverData.error?.message || 'Airtable waiver creation failed');
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Airtable error: ' + err.message })
    };
  }

  // ── Send confirmation email via SendGrid ──
  try {
    const waiverBase64 = Buffer.from(`
PROSPERITY LAKES CLUB — GUEST WAIVER

Guest Name:       ${guestName}
Member Name:      ${memberName}
Member Address:   ${memberAddress}
Additional Guests: ${additionalGuests || 'None'}
Submission Date:  ${submissionDate}

ASSUMPTION OF RISK & INDEMNITY AGREEMENT
Guest confirmed reading and voluntary agreement on ${submissionDate}.
Signatures captured digitally — view in Airtable.
    `.trim()).toString('base64');

    const emailResult = await sendEmail(
      TO_EMAIL, FROM_EMAIL,
      `New Guest Waiver — ${guestName}`,
      `New waiver: ${guestName} | ${memberName} | ${memberAddress}`,
      `<div style="font-family:Georgia,serif;padding:24px;">
        <h2 style="color:#21465e;">New Guest Waiver Submitted</h2>
        <p><strong>Guest:</strong> ${guestName}</p>
        <p><strong>Member:</strong> ${memberName}</p>
        <p><strong>Address:</strong> ${memberAddress}</p>
        <p><strong>Additional Guests:</strong> ${additionalGuests || 'None'}</p>
        <p><strong>Date:</strong> ${submissionDate}</p>
        <p style="color:#777;font-size:12px;">Signatures stored in Airtable.</p>
      </div>`,
      SENDGRID_KEY
    );
    logSendGridResponse('confirmation email', emailResult.status, emailResult.body);
  } catch (err) {
    console.error('SendGrid error:', err.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true })
  };

  } catch (topErr) {
    // Unhandled exception — return structured error instead of crashing
    console.error('Unhandled exception in submit-waiver:', topErr);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error: ' + (topErr.message || String(topErr)) })
    };
  }
};
