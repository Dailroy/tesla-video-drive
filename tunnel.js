// Публичный туннель: сайт становится доступен по https-адресу с любой сети.
// Локальный сервер должен быть уже запущен (start.bat). Запуск: expose.bat
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function main() {
  let health = null;
  try {
    const r = await fetch('http://127.0.0.1:8742/api/health');
    health = await r.json();
    if (!health.ok) throw new Error('bad');
  } catch (e) {
    console.error('Сервер не запущен. Сначала запусти start.bat, потом expose.bat.');
    process.exit(1);
  }

  const dep = path.join(__dirname, 'node_modules', '@pinggy', 'pinggy');
  if (!fs.existsSync(dep)) {
    console.error('Не найден @pinggy/pinggy — выполни: npm install');
    process.exit(1);
  }
  const { pinggy } = require('@pinggy/pinggy');
  const tunnel = await pinggy.forward({ forwarding: 'localhost:' + (health.port || 8742) });
  const urls = await tunnel.urls();
  const arr = Array.isArray(urls) ? urls : [urls];
  const url = arr.find((u) => /^https:/i.test(u)) || arr[0];

  const line = '='.repeat(68);
  console.log('');
  console.log(line);
  console.log('  ПУБЛИЧНЫЙ АДРЕС: ' + url);
  console.log(line);
  console.log('  Открывай с любой сети: с телефона, с Теслы, из любого города.');
  console.log('  Первый заход в браузере покажет страницу Pinggy — нажми "Enter site",');
  console.log('  потом сайт откроется всегда (браузер запомнит cookie).');
  console.log('  Бесплатный туннель живёт 60 минут — после этого запусти expose.bat снова.');
  console.log('  Остановить: Ctrl+C или закрыть окно.');
  console.log('');
  try {
    execSync('cmd /c echo ' + url + '| clip', { stdio: 'ignore' });
    console.log('  Адрес скопирован в буфер обмена.');
  } catch (e) {}

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error('Ошибка туннеля:', (e && e.message) || e);
  process.exit(1);
});
