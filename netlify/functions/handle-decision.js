const crypto = require('crypto');
const { airtableGet, airtableCreate, airtableUpdate } = require('./utils/airtable');

function page(title, heading, color, message) {
  return `<html>
    <head>
      <title>${title}</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
    </head>
    <body style="font-family:Georgia,serif;text-align:center;padding:60px 24px;background:#f8f5ef;">
      <h2 style="color:${color};margin-bottom:16px;">${heading}</h2>
      <p style="color:#444;font-size:16px;line-height:1.6;max-width:400px;margin:0 auto;">${message}</p>
    </body>
  </html>`;
}

const VALID_ACTIONS = ['approve', 'deny', 'retry', 'delete'];

exports.handler = async (event) => {
  const htmlHeaders = { 'Content-Type': 'text/html' };
  const { id, action, token } = event.queryStringParameters || {};

  // ── Basic validation ──────────────────────────────────────────────────────
  if (!id || !action || !token) {
    return { statusCode: 400, headers: htmlHeaders, body: page('Error', 'Invalid Request', '#c0392b', 'This link is missing required parameters.') };
  }

  if (!VALID_ACTIONS.includes(action)) {
    return { statusCode: 400, headers: htmlHeaders, body: page('Error', 'Unknown Action', '#c0392b', 'This link contains an unrecognized action.') };
  }

  const TOKEN         = process.env.AIRTABLE_TOKEN;
  const BASE          = process.env.AIRTABLE_BASE;
  const PENDING_TABLE = process.env.AIRTABLE_PENDING_TABLE;
  const ADDRESS_TABLE = process.env.AIRTABLE_ADDRESS_MASTER_TABLE;

  // ── HMAC token validation ─────────────────────────────────────────────────
  const expectedToken = crypto.createHmac('sha256', TOKEN).update(id + action).digest('hex');
  if (token !== expectedToken) {
    return { statusCode: 403, headers: htmlHeaders, body: page('Error', 'Invalid or Expired Link', '#c0392b', 'This link is no longer valid. It may have already been used.') };
  }

  // ── Fetch pending record ──────────────────────────────────────────────────
  let pendingRecord;
  try {
    const res  = await airtableGet(BASE, PENDING_TABLE, `{Pending ID} = "${id}"`, TOKEN);
    const data = JSON.parse(res.body);
    if (!data.records || data.records.length === 0) {
      return { statusCode: 404, headers: htmlHeaders, body: page('Not Found', 'Submission Not Found', '#c0392b', 'This submission could not be found. It may have already been processed or deleted.') };
    }
    pendingRecord = data.records[0];
  } catch (err) {
    console.error('Failed to fetch pending record:', err);
    return { statusCode: 500, headers: htmlHeaders, body: page('Error', 'Server Error', '#c0392b', 'An error occurred retrieving this submission. Please try again.') };
  }

  // ── Already processed? ────────────────────────────────────────────────────
  const currentStatus = pendingRecord.fields['Status'];
  if (currentStatus !== 'pending') {
    return {
      statusCode: 200,
      headers: htmlHeaders,
      body: page('Already Processed', 'Already Processed', '#21465e',
        `This submission has already been <strong>${currentStatus}</strong>. No further action is needed.`)
    };
  }

  const recordId   = pendingRecord.id;
  const address    = pendingRecord.fields['Full Address'] || '';
  const guestName  = pendingRecord.fields['Guest Name']  || '';
  const streetPart = address.split(',')[0].trim();

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (action === 'approve') {
    // Add street to Address Master
    if (streetPart) {
      try {
        const r = await airtableCreate(BASE, ADDRESS_TABLE, { 'Street Address': streetPart }, TOKEN);
        const d = JSON.parse(r.body);
        if (r.status === 200 || r.status === 201) {
          console.log(`Address master created: "${streetPart}" (${d.id})`);
        } else {
          console.error(`Address master create failed (${r.status}):`, r.body);
        }
      } catch (err) { console.error('Address master create error:', err); }
    }

    await airtableUpdate(BASE, PENDING_TABLE, recordId, { 'Status': 'approved' }, TOKEN);

    return {
      statusCode: 200,
      headers: htmlHeaders,
      body: page('Approved', '&#10003; Address Approved', '#2d6a4f',
        `<strong>${streetPart || address}</strong> has been added to the Address Master.<br><br>
         The guest may now re-sign and complete their waiver submission.`)
    };
  }

  // ── DENY ──────────────────────────────────────────────────────────────────
  if (action === 'deny') {
    await airtableUpdate(BASE, PENDING_TABLE, recordId, { 'Status': 'denied' }, TOKEN);

    return {
      statusCode: 200,
      headers: htmlHeaders,
      body: page('Denied', '&#10007; Address Denied', '#c0392b',
        `The submission for <strong>${guestName}</strong> has been denied.<br><br>
         The guest will be asked to re-enter their street address.`)
    };
  }

  // ── RETRY (same outcome as deny — guest re-enters street) ─────────────────
  if (action === 'retry') {
    await airtableUpdate(BASE, PENDING_TABLE, recordId, { 'Status': 'denied' }, TOKEN);

    return {
      statusCode: 200,
      headers: htmlHeaders,
      body: page('Retry', '&#8635; Retry Requested', '#b8963e',
        `The submission for <strong>${guestName}</strong> has been returned for re-entry.<br><br>
         The guest will be prompted to re-enter their street address.`)
    };
  }

  // ── DELETE (cancels submission entirely) ──────────────────────────────────
  if (action === 'delete') {
    await airtableUpdate(BASE, PENDING_TABLE, recordId, { 'Status': 'deleted' }, TOKEN);

    return {
      statusCode: 200,
      headers: htmlHeaders,
      body: page('Deleted', '&#128465; Submission Deleted', '#7f1d1d',
        `The submission for <strong>${guestName}</strong> has been cancelled and deleted.<br><br>
         The guest's screen will reset and they will be asked to start over.`)
    };
  }
};
