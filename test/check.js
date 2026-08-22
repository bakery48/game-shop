#!/usr/bin/env node
'use strict';
/**
 * 回帰チェック。`node test/check.js` で全部走る。
 * 依存なし。ブラウザ側の確認は test/browser.js（playwright があるときだけ）。
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failed = 0, passed = 0;
function check(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log('  ok   ' + name + (note ? '  — ' + note : ''));
  } catch (e) {
    failed++;
    console.log('  NG   ' + name + '\n         ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
/** シェバンを外してから構文を見る */
const syntaxOk = file => {
  const code = fs.readFileSync(path.join(root, file), 'utf8').replace(/^#![^\n]*\n/, '');
  new Function(code);
};
const section = t => console.log('\n' + t);

// ---------------- 1. 構文 ----------------
section('構文');
const srcFiles = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js'));
for (const f of srcFiles) {
  check(`src/${f}`, () => syntaxOk('src/' + f));   // 構文エラーならここで落ちる
}
for (const f of ['build/build.js', 'build/gen-data.js', 'test/check.js']) {
  check(f, () => syntaxOk(f));
}

// ---------------- 2. データ ----------------
section('データ');
const sw = JSON.parse(fs.readFileSync(path.join(root, 'data/software.json'), 'utf8'));
const rg = JSON.parse(fs.readFileSync(path.join(root, 'data/regulars.json'), 'utf8'));
const E = require(path.join(root, 'src/engine.js'));

check('software.json の希少度が有効', () => {
  const tiers = Object.keys(E.BALANCE.tiers);
  for (const t of sw.titles) assert(tiers.includes(t.tier), `${t.title} の tier=${t.tier}`);
  return `${sw.titles.length}本`;
});
check('software.json にタイトルの重複がない', () => {
  const n = new Set(sw.titles.map(t => t.title)).size;
  assert(n === sw.titles.length, `${sw.titles.length - n}件が重複`);
});
check('software.json の相場と発売年が妥当', () => {
  for (const t of sw.titles) {
    assert(t.base > 0, `${t.title} の base`);
    assert(t.year >= sw.hardware.span[0] && t.year <= sw.hardware.span[1],
      `${t.title} の year=${t.year} がハードの期間外`);
  }
});
check('regulars.json のイベント数がしきい値と一致', () => {
  const n = rg.visitThresholds.length;
  for (const r of rg.regulars) assert(r.events.length === n, `${r.name} は${r.events.length}件`);
  return `${rg.regulars.length}人 × ${n}件`;
});
check('regulars.json が参照するタイトルが実在する', () => {
  const titles = new Set(sw.titles.map(t => t.title));
  for (const r of rg.regulars) for (const e of r.events) {
    if (e.title) assert(titles.has(e.title), `${r.name}: 「${e.title}」が無い`);
  }
});
check('常連の呼び方が主人公の年齢を漏らさない', () => {
  // 名前でも年齢でも呼ばせない。「おじさん」「おじいちゃん」は一発で叙述トリックが壊れる
  const banned = /おじいちゃん|おじさん|お兄さん|お若い|若く見え/;
  const self = sw.lore.self.name;
  for (const r of rg.regulars) {
    assert(r.calls, `${r.name} に calls が無い`);
    const all = (r.lines || []).concat(r.events.map(e => e.text))
      .concat(r.events.filter(e => e.skillKnown).map(e => e.skillKnown.text));
    for (const line of all) {
      const hit = line.match(banned);
      assert(!hit, hit && `${r.name}: 年齢が漏れる呼びかけ「${hit[0]}」`);
      assert(!line.includes(self), `${r.name}: 主人公を名前で呼んでいる`);
    }
  }
  const calls = {};
  for (const r of rg.regulars) calls[r.calls] = (calls[r.calls] || 0) + 1;
  return Object.entries(calls).map(([k, v]) => `${k}${v}人`).join(' / ');
});
check('「店長」と呼ぶ常連が実際にそう呼んでいる', () => {
  const users = rg.regulars.filter(r => r.calls.startsWith('店長'));
  assert(users.length >= 1, '店長呼びの常連がいない');
  for (const r of users) {
    const used = (r.lines || []).some(l => l.includes(r.calls));
    assert(used, `${r.name} は calls=${r.calls} なのに一度も使っていない`);
  }
  // 逆に「あんた」派が店長と呼んでいないこと
  for (const r of rg.regulars.filter(x => !x.calls.startsWith('店長'))) {
    for (const l of (r.lines || [])) {
      assert(!l.includes('店長'), `${r.name}（${r.calls}派）が店長と呼んでいる`);
    }
  }
  return users.map(r => r.name).join('・');
});
check('常連のセリフが来店回数に対して足りている', () => {
  // 1周で12〜18回来店するので、同じ言い回しの繰り返しがどれだけ残っているかを見る
  const counts = rg.regulars.map(r => (r.lines || []).length);
  const min = Math.min(...counts);
  assert(min >= 4, `最少${min}本`);
  return `${min}〜${Math.max(...counts)}本（計${counts.reduce((a, b) => a + b, 0)}本）`;
});
check('regulars.json が参照するスキルが実在する', () => {
  for (const r of rg.regulars) for (const e of r.events) {
    if (e.skill) assert(E.BALANCE.skills[e.skill], `${r.name}: スキル ${e.skill} が無い`);
  }
});
check('スキルを教える常連が実在する', () => {
  const names = new Set(rg.regulars.map(r => r.name));
  for (const id in E.BALANCE.skills) {
    assert(names.has(E.BALANCE.skills[id].from), `${id} の from=${E.BALANCE.skills[id].from}`);
  }
});
check('src/software-data.js が data/*.json と一致', () => {
  const gen = require(path.join(root, 'src/software-data.js'));
  assert(gen.titles.length === sw.titles.length, 'ソフトの数が違う（node build/gen-data.js を実行）');
  assert(gen.regulars.length === rg.regulars.length, '常連の数が違う（node build/gen-data.js を実行）');
  assert(String(gen.visitThresholds) === String(rg.visitThresholds),
    'しきい値が違う（node build/gen-data.js を実行）');
});

check('伏線がカタログに必ず載る', () => {
  // 区分の枠から溢れると伏線ごと消えるので、7本すべてが200本の中にいることを見る
  const st = E.createGame({ seed: 1 });
  const inCatalog = new Set(st.catalog.map(t => t.name));
  const lore = sw.titles.filter(t => t.lore);
  assert(lore.length >= 8, `伏線が${lore.length}本しかない`);
  for (const t of lore) {
    assert(inCatalog.has(t.title), `「${t.title}」が枠から溢れている`);
    assert(['uncle', 'self'].includes(t.lore), `${t.title}: lore=${t.lore}`);
  }
  const self = lore.filter(t => t.lore === 'self').length;
  return `${lore.length}本（叔父${lore.length - self} / 主人公${self}）`;
});
check('主人公の正体をUIに出していない', () => {
  // 真エンドまで伏せる。ソースに直接名前を書かないこと（データ側にだけ置く）
  const self = sw.lore.self.name;
  for (const f of ['src/ui.js', 'build/template.html', 'index.html']) {
    const body = fs.readFileSync(path.join(root, f), 'utf8');
    assert(!body.includes(self), `${f} に「${self}」が直書きされている`);
  }
  return `「${self}」はデータの中だけ`;
});
check('会話では誰も家名を口にしない', () => {
  // 図鑑の details だけが姓を持つ。会話に出ると種明かしが先に割れる
  const names = [sw.lore.uncle.surname, sw.lore.self.surname];
  for (const r of rg.regulars) {
    const all = (r.lines || []).concat(r.events.map(e => e.text))
      .concat(r.events.filter(e => e.skillKnown).map(e => e.skillKnown.text));
    for (const line of all) for (const nm of names) {
      assert(!line.includes(nm), `${r.name} が「${nm}」と言っている`);
    }
  }
  return `${names.join('・')} は図鑑の中だけ`;
});
check('屋号が叔父の姓の暗号になっている', () => {
  // 石橋→ブリヂストン方式。看板を見ても姓は分からない、が正解を知れば一致する
  const st = E.createGame({ seed: 1 });
  assert(st.log[0].text.includes(sw.lore.shop), '屋号が開店の一言に出ていない');
  assert(!sw.lore.shop.includes(sw.lore.uncle.surname), '屋号に姓がそのまま入っている');
  return `${sw.lore.shop} ← ${sw.lore.uncle.surname}`;
});
check('主人公の姓が看板と無関係', () => {
  // 「生涯なにも署名していない」男なので、看板の姓と一致してはいけない
  const u = sw.lore.uncle.surname, self = sw.lore.self.surname;
  assert(u !== self, `叔父と主人公が同じ姓（${u}）だと、看板が主人公の署名になってしまう`);
  for (const t of sw.titles.filter(x => x.lore === 'self')) {
    assert(!t.details.includes(u), `「${t.title}」に叔父の姓が混ざっている`);
  }
  return `叔父${u} / 主人公${self}（別姓）`;
});
check('図鑑に載る回数が叔父＞主人公になっている', () => {
  // 叔父は「ゲームファンなら知っている名前」、主人公は「署名しなかった男」。
  // ここが逆転すると、二人の対比も真エンドの落差も消える
  const named = who => sw.titles.filter(t => t.details.includes(sw.lore[who].name)).length;
  const u = named('uncle'), self = named('self');
  assert(u >= 3, `叔父が${u}本しか載っていない。読んでいて覚える名前にならない`);
  assert(self === 1, `主人公が${self}本に載っている。名前が残るのは1本だけにすること`);
  assert(u > self, `叔父${u}本 ≦ 主人公${self}本 で逆転している`);

  // 主人公側の残りは無名のまま置く（真エンドで初めて結びつく）
  const anon = sw.titles.filter(t => t.lore === 'self' && !t.details.includes(sw.lore.self.surname));
  assert(anon.length >= 3, `無名の痕跡が${anon.length}本しかない`);
  return `叔父${u}本 / 主人公${self}本（＋無名の痕跡${anon.length}本）`;
});
check('開店の一言が屋号を出し、年齢に触れない', () => {
  const st = E.createGame({ seed: 1 });
  const first = st.log[0].text;
  assert(first.includes(sw.lore.shop), '屋号が出ていない');
  assert(!/歳|定年|退職/.test(first), '年齢の手がかりを出してしまっている');
  return first.slice(0, 34) + '…';
});

// ---------------- 3. カタログ ----------------
section('カタログ生成');
check('カタログ総数ぶんが区分どおりに揃う', () => {
  const st = E.createGame({ seed: 1 });
  const total = E.BALANCE.catalogSize;
  assert(st.catalog.length === total, `カタログが ${st.catalog.length} 本（期待 ${total}）`);

  // catalog.js と同じ按分（tiers[k].count の比率を総数に合わせる）
  const keys = Object.keys(E.BALANCE.tiers);
  const declared = keys.reduce((s, k) => s + E.BALANCE.tiers[k].count, 0);
  const want = {};
  let assigned = 0;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) want[k] = total - assigned;
    else { want[k] = Math.round(E.BALANCE.tiers[k].count / declared * total); assigned += want[k]; }
  });

  const by = {};
  for (const t of st.catalog) by[t.tier] = (by[t.tier] || 0) + 1;
  for (const k of keys) {
    assert(by[k] === want[k], `${k} が ${by[k]} 本（期待 ${want[k]}）`);
  }
  return `${total}本 ` + keys.map(k => `${k}${by[k]}`).join(' ');
});
check('カタログは seed によらず同じ', () => {
  const a = E.createGame({ seed: 1 }).catalog.map(t => t.name).join('|');
  const b = E.createGame({ seed: 999 }).catalog.map(t => t.name).join('|');
  assert(a === b, 'seed でカタログが変わっている');
});

