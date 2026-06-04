const https   = require('https');
const crypto  = require('crypto');
const PDFDocument = require('pdfkit');

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

function sendEmail(to, from, subject, text, html, sendgridKey, attachments = []) {
  return new Promise((resolve, reject) => {
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'Prosperity Lakes Club' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html',  value: html }
      ]
    };
    if (attachments.length > 0) {
      payload.attachments = attachments;
    }
    const body = JSON.stringify(payload);
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

// ── PDF generation ───────────────────────────────────────────────────────────

const WAIVER_PARAGRAPHS = [
  'By entering and/or using any facilities, services, equipment, or participating in any activity organized, arranged, or sponsored by PROSPERITY LAKES CLUB, I, the undersigned Guest, acknowledge and agree that I do so entirely at my own risk. I hereby release, waive, and forever discharge PROSPERITY LAKES CLUB, its officers, partners, agents, employees, affiliates, directors, and attorneys (collectively, the "Club Indemnified Parties") from any and all claims, demands, damages, actions, or causes of action of any kind whatsoever, including those arising from the negligence of the Club Indemnified Parties, which I now have or may have in the future, resulting from my participation in or use of any Club facilities, equipment, services, or activities.',
  "I agree to defend, indemnify, and hold harmless the Club Indemnified Parties from any and all losses, liabilities, damages, or expenses (including reasonable attorneys' fees) arising from any personal injury, death, or property damage caused by my actions or omissions.",
  'I understand that participation in recreational, water-related, and other activities carries inherent risks, including but not limited to falls, collisions, contact with other participants or equipment, weather conditions, sun exposure, drowning, wildlife encounters, or medical emergencies. These risks may result in serious injury, disability, or death. I certify that I am a competent swimmer if participating in any water-related activities and that I am solely responsible for my own safety at all times.',
  'By signing below, I acknowledge that I have read, understand, and voluntarily agree to the terms of this Waiver and Indemnity.'
];

function generateWaiverPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const {
        guestName, memberName, memberAddress, additionalGuests,
        submissionDate, guestSignature, residentSignature
      } = data;

      const doc = new PDFDocument({ margin: 50, size: 'letter' });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const brandDark  = '#21465e';
      const brandBlue  = '#4b9cd3';
      const borderGray = '#c9bfa8';
      const pageWidth  = doc.page.width - 100; // margins both sides

      // ── Header ──
      doc.rect(0, 0, doc.page.width, 90).fill(brandBlue);
      doc.fillColor('white')
         .font('Helvetica-Bold')
         .fontSize(18)
         .text('PROSPERITY LAKES CLUB', 0, 22, { align: 'center', width: doc.page.width });
      doc.font('Helvetica')
         .fontSize(11)
         .text('GUEST WAIVER', 0, 46, { align: 'center', width: doc.page.width });
      doc.moveDown(0.5);

      // ── Guest Information ──
      doc.y = 110;
      doc.fillColor(brandDark).font('Helvetica-Bold').fontSize(9)
         .text('GUEST INFORMATION', 50, doc.y, { characterSpacing: 1.5 });
      doc.moveTo(50, doc.y + 2).lineTo(50 + pageWidth, doc.y + 2).strokeColor(borderGray).lineWidth(0.5).stroke();
      doc.moveDown(0.8);

      const infoFontSize = 11;
      const labelWidth   = 140;
      const col2X        = 50 + labelWidth;

      function infoRow(label, value) {
        const rowY = doc.y;
        doc.fillColor('#555').font('Helvetica-Bold').fontSize(infoFontSize)
           .text(label, 50, rowY, { width: labelWidth });
        doc.fillColor('#222').font('Helvetica').fontSize(infoFontSize)
           .text(value || '—', col2X, rowY, { width: pageWidth - labelWidth });
        doc.moveDown(0.5);
      }

      infoRow('Guest Name:', guestName);
      infoRow('Member Name:', memberName);
      infoRow('Member Address:', memberAddress);
      infoRow('Additional Guests:', (additionalGuests && additionalGuests !== 'None') ? additionalGuests : 'None');
      infoRow('Submission Date:', submissionDate);

      doc.moveDown(1);

      // ── Waiver Text ──
      doc.fillColor(brandDark).font('Helvetica-Bold').fontSize(9)
         .text('ASSUMPTION OF RISK & INDEMNITY AGREEMENT', 50, doc.y, { characterSpacing: 1.5 });
      doc.moveTo(50, doc.y + 2).lineTo(50 + pageWidth, doc.y + 2).strokeColor(borderGray).lineWidth(0.5).stroke();
      doc.moveDown(0.8);

      WAIVER_PARAGRAPHS.forEach((para, i) => {
        doc.fillColor('#2c2c2c').font('Helvetica').fontSize(9.5)
           .text(para, 50, doc.y, { width: pageWidth, lineGap: 3, align: 'justify' });
        if (i < WAIVER_PARAGRAPHS.length - 1) doc.moveDown(0.7);
      });

      doc.moveDown(1);

      // ── Agreement confirmation ──
      doc.fillColor(brandDark).font('Helvetica-Bold').fontSize(9)
         .text('AGREEMENT', 50, doc.y, { characterSpacing: 1.5 });
      doc.moveTo(50, doc.y + 2).lineTo(50 + pageWidth, doc.y + 2).strokeColor(borderGray).lineWidth(0.5).stroke();
      doc.moveDown(0.8);
      doc.fillColor('#2c2c2c').font('Helvetica').fontSize(9.5)
         .text('☑  I have read and fully understand the Assumption of Risk & Indemnity Agreement above, and I voluntarily agree to its terms.', 50, doc.y, { width: pageWidth, lineGap: 3 });

      doc.moveDown(1.2);

      // ── Signatures ──
      doc.fillColor(brandDark).font('Helvetica-Bold').fontSize(9)
         .text('SIGNATURES', 50, doc.y, { characterSpacing: 1.5 });
      doc.moveTo(50, doc.y + 2).lineTo(50 + pageWidth, doc.y + 2).strokeColor(borderGray).lineWidth(0.5).stroke();
      doc.moveDown(0.8);

      const sigBoxWidth  = (pageWidth - 20) / 2;
      const sigBoxHeight = 90;
      const sigY         = doc.y;
      const sig2X        = 50 + sigBoxWidth + 20;

      // Signature box borders
      doc.rect(50, sigY, sigBoxWidth, sigBoxHeight).strokeColor(borderGray).lineWidth(0.5).stroke();
      doc.rect(sig2X, sigY, sigBoxWidth, sigBoxHeight).strokeColor(borderGray).lineWidth(0.5).stroke();

      // Labels above boxes
      doc.fillColor('#555').font('Helvetica-Bold').fontSize(8)
         .text('GUEST SIGNATURE', 50, sigY - 14, { width: sigBoxWidth });
      doc.text('RESIDENT SIGNATURE', sig2X, sigY - 14, { width: sigBoxWidth });

      // Embed signature images
      function embedSig(dataUrl, x, y, w, h) {
        try {
          if (!dataUrl || !dataUrl.startsWith('data:image/')) return;
          const base64 = dataUrl.split(',')[1];
          const imgBuf = Buffer.from(base64, 'base64');
          doc.image(imgBuf, x + 4, y + 4, { width: w - 8, height: h - 8, fit: [w - 8, h - 8] });
        } catch (e) {
          console.error('Signature embed error:', e.message);
        }
      }

      embedSig(guestSignature,    50,   sigY, sigBoxWidth, sigBoxHeight);
      embedSig(residentSignature, sig2X, sigY, sigBoxWidth, sigBoxHeight);

      // Date below boxes
      doc.fillColor('#777').font('Helvetica').fontSize(9)
         .text(`Date: ${submissionDate}`, 50, sigY + sigBoxHeight + 6, { width: sigBoxWidth });
      doc.text(`Date: ${submissionDate}`, sig2X, sigY + sigBoxHeight + 6, { width: sigBoxWidth });

      // ── Footer ──
      doc.moveDown(3);
      doc.fillColor('#aaa').font('Helvetica').fontSize(8)
         .text('Prosperity Lakes Club · Guest Waiver System · Document generated electronically', 50, doc.y, {
           align: 'center', width: pageWidth
         });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── Fuzzy street matching ────────────────────────────────────────────────────

const STREET_SUFFIXES = [
  'terrace','trail','way','cove','place','court','lane',
  'drive','run','boulevard','blvd','street','st','ave',
  'avenue','rd','road','dr','ct','pl','ln','ter','trl'
];

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function stripNumber(str) {
  return str.replace(/^\d+\s*/, '').trim();
}

function removeSuffixes(str) {
  return str.split(' ').filter(w => !STREET_SUFFIXES.includes(w)).join(' ').trim();
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

  let bestMatch = null;
  let bestScore = 0;

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
    if (score > bestScore) { bestScore = score; bestMatch = street; }
  }

  return { matched: bestScore >= 0.5, bestMatch, score: bestScore };
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

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
      submissionDate, submissionDateISO, guestSignature, residentSignature,
      addrCity, addrState, addrZip
    } = data;

    // Street-only portion of the address for address master lookup
    const addrStreet = memberAddress ? memberAddress.split(',')[0].trim() : '';

    const TOKEN         = process.env.AIRTABLE_TOKEN;
    const BASE          = process.env.AIRTABLE_BASE;
    const WAIVER_TABLE  = process.env.AIRTABLE_TABLE;
    const STREETS_TABLE = process.env.AIRTABLE_STREET_NAMES_TABLE;
    const ADDRESS_TABLE = process.env.AIRTABLE_ADDRESS_MASTER_TABLE;
    const PENDING_TABLE = process.env.AIRTABLE_PENDING_TABLE;
    const SENDGRID_KEY  = process.env.SENDGRID_API_KEY;
    const TO_EMAIL      = process.env.TO_EMAIL;
    const FROM_EMAIL    = process.env.FROM_EMAIL;
    const SITE_URL      = process.env.URL || 'https://pl-guestwaiver.netlify.app';

    // ── 1. Fetch street names ──
    let streetNames = [];
    try {
      const streetsRes  = await airtableGet(BASE, STREETS_TABLE, 'NOT({Street Name} = "")', TOKEN);
      const streetsData = JSON.parse(streetsRes.body);
      streetNames = (streetsData.records || []).map(r => r.fields['Street Name']).filter(Boolean);
    } catch (err) {
      console.error('Failed to fetch street names:', err);
    }

    // ── 2. Fuzzy match against street name only ──
    const safeAddress = typeof addrStreet === 'string' ? addrStreet : '';
    const { matched } = matchStreetName(safeAddress, streetNames);

    if (!matched) {
      // ── 3a. Pending path ──
      const pendingId    = crypto.randomBytes(16).toString('hex');
      const approveToken = crypto.createHmac('sha256', TOKEN).update(pendingId + 'approve').digest('hex');
      const denyToken    = crypto.createHmac('sha256', TOKEN).update(pendingId + 'deny').digest('hex');

      const formData = JSON.stringify({
        title:           data.title || '',
        guestName,
        memberName,
        addrStreet,
        addrCity:        addrCity  || '',
        addrState:       addrState || '',
        addrZip:         addrZip   || '',
        memberAddress,
        additionalGuests
      });

      try {
        await airtableCreate(BASE, PENDING_TABLE, {
          'Pending ID':        pendingId,
          'Guest Name':        guestName,
          'Member Name':       memberName,
          'Full Address':      memberAddress,
          'Additional Guests': additionalGuests || 'None',
          'Submission Date':   submissionDateISO,
          'Status':            'pending',
          'Form Data':         formData
        }, TOKEN);
      } catch (err) {
        console.error('Failed to create pending record:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to process submission' }) };
      }

      const approveUrl = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=approve&token=${approveToken}`;
      const denyUrl    = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=deny&token=${denyToken}`;

      const guestsDisplay = (additionalGuests && additionalGuests !== 'None') ? additionalGuests : 'None';

      const adminHtml = `
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
              <td style="padding:10px 14px;color:#333;">${guestsDisplay}</td>
            </tr>
            <tr style="background:#f8f5ef;">
              <td style="padding:10px 14px;font-weight:bold;color:#21465e;">Submitted Address</td>
              <td style="padding:10px 14px;color:#333;">${memberAddress}</td>
            </tr>
          </table>
          <div style="margin:28px 0;text-align:center;">
            <a href="${approveUrl}" style="background:#2d6a4f;color:white;padding:14px 32px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;font-size:15px;font-weight:bold;margin-right:16px;">✓ Approve</a>
            <a href="${denyUrl}"    style="background:#c0392b;color:white;padding:14px 32px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;font-size:15px;font-weight:bold;">✗ Deny</a>
          </div>
          <p style="color:#999;font-size:12px;text-align:center;">Prosperity Lakes Club · Guest Waiver System</p>
        </div>`;

      const adminText = `Address Verification Required\n\nGuest: ${guestName}\nAdditional Guests: ${guestsDisplay}\nAddress: ${memberAddress}\n\nApprove: ${approveUrl}\nDeny: ${denyUrl}`;

      try {
        const r = await sendEmail(TO_EMAIL, FROM_EMAIL, `Address Verification Required — ${guestName}`, adminText, adminHtml, SENDGRID_KEY);
        logSendGridResponse('admin notification', r.status, r.body);
      } catch (err) {
        console.error('Failed to send admin email:', err.message);
      }

      return { statusCode: 202, headers, body: JSON.stringify({ status: 'pending', pendingId }) };
    }

    // ── 3b. Matched — full submission path ──

    // Address master: look up by street only
    try {
      const addrRes  = await airtableGet(BASE, ADDRESS_TABLE, `{Street Address} = "${addrStreet}"`, TOKEN);
      const addrData = JSON.parse(addrRes.body);

      if (!addrData.records || addrData.records.length === 0) {
        // New address on a known street — add it and notify
        await airtableCreate(BASE, ADDRESS_TABLE, { 'Street Address': addrStreet }, TOKEN);

        const notifyHtml = `
          <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#21465e;border-bottom:2px solid #4b9cd3;padding-bottom:10px;">New Address Added — Prosperity Lakes Club</h2>
            <p style="color:#444;font-size:15px;">A new address has been automatically added to the Address Master. Please verify this was intentional.</p>
            <table style="width:100%;border-collapse:collapse;margin:20px 0;">
              <tr style="background:#f8f5ef;">
                <td style="padding:10px 14px;font-weight:bold;color:#21465e;">New Address</td>
                <td style="padding:10px 14px;color:#333;">${addrStreet}</td>
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
            <p style="color:#999;font-size:12px;text-align:center;">Prosperity Lakes Club · Guest Waiver System</p>
          </div>`;
        const notifyText = `New Address Added: ${addrStreet}\nGuest: ${guestName}\nMember: ${memberName}`;

        try {
          const r = await sendEmail(TO_EMAIL, FROM_EMAIL, `New Address Added — ${addrStreet}`, notifyText, notifyHtml, SENDGRID_KEY);
          logSendGridResponse('new address notification', r.status, r.body);
        } catch (err) {
          console.error('Failed to send new address notification:', err.message);
        }
      }
    } catch (err) {
      console.error('Address master lookup failed:', err);
    }

    // ── Submit waiver to Airtable ──
    try {
      const waiverRes  = await airtableCreate(BASE, WAIVER_TABLE, {
        'Guest Name':         guestName,
        'Member Name':        memberName,
        'Member Address':     memberAddress,
        'Additional Guests':  additionalGuests || 'None',
        'Submission Date':    submissionDateISO,
        'Guest Signature':    guestSignature,
        'Resident Signature': residentSignature,
        'Waiver Text':        `Assumption of Risk & Indemnity Agreement - Guest confirmed reading and voluntary agreement on ${submissionDate}.`
      }, TOKEN);
      const waiverData = JSON.parse(waiverRes.body);
      if (waiverRes.status !== 200) {
        throw new Error(waiverData.error?.message || 'Airtable waiver creation failed');
      }
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Airtable error: ' + err.message }) };
    }

    // ── Generate PDF and send confirmation email ──
    try {
      const pdfBuffer = await generateWaiverPDF({
        guestName, memberName, memberAddress, additionalGuests,
        submissionDate, guestSignature, residentSignature
      });

      const pdfBase64 = pdfBuffer.toString('base64');
      const safeGuest = guestName.replace(/[^a-z0-9]/gi, '_');
      const filename  = `Waiver_${safeGuest}_${submissionDateISO}.pdf`;

      const confirmHtml = `
        <div style="font-family:Georgia,serif;padding:24px;">
          <h2 style="color:#21465e;">New Guest Waiver Submitted</h2>
          <p><strong>Guest:</strong> ${guestName}</p>
          <p><strong>Member:</strong> ${memberName}</p>
          <p><strong>Address:</strong> ${memberAddress}</p>
          <p><strong>Additional Guests:</strong> ${additionalGuests || 'None'}</p>
          <p><strong>Date:</strong> ${submissionDate}</p>
          <p style="color:#777;font-size:12px;">Signed waiver attached as PDF.</p>
        </div>`;
      const confirmText = `New Guest Waiver Submitted\n\nGuest: ${guestName}\nMember: ${memberName}\nAddress: ${memberAddress}\nAdditional Guests: ${additionalGuests || 'None'}\nDate: ${submissionDate}\n\nSigned waiver attached as PDF.`;

      const r = await sendEmail(
        TO_EMAIL, FROM_EMAIL,
        `New Guest Waiver — ${guestName}`,
        confirmText, confirmHtml, SENDGRID_KEY,
        [{ content: pdfBase64, type: 'application/pdf', filename, disposition: 'attachment' }]
      );
      logSendGridResponse('confirmation email with PDF', r.status, r.body);
    } catch (err) {
      console.error('PDF/email error:', err.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (topErr) {
    console.error('Unhandled exception in submit-waiver:', topErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + (topErr.message || String(topErr)) }) };
  }
};
