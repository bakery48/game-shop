#!/usr/bin/env node
'use strict';
/**
 * 台本机（dist/text-editor.html）の確認。playwright があるときだけ動く。
 *   node build/gen-editor.js && node test/editor.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('playwright が無いのでスキップします'); process.exit(0); }

const file = path.join(__dirname, '..', 'dist', 'text-editor.html');
if (!fs.existsSync(file)) {
  console.log('dist/text-editor.html がありません（node build/gen-editor.js を実行）');
  process.exit(1);
}
// 公開時と同じ骨組みで包んでから開く
const tmp = path.join(os.tmpdir(), 'script-desk-check.html');
fs.writeFileSync(tmp, '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '</head><body>' + fs.readFileSync(file, 'utf8') + '</body></html>');

const out = [];
const check = (name, ok, note) => out.push((ok ? '  ok   ' : '  NG   ') + name + (note ? '  — ' + note : ''));
/** 「元に戻す」は全行に隠して置いてあるので、見えている行のものを押す */
const UNDO = "[...document.querySelectorAll('#main .f.edited button')].find(x => x.textContent === '元に戻す')";

(async () => {
  let browser;
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); }
  catch (e) { console.log('chromium を起動できないのでスキップします'); process.exit(0); }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('file://' + tmp);
  await page.waitForTimeout(600);

  // 開いて何も触らなければ、書き出しは data/*.json と1文字も違わないこと。
  // ここがずれると、貼り戻したときに関係のない差分が出る
  const fresh = await page.evaluate(() => ({
    sw: JSON.stringify(window.ScriptDesk.work.software, null, 2) + '\n',
    rg: JSON.stringify(window.ScriptDesk.work.regulars, null, 2) + '\n',
  }));
  const orig = f => fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8');
  check('触らなければ書き出しが元のファイルと一致する',
    fresh.sw === orig('software.json') && fresh.rg === orig('regulars.json'),
    `software ${fresh.sw.length} / ${orig('software.json').length} 字`);

  const edit = await page.evaluate(u => {
    const ta = document.querySelectorAll('#main textarea')[2];
    ta.value = ta.value + 'テスト追記';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const dirty = document.getElementById('dirty').textContent;
    eval(u).click();
    return { dirty, back: document.getElementById('dirty').textContent };
  }, UNDO);
  check('編集すると変更件数が出る', /1か所/.test(edit.dirty), edit.dirty);
  check('元に戻せる', edit.back === '変更なし', edit.back);

  // 叙述トリックの約束を、その場で破れないこと
  const flag = await page.evaluate(u => {
    const ta = document.querySelectorAll('#main textarea')[2];
    ta.value = '辻さんの店はよかったね';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const t = document.getElementById('checks').textContent;
    eval(u).click();
    return t;
  }, UNDO);
  check('家名を書くと違反が出る', /違反/.test(flag) && /辻/.test(flag), flag.slice(0, 40));

  const call = await page.evaluate(u => {
    const ta = document.querySelectorAll('#main textarea')[2];
    ta.value = '店長さん、これ売ってよ';        // 黒沢は「あんた」派
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const t = document.getElementById('checks').textContent;
    eval(u).click();
    return t;
  }, UNDO);
  check('呼び方の混在が見つかる', /店長/.test(call) && /違反/.test(call), call.slice(0, 44));

  const soft = await page.evaluate(() => {
    [...document.querySelectorAll('#tabs button')].find(x => x.textContent === 'ソフト').click();
    const all = document.querySelectorAll('#index button').length;
    const q = document.getElementById('q');
    q.value = 'ドラゴン'; q.dispatchEvent(new Event('input', { bubbles: true }));
    const few = document.querySelectorAll('#index button').length;
    q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
    return { all, few };
  });
  check('ソフトが全部並ぶ', soft.all === 151, `${soft.all}本`);
  check('絞り込みが効く', soft.few > 0 && soft.few < 20, `ドラゴン → ${soft.few}本`);

  const sales = await page.evaluate(u => {
    const i = window.ScriptDesk.ORIGINAL.software.titles.findIndex(t => /わずか\d+本/.test(t.details));
    const btns = [...document.querySelectorAll('#index button')];
    if (!btns[i]) return `索引が${btns.length}件 / i=${i}`;
    btns[i].click();
    const ta = [...document.querySelectorAll('#main textarea')].pop();
    ta.value = ta.value.replace(/わずか\d+本/, 'わずか99本');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const t = document.getElementById('checks').textContent;
    eval(u).click();
    return t;
  }, UNDO);
  check('本文と出荷本数の食い違いが出る', /違反/.test(sales) && /99本/.test(sales), sales.slice(0, 44));

  const json = await page.evaluate(() => {
    [...document.querySelectorAll('#tabs button')].find(x => x.textContent === '書き出し').click();
    const tas = [...document.querySelectorAll('#main textarea')];
    try {
      const a = JSON.parse(tas[0].value), b = JSON.parse(tas[1].value);
      return { n: tas.length, titles: a.titles.length, regs: b.regulars.length };
    } catch (e) { return { err: e.message }; }
  });
  check('書き出しが読めるJSONになる', json.titles === 151 && json.regs === 8, JSON.stringify(json));

  // 試したぶんを全部戻したら、変更なしに戻っていること
  const back = await page.evaluate(() => window.ScriptDesk.dirtyCount());
  check('試した編集がすべて元に戻っている', back === 0, `${back}か所が残っている`);

  check('JSエラーが無い', errs.length === 0, errs[0]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check('スマホ幅で横に溢れない', over.doc <= over.win + 1, JSON.stringify(over));

  await browser.close();
  console.log(out.join('\n'));
  const failed = out.filter(l => l.startsWith('  NG')).length;
  console.log('\n' + (failed ? `${failed} 件失敗` : '台本机: 全て成功'));
  process.exit(failed ? 1 : 0);
})();
