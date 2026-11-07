<img width="1830" height="915" alt="Captura de tela 2026-11-07 192722" src="https://github.com/user-attachments/assets/a00a3e1f-a557-4a44-a56b-3e746f5ca093" />


# Fornalha Pizzaria

Site de pedidos com cardápio, carrinho, checkout, acompanhamento do pedido e painel da cozinha.
HTML, CSS e JavaScript puros no front. Node.js + SQLite no back, **sem nenhuma dependência para instalar**.

## Tecnologias utilizadas

<div align="center">

<img src="https://skillicons.dev/icons?i=html,css,js,nodejs,sqlite" />

</div>


## Como rodar

Requer Node.js 22.5 ou mais novo (o SQLite vem embutido no Node).

```bash
npm start
```

- Site: http://localhost:3000
- Painel da cozinha: http://localhost:3000/admin (chave padrão: `fornalha`)

Variáveis opcionais: `PORT`, `ADMIN_KEY` (troque a chave antes de publicar), `DB_PATH`.

```bash
ADMIN_KEY=minha-chave-forte PORT=8080 npm start
npm run reset-db   # apaga o banco; ele é recriado e repovoado no próximo start
```

## Estrutura

```
server.js        API REST + arquivos estáticos (módulos nativos do Node)
db.js            esquema SQLite, seed do cardápio, cálculo de desconto
data/            arquivo do banco (fornalha.db), criado no primeiro start
public/
  index.html     site do cliente
  admin.html     painel de pedidos
  css/           style.css (site), admin.css
  js/            app.js (site), admin.js (painel)
  img/           fotos e ícones
```

## Banco de dados

| Tabela | Para que serve |
| --- | --- |
| `categories` | Pizzas, Lanches, Pratos, Japonesa, Sobremesas, Bebidas |
| `users` | Contas de clientes (senha com scrypt, nunca em texto puro) |
| `sessions` | Sessões de login (cookie HttpOnly, 30 dias) |
| `products` | Itens do cardápio, com `discount_pct` |
| `product_sizes` | Tamanhos e preços de cada item, em centavos |
| `orders` | Pedido: cliente, entrega, pagamento, totais e status |
| `order_items` | Itens do pedido, com nome e preço congelados no momento da compra |
| `order_events` | Histórico de status (alimenta a linha do tempo do cliente) |

Para mudar preços, descontos ou itens, edite as tabelas `products` e `product_sizes` (ou o `SEED` em `db.js` e rode `npm run reset-db`).

## API

| Método e rota | Descrição |
| --- | --- |
| `GET /api/menu` | Cardápio completo com preços finais e configurações (taxa, horário) |
| `POST /api/orders` | Cria um pedido. O servidor recalcula todos os preços a partir do banco |
| `POST /api/auth/register`, `/login`, `/logout` | Criar conta, entrar e sair |
| `GET /api/me`, `GET /api/me/orders` | Usuário logado e seus últimos pedidos |
| `GET /api/orders/:codigo` | Status, itens e totais (sem telefone nem endereço) |
| `GET /api/admin/orders` | Pedidos para a cozinha. Header `x-admin-key` |
| `PATCH /api/admin/orders/:codigo/status` | Muda o status: `received`, `baking`, `ready`, `done`, `cancelled` |

## Regras de negócio

- Taxa de entrega R$ 6,00, grátis a partir de R$ 90,00. Retirada não paga taxa.
- Horário: 11h à meia-noite (fuso de São Paulo). Fora do horário o pedido entra na fila.
- Pagamento na entrega ou retirada (Pix, cartão ou dinheiro). Não há gateway de pagamento.
- Conta é opcional: dá para pedir sem login. Logado, nome e telefone vêm preenchidos e os pedidos ficam em "Minha conta".
- Na categoria Japonesa o selo de desconto já faz parte das fotos; se mudar o desconto no banco, troque a imagem.
- Endereço, telefone e e-mail do rodapé são exemplos: troque pelos dados reais em `public/index.html`.
