// Щоденна резервна копія бази.
// 1) Робить цілісну копію SQLite (навіть поки сайт працює) у BACKUP_DIR.
// 2) Видаляє локальні копії, старші за BACKUP_KEEP_DAYS днів.
// 3) Якщо задано BACKUP_REMOTE (наприклад root@192.168.3.10:/var/backups/podology/),
//    копіює свіжий файл на іншу машину через scp. Потрібен SSH-ключ без пароля.
//
// Запуск вручну: node scripts/backup.js
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'studio.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 30;
const REMOTE = (process.env.BACKUP_REMOTE || '').trim();

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`Базу не знайдено: ${DB_PATH}`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-'); // 2026-11-18_03-15
  const dest = path.join(BACKUP_DIR, `studio-${stamp}.db`);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }

  // Копія стає одним самодостатнім файлом (без супутніх -wal/-shm) і перевіряється на цілісність
  const check = new Database(dest);
  check.pragma('journal_mode = DELETE');
  const ok = check.pragma('integrity_check', { simple: true });
  const appts = check.prepare('SELECT COUNT(*) AS n FROM appointments').get().n;
  check.close();
  if (ok !== 'ok') throw new Error(`Копія пошкоджена: ${ok}`);
  console.log(`Копію збережено: ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} КБ, записів: ${appts})`);

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const full = path.join(BACKUP_DIR, f);
    if (/^studio-.*\.db$/.test(f) && fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      console.log(`Видалено стару копію: ${f}`);
    }
  }

  if (REMOTE) {
    try {
      execFileSync('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', dest, REMOTE], { stdio: 'inherit' });
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('Немає програми scp. Встановіть: apt install -y openssh-client');
      throw new Error(`Не вдалося скопіювати на ${REMOTE}. Перевірте адресу і SSH-ключ (ssh ${REMOTE.split(':')[0]} має пускати без пароля)`);
    }
    console.log(`Скопійовано на ${REMOTE}`);
  } else {
    console.log('BACKUP_REMOTE не задано: копія лише в цьому контейнері');
  }
}

main().catch((e) => {
  console.error('Резервна копія не вдалася:', e.message);
  process.exit(1);
});
