const https = require('https');

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    };
    const req = https.request(url, options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildWaiverText(data) {
  const content = `
PROSPERITY LAKES CLUB
GUEST WAIVER

Submission Date: ${data.submissionDate}

GUEST INFORMATION
Guest Name:        ${data.guestName}
Member Name:       ${data.memberName}
Member Address:    ${data.memberAddress}
Additional Guests: ${data.additionalGuests}

ASSUMPTION OF RISK & INDEMNITY AGREEMENT

By entering and/or using any facilities, services, equipment, or participating
in any activity organized, arranged, or sponsored by PROSPERITY LAKES CLUB,
I, the undersigned Guest, acknowledge and agree that I do so entirely at my
own risk. I hereby release, waive, and forever discharge PROSPERITY LAKES CLUB,
its officers, partners, agents, employees, affiliates, directors, and attorneys
(collectively, the "Club Indemnified Parties") from any and all claims, demands,
damages, actions, or causes of action of any kind whatsoever, including those
arising from the negligence of the Club Indemnified Parties, which I now have
or may have in the future, resulting from my participation in or use of any
Club facilities, equipment, services, or activities.

I agree to defend, indemnify, and hold harmless the Club Indemnified Parties
from any and all losses, liabilities, damages, or expenses (including reasonable
attorneys fees) arising from any personal injury, death, or property damage
caused by my actions or omissions.

I understand that participation in recreational, water-related, and other
activities carries inherent risks, including but not limited to falls,
collisions, contact with other participants or equipment, weather conditions,
sun exposure, drowning, wildlife encounters, or medical emergencies. These
risks may result in serious injury, disability, or death. I certify that I am
a competent swimmer if participating in any water-related activities and that
I am solely responsible for my own safety at all times.

By signing below, I acknowledge that I have read, understand, and voluntarily
agree to the terms of this Waiver and Indemnity.

AGREEMENT CONFIRMATION
Guest confirmed reading and voluntary agreement on ${data.submissionDate}

SIGNATURES
Guest Signature:    Captured digitally on ${data.submissionDate}
Resident Signature: Captured digitally on ${data.submissionDate}

---
This waiver was submitted digitally via the Prosperity Lakes Club Guest Waiver system.
`.trim();

  return Buffer.from(content).toString('base64');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid request body' };
  }

  const {
    guestName, memberName, memberAddress, additionalGuests,
    submissionDate, submissionDateISO, guestSignature, residentSignature
  } = data;

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE  = process.env.AIRTABLE_BASE;
  const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
  const SENDGRID_KEY   = process.env.SENDGRID_API_KEY;
  const TO_EMAIL       = process.env.TO_EMAIL;
  const FROM_EMAIL     = process.env.FROM_EMAIL;

  // 1. Submit to Airtable
  try {
    const airtableRes = await httpsPost(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`,
      {
        fields: {
          'Guest Name':         guestName,
          'Member Name':        memberName,
          'Member Address':     memberAddress,
          'Additional Guests':  additionalGuests || 'None',
          'Submission Date':    submissionDateISO,
          'Guest Signature':    guestSignature,
          'Resident Signature': residentSignature,
          'Waiver Text':        `Assumption of Risk & Indemnity Agreement - Guest confirmed reading and voluntary agreement on ${submissionDate}`
        }
      },
      { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    );

    if (airtableRes.status !== 200) {
      const err = JSON.parse(airtableRes.body);
      throw new Error(err.error?.message || 'Airtable submission failed');
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Airtable error: ' + err.message })
    };
  }

  // 2. Send email with waiver attachment via SendGrid
  try {
    const waiverBase64 = buildWaiverText({
      guestName, memberName, memberAddress,
      additionalGuests, submissionDate
    });

    await httpsPost(
      'https://api.sendgrid.com/v3/mail/send',
      {
        personalizations: [{ to: [{ email: TO_EMAIL }] }],
        from: { email: FROM_EMAIL, name: 'Prosperity Lakes Club' },
        subject: `New Guest Waiver – ${guestName}`,
        content: [
          {
            type: 'text/plain',
            value: `A new guest waiver has been submitted.\n\nGuest Name: ${guestName}\nMember Name: ${memberName}\nMember Address: ${memberAddress}\nAdditional Guests: ${additionalGuests || 'None'}\nSubmission Date: ${submissionDate}\n\nThe full waiver is attached.\nSignatures are stored in Airtable.`
          }
        ],
        attachments: [
          {
            content: waiverBase64,
            filename: `waiver_${guestName.replace(/\s+/g, '_')}_${submissionDateISO}.txt`,
            type: 'text/plain',
            disposition: 'attachment'
          }
        ]
      },
      { 'Authorization': `Bearer ${SENDGRID_KEY}` }
    );
  } catch (err) {
    // Email failed but Airtable succeeded — log and continue
    console.error('SendGrid error:', err.message);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true })
  };
};
