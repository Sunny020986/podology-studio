# Робочий посібник: оновлення, відкат, аварії

Усі команди — від root усередині контейнера 105 «Podology-studio» (Proxmox). Код: `/opt/podology-studio/app`, служба: `podology`, база: `data/studio.db`.

## 1. Чекліст оновлення

### До оновлення (на гілці, до злиття в `main`)
- [ ] `node --check` для кожного зміненого `.js`.
- [ ] Перевірка на копії бази (копіювати разом із `studio.db-wal` і `studio.db-shm`).
- [ ] Зміни інтерфейсу: телефон 360 і 390 px та комп'ютер 1280 px, усі вкладки адмінки (скіл `mobile-ui-check`).
- [ ] Зміни прав: без токена — 401, майстер на чужі дані — 403.
- [ ] Нова колонка чи таблиця — лише через `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`, нічого не видаляти.
- [ ] Записати хеш поточної версії для відкату: `cd /opt/podology-studio/app && git rev-parse --short HEAD`.

### Оновлення
```bash
su -s /bin/bash podology -c "cd /opt/podology-studio/app && node scripts/backup.js && git pull && npm install"
systemctl restart podology
```

### Після оновлення (5 хвилин)
- [ ] `systemctl status podology` — `active (running)`, без перезапусків.
- [ ] `journalctl -u podology -n 50 --no-pager` — без `Error`.
- [ ] Головна сторінка відкривається, список послуг є.
- [ ] Вільний час на найближчу робочу дату показується.
- [ ] Вхід в адмінку працює, вкладка «Записи» відкривається.
- [ ] Чат: повідомлення з сайту видно в адмінці.

### Коли відкочувати одразу
- Служба не стартує або перезапускається по колу.
- Сайт не показує послуги або вільний час.
- Запис з сайту не створюється.
- Не входить в адмінку суперадмін або майстер.

## 2. Відкат

Код (база лишається як є — міграції лише додають колонки, старий код їх ігнорує):
```bash
cd /opt/podology-studio/app
su -s /bin/bash podology -c "cd /opt/podology-studio/app && git log --oneline -5"
su -s /bin/bash podology -c "cd /opt/podology-studio/app && git checkout <хеш_попередньої_версії>"
systemctl restart podology
```
Повернутися на свіжий код потім: `git checkout main && git pull`.

База (лише якщо зіпсовано дані — втратяться записи після копії):
```bash
systemctl stop podology
ls -lt backups/ | head     # або шлях з BACKUP_DIR
cp data/studio.db data/studio.db.broken
cp backups/<файл>.db data/studio.db
rm -f data/studio.db-wal data/studio.db-shm
chown podology:podology data/studio.db
systemctl start podology
```

## 3. Якщо щось зламалось

### Рівні
| Рівень | Що сталося | Реакція |
|---|---|---|
| 1 | Сайт не відкривається або запис не працює | Одразу |
| 2 | Не працює адмінка, чат або Telegram-нагадування | Протягом години |
| 3 | Одна вкладка чи функція працює неправильно | Того ж дня |
| 4 | Вигляд, тексти | Коли зручно |

### Діагностика по кроках
1. Служба жива? `systemctl status podology`
2. Що в журналі? `journalctl -u podology -n 100 --no-pager`
3. Порт слухає? `ss -ltnp | grep 3000`
4. Відповідає? `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/services` — має бути `200`.
5. Місце на диску? `df -h /opt` (SQLite не пише при повному диску).
6. База ціла? `su -s /bin/bash podology -c "cd /opt/podology-studio/app && node -e \"const D=require('better-sqlite3');console.log(new D('data/studio.db').pragma('integrity_check'))\""` — має бути `ok`.
7. Збій почався після оновлення → відкат коду (розділ 2).

### Типові причини
| Ознака | Причина | Що робити |
|---|---|---|
| `dubious ownership` при `git pull` | команда від root | запускати через `su ... podology` |
| `SQLITE_BUSY` / `database is locked` | два процеси з однією базою | `ps aux \| grep node`, лишити один |
| `EADDRINUSE :3000` | старий процес не завершився | `systemctl restart podology` |
| Не приходять повідомлення в Telegram | токен бота або мережа | вкладка «Кабінет», журнал служби |
| Після `npm install` помилка `better-sqlite3` | інша версія Node | `npm rebuild better-sqlite3` |

### Після аварії — короткий розбір (без пошуку винних)
Записати в `docs/incidents/РРРР-ММ-ДД.md`: що бачили клієнти; скільки тривало; хронологія; причина (5 разів «чому?»); що спрацювало добре; що змінити, щоб не повторилось (дія, хто, до коли).
