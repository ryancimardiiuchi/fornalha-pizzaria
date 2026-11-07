'use strict';
/**
 * Servidor da Fornalha: API REST + arquivos estáticos, sem dependências externas.
 * Requer Node 22.5+ (usa node:sqlite).  Rode com:  npm start
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, finalPrice, transaction } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'fornalha';
const PUBLIC_DIR = path.join(__dirname, 'public');

const SETTINGS = {
  delivery_fee_cents: 600,
  free_delivery_from_cents: 9000,
  open_hour: 11,
  close_hour: 24,
  timezone: 'America/Sao_Paulo',
};

const STATUSES = ['received', 'baking', 'ready', 'done', 'cancelled'];
const FINAL_STATUSES = ['done', 'cancelled'];

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/* ---------------------------- helpers ---------------------------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Pedido grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

const text = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const digits = (v) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O, 0, I, 1
function newOrderCode() {
  for (;;) {
    let c = 'FN-';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM orders WHERE code = ?').get(c)) return c;
  }
}

function requireAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const real = Buffer.from(ADMIN_KEY);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    throw new HttpError(401, 'Chave de acesso incorreta.');
  }
}


/* ------------------------------ contas ------------------------------ */
const SESSION_DAYS = 30;
const COOKIE = 'fn_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function checkPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(sha256(token));
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, name: row.name, email: row.email, phone: row.phone };
}

// limite simples de tentativas de login por IP + e-mail (em memória)
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 8) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  list.push(now);
  attempts.set(key, list);
}

function requireJson(req) {
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Requisição inválida.');
  }
}

async function register(req, res) {
  requireJson(req);
  const b = await readJson(req, 4 * 1024);
  const errors = {};
  const name = text(b.name, 80);
  const email = text(b.email, 120).toLowerCase();
  const phone = digits(b.phone);
  const password = typeof b.password === 'string' ? b.password : '';
  if (name.length < 2) errors.name = 'Informe seu nome.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Informe um e-mail válido.';
  if (phone.length < 10 || phone.length > 11) errors.phone = 'Informe o telefone com DDD.';
  if (password.length < 8 || password.length > 72) errors.password = 'A senha precisa ter de 8 a 72 caracteres.';
  if (!errors.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    errors.email = 'Esse e-mail já tem conta. Use "Entrar".';
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'Confira os campos.', errors);

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)'
  ).run(name, email, phone, hashPassword(password));
  startSession(req, res, Number(lastInsertRowid));
  json(res, 201, { user: { id: Number(lastInsertRowid), name, email, phone } });
}

