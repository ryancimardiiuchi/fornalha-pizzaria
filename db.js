'use strict';
/**
 * Banco de dados da Fornalha (SQLite, via módulo nativo node:sqlite).
 * Cria as tabelas e popula o cardápio na primeira execução.
 * Preços sempre em centavos (inteiros) para evitar erro de ponto flutuante.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'fornalha.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  icon      TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  image         TEXT NOT NULL,
  discount_pct  INTEGER NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 90),
  active        INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_sizes (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  customer_name      TEXT NOT NULL,
  phone              TEXT NOT NULL,
  delivery_type      TEXT NOT NULL CHECK (delivery_type IN ('entrega','retirada')),
  street             TEXT,
  number             TEXT,
  district           TEXT,
  complement         TEXT,
  payment_method     TEXT NOT NULL CHECK (payment_method IN ('pix','cartao','dinheiro')),
  change_for_cents   INTEGER,
  notes              TEXT,
  subtotal_cents     INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL,
  total_cents        INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','baking','ready','done','cancelled')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  size_id          INTEGER REFERENCES product_sizes(id) ON DELETE SET NULL,
  product_name     TEXT NOT NULL,
  size_label       TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20)
);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, position);
`);

/** Preço com desconto, arredondado para múltiplos de 10 centavos (ex.: R$ 34,90). */
function finalPrice(priceCents, discountPct) {
  if (!discountPct) return priceCents;
  return Math.round((priceCents * (100 - discountPct)) / 100 / 10) * 10;
}

/** Executa fn dentro de uma transação; desfaz tudo se algo lançar erro. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Cardápio inicial                                                    */
/* ------------------------------------------------------------------ */
const PIZZA_SIZES = (m, g, f) => [
  ['Média', '6 fatias', m],
  ['Grande', '8 fatias', g],
  ['Família', '12 fatias', f],
];
const SINGLE = (price, detail = '') => [['Único', detail, price]];

