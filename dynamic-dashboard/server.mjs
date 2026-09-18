import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(root, '../hithink-finance-cli');
const cli = path.join(cliRoot, 'dist/cli/main.js');
const port = Number(process.env.PORT || 3000);
const echartsBundle = path.resolve(root, 'node_modules/echarts/dist/echarts.min.js');

function validCode(value) {
  return /^[0-9]{6}\.(SH|SZ|BJ)$/i.test(value || '');
}

async function run(args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args, '--format', 'json'], {
    cwd: cliRoot, maxBuffer: 8 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (!result.ok) throw new Error(result.error?.message || '金融数据服务返回失败');
  return result.data;
}

async function stock(code) {
  const end = Date.now();
  const start = end - 366 * 24 * 60 * 60 * 1000;
  const [snapshot, history] = await Promise.all([
    run(['market', 'snapshot', '--thscodes', code]),
    run(['market', 'history', '--thscode', code, '--start-ms', String(start), '--end-ms', String(end), '--adjust', 'forward']),
  ]);
  return { code, snapshot: snapshot.item?.[0] || null, snapshotTimestamp: snapshot.timestamp, history: history.item || [], historyTimestamp: history.timestamp };
}

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function previousDate(date, days) {
  const value = new Date(`${date}T00:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

async function marketOverview() {
  const date = shanghaiDate();
  const [dragonToday, ladder, hotStock] = await Promise.all([
    run(['special', 'dragon-tiger', '--board-type', 'hot_money', '--date', date]),
    run(['special', 'limit-up-ladder']),
    run(['special', 'hot-stock', '--period', 'day']),
  ]);
  let dragonTiger = dragonToday;
  if (!dragonTiger.hot_money_items?.length) {
    const candidates = await Promise.all([1, 2, 3, 4, 5].map(days =>
      run(['special', 'dragon-tiger', '--board-type', 'hot_money', '--date', previousDate(date, days)]).catch(() => null),
    ));
    dragonTiger = candidates.find(item => item.hot_money_items?.length) || dragonToday;
  }
  const latest = ladder.item?.[0] || { date, boards: {} };
  return {
    asOf: date,
    dragonTiger: {
      tradeDate: dragonTiger.trade_date,
      count: dragonTiger.count,
      stockCount: dragonTiger.stock_count,
      items: dragonTiger.hot_money_items || [],
    },
    ladder: latest,
    hotStock: hotStock.item || [],
    timestamps: { dragonTiger: dragonTiger.timestamp, ladder: ladder.timestamp, hotStock: hotStock.timestamp },
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/stock') {
      const code = (url.searchParams.get('thscode') || '300033.SZ').toUpperCase();
      if (!validCode(code)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'thscode 格式应为 600519.SH' })); return; }
      const data = await stock(code);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); return;
    }
    if (url.pathname === '/api/market/overview') {
      const data = await marketOverview();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/market.html' || url.pathname === '/stock' || url.pathname === '/echarts.html' || url.pathname === '/legacy.html') {
      const filename = url.pathname === '/legacy.html' ? 'index.html' : (url.pathname === '/echarts.html' || url.pathname === '/stock') ? 'echarts.html' : 'market.html';
      let html = await readFile(path.join(root, filename), 'utf8');
      if (filename !== 'index.html') {
        const active = filename === 'market.html' ? '市场总览' : '个股 K 线';
        const nav = `<nav style="display:flex;gap:8px;margin:0 auto 18px;max-width:1400px;padding:0 20px"><a href="/" style="color:#9ef3df;text-decoration:none;border:1px solid #1e3a45;border-radius:9px;padding:8px 12px">市场总览</a><a href="/stock" style="color:#9ef3df;text-decoration:none;border:1px solid #1e3a45;border-radius:9px;padding:8px 12px">个股 K 线</a><span style="color:#8da6a8;padding:8px 4px">当前：${active}</span></nav>`;
        html = html.replace('<body>', `<body>${nav}`);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (url.pathname === '/vendor/echarts.min.js') {
      const bundle = await readFile(echartsBundle);
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' }); res.end(bundle); return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, '127.0.0.1', () => console.log(`动态看板：http://127.0.0.1:${port}`));
