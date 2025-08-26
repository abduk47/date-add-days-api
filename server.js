import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';

// ---- Config ----
const PORT = process.env.PORT || 3000;
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60000);
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

app.use(express.json({ limit: '1mb' }));

// Global rate limit
app.use(rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false
}));

// Optional API key gate. If API_KEYS is empty, this is effectively disabled.
function apiKeyMiddleware(req, res, next) {
  if (API_KEYS.length === 0) return next();
  const key = req.header('x-api-key');
  if (key && API_KEYS.includes(key)) return next();
  return res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-key' });
}

const SEC_PER_DAY = 86400n;

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

function parseInputToEpoch(dateInput) {
  if (typeof dateInput === 'string') {
    const ms = Date.parse(dateInput);
    if (Number.isNaN(ms)) {
      throw new Error('Invalid ISO date string. Use e.g. 2025-08-17T00:00:00Z');
    }
    const seconds = BigInt(Math.floor(ms / 1000));
    const nanos = Number((ms % 1000 + 1000) % 1000) * 1_000_000; // 0..999,999,999
    return normalizeNanos(seconds, nanos);
  }
  if (dateInput && typeof dateInput === 'object' && 'seconds' in dateInput) {
    const sRaw = dateInput.seconds;
    const nRaw = dateInput.nanos ?? 0;
    const seconds = BigInt(typeof sRaw === 'string' || typeof sRaw === 'number' ? sRaw : sRaw.toString());
    const nanos = Number(typeof nRaw === 'string' ? nRaw : nRaw);
    if (!Number.isFinite(nanos)) throw new Error('timestamp.nanos must be finite');
    return normalizeNanos(seconds, nanos);
  }
  throw new Error('Provide "date" as ISO string or {seconds, nanos} object');
}

function epochToOutputs(secondsBig, nanosInt) {
  const { seconds, nanos } = normalizeNanos(secondsBig, nanosInt);
  const ms = Number(seconds) * 1000 + Math.floor(nanos / 1_000_000);
  const d = new Date(ms);
  const ymd = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return {
    date_ymd: ymd,
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

// ---- Routes ----
app.get('/health', (req, res) => res.json({ ok: true }));

// API v1
app.post('/v1/add-days', apiKeyMiddleware, (req, res) => {
  try {
    const { date, days } = req.body ?? {};
    if (date === undefined || days === undefined) {
      return res.status(400).json({ error: 'Missing "date" or "days"' });
    }
    return res.json(handleAddDays({ date, days }));
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

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

// ---- Swagger (OpenAPI) ----
const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Date Add-Days API',
    version: '1.0.0',
    description: 'Add integer days to a date; inputs: ISO or {seconds,nanos}. Outputs both YYYY-MM-DD and {seconds,nanos}.'
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: API_KEYS.length > 0 ? { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' } } : {}
  },
  security: API_KEYS.length > 0 ? [{ ApiKeyAuth: [] }] : [],
  paths: {
    '/v1/add-days': {
      get: {
        summary: 'Add days (query params)',
        parameters: [
          { name: 'date', in: 'query', schema: { type: 'string', example: '2025-08-17T00:00:00Z' } },
          { name: 'seconds', in: 'query', schema: { type: 'string', example: '1723852800' } },
          { name: 'nanos', in: 'query', schema: { type: 'integer', example: 0 } },
          { name: 'days', in: 'query', required: true, schema: { type: 'integer', example: 5 } }
        ],
        responses: {
          200: { description: 'Success' },
          400: { description: 'Bad Request' },
          401: { description: 'Unauthorized (if API key enabled)' }
        }
      },
      post: {
        summary: 'Add days (JSON body)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  date: {
                    oneOf: [
                      { type: 'string', example: '2025-08-17T00:00:00Z' },
                      {
                        type: 'object',
                        properties: {
                          seconds: { type: 'string', example: '1723852800' },
                          nanos: { type: 'integer', example: 0 }
                        },
                        required: ['seconds']
                      }
                    ]
                  },
                  days: { type: 'integer', example: 5 }
                },
                required: ['date', 'days']
              }
            }
          }
        },
        responses: {
          200: { description: 'Success' },
          400: { description: 'Bad Request' },
          401: { description: 'Unauthorized (if API key enabled)' }
        }
      }
    }
  }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Date Add-Days API listening on :${PORT}`);
});