async function login(req, res) {
  requireJson(req);
  const b = await readJson(req, 2 * 1024);
  const email = text(b.email, 120).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  throttle(`${req.socket.remoteAddress}|${email}`);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // mesma resposta para e-mail inexistente e senha errada
  if (!user || !checkPassword(password, user.password_hash)) {
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }
  startSession(req, res, user.id);
  json(res, 200, { user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
}

function logout(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  json(res, 200, { ok: true });
}

function myOrders(user) {
  return db.prepare(
    `SELECT code, status, delivery_type, total_cents, created_at
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
  ).all(user.id);
}

/* ----------------------------- cardápio ----------------------------- */
function getMenu() {
  const categories = db.prepare('SELECT id, slug, name, icon FROM categories ORDER BY position').all();
  const products = db.prepare(
    `SELECT id, category_id, slug, name, description, image, discount_pct
       FROM products WHERE active = 1 ORDER BY position`
  ).all();
  const sizes = db.prepare(
    'SELECT id, product_id, label, detail, price_cents FROM product_sizes ORDER BY position'
  ).all();

  const sizesByProduct = new Map();
  for (const s of sizes) {
    const list = sizesByProduct.get(s.product_id) || [];
    list.push(s);
    sizesByProduct.set(s.product_id, list);
  }
  const prodByCat = new Map();
  for (const p of products) {
    const list = prodByCat.get(p.category_id) || [];
    list.push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      image: p.image,
      discount_pct: p.discount_pct,
      sizes: (sizesByProduct.get(p.id) || []).map((s) => ({
        id: s.id,
        label: s.label,
        detail: s.detail,
        price_cents: s.price_cents,
        final_cents: finalPrice(s.price_cents, p.discount_pct),
      })),
    });
    prodByCat.set(p.category_id, list);
  }
  return {
    settings: SETTINGS,
    categories: categories.map((c) => ({
      slug: c.slug, name: c.name, icon: c.icon, products: prodByCat.get(c.id) || [],
    })),
  };
}

/* ------------------------------ pedidos ------------------------------ */
function createOrder(body, userId = null) {
  const errors = {};
  const customer = body?.customer || {};
  const delivery = body?.delivery || {};
  const payment = body?.payment || {};

  const name = text(customer.name, 80);
  if (name.length < 2) errors.name = 'Informe seu nome.';

  const phone = digits(customer.phone);
  if (phone.length < 10 || phone.length > 11) errors.phone = 'Informe o telefone com DDD.';

  const type = delivery.type;
  if (type !== 'entrega' && type !== 'retirada') errors.type = 'Escolha entrega ou retirada.';

  const street = text(delivery.street, 120);
  const number = text(delivery.number, 12);
  const district = text(delivery.district, 60);
  const complement = text(delivery.complement, 60);
  if (type === 'entrega') {
    if (street.length < 3) errors.street = 'Informe a rua.';
    if (!number) errors.number = 'Informe o número.';
    if (district.length < 2) errors.district = 'Informe o bairro.';
  }

  const method = payment.method;
  if (!['pix', 'cartao', 'dinheiro'].includes(method)) errors.method = 'Escolha a forma de pagamento.';

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0 || rawItems.length > 40) errors.items = 'Adicione ao menos um item ao pedido.';

  // Preços SEMPRE vêm do banco: o navegador só diz o que e quanto.
  const lookup = db.prepare(
    `SELECT s.id AS size_id, s.label, s.price_cents, p.name, p.discount_pct
       FROM product_sizes s JOIN products p ON p.id = s.product_id
      WHERE s.id = ? AND p.active = 1`
  );
  const lines = [];
  for (const it of rawItems) {
    const sizeId = Number(it?.size_id);
    const qty = Number(it?.quantity);
    if (!Number.isInteger(sizeId) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      errors.items = 'Há um item inválido no pedido.';
      break;
    }
    const row = lookup.get(sizeId);
    if (!row) {
      errors.items = 'Um dos itens não está mais disponível. Atualize a página.';
      break;
    }
    const existing = lines.find((l) => l.size_id === sizeId);
    if (existing) existing.quantity = Math.min(20, existing.quantity + qty);
    else {
      lines.push({
        size_id: sizeId,
        product_name: row.name,
        size_label: row.label,
        unit_price_cents: finalPrice(row.price_cents, row.discount_pct),
        quantity: qty,
      });
    }
  }

  const subtotal = lines.reduce((s, l) => s + l.unit_price_cents * l.quantity, 0);
  const fee = type === 'entrega' && subtotal < SETTINGS.free_delivery_from_cents ? SETTINGS.delivery_fee_cents : 0;
  const total = subtotal + fee;

  let changeFor = null;
  if (method === 'dinheiro' && payment.change_for != null && payment.change_for !== '') {
    const cents = Math.round(Number(payment.change_for) * 100);
    if (!Number.isFinite(cents) || cents < total) {
      errors.change_for = 'O valor do troco precisa ser maior ou igual ao total do pedido.';
    } else changeFor = cents;
  }

  if (Object.keys(errors).length) throw new HttpError(422, 'Confira os campos do pedido.', errors);

  const code = newOrderCode();
  transaction(() => {
    const { lastInsertRowid: orderId } = db.prepare(
      `INSERT INTO orders (code, customer_name, phone, delivery_type, street, number, district, complement,
                           payment_method, change_for_cents, notes, subtotal_cents, delivery_fee_cents, total_cents, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      code, name, phone, type,
      type === 'entrega' ? street : null,
      type === 'entrega' ? number : null,
      type === 'entrega' ? district : null,
      type === 'entrega' ? complement || null : null,
      method, changeFor, text(body?.notes, 300) || null, subtotal, fee, total, userId
    );
    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, size_id, product_name, size_label, unit_price_cents, quantity)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      insItem.run(orderId, l.size_id, l.product_name, l.size_label, l.unit_price_cents, l.quantity);
    }
    db.prepare('INSERT INTO order_events (order_id, status) VALUES (?, ?)').run(orderId, 'received');
  });

  return { code, status: 'received', subtotal_cents: subtotal, delivery_fee_cents: fee, total_cents: total };
}

function itemsOf(orderId) {
  return db.prepare(
    `SELECT product_name AS name, size_label AS size, unit_price_cents AS unit_cents, quantity
       FROM order_items WHERE order_id = ? ORDER BY id`
  ).all(orderId);
}

