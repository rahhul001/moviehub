require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { db, getSettings, setSetting } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const DEMO = !(KEY_ID && KEY_SECRET);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
}));

app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.settings = getSettings();
  res.locals.isAdmin = !!req.session.admin;
  res.locals.demo = DEMO;
  next();
});

// ---------- helpers ----------
const safeUrl = (u) => {
  if (!u) return null;
  try { const x = new URL(u.trim()); return ['http:', 'https:'].includes(x.protocol) ? x.href : null; }
  catch { return null; }
};
const priceFor = (movie, settings) => movie.price != null ? movie.price : parseInt(settings.price, 10);
const eq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const requireAdmin = (req, res, next) => req.session.admin ? next() : res.redirect('/admin/login');
const checkCsrf = (req, res, next) =>
  req.body && req.body._csrf === req.session.csrf ? next() : res.status(403).send('Invalid CSRF token');

function markPaid(order, paymentId) {
  const hours = parseInt(getSettings().access_hours, 10) || 24;
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  db.prepare("UPDATE payments SET status='paid', payment_id=?, token=?, expires_at=? WHERE order_id=? AND status='created'")
    .run(paymentId, token, expires, order.order_id);
  return db.prepare('SELECT token FROM payments WHERE order_id=?').get(order.order_id).token;
}

// ---------- public ----------
app.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const cat = (req.query.cat || '').trim();
  let sql = 'SELECT * FROM movies WHERE active=1';
  const args = [];
  if (q) { sql += ' AND title LIKE ?'; args.push(`%${q}%`); }
  if (cat) { sql += ' AND category = ?'; args.push(cat); }
  sql += ' ORDER BY id DESC';
  const movies = db.prepare(sql).all(...args);
  const cats = db.prepare("SELECT DISTINCT category FROM movies WHERE active=1 AND category<>'' ORDER BY category").all().map(r => r.category);
  res.render('index', { movies, cats, q, cat });
});

app.get('/movie/:id', (req, res) => {
  const movie = db.prepare('SELECT * FROM movies WHERE id=? AND active=1').get(req.params.id);
  if (!movie) return res.status(404).render('message', { title: 'Not found', msg: 'Movie not found.' });
  res.render('movie', { movie, price: priceFor(movie, res.locals.settings), error: req.query.error });
});

// download link is open to everyone (free)
app.get('/go/download/:id', (req, res) => {
  const movie = db.prepare('SELECT download_url FROM movies WHERE id=? AND active=1').get(req.params.id);
  const url = movie && safeUrl(movie.download_url);
  if (!url) return res.status(404).render('message', { title: 'Unavailable', msg: 'No download link available.' });
  res.redirect(url);
});

app.post('/movie/:id/pay', (req, res) => {
  const s = getSettings();
  const movie = db.prepare('SELECT * FROM movies WHERE id=? AND active=1').get(req.params.id);
  if (!movie || !safeUrl(movie.watch_url)) return res.redirect(`/movie/${req.params.id}?error=Online+watching+not+available`);
  if (s.payments_enabled !== '1') return res.redirect(`/movie/${movie.id}?error=Payments+are+currently+disabled`);
  const contact = (req.body.contact || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(contact) && !/^[6-9]\d{9}$/.test(contact))
    return res.redirect(`/movie/${movie.id}?error=Enter+a+valid+email+or+10-digit+mobile+number`);
  const amount = priceFor(movie, s);

  (async () => {
    let orderId;
    if (DEMO) {
      orderId = 'demo_' + crypto.randomBytes(8).toString('hex');
    } else {
      const r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'),
        },
        body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt: `m${movie.id}_${Date.now()}` }),
      });
      if (!r.ok) throw new Error('Razorpay order failed: ' + (await r.text()));
      orderId = (await r.json()).id;
    }
    db.prepare('INSERT INTO payments (movie_id, contact, amount, order_id) VALUES (?,?,?,?)')
      .run(movie.id, contact, amount, orderId);
    res.redirect(`/checkout/${orderId}`);
  })().catch(e => { console.error(e); res.redirect(`/movie/${movie.id}?error=Could+not+start+payment`); });
});

app.get('/checkout/:orderId', (req, res) => {
  const order = db.prepare("SELECT p.*, m.title FROM payments p JOIN movies m ON m.id=p.movie_id WHERE order_id=? AND status='created'").get(req.params.orderId);
  if (!order) return res.status(404).render('message', { title: 'Not found', msg: 'Order not found or already paid.' });
  res.render('checkout', { order, keyId: KEY_ID });
});

// Razorpay success callback (signature verified server-side)
app.post('/payment/verify', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const order = db.prepare("SELECT * FROM payments WHERE order_id=? AND status='created'").get(razorpay_order_id || '');
  if (!order || DEMO) return res.status(400).render('message', { title: 'Error', msg: 'Invalid payment.' });
  const expected = crypto.createHmac('sha256', KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (!eq(expected, razorpay_signature || '')) return res.status(400).render('message', { title: 'Error', msg: 'Payment verification failed.' });
  res.redirect('/watch/' + markPaid(order, razorpay_payment_id));
});

// DEMO-only fake payment
app.post('/payment/demo', (req, res) => {
  if (!DEMO) return res.sendStatus(404);
  const order = db.prepare("SELECT * FROM payments WHERE order_id=? AND status='created'").get(req.body.order_id || '');
  if (!order) return res.status(400).render('message', { title: 'Error', msg: 'Invalid order.' });
  res.redirect('/watch/' + markPaid(order, 'demo_payment'));
});