// ---------------- 4. 通し実行と不変条件 ----------------
section('通し実行');
const P = require(path.join(root, 'src/policy.js'));

function playChecked(opts) {
  const st = E.createGame(opts);
  let guard = 0;
  const violations = [];
  while (!st.ended && guard++ < 500) {
    P.playTurn(st);
    if (st.inv.length > st.cfg.shelfSlots) violations.push(`在庫${st.inv.length} > 棚枠${st.cfg.shelfSlots}`);
    if (E.displayed(st).length > st.cfg.displaySlots) {
      violations.push(`陳列${E.displayed(st).length} > 陳列枠${st.cfg.displaySlots}`);
    }
    if (st.cash < 0) violations.push(`残高が負 ${st.cash}`);
    if (E.ownedIds(st).size > st.registered.size) violations.push('所持数が登録数を超えた');
    if (st.reputation < 0 || st.reputation > 100) violations.push(`評判 ${st.reputation}`);
    if (violations.length) break;
  }
  assert(guard < 500, 'ターンが終わらない（無限ループ）');
  assert(!violations.length, violations[0]);
  return st;
}

check('50週を10シード完走できる', () => {
  const ends = {};
  for (let i = 0; i < 10; i++) {
    const st = playChecked({ seed: 200 + i });
    assert(st.ended, '終了していない');
    ends[st.ending] = (ends[st.ending] || 0) + 1;
  }
  return Object.entries(ends).map(([k, v]) => `${k}:${v}`).join(' ');
});
check('αテスト版（10週）が完走できる', () => {
  const st = playChecked({ seed: 42, balance: { totalWeeks: 10 } });
  assert(st.ending === 'demo' || st.ending === 'bad', `ending=${st.ending}`);
  return `${st.week - 1}週 / ending=${st.ending}`;
});
check('全ソフトが図鑑に載る状態でも破綻しない', () => {
  const st = E.createGame({ seed: 7 });
  for (const t of st.catalog) st.registered.add(t.id);
  P.playAll(st);
  assert(st.ended, '終了していない');
});

