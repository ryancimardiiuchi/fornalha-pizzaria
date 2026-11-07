(() => {
  'use strict';
  document.documentElement.classList.add('js');

  /* ------------------------------------------------------------------ */
  /* utilidades                                                          */
  /* ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const money = (cents) => BRL.format(cents / 100);

  /** Cria elementos sem innerHTML (evita XSS com texto vindo do servidor). */
  function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return node;
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento: segue sem salvar */ }
    },
  };

  async function api(path, options) {
    const res = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options && options.headers) },
    });
    let data = null;
    try { data = await res.json(); } catch { /* resposta sem corpo */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Não foi possível concluir. Tente de novo.');
      err.fields = data && data.fields;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------------------ */
  /* estado                                                              */
  /* ------------------------------------------------------------------ */
  const state = {
    menu: null,
    settings: null,
    sizeIndex: new Map(), // size_id -> { product, size, category }
    cat: null,
    picked: new Map(),    // product_id -> size_id escolhido na lista
    cart: store.get('fornalha.cart', []), // [{ sizeId, qty }]
    view: 'cart',
    orderType: 'entrega',
    poll: null,
    code: store.get('fornalha.order', ''),
    user: null,
  };

  const drawer = $('#drawer');
  const toastEl = $('#toast');
  let toastTimer;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  /* revelar ao rolar (só com JS ativo; CSS ignora se o usuário prefere menos movimento) */
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
    : null;
  function reveal(node, delay = 0) {
    node.classList.add('reveal');
    node.style.setProperty('--d', `${delay}ms`);
    if (io) io.observe(node); else node.classList.add('in');
  }

  /* ------------------------------------------------------------------ */
  /* horário de funcionamento                                            */
  /* ------------------------------------------------------------------ */
  function isOpenNow() {
    const s = state.settings;
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: s.timezone })
        .formatToParts(new Date())
        .find((p) => p.type === 'hour').value
    ) % 24;
    return hour >= s.open_hour && hour < s.close_hour;
  }

  function renderOpenState() {
    const open = isOpenNow();
    const pill = $('#open-pill');
    pill.hidden = false;
    pill.classList.toggle('is-closed', !open);
    $('#open-text').textContent = open
      ? 'Aberto agora, recebemos pedidos até a meia-noite'
      : 'Fechado agora, abrimos às 11h';
    $('#closed-note').hidden = open;
  }

  /* ------------------------------------------------------------------ */
  /* cardápio                                                            */
  /* ------------------------------------------------------------------ */
  async function loadMenu() {
    const status = $('#menu-status');
    try {
      if (location.protocol === 'file:') throw new Error('file');
      state.menu = await api('/api/menu');
    } catch (err) {
      status.textContent = location.protocol === 'file:'
        ? 'Você abriu o arquivo direto no navegador. Rode "npm start" na pasta do projeto e acesse http://localhost:3000.'
        : 'Não conseguimos carregar o cardápio. Atualize a página para tentar de novo.';
      return;
    }
    state.settings = state.menu.settings;
    for (const category of state.menu.categories) {
      for (const product of category.products) {
        for (const size of product.sizes) state.sizeIndex.set(size.id, { product, size, category });
      }
    }
    // remove do carrinho itens que deixaram de existir
    state.cart = state.cart.filter((l) => state.sizeIndex.has(l.sizeId));
    saveCart();

    state.cat = state.menu.categories[0].slug;
    status.textContent = '';
    renderTabs();
    renderDishes();
    renderCartCount();
    renderOpenState();
    if (state.code) $('#f-code').value = state.code;
  }

  function renderTabs() {
    const nav = $('#tabs');
    nav.replaceChildren(
      ...state.menu.categories.map((c) =>
        el('button', {
          type: 'button', class: 'tab', 'data-cat': c.slug,
          'aria-pressed': String(c.slug === state.cat),
          onclick: () => selectCategory(c.slug),
        }, el('img', { src: c.icon, alt: '', width: 40, height: 40 }), c.name)
      )
    );
  }

  function selectCategory(slug, { scroll = false } = {}) {
    state.cat = slug;
    $$('#tabs .tab').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.cat === slug)));
    renderDishes();
    if (scroll) $('#cardapio').scrollIntoView();
    const active = $(`#tabs .tab[data-cat="${slug}"]`);
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  const SCALES = { 1: [1], 2: [0.9, 1], 3: [0.82, 0.91, 1] };
  const defaultSize = (p) => p.sizes[Math.min(1, p.sizes.length - 1)];

  function renderDishes() {
    const category = state.menu.categories.find((c) => c.slug === state.cat);
    const rows = category.products.map((p) => dishRow(p, category));
    $('#dishes').replaceChildren(...rows);
    rows.forEach((row, i) => reveal(row, (i % 2) * 90));
  }

  function dishRow(p, category) {
    const photo = category.slug === 'pizzas';        // foto circular que muda de tamanho
    const square = category.slug === 'japonesa';     // foto quadrada, com selo de desconto já na imagem
    const chosenId = state.picked.get(p.id) ?? defaultSize(p).id;
    const sizeOf = (id) => p.sizes.find((s) => s.id === id);
    const scales = SCALES[Math.min(p.sizes.length, 3)];

    const disc = el('div', { class: `disc ${photo ? 'is-photo' : square ? 'is-sq' : 'is-icon'}` },
      el('img', { src: p.image, alt: '', width: 300, height: 300, loading: 'lazy' }));
    const fig = el('div', { class: 'dish-fig' }, disc,
      p.discount_pct && !square ? el('span', { class: 'tag', text: `-${p.discount_pct}%` }) : null);
    const price = el('p', { class: 'price' });
    const addBtn = el('button', { type: 'button', class: 'btn btn-primary add-btn' }, 'Adicionar');

    const paint = (animate = false) => {
      const id = state.picked.get(p.id) ?? defaultSize(p).id;
      const size = sizeOf(id);
      if (photo) disc.style.setProperty('--k', scales[p.sizes.indexOf(size)] ?? 1);
      const nodes = [el('span', { class: 'now', text: money(size.final_cents) })];
      if (size.final_cents < size.price_cents) nodes.push(el('s', { class: 'was', text: money(size.price_cents) }));
      price.replaceChildren(...nodes);
      if (animate) { price.classList.remove('pop'); void price.offsetWidth; price.classList.add('pop'); }
      addBtn.setAttribute('aria-label', `Adicionar ${p.name}, ${size.label}, por ${money(size.final_cents)}`);
      addBtn.onclick = () => addToCart(size.id, disc);
    };

    let sizes = null;
    if (p.sizes.length > 1) {
      sizes = el('fieldset', { class: 'sizes' },
        el('legend', { class: 'sr-only', text: `Tamanho de ${p.name}` }),
        p.sizes.map((s) =>
          el('label', { class: 'size' },
            el('input', {
              type: 'radio', name: `size-${p.id}`, value: s.id,
              checked: s.id === chosenId,
              onchange: () => { state.picked.set(p.id, s.id); paint(true); },
            }),
            el('span', {}, el('b', { text: s.label }), s.detail ? el('small', { text: s.detail }) : null)
          )
        )
      );
    }
    const detail = p.sizes.length === 1 && p.sizes[0].detail ? el('p', { class: 'dish-detail', text: p.sizes[0].detail }) : null;

    paint();
    return el('article', { class: 'dish' },
      fig,
      el('div', { class: 'dish-body' },
        el('h3', { text: p.name }),
        el('p', { class: 'dish-desc', text: p.description }),
        detail,
        sizes,
        el('div', { class: 'dish-buy' }, price, addBtn))
    );
  }

  /* ------------------------------------------------------------------ */
  /* carrinho                                                            */
  /* ------------------------------------------------------------------ */
  const saveCart = () => store.set('fornalha.cart', state.cart);

  function renderCartCount() {
    $('#cart-count').textContent = state.cart.reduce((n, l) => n + l.qty, 0);
  }

  /** Uma cópia da foto voa até o botão do carrinho. Devolve true se animou. */
  function flyToCart(fromEl) {
    if (!fromEl || !fromEl.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const a = fromEl.getBoundingClientRect();
    const b = $('#open-cart').getBoundingClientRect();
    if (!a.width) return false;
    const ghost = fromEl.cloneNode(true);
    Object.assign(ghost.style, {
      position: 'fixed', left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`,
      margin: '0', zIndex: '80', pointerEvents: 'none', transition: 'none', transform: 'none',
    });
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    document.body.append(ghost);
    const anim = ghost.animate([
      { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.2 - 70}px) scale(.6) rotate(120deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(.1) rotate(300deg)`, opacity: 0.5 },
    ], { duration: 780, easing: 'cubic-bezier(.45, 0, .7, .45)' });
    anim.onfinish = () => ghost.remove();
    return true;
  }

  function addToCart(sizeId, fromEl) {
    const line = state.cart.find((l) => l.sizeId === sizeId);
    if (line) line.qty = Math.min(20, line.qty + 1);
    else state.cart.push({ sizeId, qty: 1 });
    saveCart();
    renderCartCount();
    const { product, size } = state.sizeIndex.get(sizeId);
    toast(`${product.name}${product.sizes.length > 1 ? ` ${size.label.toLowerCase()}` : ''} no carrinho`);
    const flew = flyToCart(fromEl);
    setTimeout(() => {
      const btn = $('#open-cart');
      btn.classList.remove('bump');
      void btn.offsetWidth; // reinicia a animação
      btn.classList.add('bump');
    }, flew ? 650 : 0);
  }

  function changeQty(sizeId, delta) {
    const line = state.cart.find((l) => l.sizeId === sizeId);
    if (!line) return;
    line.qty += delta;
    if (line.qty < 1) state.cart = state.cart.filter((l) => l !== line);
    line.qty = Math.min(20, line.qty);
    saveCart();
    renderCartCount();
    renderCart();
  }

  function removeLine(sizeId) {
    state.cart = state.cart.filter((l) => l.sizeId !== sizeId);
    saveCart();
    renderCartCount();
    renderCart();
  }

  function totals(type = 'entrega') {
    const s = state.settings;
    const subtotal = state.cart.reduce((sum, l) => sum + state.sizeIndex.get(l.sizeId).size.final_cents * l.qty, 0);
    const fee = type === 'retirada' || subtotal === 0 || subtotal >= s.free_delivery_from_cents ? 0 : s.delivery_fee_cents;
    return { subtotal, fee, total: subtotal + fee };
  }

  function totalsRows(type) {
    const t = totals(type);
    const feeRow = type === 'retirada'
      ? el('div', {}, el('dt', { text: 'Retirada' }), el('dd', { text: 'Sem taxa' }))
      : t.fee === 0
        ? el('div', { class: 'free' }, el('dt', { text: 'Entrega' }), el('dd', { text: 'Grátis' }))
        : el('div', {}, el('dt', { text: 'Entrega' }), el('dd', { text: money(t.fee) }));
    return [
      el('div', {}, el('dt', { text: 'Itens' }), el('dd', { text: money(t.subtotal) })),
      feeRow,
      el('div', { class: 'grand' }, el('dt', { text: 'Total' }), el('dd', { text: money(t.total) })),
    ];
  }

  function renderCart() {
    const empty = state.cart.length === 0;
    $('#cart-empty').hidden = !empty;
    $('#cart-filled').hidden = empty;
    if (empty) return;

    $('#cart-lines').replaceChildren(
      ...state.cart.map((l) => {
        const { product, size, category } = state.sizeIndex.get(l.sizeId);
        const kind = category.slug === 'pizzas' ? 'is-photo' : category.slug === 'japonesa' ? 'is-sq' : 'is-icon';
        const meta = [size.label !== 'Único' ? size.label : '', size.detail].filter(Boolean).join(', ');
        return el('li', { class: 'line' },
          el('div', { class: `line-img ${kind}` },
            el('img', { src: product.image, alt: '', width: 64, height: 64 })),
          el('div', {},
            el('p', { class: 'line-name', text: product.name }),
            meta ? el('p', { class: 'line-meta', text: meta }) : null,
            el('div', { class: 'stepper', role: 'group', 'aria-label': `Quantidade de ${product.name}` },
              el('button', { type: 'button', 'aria-label': 'Diminuir', onclick: () => changeQty(l.sizeId, -1) }, '−'),
              el('output', { text: String(l.qty) }),
              el('button', { type: 'button', 'aria-label': 'Aumentar', onclick: () => changeQty(l.sizeId, 1) }, '+'))),
          el('div', { class: 'line-right' },
            el('p', { class: 'line-total', text: money(size.final_cents * l.qty) }),
            el('button', { type: 'button', class: 'link-btn', 'aria-label': `Remover ${product.name}`, onclick: () => removeLine(l.sizeId) }, 'Remover'))
        );
      })
    );

    const { subtotal } = totals('entrega');
    const goal = state.settings.free_delivery_from_cents;
    $('#free-ship-text').textContent = subtotal >= goal
      ? 'Entrega grátis neste pedido.'
      : `Faltam ${money(goal - subtotal)} para entrega grátis.`;
    $('#free-ship-bar').style.setProperty('--p', Math.min(100, Math.round((subtotal / goal) * 100)));
    $('#cart-totals').replaceChildren(...totalsRows('entrega'));
  }

  /* ------------------------------------------------------------------ */
  /* gaveta: troca de telas                                              */
  /* ------------------------------------------------------------------ */
  const TITLES = { cart: 'Seu pedido', checkout: 'Finalizar pedido', track: 'Acompanhar pedido', auth: 'Entrar', account: 'Minha conta' };

  function showView(name) {
    state.view = name;
    $$('[data-view]', drawer).forEach((v) => { v.hidden = v.dataset.view !== name; });
    $('#drawer-title').textContent = TITLES[name];
    $('.drawer-body', drawer).scrollTop = 0;
    if (name !== 'track') stopPolling();
  }

  function openDrawer(view) {
    if (view === 'cart') renderCart();
    if (view === 'checkout') renderCheckout();
    if (view === 'auth') setAuthMode(authMode);
    showView(view);
    if (view === 'auth') $('#drawer-title').textContent = authMode === 'register' ? 'Criar conta' : 'Entrar';
    if (view === 'account') renderAccount();
    if (!drawer.open) drawer.showModal();
    if (view === 'track') {
      if (state.code) { $('#f-code').value = state.code; loadOrder(state.code); }
      else $('#f-code').focus();
    }
  }

  function closeDrawer() { drawer.close(); }

  drawer.addEventListener('close', stopPolling);
  drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#open-cart').addEventListener('click', () => openDrawer('cart'));
  $('#open-track').addEventListener('click', () => openDrawer('track'));
  $('#hero-track').addEventListener('click', () => openDrawer('track'));
  $('#open-account').addEventListener('click', () => openDrawer(state.user ? 'account' : 'auth'));
  $('#go-checkout').addEventListener('click', () => openDrawer('checkout'));
  $('#back-to-cart').addEventListener('click', () => openDrawer('cart'));
  $('[data-close-to]', drawer).addEventListener('click', () => { closeDrawer(); selectCategory('pizzas', { scroll: true }); });

  // banners de oferta levam direto à categoria
  $$('.offer').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    selectCategory(a.dataset.cat, { scroll: true });
  }));

  /* ------------------------------------------------------------------ */
  /* checkout                                                            */
  /* ------------------------------------------------------------------ */
  const form = $('#checkout-form');

  function renderCheckout() {
    state.orderType = form.elements.type.value;
    $('#checkout-totals').replaceChildren(...totalsRows(state.orderType));
    $('#address-fields').hidden = state.orderType === 'retirada';
    $('#change-field').hidden = form.elements.method.value !== 'dinheiro';
    if (state.user) {
      if (!form.elements.name.value) form.elements.name.value = state.user.name;
      if (!form.elements.phone.value) form.elements.phone.value = maskPhone(state.user.phone);
    }
  }

  function maskPhone(value) {
    const d = String(value).replace(/\D/g, '').slice(0, 11);
    if (d.length > 7) return `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
    if (d.length > 2) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return d;
  }

  form.addEventListener('change', (e) => {
    if (e.target.name === 'type' || e.target.name === 'method') renderCheckout();
  });

  // máscara simples de telefone: (11) 91234-5678
  form.elements.phone.addEventListener('input', (e) => { e.target.value = maskPhone(e.target.value); });

  function clearErrors(root = form, box = $('#form-error')) {
    box.hidden = true;
    $$('.field', root).forEach((f) => {
      const err = $('.err', f);
      if (err) { err.hidden = true; err.textContent = ''; }
      const input = $('input, textarea', f);
      if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
    });
  }

  function showErrors(fields = {}, general, root = form, box = $('#form-error')) {
    let first = null;
    let n = 0;
    for (const [name, message] of Object.entries(fields)) {
      const wrap = $(`[data-field="${name}"]`, root);
      const err = wrap && $('.err', wrap);
      if (!err) { general = general || message; continue; }
      err.id = `err-${root.id}-${name}-${n++}`;
      err.textContent = message;
      err.hidden = false;
      const input = $('input:not([type="radio"]), textarea', wrap) || $('input', wrap);
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', err.id);
        first = first || input;
      }
    }
    if (general) {
      box.textContent = general;
      box.hidden = false;
      if (!first) box.scrollIntoView({ block: 'nearest' });
    }
    if (first) first.focus();
  }

  function clientValidate(data) {
    const errors = {};
    if (data.name.trim().length < 2) errors.name = 'Informe seu nome.';
    const phone = data.phone.replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 11) errors.phone = 'Informe o telefone com DDD.';
    if (data.type === 'entrega') {
      if (data.street.trim().length < 3) errors.street = 'Informe a rua.';
      if (!data.number.trim()) errors.number = 'Informe o número.';
      if (data.district.trim().length < 2) errors.district = 'Informe o bairro.';
    }
    return errors;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    if (state.cart.length === 0) { openDrawer('cart'); return; }

    const f = form.elements;
    const data = {
      name: f.name.value, phone: f.phone.value, type: f.type.value,
      street: f.street.value, number: f.number.value, district: f.district.value, complement: f.complement.value,
      method: f.method.value, change_for: f.change_for.value.trim().replace(',', '.'),
      notes: f.notes.value,
    };
    const clientErrors = clientValidate(data);
    if (Object.keys(clientErrors).length) {
      showErrors(clientErrors, 'Confira os campos destacados.');
      return;
    }

    const submit = $('#submit-order');
    submit.disabled = true;
    submit.textContent = 'Enviando...';
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer: { name: data.name, phone: data.phone },
          delivery: { type: data.type, street: data.street, number: data.number, district: data.district, complement: data.complement },
          payment: { method: data.method, change_for: data.method === 'dinheiro' && data.change_for ? Number(data.change_for) : null },
          notes: data.notes,
          items: state.cart.map((l) => ({ size_id: l.sizeId, quantity: l.qty })),
        }),
      });
      state.cart = [];
      saveCart();
      renderCartCount();
      state.code = order.code;
      store.set('fornalha.order', order.code);
      form.elements.notes.value = '';
      $('#f-code').value = order.code;
      showView('track');
      await loadOrder(order.code, { fresh: true });
    } catch (err) {
      showErrors(err.fields, err.fields ? 'Confira os campos destacados.' : err.message);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Enviar pedido';
    }
  });

  /* ------------------------------------------------------------------ */
  /* acompanhamento do pedido                                            */
  /* ------------------------------------------------------------------ */
  const FLOW = ['received', 'baking', 'ready', 'done'];
  const STEP_NAMES = {
    entrega: { received: 'Pedido recebido', baking: 'No forno', ready: 'Saiu para entrega', done: 'Entregue' },
    retirada: { received: 'Pedido recebido', baking: 'No forno', ready: 'Pronto para retirada', done: 'Retirado' },
  };
  const STATUS_NOTE = {
    received: 'Recebemos o seu pedido e já vamos começar.',
    baking: 'A massa já está no forno.',
    ready: { entrega: 'O entregador saiu com o seu pedido.', retirada: 'Pode vir buscar no balcão.' },
    done: 'Pedido finalizado. Bom apetite!',
  };
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function stopPolling() { clearInterval(state.poll); state.poll = null; }

  async function loadOrder(code, { fresh = false } = {}) {
    const errBox = $('#track-error');
    errBox.hidden = true;
    try {
      const order = await api(`/api/orders/${encodeURIComponent(code)}`);
      state.code = order.code;
      store.set('fornalha.order', order.code);
      renderOrder(order, fresh);
      stopPolling();
      if (!['done', 'cancelled'].includes(order.status)) {
        state.poll = setInterval(() => { if (drawer.open && state.view === 'track') refreshQuietly(order.code); }, 8000);
      }
    } catch (err) {
      $('#track-result').replaceChildren();
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  }

  async function refreshQuietly(code) {
    try {
      const order = await api(`/api/orders/${encodeURIComponent(code)}`);
      renderOrder(order, false);
      if (['done', 'cancelled'].includes(order.status)) stopPolling();
    } catch { /* tenta de novo no próximo ciclo */ }
  }

  function renderOrder(o, fresh) {
    const type = o.delivery_type;
    const names = STEP_NAMES[type];
    const at = Object.fromEntries(o.events.map((e) => [e.status, e.at]));
    const container = $('#track-result');

    const head = [
      el('div', { class: 'track-head' },
        el('p', { class: `track-status${fresh ? ' fresh' : ''}`, text: o.status === 'cancelled' ? 'Pedido cancelado' : names[o.status] }),
        el('span', { class: 'code-chip', text: o.code })),
      o.status === 'cancelled'
        ? el('p', { class: 'cancelled', text: 'Esse pedido foi cancelado. Se tiver dúvidas, ligue para (11) 3000-4500.' })
        : el('p', { class: 'track-note', text: fresh ? `Pedido enviado! ${STATUS_NOTE.received} Guarde o código ${o.code}.` : (o.status === 'ready' ? STATUS_NOTE.ready[type] : STATUS_NOTE[o.status]) }),
    ];

    const current = FLOW.indexOf(o.status);
    const steps = o.status === 'cancelled' ? null : el('ol', { class: 'timeline' },
      FLOW.map((s, i) => {
        const cls = i < current || o.status === 'done' ? 'is-done' : i === current ? 'is-now' : '';
        return el('li', { class: `step ${cls}`, 'aria-current': i === current && o.status !== 'done' ? 'step' : null },
          el('span', { class: 'step-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'step-name', text: names[s] }),
          el('span', { class: 'step-time', text: at[s] ? hhmm(at[s]) : '' }));
      }));

    const recap = el('div', { class: 'recap' },
      el('h3', { text: 'Resumo do pedido' }),
      el('ul', {}, o.items.map((i) =>
        el('li', {},
          el('span', { text: `${i.quantity}x ${i.name}${i.size !== 'Único' ? `, ${i.size}` : ''}` }),
          el('span', { text: money(i.unit_cents * i.quantity) })))),
      el('dl', { class: 'totals' },
        el('div', {}, el('dt', { text: 'Itens' }), el('dd', { text: money(o.subtotal_cents) })),
        el('div', {}, el('dt', { text: type === 'entrega' ? 'Entrega' : 'Retirada' }),
          el('dd', { text: o.delivery_fee_cents ? money(o.delivery_fee_cents) : type === 'entrega' ? 'Grátis' : 'Sem taxa' })),
        el('div', { class: 'grand' }, el('dt', { text: 'Total' }), el('dd', { text: money(o.total_cents) }))));

    container.replaceChildren(...head, steps, recap);
  }

  $('#track-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#f-code').value.trim().toUpperCase();
    if (!code) {
      const box = $('#track-error');
      box.textContent = 'Digite o código que você recebeu ao enviar o pedido.';
      box.hidden = false;
      return;
    }
    loadOrder(code);
  });

  /* ------------------------------------------------------------------ */
  /* conta: entrar, criar conta, meus pedidos                            */
  /* ------------------------------------------------------------------ */
  const authForm = $('#auth-form');
  const authError = $('#auth-error');
  let authMode = 'login';

  function renderAccountBtn() {
    const u = state.user;
    $('#account-label').textContent = u ? u.name.split(' ')[0] : 'Entrar';
    $('#open-account .avatar-sm').toggleAttribute('hidden', !u);
    $('#open-account .person').toggleAttribute('hidden', !!u);
    $('#open-account').setAttribute('aria-label', u ? `Minha conta, ${u.name}` : 'Entrar ou criar conta');
  }

  function setAuthMode(mode) {
    authMode = mode;
    const register = mode === 'register';
    $$('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $$('[data-only="register"]', authForm).forEach((f) => { f.hidden = !register; });
    $('#password-hint').hidden = !register;
    authForm.elements.password.autocomplete = register ? 'new-password' : 'current-password';
    $('#auth-art').src = register ? 'img/auth-criar.png' : 'img/auth-entrar.png';
    $('#auth-submit').textContent = register ? 'Criar conta' : 'Entrar';
    $('#drawer-title').textContent = register ? 'Criar conta' : 'Entrar';
    clearErrors(authForm, authError);
  }

  $$('.seg button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  authForm.elements.phone.addEventListener('input', (e) => { e.target.value = maskPhone(e.target.value); });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(authForm, authError);
    const f = authForm.elements;
    const register = authMode === 'register';
    const errors = {};
    if (register && f.name.value.trim().length < 2) errors.name = 'Informe seu nome.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.value.trim())) errors.email = 'Informe um e-mail válido.';
    if (register) {
      const d = f.phone.value.replace(/\D/g, '');
      if (d.length < 10 || d.length > 11) errors.phone = 'Informe o telefone com DDD.';
    }
    if (!f.password.value) errors.password = 'Informe a senha.';
    else if (register && f.password.value.length < 8) errors.password = 'A senha precisa ter pelo menos 8 caracteres.';
    if (Object.keys(errors).length) { showErrors(errors, null, authForm, authError); return; }

    const submit = $('#auth-submit');
    submit.disabled = true;
    try {
      const body = register
        ? { name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value }
        : { email: f.email.value, password: f.password.value };
      const res = await api(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
      state.user = res.user;
      authForm.reset();
      renderAccountBtn();
      toast(register ? `Conta criada. Bem-vindo, ${res.user.name.split(' ')[0]}!` : `Oi, ${res.user.name.split(' ')[0]}!`);
      openDrawer('account');
    } catch (err) {
      showErrors(err.fields || {}, err.fields ? 'Confira os campos destacados.' : err.message, authForm, authError);
    } finally {
      submit.disabled = false;
    }
  });

  async function renderAccount() {
    const u = state.user;
    if (!u) { openDrawer('auth'); return; }
    $('#me-name').textContent = u.name;
    $('#me-mail').textContent = u.email;
    const list = $('#my-orders');
    list.replaceChildren();
    $('#my-orders-empty').hidden = true;
    try {
      const { orders } = await api('/api/me/orders');
      $('#my-orders-empty').hidden = orders.length > 0;
      list.replaceChildren(...orders.map((o) => {
        const label = o.status === 'cancelled' ? 'Cancelado' : STEP_NAMES[o.delivery_type][o.status];
        const when = new Date(o.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        return el('li', {},
          el('button', {
            type: 'button', class: 'my-order',
            onclick: () => { state.code = o.code; $('#f-code').value = o.code; openDrawer('track'); },
          },
            el('span', { class: 'mo-main' }, el('b', { text: o.code }), el('small', { text: when })),
            el('span', { class: 'mo-side' }, el('b', { text: money(o.total_cents) }), el('small', { text: label }))));
      }));
    } catch (err) {
      if (err.status === 401) { state.user = null; renderAccountBtn(); openDrawer('auth'); }
    }
  }

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sai mesmo assim */ }
    state.user = null;
    renderAccountBtn();
    closeDrawer();
    toast('Você saiu da conta.');
  });

  async function loadMe() {
    try {
      state.user = (await api('/api/me')).user;
      renderAccountBtn();
    } catch { /* sem servidor: segue como visitante */ }
  }

  /* ------------------------------------------------------------------ */
  loadMenu();
  loadMe();
  $$('.section-title').forEach((t) => reveal(t));
  $$('.offer').forEach((o, i) => reveal(o, i * 140));
  setInterval(() => { if (state.settings) renderOpenState(); }, 60000);
})();
