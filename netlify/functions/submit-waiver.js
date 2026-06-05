const https  = require('https');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ── Airtable helpers ─────────────────────────────────────────────────────────

function airtableRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.airtable.com',
      path, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr && { 'Content-Length': Buffer.byteLength(bodyStr) })
      }
    };
    const req = https.request(options, res => {
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
  const path = `/v0/${baseId}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  return airtableRequest('GET', path, null, token);
}

function airtableCreate(baseId, table, fields, token) {
  return airtableRequest('POST', `/v0/${baseId}/${encodeURIComponent(table)}`, { fields }, token);
}

function airtableUpdate(baseId, table, recordId, fields, token) {
  return airtableRequest('PATCH', `/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`, { fields }, token);
}

// ── SendGrid helper ──────────────────────────────────────────────────────────

function sendEmail(to, from, subject, text, html, key, attachments = []) {
  return new Promise((resolve, reject) => {
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'Prosperity Lakes Club' },
      subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }]
    };
    if (attachments.length) payload.attachments = attachments;
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
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

function logEmail(label, status, body) {
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

function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

async function generateWaiverPDF(data) {
  const { guestName, memberName, memberAddress, additionalGuests, submissionDate, guestSignature, residentSignature } = data;

  const pdfDoc   = await PDFDocument.create();
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const brandBlue = rgb(0.294, 0.612, 0.827);
  const brandDark = rgb(0.129, 0.275, 0.369);
  const gray      = rgb(0.5, 0.5, 0.5);
  const lightGray = rgb(0.788, 0.749, 0.659);
  const black     = rgb(0.133, 0.133, 0.133);

  const pageW = 612, pageH = 792, marginL = 50, marginR = 50;
  const contentW = pageW - marginL - marginR;

  function drawParagraph(page, text, x, y, font, size, color, maxWidth) {
    const lines = wrapText(text, Math.floor(maxWidth / (size * 0.52)));
    for (const line of lines) { page.drawText(line, { x, y, font, size, color }); y -= size * 1.5; }
    return y;
  }

  function drawSectionHeading(page, label, y) {
    page.drawText(label, { x: marginL, y, font: fontBold, size: 8, color: brandDark, characterSpacing: 1.2 });
    y -= 6;
    page.drawLine({ start: { x: marginL, y }, end: { x: pageW - marginR, y }, thickness: 0.5, color: lightGray });
    return y - 12;
  }

  function drawInfoRow(page, label, value, y) {
    page.drawText(label, { x: marginL, y, font: fontBold, size: 10, color: gray });
    page.drawText(value || '-', { x: marginL + 145, y, font: fontReg, size: 10, color: black });
    return y - 18;
  }

  let page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH;

  page.drawRectangle({ x: 0, y: pageH - 75, width: pageW, height: 75, color: brandBlue });
  const t1 = 'PROSPERITY LAKES CLUB', t2 = 'GUEST WAIVER';
  page.drawText(t1, { x: (pageW - fontBold.widthOfTextAtSize(t1, 18)) / 2, y: pageH - 38, font: fontBold, size: 18, color: rgb(1,1,1) });
  page.drawText(t2, { x: (pageW - fontBold.widthOfTextAtSize(t2, 11)) / 2, y: pageH - 58, font: fontBold, size: 11, color: rgb(1,1,1) });

  y = pageH - 95;
  y = drawSectionHeading(page, 'GUEST INFORMATION', y);
  y = drawInfoRow(page, 'Guest Name:', guestName, y);
  y = drawInfoRow(page, 'Member Name:', memberName, y);
  y = drawInfoRow(page, 'Member Address:', memberAddress, y);
  y = drawInfoRow(page, 'Additional Guests:', (additionalGuests && additionalGuests !== 'None') ? additionalGuests : 'None', y);
  y = drawInfoRow(page, 'Submission Date:', submissionDate, y);
  y -= 16;

  y = drawSectionHeading(page, 'ASSUMPTION OF RISK & INDEMNITY AGREEMENT', y);
  for (let i = 0; i < WAIVER_PARAGRAPHS.length; i++) {
    y = drawParagraph(page, WAIVER_PARAGRAPHS[i], marginL, y, fontReg, 9, black, contentW);
    if (i < WAIVER_PARAGRAPHS.length - 1) y -= 8;
    if (y < 160 && i < WAIVER_PARAGRAPHS.length - 1) { page = pdfDoc.addPage([pageW, pageH]); y = pageH - 50; }
  }
  y -= 16;

  if (y < 220) { page = pdfDoc.addPage([pageW, pageH]); y = pageH - 50; }

  y = drawSectionHeading(page, 'AGREEMENT', y);
  y = drawParagraph(page, '[X]  I have read and fully understand the Assumption of Risk & Indemnity Agreement above, and I voluntarily agree to its terms.', marginL, y, fontReg, 9, black, contentW);
  y -= 20;

  y = drawSectionHeading(page, 'SIGNATURES', y);
  const sigW = (contentW - 20) / 2, sigH = 80;
  const sig1X = marginL, sig2X = marginL + sigW + 20;

  page.drawText('GUEST SIGNATURE',    { x: sig1X, y: y + 2, font: fontBold, size: 8, color: gray });
  page.drawText('RESIDENT SIGNATURE', { x: sig2X, y: y + 2, font: fontBold, size: 8, color: gray });
  y -= 10;
  page.drawRectangle({ x: sig1X, y: y - sigH, width: sigW, height: sigH, borderColor: lightGray, borderWidth: 0.5 });
  page.drawRectangle({ x: sig2X, y: y - sigH, width: sigW, height: sigH, borderColor: lightGray, borderWidth: 0.5 });

  async function embedSig(dataUrl, x, boxY) {
    try {
      if (!dataUrl || !dataUrl.startsWith('data:image/')) return;
      const img  = await pdfDoc.embedPng(Buffer.from(dataUrl.split(',')[1], 'base64'));
      const dims = img.scaleToFit(sigW - 8, sigH - 8);
      page.drawImage(img, { x: x + 4, y: boxY - sigH + (sigH - dims.height) / 2, width: dims.width, height: dims.height });
    } catch (e) { console.error('Sig embed error:', e.message); }
  }

  await embedSig(guestSignature,    sig1X, y);
  await embedSig(residentSignature, sig2X, y);

  const dateY = y - sigH - 10;
  page.drawText(`Date: ${submissionDate}`, { x: sig1X, y: dateY, font: fontReg, size: 9, color: gray });
  page.drawText(`Date: ${submissionDate}`, { x: sig2X, y: dateY, font: fontReg, size: 9, color: gray });

  const footerText = 'Prosperity Lakes Club - Guest Waiver System - Document generated electronically';
  page.drawText(footerText, { x: (pageW - fontReg.widthOfTextAtSize(footerText, 8)) / 2, y: 20, font: fontReg, size: 8, color: gray });

  return Buffer.from(await pdfDoc.save());
}

// ── Fuzzy street matching ────────────────────────────────────────────────────

const STREET_SUFFIXES = [
  'terrace','trail','way','cove','place','court','lane','drive','run',
  'boulevard','blvd','street','st','ave','avenue','rd','road','dr',
  'ct','pl','ln','ter','trl'
];

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function extractNumber(str) {
  const m = str.match(/^(\d+)/);
  return m ? m[1] : '';
}

function stripNumber(str)    { return str.replace(/^\d+\s*/, '').trim(); }
function removeSuffixes(str) { return str.split(' ').filter(w => !STREET_SUFFIXES.includes(w)).join(' ').trim(); }

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function wordSimilarity(word, target) {
  if (word === target) return 1;
  if (target.includes(word) || word.includes(target)) return 0.9;
  return Math.max(0, 1 - editDistance(word, target) / Math.max(word.length, target.length));
}

function matchStreetName(submittedAddress, streetNames) {
  const norm     = normalize(stripNumber(submittedAddress));
  const noSuffix = removeSuffixes(norm);
  const subWords = noSuffix.split(' ').filter(w => w.length > 1);

  let bestMatch = null, bestScore = 0;
  for (const street of streetNames) {
    const streetWords = removeSuffixes(normalize(street)).split(' ').filter(w => w.length > 1);
    let matchedCount  = 0;
    for (const sw of streetWords) {
      if (Math.max(...subWords.map(w => wordSimilarity(w, sw))) >= 0.75) matchedCount++;
    }
    const score = streetWords.length > 0 ? matchedCount / streetWords.length : 0;
    if (score > bestScore) { bestScore = score; bestMatch = street; }
  }
  return { matched: bestScore >= 0.5, bestMatch, score: bestScore };
}

// ── Email templates ──────────────────────────────────────────────────────────

function buildEmailTable(rows) {
  return rows.map(([label, value], i) =>
    `<tr style="background:${i % 2 === 0 ? '#f8f5ef' : 'white'};">
      <td style="padding:10px 14px;font-weight:bold;color:#21465e;width:40%;">${label}</td>
      <td style="padding:10px 14px;color:#333;">${value}</td>
    </tr>`
  ).join('');
}

function emailWrapper(title, bodyHtml) {
  return `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:24px;">
    <h2 style="color:#21465e;border-bottom:2px solid #4b9cd3;padding-bottom:10px;">${title}</h2>
    ${bodyHtml}
    <p style="color:#999;font-size:12px;text-align:center;margin-top:24px;">Prosperity Lakes Club - Guest Waiver System</p>
  </div>`;
}

function buildNewResidentEmail(guestName, guestsDisplay, memberAddress, approveUrl, denyUrl) {
  const html = emailWrapper('New Address — Prosperity Lakes Club', `
    <p style="color:#444;font-size:15px;">A guest has indicated they recently moved. Please check CINC to verify their address before taking action.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      ${buildEmailTable([['Guest Name', guestName], ['Additional Guests', guestsDisplay], ['Submitted Address', memberAddress]])}
    </table>
    <div style="margin:28px 0;text-align:center;">
      <a href="${approveUrl}" style="background:#2d6a4f;color:white;padding:14px 32px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;font-size:15px;font-weight:bold;margin-right:16px;">Approve</a>
      <a href="${denyUrl}"    style="background:#c0392b;color:white;padding:14px 32px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;font-size:15px;font-weight:bold;">Deny</a>
    </div>`);
  const text = `New Address - Please check CINC\n\nGuest: ${guestName}\nAdditional Guests: ${guestsDisplay}\nAddress: ${memberAddress}\n\nApprove: ${approveUrl}\nDeny: ${denyUrl}`;
  return { html, text };
}

function buildRepeatedFailureEmail(guestName, guestsDisplay, memberAddress, retryUrl, deleteUrl) {
  const html = emailWrapper('Could Not Verify Address — Prosperity Lakes Club', `
    <p style="color:#444;font-size:15px;">A guest waiver could not be verified after multiple attempts. Please have the resident confirm their address in CINC before taking action.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      ${buildEmailTable([['Guest Name', guestName], ['Additional Guests', guestsDisplay], ['Submitted Address', memberAddress]])}
    </table>
    <div style="margin:28px 0;text-align:center;">
      <a href="${retryUrl}"  style="background:#2d6a4f;color:white;padding:14px 32px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;font-size:15px;font-weight:bold;margin-right:16px;">Retry</a>
      <a href="${deleteUrl}" style="background:#7f1d1d;color:white;padding:14px 32px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;font-size:15px;font-weight:bold;">Delete</a>
    </div>
    <p style="color:#888;font-size:13px;text-align:center;">Delete will cancel this submission entirely. The guest will be asked to start over.</p>`);
  const text = `Could not verify address - Have resident confirm address in CINC\n\nGuest: ${guestName}\nAdditional Guests: ${guestsDisplay}\nAddress: ${memberAddress}\n\nRetry (returns guest to form): ${retryUrl}\nDelete (cancels submission): ${deleteUrl}`;
  return { html, text };
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

    let data;
    try { data = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    const {
      pendingType,
      guestName, memberName, memberAddress, additionalGuests,
      submissionDate, submissionDateISO, guestSignature, residentSignature,
      addrCity, addrState, addrZip
    } = data;

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

    const submittedStreet = memberAddress ? memberAddress.split(',')[0].trim() : '';
    const houseNumber     = extractNumber(submittedStreet);
    const safeStreet      = typeof submittedStreet === 'string' ? submittedStreet : '';
    const guestsDisplay   = (additionalGuests && additionalGuests !== 'None') ? additionalGuests : 'None';

    // ── PATH A: Frontend-triggered pending flow ───────────────────────────
    if (pendingType === 'new_resident' || pendingType === 'repeated_failure') {

      // For new_resident: fuzzy-match to get properly formatted address for master
      let formattedAddress = memberAddress;
      if (pendingType === 'new_resident' && houseNumber) {
        let streetNames = [];
        try {
          const r = await airtableGet(BASE, STREETS_TABLE, 'NOT({Street Name} = "")', TOKEN);
          streetNames = (JSON.parse(r.body).records || []).map(rec => rec.fields['Street Name']).filter(Boolean);
        } catch (e) { console.error('Street names fetch (pending path):', e); }

        const { matched, bestMatch } = matchStreetName(safeStreet, streetNames);
        if (matched && bestMatch) {
          const fmtStreet  = `${houseNumber} ${bestMatch}`;
          const cityBlock  = [addrCity, [addrState, addrZip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
          formattedAddress = cityBlock ? `${fmtStreet}, ${cityBlock}` : fmtStreet;
        }
      }

      const pendingId  = crypto.randomBytes(16).toString('hex');
      const formData   = JSON.stringify({
        title:        data.title || '',
        guestName, memberName,
        addrStreet:   submittedStreet,
        addrCity:     addrCity  || '',
        addrState:    addrState || '',
        addrZip:      addrZip   || '',
        memberAddress, additionalGuests
      });

      try {
        await airtableCreate(BASE, PENDING_TABLE, {
          'Pending ID':        pendingId,
          'Guest Name':        guestName,
          'Member Name':       memberName,
          'Full Address':      formattedAddress,
          'Additional Guests': additionalGuests || 'None',
          'Submission Date':   submissionDateISO,
          'Status':            'pending',
          'Form Data':         formData
        }, TOKEN);
      } catch (err) {
        console.error('Failed to create pending record:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to process submission' }) };
      }

      if (pendingType === 'new_resident') {
        const approveToken = crypto.createHmac('sha256', TOKEN).update(pendingId + 'approve').digest('hex');
        const denyToken    = crypto.createHmac('sha256', TOKEN).update(pendingId + 'deny').digest('hex');
        const approveUrl   = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=approve&token=${approveToken}`;
        const denyUrl      = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=deny&token=${denyToken}`;
        const { html, text } = buildNewResidentEmail(guestName, guestsDisplay, formattedAddress, approveUrl, denyUrl);
        try {
          const r = await sendEmail(TO_EMAIL, FROM_EMAIL, 'New Address - Please check CINC', text, html, SENDGRID_KEY);
          logEmail('new resident email', r.status, r.body);
        } catch (err) { console.error('New resident email error:', err.message); }

      } else {
        const retryToken  = crypto.createHmac('sha256', TOKEN).update(pendingId + 'retry').digest('hex');
        const deleteToken = crypto.createHmac('sha256', TOKEN).update(pendingId + 'delete').digest('hex');
        const retryUrl    = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=retry&token=${retryToken}`;
        const deleteUrl   = `${SITE_URL}/.netlify/functions/handle-decision?id=${pendingId}&action=delete&token=${deleteToken}`;
        const { html, text } = buildRepeatedFailureEmail(guestName, guestsDisplay, memberAddress, retryUrl, deleteUrl);
        try {
          const r = await sendEmail(TO_EMAIL, FROM_EMAIL, 'Could not verify address - Have resident confirm address in CINC', text, html, SENDGRID_KEY);
          logEmail('repeated failure email', r.status, r.body);
        } catch (err) { console.error('Repeated failure email error:', err.message); }
      }

      return { statusCode: 202, headers, body: JSON.stringify({ status: 'pending', pendingId }) };
    }

    // ── PATH B: Normal submission ─────────────────────────────────────────

    // 1. Fetch street names
    let streetNames = [];
    try {
      const r = await airtableGet(BASE, STREETS_TABLE, 'NOT({Street Name} = "")', TOKEN);
      streetNames = (JSON.parse(r.body).records || []).map(rec => rec.fields['Street Name']).filter(Boolean);
    } catch (err) { console.error('Failed to fetch street names:', err); }

    // 2. Fuzzy match street name
    const { matched, bestMatch } = matchStreetName(safeStreet, streetNames);
    console.log(`Street match: submitted="${submittedStreet}" matched=${matched} bestMatch="${bestMatch}"`);

    if (!matched) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'street_error' }) };
    }

    // 3. Format address using matched street name
    const formattedStreet  = (bestMatch && houseNumber) ? `${houseNumber} ${bestMatch}` : submittedStreet;
    const cityBlock        = [addrCity, [addrState, addrZip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const formattedAddress = cityBlock ? `${formattedStreet}, ${cityBlock}` : formattedStreet;
    console.log(`Formatted: "${formattedStreet}"`);

    // 4. Look up full address in Address Master
    let addressFound = false;
    try {
      const r    = await airtableGet(BASE, ADDRESS_TABLE, `{Street Address} = "${formattedStreet}"`, TOKEN);
      const recs = JSON.parse(r.body).records || [];
      addressFound = recs.length > 0;
      console.log(`Address master lookup "${formattedStreet}": ${addressFound ? 'found' : 'not found'}`);
    } catch (err) { console.error('Address master lookup failed:', err); }

    if (!addressFound) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'house_error' }) };
    }

    // 5. Save waiver to Airtable
    try {
      const waiverRes  = await airtableCreate(BASE, WAIVER_TABLE, {
        'Guest Name':         guestName,
        'Member Name':        memberName,
        'Member Address':     formattedAddress,
        'Additional Guests':  additionalGuests || 'None',
        'Submission Date':    submissionDateISO,
        'Guest Signature':    guestSignature,
        'Resident Signature': residentSignature,
        'Waiver Text':        `Assumption of Risk & Indemnity Agreement - Guest confirmed voluntary agreement on ${submissionDate}.`
      }, TOKEN);
      const waiverData = JSON.parse(waiverRes.body);
      if (waiverRes.status !== 200) throw new Error(waiverData.error?.message || 'Airtable waiver creation failed');
      console.log('Waiver saved:', waiverData.id);
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Airtable error: ' + err.message }) };
    }

    // 6. Generate PDF and send confirmation email
    try {
      const pdfBuffer = await generateWaiverPDF({
        guestName, memberName, memberAddress: formattedAddress,
        additionalGuests, submissionDate, guestSignature, residentSignature
      });
      const pdfBase64 = pdfBuffer.toString('base64');
      const filename  = `Waiver_${guestName.replace(/[^a-z0-9]/gi, '_')}_${submissionDateISO}.pdf`;

      const confirmHtml = `<div style="font-family:Georgia,serif;padding:24px;">
        <h2 style="color:#21465e;">New Guest Waiver Submitted</h2>
        <p><strong>Guest:</strong> ${guestName}</p>
        <p><strong>Member:</strong> ${memberName}</p>
        <p><strong>Address:</strong> ${formattedAddress}</p>
        <p><strong>Additional Guests:</strong> ${additionalGuests || 'None'}</p>
        <p><strong>Date:</strong> ${submissionDate}</p>
        <p style="color:#777;font-size:12px;">Signed waiver attached as PDF.</p>
      </div>`;
      const confirmText = `New Guest Waiver\n\nGuest: ${guestName}\nMember: ${memberName}\nAddress: ${formattedAddress}\nAdditional Guests: ${additionalGuests || 'None'}\nDate: ${submissionDate}\n\nSigned waiver attached as PDF.`;

      const r = await sendEmail(TO_EMAIL, FROM_EMAIL, `New Guest Waiver — ${guestName}`, confirmText, confirmHtml, SENDGRID_KEY,
        [{ content: pdfBase64, type: 'application/pdf', filename, disposition: 'attachment' }]);
      logEmail('confirmation email with PDF', r.status, r.body);
    } catch (err) { console.error('PDF/email error:', err.message); }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (topErr) {
    console.error('Unhandled exception:', topErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + (topErr.message || String(topErr)) }) };
  }
};
