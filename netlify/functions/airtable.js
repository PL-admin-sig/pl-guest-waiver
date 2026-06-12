const https = require('https');

// ── Shared Airtable request helpers ──────────────────────────────────────────
// Used across submit-waiver.js, handle-decision.js, and checkin.js.
// Centralizing these keeps Airtable interaction consistent and makes this
// module reusable as a starting point for additional clubhouse deployments.

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

function airtableGet(baseId, table, filterFormula, token, offset) {
  let path = `/v0/${baseId}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  if (offset) path += `&offset=${encodeURIComponent(offset)}`;
  return airtableRequest('GET', path, null, token);
}

function airtableCreate(baseId, table, fields, token) {
  return airtableRequest('POST', `/v0/${baseId}/${encodeURIComponent(table)}`, { fields }, token);
}

function airtableUpdate(baseId, table, recordId, fields, token) {
  return airtableRequest('PATCH', `/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`, { fields }, token);
}

module.exports = { airtableRequest, airtableGet, airtableCreate, airtableUpdate };