app.get('/watch/:token', (req, res) => {
  const p = db.prepare("SELECT p.*, m.title, m.watch_url, m.active FROM payments p JOIN movies m ON m.id=p.movie_id WHERE token=? AND p.status='paid'").get(req.params.token);
  if (!p) return res.status(404).render('message', { title: 'Invalid link', msg: 'This access link is invalid.' });
  if (new Date(p.expires_at) < new Date()) return res.status(410).render('message', { title: 'Expired', msg: 'Your access has expired. Please pay again to watch.' });
  const url = p.active ? safeUrl(p.watch_url) : null;
  if (!url) return res.status(404).render('message', { title: 'Unavailable', msg: 'This movie is currently unavailable.' });
  res.render('watch', { p, url });
});

// ---------- admin ----------
const loginAttempts = new Map();
app.get('/admin/login', (req, res) => res.render('admin/login', { error: null }));
app.post('/admin/login', checkCsrf, (req, res) => {
  const ip = req.ip, now = Date.now();
  const rec = (loginAttempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (rec.length >= 5) return res.status(429).render('admin/login', { error: 'Too many attempts. Try again in 15 minutes.' });
  const okUser = eq(req.body.username || '', process.env.ADMIN_USER || 'admin');
  const okPass = eq(req.body.password || '', process.env.ADMIN_PASSWORD || 'admin');
  if (okUser && okPass) {
    loginAttempts.delete(ip);
    return req.session.regenerate(() => { req.session.admin = true; req.session.csrf = crypto.randomBytes(16).toString('hex'); res.redirect('/admin'); });
  }
  rec.push(now); loginAttempts.set(ip, rec);
  res.status(401).render('admin/login', { error: 'Invalid credentials' });
});
app.post('/admin/logout', requireAdmin, checkCsrf, (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin', requireAdmin, (req, res) => {
  const movies = db.prepare('SELECT * FROM movies ORDER BY id DESC').all();
  const stats = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM payments WHERE status='paid'").get();
  res.render('admin/dashboard', { movies, stats: { n: stats.n, total: stats.total, movies: movies.length } });
});

const readMovie = (b) => ({
  title: (b.title || '').trim(),
  year: parseInt(b.year, 10) || null,
  category: (b.category || '').trim(),
  description: (b.description || '').trim(),
  poster_url: safeUrl(b.poster_url),
  download_url: safeUrl(b.download_url),
  watch_url: safeUrl(b.watch_url),
  price: b.price === '' || b.price == null ? null : Math.max(1, parseInt(b.price, 10) || 10),
  active: b.active ? 1 : 0,
});

app.get('/admin/movies/new', requireAdmin, (req, res) => res.render('admin/movie_form', { movie: {}, action: '/admin/movies', error: null }));
app.post('/admin/movies', requireAdmin, checkCsrf, (req, res) => {
  const m = readMovie(req.body);
  if (!m.title) return res.render('admin/movie_form', { movie: m, action: '/admin/movies', error: 'Title is required' });
  db.prepare('INSERT INTO movies (title,year,category,description,poster_url,download_url,watch_url,price,active) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(m.title, m.year, m.category, m.description, m.poster_url, m.download_url, m.watch_url, m.price, m.active);
  res.redirect('/admin');
});
app.get('/admin/movies/:id/edit', requireAdmin, (req, res) => {
  const movie = db.prepare('SELECT * FROM movies WHERE id=?').get(req.params.id);
  if (!movie) return res.redirect('/admin');
  res.render('admin/movie_form', { movie, action: `/admin/movies/${movie.id}`, error: null });
});
app.post('/admin/movies/:id', requireAdmin, checkCsrf, (req, res) => {
  const m = readMovie(req.body);
  if (!m.title) return res.render('admin/movie_form', { movie: { ...m, id: req.params.id }, action: `/admin/movies/${req.params.id}`, error: 'Title is required' });
  db.prepare('UPDATE movies SET title=?,year=?,category=?,description=?,poster_url=?,download_url=?,watch_url=?,price=?,active=? WHERE id=?')
    .run(m.title, m.year, m.category, m.description, m.poster_url, m.download_url, m.watch_url, m.price, m.active, req.params.id);
  res.redirect('/admin');
});
app.post('/admin/movies/:id/toggle', requireAdmin, checkCsrf, (req, res) => {
  db.prepare('UPDATE movies SET active = 1 - active WHERE id=?').run(req.params.id);
  res.redirect('/admin');
});
app.post('/admin/movies/:id/delete', requireAdmin, checkCsrf, (req, res) => {
  db.prepare('DELETE FROM movies WHERE id=?').run(req.params.id);
  res.redirect('/admin');
});

app.get('/admin/payments', requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT p.*, m.title FROM payments p LEFT JOIN movies m ON m.id=p.movie_id ORDER BY p.id DESC LIMIT 500").all();
  res.render('admin/payments', { rows });
});

app.get('/admin/settings', requireAdmin, (req, res) => res.render('admin/settings', { saved: req.query.saved }));
app.post('/admin/settings', requireAdmin, checkCsrf, (req, res) => {
  const price = Math.max(1, parseInt(req.body.price, 10) || 10);
  const hours = Math.max(1, parseInt(req.body.access_hours, 10) || 24);
  setSetting('price', price);
  setSetting('access_hours', hours);
  setSetting('payments_enabled', req.body.payments_enabled ? '1' : '0');
  setSetting('site_name', (req.body.site_name || 'MovieHub').trim().slice(0, 40));
  res.redirect('/admin/settings?saved=1');
});

app.listen(PORT, () => console.log(`MovieHub running on http://localhost:${PORT}  (${DEMO ? 'DEMO payment mode' : 'Razorpay live'})`));
