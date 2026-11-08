// ==UserScript==
// @name         Delgado PH Stats — сборщик с форума
// @namespace    delgadoph-stats
// @version      0.1.0
// @description  Читает темы раздела форума (IPS) в вашем браузере и отправляет посты на сайт статистики
// @match        https://gta-trinity.com/forum/forum/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

// ВНИМАНИЕ: селекторы написаны под стандартную разметку IPS 4.x и ещё не проверены на вашем форуме.
// Если что-то не находится, скрипт покажет это в статусе, а не отправит неполные данные.
(() => {
  'use strict';
  const DELAY_MS = 1200; // пауза между запросами — не нагружаем форум
  const SEL = {
    topicRow: 'li.ipsDataItem[data-rowid], tr.ipsDataItem[data-rowid]',
    topicLink: '.ipsDataItem_title a[href*="/topic/"]',
    topicLocked: '.ipsBadge_locked, [data-ipstooltip][title*="акры"], .ipsType_light .fa-lock',
    post: 'article[id^="elComment_"], article.cPost',
    postAuthor: '.cAuthorPane_author a, .cAuthorPane_author, aside.ipsComment_author h3 a',
    postTime: '.ipsComment_meta time[datetime], time[datetime]',
    pagination: 'ul.ipsPagination[data-pages]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = () => ({ server: (GM_getValue('server', '') || '').replace(/\/+$/, ''), token: GM_getValue('token', '') });

  function configure() {
    const server = prompt('Адрес сайта статистики (например https://stats.example.com):', GM_getValue('server', ''));
    if (server === null) return;
    const token = prompt('Токен из раздела «Управление» на сайте:', GM_getValue('token', ''));
    if (token === null) return;
    GM_setValue('server', server.trim());
    GM_setValue('token', token.trim());
  }
  GM_registerMenuCommand('Настроить адрес и токен', configure);

  async function getDoc(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`${res.status} при загрузке ${url}`);
    const text = await res.text();
    if (/Check your browser|vddosw3data/.test(text) && !/ipsDataItem|elComment_/.test(text)) {
      throw new Error('Форум вернул проверку браузера — обновите страницу и повторите');
    }
    return new DOMParser().parseFromString(text, 'text/html');
  }

  const pagesOf = (doc) => Number(doc.querySelector(SEL.pagination)?.dataset.pages) || 1;
  const baseUrl = (href) => new URL(href, location.href).href.replace(/\/page\/\d+\/?/, '/').replace(/[?#].*$/, '').replace(/\/?$/, '/');
  const topicId = (href) => Number(/\/topic\/(\d+)/.exec(href)?.[1]);

  async function listTopics(setStatus) {
    const first = location.href.replace(/\/page\/\d+\/?/, '/').replace(/[?#].*$/, '');
    const topics = new Map();
    const total = pagesOf(document);
    for (let p = 1; p <= total; p++) {
      const doc = p === 1 ? document : await getDoc(`${first.replace(/\/?$/, '/')}page/${p}/`);
      for (const row of doc.querySelectorAll(SEL.topicRow)) {
        const a = row.querySelector(SEL.topicLink);
        const id = a && topicId(a.href);
        if (id) topics.set(id, { id, title: a.textContent.trim(), url: baseUrl(a.href), locked: !!row.querySelector(SEL.topicLocked) });
      }
      setStatus(`Список тем: страница ${p}/${total}, найдено ${topics.size}`);
      if (p < total) await sleep(DELAY_MS);
    }
    return [...topics.values()];
  }

  function parsePosts(doc) {
    const out = [];
    for (const el of doc.querySelectorAll(SEL.post)) {
      const id = Number(/(\d+)$/.exec(el.id || '')?.[1] || el.dataset.commentid);
      const author = el.querySelector(SEL.postAuthor)?.textContent.trim();
      const at = el.querySelector(SEL.postTime)?.getAttribute('datetime');
      if (!id || !author || !at) throw new Error(`Не удалось разобрать пост (id=${id}, автор=${author}, время=${at}) — нужно поправить селекторы`);
      out.push({ id, author, at });
    }
    return out;
  }

  async function readTopic(t) {
    const first = await getDoc(t.url);
    const pages = pagesOf(first);
    let posts = parsePosts(first);
    const starter = posts.shift(); // первый пост темы не считаем ответом
    for (let p = 2; p <= pages; p++) {
      await sleep(DELAY_MS);
      posts = posts.concat(parsePosts(await getDoc(`${t.url}page/${p}/`)));
    }
    return { section: { ...t, author: starter?.author, createdAt: starter?.at }, posts };
  }

  function send(path, body) {
    const { server, token } = cfg();
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: body ? 'POST' : 'GET', url: server + path, data: body && JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      onload: (r) => (r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(new Error(`Сайт ответил ${r.status}: ${r.responseText}`))),
      onerror: () => reject(new Error('Сайт статистики недоступен')),
    }));
  }

  const btn = document.createElement('button');
  Object.assign(btn.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999, padding: '10px 14px', background: '#2a2412', color: '#d4a24c', border: '1px solid #4a3d18', borderRadius: '8px', cursor: 'pointer', font: '13px system-ui' });
  btn.textContent = 'Синхронизировать статистику';
  const setStatus = (s) => { btn.textContent = s; };
  btn.onclick = async () => {
    if (!cfg().server || !cfg().token) { configure(); if (!cfg().server) return; }
    btn.disabled = true;
    try {
      await send('/api/ping');
      const topics = await listTopics(setStatus);
      if (!topics.length) throw new Error('Темы не найдены — нужно поправить селекторы списка тем');
      let n = 0;
      for (const t of topics) {
        setStatus(`Тема ${++n}/${topics.length}: ${t.title.slice(0, 30)}`);
        await send('/api/ingest', await readTopic(t));
        await sleep(DELAY_MS);
      }
      setStatus(`Готово: ${topics.length} тем`);
    } catch (e) {
      console.error(e);
      setStatus(`Ошибка: ${e.message}`);
      alert(e.message);
    } finally { btn.disabled = false; }
  };
  document.body.append(btn);
})();