/** Visão pública: quem tem o código acompanha status, itens e valores (sem telefone/endereço). */
function getPublicOrder(code) {
  const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(String(code).toUpperCase());
  if (!o) throw new HttpError(404, 'Não encontramos esse código. Confira e tente de novo.');
  return {
    code: o.code,
    status: o.status,
    delivery_type: o.delivery_type,
    subtotal_cents: o.subtotal_cents,
    delivery_fee_cents: o.delivery_fee_cents,
    total_cents: o.total_cents,
    created_at: o.created_at,
    items: itemsOf(o.id),
    events: db.prepare('SELECT status, created_at AS at FROM order_events WHERE order_id = ? ORDER BY id').all(o.id),
  };
}

function listAdminOrders() {
  const rows = db.prepare(
    `SELECT * FROM orders
      WHERE status NOT IN ('done','cancelled') OR updated_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 hours')
      ORDER BY created_at DESC LIMIT 200`
  ).all();
  return rows.map((o) => ({ ...o, items: itemsOf(o.id) }));
}

function setStatus(code, status) {
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Status inválido.');
  const o = db.prepare('SELECT id, status FROM orders WHERE code = ?').get(String(code).toUpperCase());
  if (!o) throw new HttpError(404, 'Pedido não encontrado.');
  if (FINAL_STATUSES.includes(o.status)) throw new HttpError(409, 'Esse pedido já foi encerrado.');
  transaction(() => {
    db.prepare(`UPDATE orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(status, o.id);
    db.prepare('INSERT INTO order_events (order_id, status) VALUES (?, ?)').run(o.id, status);
  });
  return { code, status };
}

/* ------------------------------- rotas ------------------------------- */
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/menu' && m === 'GET') return json(res, 200, getMenu());

  if (p === '/api/auth/register' && m === 'POST') return register(req, res);
  if (p === '/api/auth/login' && m === 'POST') return login(req, res);
  if (p === '/api/auth/logout' && m === 'POST') return logout(req, res);
  if (p === '/api/me' && m === 'GET') return json(res, 200, { user: currentUser(req) });
  if (p === '/api/me/orders' && m === 'GET') {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Entre na sua conta para ver seus pedidos.');
    return json(res, 200, { orders: myOrders(user) });
  }

  if (p === '/api/orders' && m === 'POST') {
    return json(res, 201, createOrder(await readJson(req), currentUser(req)?.id ?? null));
  }

  let match = p.match(/^\/api\/orders\/([A-Za-z0-9-]{4,20})$/);
  if (match && m === 'GET') return json(res, 200, getPublicOrder(match[1]));

  if (p === '/api/admin/orders' && m === 'GET') {
    requireAdmin(req);
    return json(res, 200, { orders: listAdminOrders() });
  }

  match = p.match(/^\/api\/admin\/orders\/([A-Za-z0-9-]{4,20})\/status$/);
  if (match && m === 'PATCH') {
    requireAdmin(req);
    const body = await readJson(req, 2 * 1024);
    return json(res, 200, setStatus(match[1], body.status));
  }

  throw new HttpError(404, 'Rota não encontrada.');
}

/* ------------------------- arquivos estáticos ------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Acesso negado.');
  let stat;
  try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'Página não encontrada.'); }
  if (!stat.isFile()) throw new HttpError(404, 'Página não encontrada.');

  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === '.html';
  send(res, 200, req.method === 'HEAD' ? undefined : fs.readFileSync(file), {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': isHtml || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    ...(isHtml ? { 'content-security-policy': CSP } : {}),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      const accept = String(req.headers.accept || '');
      if (req.url.startsWith('/api/') || !accept.includes('text/html')) {
        return json(res, err.status, { error: err.message, fields: err.fields });
      }
      return send(res, err.status, `<!doctype html><meta charset="utf-8"><title>${err.status}</title><p>${err.message}</p><a href="/">Voltar ao cardápio</a>`, {
        'content-type': 'text/html; charset=utf-8',
      });
    }
    console.error(err);
    return json(res, 500, { error: 'Algo deu errado do nosso lado. Tente de novo em instantes.' });
  }
});

server.listen(PORT, () => {
  console.log(`Fornalha no ar:   http://localhost:${PORT}`);
  console.log(`Painel de pedidos: http://localhost:${PORT}/admin  (chave: ${ADMIN_KEY === 'fornalha' ? 'fornalha — troque com ADMIN_KEY' : 'definida em ADMIN_KEY'})`);
});
