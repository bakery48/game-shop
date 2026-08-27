#!/usr/bin/env node
'use strict';
/**
 * ブラウザでの起動確認。playwright が入っているときだけ動く。
 *   npm i -D playwright && node test/browser.js
 */
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.log('playwright が無いのでスキップします（npm i -D playwright）');
  process.exit(0);
}
const file = 'file://' + path.join(__dirname, '..', 'dist', 'prototype.html');

(async () => {
  let failed = 0;
  const check = (name, ok, note) => {
    if (ok) console.log('  ok   ' + name + (note ? '  — ' + note : ''));
    else { failed++; console.log('  NG   ' + name + (note ? '  — ' + note : '')); }
  };
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  } catch (e) {
    // ブラウザ本体が落ちていない環境ではスキップする（npx playwright install chromium）
    console.log('chromium を起動できないのでスキップします: ' + e.message.split('\n')[0]);
    console.log('  npx playwright install chromium か、CHROMIUM_PATH に実行ファイルを指定してください');
    process.exit(0);
  }
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1400, height: 1200 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/net::/.test(m.text())) errs.push(m.text()); });
    await page.goto(file);
    await page.waitForTimeout(600);

    const booted = await page.evaluate(() => typeof st === 'object' && st !== null && st.catalog.length > 0);
    check(`${scheme}: 起動する`, booted);
    check(`${scheme}: JSエラーが無い`, errs.length === 0, errs[0]);
    check(`${scheme}: 図鑑が描画される`, (await page.locator('#dex tr').count()) > 100);
    check(`${scheme}: 常連が描画される`, (await page.locator('#regulars tr').count()) === 9);
    check(`${scheme}: 常連表に呼び方の列がある`,
      (await page.locator('#regulars th').allTextContents()).includes('呼び方'));
    check(`${scheme}: 横スクロールしない`,
      !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));

    // 取り寄せを手動でまとめて頼めるか（自動プレイと同じ本数を人間も使えること）
    const order = await page.evaluate(() => {
      st.week = 30;
      st.cash = 3000000;
      st.catalog.slice(0, 60).forEach(t => st.registered.add(t.id));
      while (st.phase === 'shop' && st.current) Engine.answer(st, false);
      window.renderUI();
      const sel = [...document.querySelectorAll('select')].find(x => x.multiple);
      if (!sel || sel.options.length < 3) return { ok: false, why: '取り寄せの複数選択が無い' };
      for (let i = 0; i < 3; i++) sel.options[i].selected = true;
      const card = sel.closest('.card');
      const before = st.totals.orderCount;
      [...card.querySelectorAll('button')].find(b => b.textContent.includes('頼む')).click();
      return { ok: true, got: st.totals.orderCount - before };
    });
    check(`${scheme}: 取り寄せを1手番で3本頼める`,
      order.ok && order.got === 3, order.why || `${order.got}本`);

    // ソフトの詳細に当時の出荷本数が出る
    const sales = await page.evaluate(() => {
      const t = st.catalog.find(x => x.authored);
      st.registered.add(t.id);
      window.renderUI();
      // 図鑑の行をクリックすると詳細が出る、という導線ごと確かめる
      const row = [...document.querySelectorAll('#dex tr')]
        .find(r => r.textContent.includes(t.name));
      if (!row) return { why: '図鑑に行が無い' };
      row.click();
      const txt = document.getElementById('detail').textContent;
      return { has: txt.includes('当時の出荷'),
               num: txt.includes(t.sales.toLocaleString()), sales: t.sales };
    });
    check(`${scheme}: ソフトの詳細に出荷本数が出る`,
      sales.has && sales.num, JSON.stringify(sales));

    // 交渉術の入り切り: ボタンで1つずつ切り替えられる
    const sk = await page.evaluate(() => {
      st.skills = {}; st.skillOff = {}; window.renderUI();
      const row = () => document.getElementById('skillRow');
      const n = row().querySelectorAll('button').length;
      const b = row().querySelectorAll('button')[0];
      if (!b) return { why: '交渉術のボタンが無い' };
      b.click();
      const onNow = Object.keys(st.skills).length === 1;
      row().querySelectorAll('button')[0].click();
      const offNow = Object.keys(st.skillOff).length === 1;
      return { n, onNow, offNow, all: Object.keys(Engine.BALANCE.skills).length };
    });
    check(`${scheme}: 交渉術を1つずつ入り切りできる`,
      sk.n === sk.all && sk.onNow && sk.offNow, sk.why || JSON.stringify(sk));

    // 常連との記憶: 完走した相手に印が付く
    const memo = await page.evaluate(() => {
      const r = Engine.REGULARS[0];
      st.memories = {}; st.memoryOff = {}; window.renderUI();
      const tb = () => document.getElementById('regulars');
      const before = tb().textContent.includes('会いやすい');
      st.memories[r.id] = true; window.renderUI();
      const after = tb().textContent.includes('会いやすい');
      // 押すと切れる／もう一度押すと戻る
      const cell = [...tb().rows].find(x => x.cells[0].textContent.includes(r.name));
      const b = cell && cell.querySelector('button');
      if (!b) return { before, after, why: '切替ボタンが無い' };
      b.click();
      const offNow = !!st.memoryOff[r.id] && tb().textContent.includes('切っている');
      [...tb().rows].find(x => x.cells[0].textContent.includes(r.name))
        .querySelector('button').click();
      const backOn = !st.memoryOff[r.id];
      return { before, after, offNow, backOn };
    });
    check(`${scheme}: 記憶の印が付き、押すと切り替わる`,
      memo.after && !memo.before && memo.offNow && memo.backOn,
      memo.why || JSON.stringify(memo));

    // SNS宣伝: カードから投稿でき、回数と効きが画面に出る
    const promo = await page.evaluate(() => {
      st.promo = 0; st.promoOpen = true;
      while (st.phase === 'shop' && st.current) Engine.answer(st, false);
      if (st.phase !== 'action') return { ok: false, why: `行動フェイズに入れない（${st.phase}）` };
      window.renderUI();
      const card = [...document.querySelectorAll('.card')]
        .find(c => c.textContent.includes('SNSで宣伝する'));
      if (!card) return { ok: false, why: '宣伝のカードが無い' };
      const btn = [...card.querySelectorAll('button')].find(b => b.textContent.includes('投稿'));
      if (!btn) return { ok: false, why: '投稿ボタンが無い' };
      const rep = st.reputation;
      btn.click();
      const stat = document.getElementById('stat').textContent;
      return { ok: true, n: st.promo, up: st.reputation > rep, shown: stat.includes('宣伝') };
    });
    check(`${scheme}: SNS宣伝が投稿できて画面に出る`,
      promo.ok && promo.n === 1 && promo.up && promo.shown,
      promo.why || JSON.stringify(promo));

    // 会話スキップ: 判断の要らない客だけ自動で進み、判断が要る客は残る
    const skip = await page.evaluate(() => {
      const box = document.getElementById('skipTalk');
      const setup = () => {
        st.phase = 'shop'; st.queue = [{ type: 'browser', line: 'ダミー2' }];
        st.current = { type: 'browser', line: 'ダミー1' };
      };
      box.checked = false; box.onchange();
      setup(); window.renderUI();
      const off = document.getElementById('phase').textContent.includes('ダミー1');
      box.checked = true; box.onchange();
      setup(); window.renderUI();
      const on = !document.getElementById('phase').textContent.includes('ダミー1') && st.phase === 'action';
      // 取引の判断は飛ばさない
      st.phase = 'shop'; st.queue = [];
      st.current = { type: 'seller', titleId: st.catalog[0].id, ask: 100 };
      window.renderUI();
      const kept = st.current !== null;
      box.checked = false; box.onchange();
      return { off, on, kept };
    });
    check(`${scheme}: 会話スキップが効く`, skip.off && skip.on && skip.kept, JSON.stringify(skip));

    // 交渉術を習得済みなら別セリフ＋現金になる
    const alt = await page.evaluate(() => {
      st.skills.haggle = true;
      const ev = Engine.REGULARS.find(r => r.id === 'omachi').events.find(e => e.skill === 'haggle');
      const before = st.cash;
      st.phase = 'shop'; st.queue = [];
      st.current = { type: 'event', event: ev,
        regular: { id: 'omachi', name: '大町', title: 'ライバル店主', visits: 7 } };
      window.renderUI();
      const shown = document.getElementById('phase').textContent.includes('習得済み');
      [...document.querySelectorAll('#phase button')].find(b => b.textContent.includes('断る')).click();
      return { shown, gained: st.cash - before };
    });
    check(`${scheme}: 習得済みの交渉術は別セリフ＋現金`,
      alt.shown && alt.gained === 30000, `${alt.gained}円`);

    // 在庫表に状態列が出て、持ち込みカードにも状態が出るか
    const cond = await page.evaluate(() => {
      const head = [...document.querySelectorAll('#inv th')].map(x => x.textContent);
      st.phase = 'shop'; st.queue = [];
      const t = st.catalog.find(x => x.tier === 'mid');
      st.current = { type: 'seller', titleId: t.id, ask: 5000, cond: 2 };
      window.renderUI();
      const card = document.getElementById('phase').textContent;
      return { col: head.includes('状態'), seller: card.includes('美品') };
    });
    check(`${scheme}: ソフトの状態が表示される`, cond.col && cond.seller, JSON.stringify(cond));

    // 種明かしが読めて、閉じると消えるか
    const reveal = await page.evaluate(() => {
      st.catalog.forEach(t => st.registered.add(t.id));
      Engine.endTurn(st); window.renderUI();
      const box = document.getElementById('phase');
      const shown = box.textContent.includes('辻邦彦') && box.textContent.includes('クロスロード');
      const leaked = box.textContent.includes('谷口誠');   // 二段目はまだ出てはいけない
      const b = [...box.querySelectorAll('button')].find(x => x.textContent === '閉じる');
      if (b) b.click();
      return { shown, leaked, closed: !document.getElementById('phase').textContent.includes('辻邦彦') };
    });
    check(`${scheme}: 一段目の種明かしが読めて閉じられる`,
      reveal.shown && !reveal.leaked && reveal.closed, JSON.stringify(reveal));

    // 50週を自動で回して落ちないか
    await page.evaluate(() => { Policy.playAll(st); window.renderUI(); });
    check(`${scheme}: 最後まで自動で回せる`, await page.evaluate(() => st.ended), errs[0]);
    check(`${scheme}: 通しでもJSエラーが無い`, errs.length === 0, errs[0]);
    await page.close();
  }
  // ── スマホ幅 ───────────────────────────────────────────
  // 横に溢れていないか。1400px幅では気づけないので専用に見る
  for (const [label, w, h] of [['スマホ', 390, 844], ['細い端末', 360, 780]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(file);
    await page.waitForTimeout(500);

    const over = () => page.evaluate(() => {
      const doc = document.documentElement.scrollWidth, win = window.innerWidth;
      // 自分の枠内で横スクロールする表（.scroll の中）は溢れていない扱い
      const loose = [...document.querySelectorAll('table, pre, .card, #stat, .row')]
        .filter(e => !e.closest('.scroll'))
        .filter(e => e.scrollWidth > win + 2)
        .slice(0, 4).map(e => `${e.tagName}${e.id ? '#' + e.id : ''}=${e.scrollWidth}`);
      return { doc, win, loose };
    });

    const start = await over();
    check(`${label}: 開幕が横に溢れない`,
      start.doc <= start.win + 1 && !start.loose.length, JSON.stringify(start));

    // 行動フェイズは要素がいちばん多い
    await page.evaluate(() => {
      st.week = 30; st.cash = 900000; st.promoOpen = true;
      st.catalog.slice(0, 80).forEach(t => st.registered.add(t.id));
      while (st.phase === 'shop' && st.current) Engine.answer(st, false);
      window.renderUI();
    });
    const acting = await over();
    check(`${label}: 行動フェイズが横に溢れない`,
      acting.doc <= acting.win + 1 && !acting.loose.length, JSON.stringify(acting));

    // 数字が「29 / 200 (1…」のように切れていないか
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll('#stat b')]
        .filter(e => e.scrollWidth > e.clientWidth + 1)
        .map(e => e.textContent));
    check(`${label}: ステータスの数字が切れない`, !clipped.length, clipped.join(' / '));
    check(`${label}: JSエラーが無い`, errs.length === 0, errs[0]);
    await page.close();
  }

  await browser.close();
  console.log('\n' + (failed ? `${failed} 件失敗` : 'ブラウザ確認: 全て成功'));
  process.exit(failed ? 1 : 0);
})();
