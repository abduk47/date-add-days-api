import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';

// ---- Config ----
const PORT = process.env.PORT || 3000;
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60_000);
const RATE_MAX = Number(process.env.RATE_MAX ?? 120);
const API_KEYS = (process.env.API_KEYS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '*')
  .split(',')
  .map(s => s.trim());

// ---- App ----
const app = express();
app.disable('x-powered-by');
app.use(helmet());

// CORS: allow specific origins or all
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('CORS: origin not allowed'));
  }
}));

// Body parsers: JSON, raw text (for text/plain), and form
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/plain', 'text/*'], limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Rate limit (global)
app.use(rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false
}));

// Optional API key gate. If API_KEYS is empty, it is disabled.
function apiKeyMiddleware(req, res, next) {
  if (API_KEYS.length === 0) return next();
  const key = req.header('x-api-key');
  if (key && API_KEYS.includes(key)) return next();
  return res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-key' });
}

// -------------------- Date math helpers --------------------
const SEC_PER_DAY = 86_400n;

function normalizeNanos(secondsBig, nanosInt) {
  let s = BigInt(secondsBig);
  let n = BigInt(nanosInt);
  const ONE_BILLION = 1_000_000_000n;
  if (n >= ONE_BILLION) {
    s += n / ONE_BILLION;
    n = n % ONE_BILLION;
  } else if (n < 0n) {
    const borrow = ((-n + ONE_BILLION - 1n) / ONE_BILLION);
    s -= borrow;
    n += borrow * ONE_BILLION;
  }
  return { seconds: s, nanos: Number(n) };
}

/**
 * Universal parser that accepts:
 *  - ISO-8601 UTC string, e.g. "2025-08-17T00:00:00Z"
 *  - object {seconds, nanos}
 *  - stringified JSON object like "{\"seconds\":\"1608826790\",\"nanos\":0}"
 */
function parseInputToEpoch(dateInput) {
  // Strings: could be ISO or stringified JSON
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();

    // Try stringified JSON first if it looks like an object
    if (trimmed.startsWith('{')) {
      try {
        const asObj = JSON.parse(trimmed);
        if (asObj && typeof asObj === 'object' && 'seconds' in asObj) {
          const s = BigInt(asObj.seconds);
          const n = Number(asObj.nanos ?? 0);
          if (!Number.isFinite(n)) throw new Error('timestamp.nanos must be finite');
          return normalizeNanos(s, n);
        }
      } catch {
        // fall through to ISO parse
      }
    }

    // ISO 8601 path
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) {
      throw new Error('Invalid ISO date string. Use e.g. 2025-08-17T00:00:00Z or pass {seconds,nanos}.');
    }
    const seconds = BigInt(Math.floor(ms / 1000));
    const nanos = Number((ms % 1000 + 1000) % 1000) * 1_000_000; // 0..999,999,999
    return normalizeNanos(seconds, nanos);
  }

  // Objects with seconds/nanos
  if (dateInput && typeof dateInput === 'object' && 'seconds' in dateInput) {
    const seconds = BigInt(dateInput.seconds);
    const nanos = Number(dateInput.nanos ?? 0);
    if (!Number.isFinite(nanos)) throw new Error('timestamp.nanos must be finite');
    return normalizeNanos(seconds, nanos);
  }

  throw new Error('Provide "date" as ISO string, stringified {"seconds","nanos"}, or object {"seconds","nanos"}.');
}

function epochToOutputs(secondsBig, nanosInt) {
  const { seconds, nanos } = normalizeNanos(secondsBig, nanosInt);
  const ms = Number(seconds) * 1000 + Math.floor(nanos / 1_000_000);
  const d = new Date(ms);
  const ymd = d.toISOString().slice(0, 10);      // YYYY-MM-DD
  const isoFull = d.toISOString();               // e.g., 2025-08-22T00:00:00.000Z
  const isoNoMs = isoFull.slice(0, 19) + 'Z';    // YYYY-MM-DDTHH:MM:SSZ
  return {
    date_ymd: ymd,
    date_iso: isoNoMs,
    timestamp: { seconds: seconds.toString(), nanos }
  };
}

function parseDays(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error('days must be an integer');
}

function handleAddDays({ date, days }) {
  const { seconds, nanos } = parseInputToEpoch(date);
  const daysBig = parseDays(days);
  const resultSeconds = seconds + daysBig * SEC_PER_DAY;
  return epochToOutputs(resultSeconds, nanos);
}

// -------------------- String list helpers --------------------
/** Extract value after "input": or input= from text/plain, or from JSON/form { input: ... } */
function extractInput(body) {
  if (typeof body === 'string') {
    // Accept:  input="id1", "id2"  OR  "input": "id1", "id2"
    const m = body.match(/^\s*"?input"?\s*[:=]\s*(.*)\s*$/s);
    return m ? m[1] : body; // if no key provided, treat whole body as the list
  }
  if (body && typeof body === 'object' && 'input' in body) {
    return body.input;
  }
  return undefined;
}

