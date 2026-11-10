# Хостинг: требования и развёртывание

## Системные требования

Одно приложение на Node.js, база — один файл SQLite, внешних сервисов не нужно. Сайт сам никуда не ходит (форум не опрашивается), нужен только входящий HTTP(S).

| Параметр | Минимум | Рекомендуется |
|---|---|---|
| vCPU | 1 | 1–2 |
| ОЗУ | 512 МБ (с Docker впритык, лучше без него) | **1 ГБ** |
| Диск | 10 ГБ SSD | **20 ГБ SSD/NVMe** (основное место занимают скриншоты) |
| ОС | Linux x86-64 или ARM64 | Ubuntu 24.04 LTS / Debian 12 |
| ПО | Node.js **22.13+** (нужен встроенный `node:sqlite`) | Docker 24+ или Node 22 LTS |
| Сеть | входящие 80/443 | + домен для HTTPS |
| Прочее | компилятор **не нужен** (нет нативных модулей), root-доступ по SSH | |

Это не прикидка, а замеры на этом приложении (Node 22, 4 ядра):

| Показатель | Результат |
|---|---|
| Память в простое | ~85–95 МБ |
| Память при обычной работе и выгрузке xlsx | пик ~140 МБ на 5 000 постов, ~190 МБ на 50 000 (при лимите кучи 192 МБ) |
| Зависимости в продакшене | 79 МБ (`node_modules`) + ~0,4 МБ кода |
| Ответ «Обзора» | 53 мс на 5 000 постов, 360 мс на 50 000, 2,3 с на 250 000 |
| Выгрузка xlsx | 0,2 с на 5 000 постов, 1,3 с на 50 000 |
| Размер базы | ~1 МБ на 5 000 постов, ~8 МБ на 50 000 |

Что это значит на практике:
- **Один человек вносит несколько десятков постов в неделю**, поэтому база за годы останется в единицах мегабайт, а все страницы будут отвечать за доли секунды. Статистика форума пересчитывается на каждом запросе, так что комфортный потолок — порядка 50 000 постов; дальше потребуется кэш (при вашем темпе ввода это не раньше чем через много лет).
- **Диск растёт от скриншотов.** При 100 файлах в месяц по 0,3–1,5 МБ это 30–150 МБ в месяц, то есть 1–2 ГБ в год. 20 ГБ хватит с большим запасом.
- **Нагрузка:** одновременно работает редакция из нескольких человек, 1 vCPU справляется без проблем.

Тарифы вида «1 vCPU / 1 ГБ RAM / 20+ ГБ SSD» у любого VPS-провайдера подходят. Выбирайте ближе к вашей аудитории, если важна скорость; для работы редакции расположение не критично.

## Вариант 1. Docker (рекомендуется)

> Эти команды я не смог проверить в своей среде (там не запущен демон Docker), но сам `Dockerfile` стандартный. Проверьте на сервере и, если что-то не взлетит, пришлите вывод ошибки.

```bash
# на сервере (Ubuntu 24.04), под root или через sudo
curl -fsSL https://get.docker.com | sh
git clone <адрес репозитория> delgadoph-stats && cd delgadoph-stats
docker build -t delgadoph-stats .
docker run -d --name stats --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v stats-data:/data -e ADMIN_NICK=Brianna_Delgado -e SECURE_COOKIE=1 delgadoph-stats
```

Приложение слушает 127.0.0.1:3000, наружу его выставляет обратный прокси с HTTPS. Самый простой — Caddy (сам получает сертификат Let's Encrypt):

```bash
apt install -y caddy
cat > /etc/caddy/Caddyfile <<'CADDY'
stats.example.com {
    reverse_proxy 127.0.0.1:3000
    request_body { max_size 60MB }
}
CADDY
systemctl reload caddy
```
Домен должен указывать A-записью на IP сервера. Лимит `max_size` должен быть не меньше `MAX_UPLOAD_MB` (по умолчанию 50).

Обновление версии: `git pull && docker build -t delgadoph-stats . && docker rm -f stats && docker run …` (та же команда запуска; данные лежат в томе `stats-data` и сохраняются).

## Вариант 2. Без Docker (меньше памяти)

```bash
# Node 22 LTS, например через NodeSource или nvm
git clone <адрес репозитория> delgadoph-stats && cd delgadoph-stats
npm ci --omit=dev
```
Сервис systemd `/etc/systemd/system/delgadoph-stats.service`:
```ini
[Unit]
Description=Delgado PH Stats
After=network.target

[Service]
WorkingDirectory=/opt/delgadoph-stats
Environment=NODE_ENV=production PORT=3000 HOST=127.0.0.1 DATA_DIR=/var/lib/delgadoph-stats ADMIN_NICK=Brianna_Delgado SECURE_COOKIE=1
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```
Дальше — тот же Caddy, что выше.

## Резервные копии

Всё состояние — папка `DATA_DIR` (в Docker это `/data`): база `stats.sqlite` и файлы в `storage/`.

```bash
docker exec stats npm run backup     # или: npm run backup  (без Docker)
```
Команда делает согласованную копию базы без остановки сайта в `DATA_DIR/backups/` и хранит 14 последних (`BACKUP_KEEP` меняет число). Скриншоты в `storage/` нужно копировать отдельно. Поставьте на cron раз в сутки и выгружайте `backups/` + `storage/` за пределы сервера (rsync, `rclone`, снимок диска у провайдера).

## Безопасность

- Вход без пароля: любой, кто знает ник из списка, зайдёт под ним. Не публикуйте адрес открыто; надёжнее поставить HTTP-авторизацию в Caddy (`basicauth`) или закрыть сайт VPN.
- Держите `SECURE_COOKIE=1` только за HTTPS, иначе вход не сработает.
- Файрвол: открыть 22, 80, 443; порт 3000 наружу не открывать.
