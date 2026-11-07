(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const money = (c) => BRL.format(c / 100);
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return n;
  }

  let key = '';
  try { key = sessionStorage.getItem('fornalha.admin') || ''; } catch { /* sem armazenamento */ }
  let timer = null;

  const COLUMNS = [
    { status: 'received', title: 'Recebidos', next: 'baking', action: 'Levar ao forno' },
    { status: 'baking', title: 'No forno', next: 'ready', action: 'Pedido pronto' },
    { status: 'ready', title: 'Prontos', next: 'done', actionFor: (o) => (o.delivery_type === 'entrega' ? 'Marcar como entregue' : 'Marcar como retirado') },
    { status: 'done', title: 'Finalizados', last: true },
  ];

  async function call(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-admin-key': key, ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Não foi possível concluir.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function showLogin(message) {
    clearInterval(timer);
    $('#board-wrap').hidden = true;
    $('#login').hidden = false;
    $('#logout').hidden = true;
    const box = $('#login-error');
    box.hidden = !message;
    box.textContent = message || '';
  }

  function showBoard() {
    $('#login').hidden = true;
    $('#board-wrap').hidden = false;
    $('#logout').hidden = false;
  }

  async function refresh() {
    try {
      const { orders } = await call('/api/admin/orders');
      showBoard();
      render(orders);
    } catch (err) {
      if (err.status === 401) {
        key = '';
        try { sessionStorage.removeItem('fornalha.admin'); } catch { /* ignora */ }
        showLogin(err.message);
      } else {
        $('#board-meta').textContent = 'Sem conexão com o servidor. Tentando de novo...';
      }
    }
  }

  async function advance(code, status) {
    try {
      await call(`/api/admin/orders/${code}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    } catch (err) {
      $('#board-meta').textContent = err.message;
    }
    refresh();
  }

  function orderCard(o, col) {
    const where = o.delivery_type === 'entrega'
      ? `${o.street}, ${o.number}${o.complement ? `, ${o.complement}` : ''}. ${o.district}`
      : 'Cliente retira no balcão';
    const payLabel = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' }[o.payment_method];
    const change = o.payment_method === 'dinheiro' && o.change_for_cents ? `, troco para ${money(o.change_for_cents)}` : '';
    const phone = o.phone.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');

    const actions = [];
    if (!col.last) {
      actions.push(el('button', { type: 'button', class: 'btn btn-yellow', onclick: () => advance(o.code, col.next) },
        col.actionFor ? col.actionFor(o) : col.action));
      actions.push(el('button', {
        type: 'button', class: 'btn btn-ghost',
        onclick: () => { if (confirm(`Cancelar o pedido ${o.code}?`)) advance(o.code, 'cancelled'); },
      }, 'Cancelar'));
    }

    return el('article', { class: `order${o.status === 'cancelled' ? ' is-cancelled' : ''}` },
      el('div', { class: 'order-top' },
        el('span', { class: 'order-code', text: o.code }),
        el('span', { class: 'order-time', text: hhmm(o.created_at) })),
      el('p', { class: 'order-who' }, o.customer_name, el('small', { text: phone })),
      el('p', { class: 'order-where' },
        el('span', { class: 'order-badge', text: o.delivery_type === 'entrega' ? 'Entrega' : 'Retirada' }),
        where),
      el('ul', {}, o.items.map((i) =>
        el('li', {}, el('b', { text: `${i.quantity}x` }),
          el('span', { text: `${i.name}${i.size !== 'Único' ? `, ${i.size}` : ''}` })))),
      o.notes ? el('p', { class: 'order-note', text: `Obs.: ${o.notes}` }) : null,
      el('p', { class: 'order-pay' },
        el('span', { text: `${payLabel}${change}` }),
        el('strong', { text: money(o.total_cents) })),
      actions.length ? el('div', { class: 'order-actions' }, actions) : null,
      o.status === 'cancelled' ? el('p', { class: 'order-badge', text: 'Cancelado' }) : null
    );
  }

  function render(orders) {
    const board = $('#board');
    const active = orders.filter((o) => !['done', 'cancelled'].includes(o.status)).length;
    $('#board-meta').textContent = active === 0
      ? 'Nenhum pedido em andamento. Novos pedidos aparecem aqui sozinhos.'
      : `${active} pedido${active > 1 ? 's' : ''} em andamento. A lista atualiza a cada 6 segundos.`;
    document.title = active ? `(${active}) Painel de pedidos: Fornalha` : 'Painel de pedidos: Fornalha';

    board.replaceChildren(...COLUMNS.map((col) => {
      const list = orders
        .filter((o) => (col.last ? ['done', 'cancelled'].includes(o.status) : o.status === col.status))
        .sort((a, b) => (col.last ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at)));
      return el('section', { class: 'col', 'aria-label': col.title },
        el('div', { class: 'col-head' }, el('h2', { text: col.title }), el('span', { class: 'col-count', text: String(list.length) })),
        list.length ? list.map((o) => orderCard(o, col)) : el('p', { class: 'col-empty', text: 'Nada por aqui.' }));
    }));
  }

  $('#login').addEventListener('submit', (e) => {
    e.preventDefault();
    key = $('#key').value;
    if (!key) { showLogin('Digite a chave de acesso.'); return; }
    try { sessionStorage.setItem('fornalha.admin', key); } catch { /* ignora */ }
    start();
  });

  $('#logout').addEventListener('click', () => {
    key = '';
    try { sessionStorage.removeItem('fornalha.admin'); } catch { /* ignora */ }
    $('#key').value = '';
    showLogin();
  });

  function start() {
    clearInterval(timer);
    refresh();
    timer = setInterval(refresh, 6000);
  }

  if (key) start(); else showLogin();
})();