check('skill を持つイベントには skillKnown がある', () => {
  let n = 0;
  for (const r of rg.regulars) for (const e of r.events) {
    if (!e.skill) continue;
    n++;
    assert(e.skillKnown && e.skillKnown.text && e.skillKnown.amount > 0,
      `${r.name}: ${e.skill} に skillKnown が無い`);
  }
  assert(n === Object.keys(E.BALANCE.skills).length, `${n}件（交渉術の数と合わない）`);
  return `${n}件`;
});
check('習得済みなら教え直さず現金になる', () => {
  const ev = E.REGULARS.find(r => r.id === 'omachi').events.find(e => e.skill === 'haggle');
  const st = E.createGame({ seed: 5 });
  st.skills.haggle = true;
  const before = st.cash;
  st.phase = 'shop'; st.queue = [];
  st.current = { type: 'event', event: ev, regular: { id: 'omachi', name: '大町', title: 'x', visits: 7 } };
  E.answer(st, false);
  assert(st.cash - before === ev.skillKnown.amount, `${st.cash - before}円`);
  const line = st.log.filter(l => l.kind === 'skill').pop();
  assert(line && !/教わった/.test(line.text), '教え直しのログが出ている');
  return `${ev.skillKnown.amount.toLocaleString()}円`;
});
check('判断が要る客は会話スキップの対象外', () => {
  const yes = [{ type: 'browser' }, { type: 'event', event: { type: 'talk' } },
               { type: 'event', event: { type: 'giftUltra' } }];
  const no  = [{ type: 'buyer' }, { type: 'seller' },
               { type: 'event', event: { type: 'offer' } }];
  for (const c of yes) assert(E.skippable(c), `${c.type} が飛ばせない`);
  for (const c of no) assert(!E.skippable(c), `${c.type} を飛ばしてしまう`);
});