/** Split a comma-separated list (quotes respected) into a clean array of strings */
function parseStringList(input) {
  if (Array.isArray(input)) {
    return input.map(v => String(v).trim()).filter(Boolean);
  }

  const raw = String(input ?? '').trim();
  if (!raw) return [];

  const items = [];
  let buf = '', inQuote = false, quoteChar = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false; quoteChar = null;
      } else if (ch === '\\' && i + 1 < raw.length) {
        i++; buf += raw[i]; // keep escaped char literally
      } else {
        buf += ch;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = true; quoteChar = ch;
      } else if (ch === ',') {
        const token = buf.trim();
        if (token) items.push(token);
        buf = '';
      } else {
        buf += ch;
      }
    }
  }
  const last = buf.trim(); if (last) items.push(last);

  // Remove surrounding quotes if present, trim, drop empties
  return items.map(t => {
    let s = t;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    return s.trim();
  }).filter(Boolean);
}

// -------------------- Routes --------------------
app.get('/health', (req, res) => res.json({ ok: true }));

// Date math: POST (JSON body or top-level seconds), also supports stringified object
app.post('/v1/add-days', apiKeyMiddleware, (req, res) => {
  try {
    let { date, days, seconds, nanos } = req.body ?? {};
    // Accept top-level seconds/nanos when date is missing
    if (date === undefined && seconds !== undefined) {
      date = { seconds: String(seconds), nanos: Number(nanos ?? 0) };
    }
    if (date === undefined || days === undefined) {
      return res.status(400).json({ error: 'Missing "date" (or top-level seconds/nanos) or "days"' });
    }
    return res.json(handleAddDays({ date, days }));
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

// Date math: GET (?date=ISO&days=.. OR ?seconds=..&nanos=..&days=..)
app.get('/v1/add-days', apiKeyMiddleware, (req, res) => {
  try {
    const { date, days, seconds, nanos } = req.query;
    let dateInput;
    if (seconds !== undefined) {
      dateInput = { seconds: String(seconds), nanos: nanos ? Number(nanos) : 0 };
    } else if (date !== undefined) {
      dateInput = String(date);
    } else {
      return res.status(400).json({ error: 'Provide ?date=ISO... or ?seconds=...&nanos=...' });
    }
    return res.json(handleAddDays({ date: dateInput, days }));
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

// Parse-list: POST (supports text/plain with `"input": "id1", "id2"`, form, or JSON)
app.post('/v1/parse-list', apiKeyMiddleware, (req, res) => {
  try {
    const input = extractInput(req.body);
    if (input === undefined) {
      return res.status(400).json({ error: 'Missing input (use text body "input: ...", form field "input", or JSON { "input": ... })' });
    }
    const items = parseStringList(input);
    return res.json({ items });
  } catch (e) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
});

// Parse-list: GET (?input="id1",%20"id2",%20"id3")
app.get('/v1/parse-list', apiKeyMiddleware, (req, res) => {
  try {
    const items = parseStringList(req.query?.input ?? '');
    return res.json({ items });
  } catch (e) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
});

// ---- Minimal Swagger (optional docs at /docs) ----
const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Utility API',
    version: '1.3.0',
    description: 'Endpoints: add-days (date math) & parse-list (split comma-separated strings).'
  },
  servers: [{ url: '/' }],
  paths: {
    '/v1/add-days': {
      get: {
        summary: 'Add days (query params)',
        parameters: [
          { name: 'date', in: 'query', schema: { type: 'string', example: '2025-08-17T00:00:00Z' } },
          { name: 'seconds', in: 'query', schema: { type: 'string', example: '1608826790' } },
          { name: 'nanos', in: 'query', schema: { type: 'integer', example: 0 } },
          { name: 'days', in: 'query', required: true, schema: { type: 'integer', example: 5 } }
        ],
        responses: { 200: { description: 'OK' } }
      },
      post: {
        summary: 'Add days (JSON body)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      date: {
                        oneOf: [
                          { type: 'string', description: 'ISO-8601 or stringified {"seconds","nanos"}' },
                          {
                            type: 'object',
                            properties: {
                              seconds: { type: 'string' },
                              nanos: { type: 'integer' }
                            },
                            required: ['seconds']
                          }
                        ]
                      },
                      days: { type: 'integer' }
                    },
                    required: ['date', 'days']
                  },
                  {
                    type: 'object',
                    properties: {
                      seconds: { type: 'string' },
                      nanos: { type: 'integer' },
                      days: { type: 'integer' }
                    },
                    required: ['seconds', 'days']
                  }
                ]
              }
            }
          }
        },
        responses: { 200: { description: 'OK' } }
      }
    },
    '/v1/parse-list': {
      get: {
        summary: 'Parse list (query param)',
        parameters: [
          { name: 'input', in: 'query', required: false, schema: { type: 'string', example: '"id1", "id2", "id3"' } }
        ],
        responses: { 200: { description: 'OK' } }
      },
      post: {
        summary: 'Parse list (text/plain, form, or JSON)',
        requestBody: {
          required: true,
          content: {
            'text/plain': { schema: { type: 'string', example: '"input": "id1", "id2", "id3"' } },
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', properties: { input: { type: 'string', example: '"id1", "id2", "id3"' } } }
            },
            'application/json': {
              schema: {
                type: 'object',
                properties: { input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
                required: ['input']
              }
            }
          }
        },
        responses: { 200: { description: 'OK' } }
      }
    },
    '/health': { get: { summary: 'Health check', responses: { 200: { description: 'OK' } } } }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

// ---- Start ----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Utility API listening on :${PORT}`);
});