const SEED = [
  {
    slug: 'pizzas', name: 'Pizzas', icon: '/img/icon-pizza.png',
    products: [
      { slug: 'margherita', name: 'Margherita', image: '/img/pizza-margherita.png', discount: 0,
        description: 'Molho de tomate pelado, muçarela de búfala e manjericão colhido no dia.',
        sizes: PIZZA_SIZES(3990, 4990, 5990) },
      { slug: 'tomate-fresco', name: 'Tomate fresco', image: '/img/pizza-tomate.png', discount: 30,
        description: 'Muçarela, fatias de tomate maduro, orégano e salsinha por cima.',
        sizes: PIZZA_SIZES(4290, 5290, 6290) },
      { slug: 'fornalha-especial', name: 'Fornalha especial', image: '/img/pizza-fornalha.jpg', discount: 0,
        description: 'Salame, cogumelos, azeitonas pretas, tomate-cereja e manjericão.',
        sizes: PIZZA_SIZES(4990, 6290, 7490) },
      { slug: 'carnivora', name: 'Carnívora', image: '/img/pizza-carnivora.png', discount: 20,
        description: 'Calabresa, bacon, presunto, pimentão vermelho, cogumelos e azeitonas.',
        sizes: PIZZA_SIZES(5290, 6590, 7890) },
      { slug: 'supreme', name: 'Supreme', image: '/img/pizza-supreme.png', discount: 25,
        description: 'Pimentão verde, cogumelos, azeitonas, linguiça e muçarela.',
        sizes: PIZZA_SIZES(4790, 5990, 7190) },
      { slug: 'mar-e-terra', name: 'Mar e terra', image: '/img/pizza-mar-e-terra.png', discount: 15,
        description: 'Camarão, frango desfiado, cebola e muçarela gratinada.',
        sizes: PIZZA_SIZES(5490, 6890, 8290) },
    ],
  },
  {
    slug: 'lanches', name: 'Lanches', icon: '/img/icon-lanche.png',
    products: [
      { slug: 'x-burger', name: 'X-Burger', image: '/img/icon-lanche.png', discount: 0,
        description: 'Hambúrguer de 120 g, queijo prato e maionese da casa.', sizes: SINGLE(1790) },
      { slug: 'x-salada', name: 'X-Salada', image: '/img/icon-lanche.png', discount: 0,
        description: 'Hambúrguer, queijo, alface, tomate e maionese.', sizes: SINGLE(2190) },
      { slug: 'x-bacon', name: 'X-Bacon', image: '/img/icon-lanche.png', discount: 0,
        description: 'Hambúrguer, queijo, bacon crocante e cebola roxa.', sizes: SINGLE(2690) },
      { slug: 'duplo-fornalha', name: 'Duplo Fornalha', image: '/img/icon-lanche.png', discount: 0,
        description: 'Dois hambúrgueres, dobro de queijo, tomate, alface e molho especial.', sizes: SINGLE(3290) },
    ],
  },
  {
    slug: 'pratos', name: 'Pratos', icon: '/img/icon-prato.png',
    products: [
      { slug: 'prato-da-casa', name: 'Prato da casa', image: '/img/icon-prato.png', discount: 0,
        description: 'Arroz, ovo frito, linguiça, banana frita, abacate e salada.', sizes: SINGLE(2990, 'Serve 1 pessoa') },
      { slug: 'prato-para-dividir', name: 'Prato para dividir', image: '/img/icon-prato.png', discount: 0,
        description: 'O prato da casa em porção dupla, com ovo extra e mais linguiça.', sizes: SINGLE(5490, 'Serve 2 pessoas') },
    ],
  },
  {
    slug: 'japonesa', name: 'Japonesa', icon: '/img/icon-sushi.png',
    products: [
      { slug: 'ramen-classico', name: 'Ramen clássico', image: '/img/japonesa-ramen.png', discount: 10,
        description: 'Caldo encorpado, macarrão, ovo marinado, cenoura e cogumelos.', sizes: SINGLE(3500) },
      { slug: 'combo-hot-roll', name: 'Combo hot roll', image: '/img/japonesa-hot-roll.png', discount: 20,
        description: 'Hot rolls empanados e crocantes, com gengibre e shoyu.', sizes: SINGLE(4500, '10 unidades') },
      { slug: 'uramaki-especial', name: 'Uramaki especial', image: '/img/japonesa-uramaki.png', discount: 20,
        description: 'Uramakis variados, com salmão, kani e cobertura de gergelim.', sizes: SINGLE(6000, '16 unidades') },
      { slug: 'sushi-misto', name: 'Sushi misto', image: '/img/japonesa-sushi-misto.png', discount: 25,
        description: 'Makis de salmão com alga e arroz temperado.', sizes: SINGLE(5000, '12 unidades') },
    ],
  },
  {
    slug: 'sobremesas', name: 'Sobremesas', icon: '/img/icon-sorvete.png',
    products: [
      { slug: 'casquinha', name: 'Casquinha', image: '/img/icon-sorvete.png', discount: 0,
        description: 'Sorvete cremoso na casquinha crocante. Escolha o número de bolas.',
        sizes: [['1 bola', '', 890], ['2 bolas', '', 1290], ['3 bolas', '', 1690]] },
      { slug: 'sundae-cereja', name: 'Sundae de cereja', image: '/img/icon-sorvete.png', discount: 0,
        description: 'Sorvete de creme, calda de chocolate e cereja no topo.', sizes: SINGLE(1690) },
    ],
  },
  {
    slug: 'bebidas', name: 'Bebidas', icon: '/img/icon-limonada.png',
    products: [
      { slug: 'limonada', name: 'Limonada com gelo', image: '/img/icon-limonada.png', discount: 0,
        description: 'Limão espremido na hora, bem gelada.',
        sizes: [['300 ml', '', 990], ['500 ml', '', 1390], ['1 litro', '', 2190]] },
      { slug: 'cola-vidro', name: 'Refrigerante de vidro', image: '/img/icon-cola.png', discount: 0,
        description: 'Garrafinha de cola gelada, 290 ml.', sizes: SINGLE(790) },
      { slug: 'cola-2l', name: 'Refrigerante 2 litros', image: '/img/icon-cola.png', discount: 0,
        description: 'Cola gelada para a mesa toda.', sizes: SINGLE(1490) },
    ],
  },
];

function addCategory(cat, position) {
  const { lastInsertRowid: catId } = db.prepare(
    'INSERT INTO categories (slug, name, icon, position) VALUES (?, ?, ?, ?)'
  ).run(cat.slug, cat.name, cat.icon, position);
  const insProd = db.prepare(
    `INSERT INTO products (category_id, slug, name, description, image, discount_pct, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insSize = db.prepare(
    'INSERT INTO product_sizes (product_id, label, detail, price_cents, position) VALUES (?, ?, ?, ?, ?)'
  );
  cat.products.forEach((p, pi) => {
    const { lastInsertRowid: prodId } = insProd.run(catId, p.slug, p.name, p.description, p.image, p.discount, pi);
    p.sizes.forEach(([label, detail, price], si) => insSize.run(prodId, label, detail, price, si));
  });
}

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n > 0) return;
  transaction(() => SEED.forEach((cat, ci) => addCategory(cat, ci)));
}

/** Atualiza bancos criados por versões anteriores. */
function migrate() {
  // v2: pedidos ligados a contas
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('user_id')) db.exec('ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id)');

  // v2: categoria "Entradas" dá lugar a "Japonesa"
  const hasJap = db.prepare("SELECT 1 FROM categories WHERE slug = 'japonesa'").get();
  const entradas = db.prepare("SELECT id FROM categories WHERE slug = 'entradas'").get();
  if (!hasJap && entradas) {
    transaction(() => {
      db.prepare('DELETE FROM product_sizes WHERE product_id IN (SELECT id FROM products WHERE category_id = ?)').run(entradas.id);
      db.prepare('DELETE FROM products WHERE category_id = ?').run(entradas.id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(entradas.id);
      addCategory(SEED.find((c) => c.slug === 'japonesa'), 3);
    });
  }
}

seedIfEmpty();
migrate();

module.exports = { db, finalPrice, transaction };
