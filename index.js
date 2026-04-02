// Net-Net Backend v0.1.0
// Express API server for AI-powered tax categorization
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// ─── Health Check ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'netnet-backend', version: '0.1.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[NN] Net-Net backend running on port ${PORT}`);
});
