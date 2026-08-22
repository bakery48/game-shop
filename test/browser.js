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
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
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
