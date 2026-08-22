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
    check(`${scheme}: 常連が描画される`, (await page.locator('#regulars tr').count()) === 8);
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

    // 50週を自動で回して落ちないか
    await page.evaluate(() => { Policy.playAll(st); window.renderUI(); });
    check(`${scheme}: 最後まで自動で回せる`, await page.evaluate(() => st.ended), errs[0]);
    check(`${scheme}: 通しでもJSエラーが無い`, errs.length === 0, errs[0]);
    await page.close();
  }
  await browser.close();
  console.log('\n' + (failed ? `${failed} 件失敗` : 'ブラウザ確認: 全て成功'));
  process.exit(failed ? 1 : 0);
})();
