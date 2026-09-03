#!/usr/bin/env node
'use strict';
/** data/*.json と src/editor.js を1枚に埋めて dist/text-editor.html を作る（台本机） */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const data = `<script>\nwindow.EditorData = {\n  software: ${read('data/software.json').trim()},\n`
  + `  regulars: ${read('data/regulars.json').trim()}\n};\n</script>`;
const script = f => '<script>\n' + read(f).replace(/<\/script>/gi, '<\\/script>') + '\n</script>';
const app = script('src/textbox.js') + '\n' + script('src/editor.js');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'text-editor.html');
fs.writeFileSync(out, read('build/editor.html') + '\n' + data + '\n' + app + '\n');
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1) + 'KB');
