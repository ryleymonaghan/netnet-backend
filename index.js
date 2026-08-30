// Net-Net Backend — version read from package.json
// Express API server for AI-powered tax categorization
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ─────────────────────────────────────────────────
// FRONTEND_URL accepts a comma-separated list so the apex domain, the www
// subdomain, the Vercel preview URLs, and local dev can all be allowed at once.
// A single-origin string was silently blocking net-net.io in production.
const DEFAULT_ORIGINS = [
  'https://net-net.io',
  'https://www.net-net.io',
  'https://netnet-frontend.vercel.app',
  'http://localhost:5173',
];

const allowedOrigins = new Set(
  (process.env.FRONTEND_URL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .concat(DEFAULT_ORIGINS)
);

app.use(cors({
  origin(origin, callback) {
    // No origin = server-to-server, curl, or same-origin. Allow.
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    // Allow any Vercel preview deployment of this project.
    if (/^https:\/\/netnet-frontend-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }
    console.warn('[NN] CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// ─── Health Check ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'netnet-backend', version: require('./package.json').version });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    allowedOrigins: Array.from(allowedOrigins),
  });
});

// ─── Routes ──────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/entities', require('./routes/entities'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/categorize', require('./routes/categorize'));
app.use('/api/reconcile', require('./routes/reconcile'));
app.use('/api/opportunities', require('./routes/opportunities'));

// ─── Error Handler ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[NN] Error:', err.message);
  const status = err.message === 'Not allowed by CORS' ? 403 : (err.status || 500);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[NN] Net-Net backend running on port ${PORT}`);
  console.log('[NN] Allowed origins:', Array.from(allowedOrigins).join(', '));
});
