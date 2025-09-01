import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

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

// CORS
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('CORS: origin not allowed'));
  }
}));

app.use(express.json({ limit: '1mb' }));

// Rate limiting
app.use(rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false
}));

// API key check
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

// Parse different input formats
function parseInputToEpoch(dateInput) {
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (trimmed.startsWith('{')) {
      try {
        const asObj = JSON.parse(trimmed);
        if (asObj && typeof asObj === 'object' && 'seconds' in asObj) {
          return normalizeNanos(BigInt(asObj.seconds), Number(asObj.nanos ?? 0));
        }
      } catch (_) {}
    }
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) throw new Error('Invalid ISO date string');
    return normalizeNanos(BigInt(Math.floor(ms / 1000)), Number((ms % 1000 + 1000) % 1000) * 1_000_000);
  }
  if (dateInput && typeof dateInput === 'object' && 'seconds' in dateInput) {
    return normalizeNanos(BigInt(dateInput.seconds), Number(dateInput.nanos ?? 0));
  }
  throw new Error('Provide "date" as ISO string or {seconds, nanos}');
}

function epochToOutputs(secondsBig, nanosInt) {
  const { seconds, nanos } = normalizeNanos(secondsBig, nanosInt);
  const ms = Number(seconds) * 1000 + Math.floor(nanos / 1_000_000);
  const d = new Date(ms);
  const ymd = d.toISOString().slice(0, 10);
  const isoFull = d.toISOString();
  const isoNoMs = isoFull.slice(0, 19) + 'Z'; // YYYY-MM-DDTHH:MM:SSZ
  return { date_ymd: ymd, date_iso: isoNoMs, timestamp: { seconds: seconds.toString(), nanos } };
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

// Routes
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/v1/add-days', apiKeyMiddleware, (req, res) => {
  try {
    let { date, days, seconds, nanos } = req.body ?? {};
    if (date === undefined && seconds !== undefined) {
      date = { seconds: String(seconds), nanos: Number(nanos ?? 0) };
    }
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

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Date Add-Days API listening on :${PORT}`);
});
