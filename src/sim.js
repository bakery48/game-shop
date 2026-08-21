'use strict';
/**
 * 自動シミュレーション（仕様書 10 節「進め方」3）
 *   node src/sim.js [回数] [--seed=N] [--json] [--balance=key=value,...]
 * 検証項目:
 *   10週目の残高は10万円前後か / 25週目に図鑑80本に届くか / 50週で150本所持は可能か
 *   家賃が圧力として機能しているか（序盤の破産・ヒヤリ）
 */
const E = require('./engine.js');
const P = require('./policy.js');

function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const yen = n => Math.round(n).toLocaleString('ja-JP') + '円';

function runOne(seed, balance) {
  const st = E.createGame({ seed, balance });
  P.playAll(st);
  return st;
}

function run(n, opts) {
  opts = opts || {};
  const games = [];
  for (let i = 0; i < n; i++) games.push(runOne((opts.seed || 1000) + i, opts.balance));

  const endings = {};
  for (const g of games) endings[g.ending] = (endings[g.ending] || 0) + 1;

  const at = w => games.map(g => g.history.weeks[w - 1]).filter(Boolean);
  const survivors = w => at(w).length;

  const rows = [];
  for (const w of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) {
    const s = at(w);
    if (!s.length) { rows.push({ week: w, alive: 0 }); continue; }
    rows.push({
      week: w, alive: s.length,
      cash: median(s.map(x => x.cash)),
      cashLo: pct(s.map(x => x.cash), 0.1),
      cashHi: pct(s.map(x => x.cash), 0.9),
      registered: median(s.map(x => x.registered)),
      owned: median(s.map(x => x.owned)),
      inventory: median(s.map(x => x.inventory)),
      junk: median(s.map(x => x.junk)),
    });
  }

  // 家賃の圧力: 強制売却が起きた週の数 / 残高が家賃を下回った週の数
  const forcedWeeks = games.map(g => g.history.weeks.filter(w => w.forcedCount > 0).length);
  const scaryWeeks = games.map(g => g.history.weeks.filter(w => w.cash < E.BALANCE.rent).length);
  const bankruptWeek = games.filter(g => g.ending === 'bad').map(g => g.week);

  const finals = games.map(g => g.result || E.stats(g));
  return {
    n, games, rows, endings,
    survival: survivors(50) / n,
    final: {
      registered: median(finals.map(f => f.registered)),
      owned: median(finals.map(f => f.owned)),
      ownedMax: Math.max(...finals.map(f => f.owned)),
      cash: median(finals.map(f => f.cash)),
    },
    pressure: {
      forcedWeeks: mean(forcedWeeks),
      scaryWeeks: mean(scaryWeeks),
      bankruptRate: (endings.bad || 0) / n,
      bankruptWeekMedian: median(bankruptWeek),
    },
  };
}

function report(r) {
  const L = [];
  L.push(`=== ${r.n}回シミュレーション ===`);
  L.push('週    生存   残高(中央値)      10%〜90%              登録  所持  在庫 (ガラクタ)');
  for (const x of r.rows) {
    if (!x.alive) { L.push(`${String(x.week).padStart(2)}週   0`); continue; }
    L.push(`${String(x.week).padStart(2)}週  ${String(x.alive).padStart(3)}回  ${yen(x.cash).padStart(14)}  `
      + `${(yen(x.cashLo) + ' 〜 ' + yen(x.cashHi)).padStart(24)}  `
      + `${String(x.registered).padStart(4)}  ${String(x.owned).padStart(4)}  ${String(x.inventory).padStart(4)} (${x.junk})`);
  }
  L.push('');
  L.push('エンド分布: ' + Object.entries(r.endings)
    .map(([k, v]) => `${{ true: '真エンド', normal: 'ノーマル', incomplete: '未達', bad: 'バッド(閉店)' }[k] || k} ${v}回(${Math.round(v / r.n * 100)}%)`).join(' / '));
  L.push(`最終: 登録${r.final.registered}本 / 所持${r.final.owned}本 (最高${r.final.ownedMax}本) / 残高${yen(r.final.cash)}`);
  L.push(`家賃の圧力: 強制売却 平均${r.pressure.forcedWeeks.toFixed(1)}週 / 残高<家賃 平均${r.pressure.scaryWeeks.toFixed(1)}週 / 閉店率${Math.round(r.pressure.bankruptRate * 100)}%`
    + (r.pressure.bankruptWeekMedian ? `（中央値${r.pressure.bankruptWeekMedian}週目）` : ''));
  L.push('');
  L.push('--- 検証項目 ---');
  const w10 = r.rows.find(x => x.week === 10), w25 = r.rows.find(x => x.week === 25), w50 = r.rows.find(x => x.week === 50);
  const judge = (ok, s) => (ok ? '○ ' : '× ') + s;
  L.push(judge(w10.alive && w10.cash >= 60000 && w10.cash <= 160000, `10週目の残高が10万円前後 → ${w10.alive ? yen(w10.cash) : '全滅'}`));
  L.push(judge(w25.alive && w25.registered >= 75, `25週目に図鑑80本 → ${w25.alive ? w25.registered + '本' : '全滅'}`));
  L.push(judge(r.final.ownedMax >= 140 && r.endings.true !== r.n, `50週で150本所持が「可能だが余裕はない」 → 最高${r.final.ownedMax}本 / 真エンド${r.endings.true || 0}回`));
  L.push(judge(r.pressure.scaryWeeks >= 1 && r.pressure.bankruptRate < 0.35, `家賃が圧力として機能 → ヒヤリ${r.pressure.scaryWeeks.toFixed(1)}週 / 閉店率${Math.round(r.pressure.bankruptRate * 100)}%`));
  return L.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const n = parseInt(args.find(a => /^\d+$/.test(a)) || '100', 10);
  const seedArg = args.find(a => a.startsWith('--seed='));
  const balArg = args.find(a => a.startsWith('--balance='));
  let balance;
  if (balArg) {
    balance = {};
    for (const kv of balArg.slice(10).split(',')) {
      const [k, v] = kv.split('=');
      balance[k] = isNaN(Number(v)) ? v : Number(v);
    }
  }
  const r = run(n, { seed: seedArg ? Number(seedArg.slice(7)) : 1000, balance });
  if (args.includes('--json')) console.log(JSON.stringify({ rows: r.rows, endings: r.endings, final: r.final, pressure: r.pressure }, null, 2));
  else console.log(report(r));
}

module.exports = { run, runOne, report, median, mean };