// ---------------- 5. 周回引き継ぎ ----------------
section('周回引き継ぎ');
check('図鑑と交渉術が次の周に残る', () => {
  const a = E.createGame({ seed: 11 });
  P.playAll(a);
  const carried = E.carryFrom(a);
  const b = E.createGame({ seed: 12, previous: carried });
  for (const id of carried.registered) assert(b.registered.has(id), '図鑑が引き継がれていない');
  for (const id of carried.skills) assert(b.skills[id], `スキル ${id} が引き継がれていない`);
  assert(b.cash === E.BALANCE.startCash, '資金が引き継がれてしまっている');
  assert(b.inv.length === E.BALANCE.startInventory, '在庫が引き継がれてしまっている');
  return `図鑑${carried.registered.length}本 / スキル${carried.skills.length}個`;
});

// ---------------- 6. スキルと設備の効果 ----------------
section('スキルと設備');
check('スキルが価格に効く', () => {
  const st = E.createGame({ seed: 3 });
  const t = st.catalog.find(x => x.tier === 'rare');
  const before = E.orderCost(st, t);
  st.skills.connections = true;
  const after = E.orderCost(st, t);
  assert(after < before, `取り寄せ ${before} → ${after}`);
  return `取り寄せ ${before.toLocaleString()} → ${after.toLocaleString()}`;
});
check('設備が枠を増やす', () => {
  const st = E.createGame({ seed: 3, balance: { unlock: Object.assign({}, E.BALANCE.unlock, { expand: 1 }) } });
  st.cash = 1000000;
  while (st.phase === 'shop' && st.current) E.answer(st, false);
  const before = st.cfg.shelfSlots;
  const r = E.doAction(st, 'upgrade', { id: 'warehouse' });
  assert(r.ok, `購入に失敗 reason=${r.reason}`);
  assert(st.cfg.shelfSlots > before, `棚枠 ${before} → ${st.cfg.shelfSlots}`);
  return `棚枠 ${before} → ${st.cfg.shelfSlots}`;
});

// ---------------- 7. 配布物 ----------------
section('配布物');
check('dist/prototype.html が src より新しい', () => {
  const dist = fs.statSync(path.join(root, 'dist/prototype.html')).mtimeMs;
  const newest = ['src', 'build', 'data'].flatMap(d =>
    fs.readdirSync(path.join(root, d)).map(f => fs.statSync(path.join(root, d, f)).mtimeMs));
  const max = Math.max(...newest);
  assert(dist >= max, 'ビルドが古い（node build/gen-data.js && node build/build.js を実行）');
});
check('dist/prototype.html が自己完結している', () => {
  const html = fs.readFileSync(path.join(root, 'dist/prototype.html'), 'utf8');
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
  const bad = ext.filter(u => !/^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(u));
  assert(!bad.length, '外部参照: ' + bad.join(', '));
  assert(html.includes('<title>'), 'title が無い');
  return `${(html.length / 1024).toFixed(0)}KB / 外部はGoogle Fontsのみ`;
});

// ---------------- 結果 ----------------
console.log('\n' + '─'.repeat(50));
console.log(`${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed ? 1 : 0);
