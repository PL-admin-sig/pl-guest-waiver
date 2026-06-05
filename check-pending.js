const https = require('https');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const { id } = event.queryStringParameters || {};
  if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

  const TOKEN         = process.env.AIRTABLE_TOKEN;
  const BASE          = process.env.AIRTABLE_BASE;
  const PENDING_TABLE = process.env.AIRTABLE_PENDING_TABLE;

  try {
    const encoded = encodeURIComponent(`{Pending ID} = "${id}"`);
    const path    = `/v0/${BASE}/${encodeURIComponent(PENDING_TABLE)}?filterByFormula=${encoded}`;
    const options = {
      hostname: 'api.airtable.com',
      path, method: 'GET',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
    };

    const res = await new Promise((resolve, reject) => {
      const req = https.request(options, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    const data = JSON.parse(res.body);

    if (!data.records || data.records.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_found' }) };
    }

    const record   = data.records[0];
    const status   = record.fields['Status'] || 'pending';
    let formData   = {};

    try { formData = JSON.parse(record.fields['Form Data'] || '{}'); }
    catch (e) { formData = {}; }

    return { statusCode: 200, headers, body: JSON.stringify({ status, formData }) };

  } catch (err) {
    console.error('check-pending error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
