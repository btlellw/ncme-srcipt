// ==UserScript==
// @name         NCME Auto Play Helper
// @namespace    https://www.ncme.org.cn/
// @version      0.2.0
// @description  自动静音播放视频，并在当前页面可见时尝试进入下一节。
// @match        https://www.ncme.org.cn/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      qyapi.weixin.qq.com
// ==/UserScript==

(function () {
  'use strict';

  let lastNextAttemptAt = 0;
  let navigationInProgress = false;
  let navigationStartedAt = 0;
  let navigationReason = '';
  let navigationSourceTitle = '';
  let lastExpandAttemptAt = 0;
  let lastExpandAttemptKey = '';
  let expandSequenceInProgress = false;
  let unitStartSequenceInProgress = false;
  let listActionQuietUntil = 0;
  let listPlayLockUntil = 0;
  let lastListPlayKey = '';
  let lastWindowOpenAt = 0;
  let lastWindowOpenUrl = '';
  let traceHooksInstalled = false;
  let traceEnabled = false;
  const triedPendingUnits = new Set();
  const traceLog = [];

  const STORAGE = {
    listUrl: 'ncme.auto.listUrl',
    lastLessonTitle: 'ncme.auto.lastLessonTitle',
    returningToList: 'ncme.auto.returningToList',
    notifyPrefix: 'ncme.auto.notify.',
    courseSnapshot: 'ncme.auto.courseSnapshot',
    listPlayLock: 'ncme.auto.listPlayLock',
  };

  const CFG = {
    scanIntervalMs: 3000,
    nextDelayMs: 2000,
    navigationTimeoutMs: 12000,
    listPlayQuietAfterClickMs: 2 * 60 * 60 * 1000,
    debug: true,
    autoExpandUnits: true,
    courseButtonText: /立即播放|继续学习|开始学习|去学习|去播放/,
    nextButtonText: /下一节|下一课|下一讲|下一个|继续学习|继续播放/,
    examMarkerText: /考试|测验|答题|提交试卷|交卷/,
    listStatusText: /未学习|学习中|未完成/,
    courseItemTitleText: /^(单元\s*\d+|第?\d+\s*[讲课节章]).+/,
    skipAutoPlayItemText: /课程考核|考核|考试|测验|答题/,
    unitHeaderText: /(?:\(|（)必修(?:\)|）)/,
    unitPendingText: /未学习|学习中/,
    fallbackCourseListUrl: 'https://www.ncme.org.cn/study-course/10085?projectType=4&periodId=10140',
    notify: {
      enabled: true,
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=941705ed-35d5-4327-ad00-ffc4d9e756fe',
      mentionedMobiles: [],
      messageType: 'markdown',
      timeoutMs: 15000,
      progressIntervalMs: 5 * 60 * 1000,
    },
  };

  const log = (...args) => {
    if (CFG.debug) {
      console.log('[ncme-auto]', ...args);
    }
  };

  const logError = (...args) => {
    console.error('[ncme-auto]', ...args);
  };

  const PAGE_WINDOW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const installWindowOpenGuard = () => {
    const currentOpen = PAGE_WINDOW.open;
    if (typeof currentOpen !== 'function' || currentOpen.__ncmeAutoGuarded) return;

    const guardedOpen = function guardedOpen(url, target, features) {
      const normalizedUrl = String(url || '');
      const current = now();
      if (normalizedUrl && normalizedUrl === lastWindowOpenUrl && current - lastWindowOpenAt < 5000) {
        log('duplicate window.open blocked:', normalizedUrl);
        return null;
      }

      lastWindowOpenUrl = normalizedUrl;
      lastWindowOpenAt = current;
      return currentOpen.call(this, url, target, features);
    };

    guardedOpen.__ncmeAutoGuarded = true;
    guardedOpen.__ncmeAutoOriginal = currentOpen;
    PAGE_WINDOW.open = guardedOpen;
    log('window.open duplicate guard installed');
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const now = () => Date.now();

  const hashText = (text) => encodeURIComponent(norm(text)).slice(0, 120) || 'empty';

  const getBodyLines = () =>
    (document.body?.innerText || '')
      .split('\n')
      .map((line) => norm(line))
      .filter(Boolean);

  const uniq = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  };

  const isCourseItemTitle = (text) => CFG.courseItemTitleText.test(norm(text));

  const setStorage = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch (_) {
      // Ignore storage failures.
    }
  };

  const getStorage = (key) => {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  };

  const removeStorage = (key) => {
    try {
      localStorage.removeItem(key);
    } catch (_) {
      // Ignore storage failures.
    }
  };

  const readJsonStorage = (key, fallback = null) => {
    const raw = getStorage(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  };

  const setNotifyStamp = (key) => setStorage(`${STORAGE.notifyPrefix}${key}`, String(now()));

  const getNotifyStamp = (key) => {
    const value = getStorage(`${STORAGE.notifyPrefix}${key}`);
    return value ? Number(value) || 0 : 0;
  };

  const allowNotify = (key, intervalMs = 0) => {
    if (!intervalMs) return true;
    const ts = getNotifyStamp(key);
    if (now() - ts < intervalMs) return false;
    setNotifyStamp(key);
    return true;
  };

  const formatSeconds = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const parseLessonTitle = (title) => {
    const text = norm(title);
    const match = text.match(/^(单元\s*\d+)[-—–:：]?\s*(.*)$/);
    return {
      raw: text,
      unitLabel: match ? norm(match[1]) : '',
      lessonName: match ? norm(match[2]) : text,
    };
  };

  const extractCourseTitleFromPage = () => {
    const selectors = [
      '.courseHeadtitle',
      '.courseHeadtitle span',
      '.mcneHeadArea',
      '.record .title-body',
      '.title-body',
    ];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const text = norm(el.textContent || '');
        if (
          text &&
          !isCourseItemTitle(text) &&
          !/有效期|项目编号|项目负责人|首页|资讯|在线课程|培训统筹|品牌学院/.test(text)
        ) {
          return text;
        }
      }
    }

    return '';
  };

  const extractLessonTitleFromText = (text) => {
    const lines = text
      .split('\n')
      .map((line) => norm(line))
      .filter(Boolean);
    return lines.find((line) => isCourseItemTitle(line)) || '';
  };

  const inferStudyStatus = (text) => {
    if (/已完成/.test(text)) return '已完成';
    if (/学习中/.test(text)) return '学习中';
    if (/未学习/.test(text)) return '未学习';
    return '未知';
  };

  const getCandidateRow = (el) => {
    const directDetail = el.closest?.('.courseStudyInfoDetail');
    if (directDetail) {
      return directDetail;
    }

    let cur = el;
    let best = null;
    for (let i = 0; cur && cur !== document.body && i < 8; i += 1) {
      const text = norm(cur.textContent || '');
      const lessonTitle = extractLessonTitleFromText(text);
      if (
        text &&
        isCourseItemTitle(lessonTitle) &&
        (CFG.courseButtonText.test(text) || /未学习|学习中|已完成|任务点/.test(text))
      ) {
        best = cur;
      }
      cur = cur.parentElement;
    }
    return best;
  };

  const getCourseSnapshot = () => readJsonStorage(STORAGE.courseSnapshot, null);

  const setCourseSnapshot = (snapshot) => {
    try {
      localStorage.setItem(STORAGE.courseSnapshot, JSON.stringify(snapshot));
    } catch (_) {
      // Ignore storage failures.
    }
  };

  const collectCourseSnapshot = () => {
    if (!/\/study-course\//.test(location.pathname)) return null;

    const lessons = [];
    for (const entry of getCourseListPlayEntries()) {
      lessons.push({
        title: entry.title,
        status: entry.status,
        isExam: CFG.skipAutoPlayItemText.test(entry.title) || CFG.skipAutoPlayItemText.test(entry.rowText),
      });
    }

    const uniqLessons = uniq(
      lessons.map((item) => JSON.stringify(item))
    ).map((item) => JSON.parse(item));

    if (uniqLessons.length === 0) return null;

    const videoLessons = uniqLessons.filter((item) => !item.isExam);
    const completedLessons = videoLessons.filter((item) => item.status === '已完成').length;
    const snapshot = {
      courseTitle: extractCourseTitleFromPage(),
      updatedAt: now(),
      lessons: uniqLessons,
      totalLessons: videoLessons.length,
      completedLessons,
    };
    setCourseSnapshot(snapshot);
    return snapshot;
  };

  const getCourseProgressContext = (currentTitle = '', options = {}) => {
    const snapshot = getCourseSnapshot();
    const base = {
      courseTitle: snapshot?.courseTitle || extractCourseTitleFromPage() || '',
      totalLessons: snapshot?.totalLessons || 0,
      completedLessons: snapshot?.completedLessons || 0,
      remainingLessons: 0,
      overallText: '未知',
    };

    if (!snapshot || !Array.isArray(snapshot.lessons)) {
      return base;
    }

    let completedLessons = snapshot.completedLessons || 0;
    if (options.markCurrentDone && currentTitle) {
      const current = snapshot.lessons.find((item) => item.title === currentTitle && !item.isExam);
      if (current && current.status !== '已完成') {
        completedLessons += 1;
      }
    }

    const totalLessons = snapshot.totalLessons || 0;
    const remainingLessons = Math.max(0, totalLessons - completedLessons);
    return {
      courseTitle: snapshot.courseTitle || '',
      totalLessons,
      completedLessons,
      remainingLessons,
      overallText: totalLessons > 0 ? `${completedLessons} / ${totalLessons}` : '未知',
    };
  };

  const escapeMd = (text) => String(text || '').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');

  const isBenignPlayAbort = (err) => {
    const name = String(err?.name || '');
    const message = String(err?.message || '');
    return name === 'AbortError' && /interrupted by a call to pause|interrupted by a new load request/i.test(message);
  };

  const beginNavigation = (reason, sourceTitle = '') => {
    navigationInProgress = true;
    navigationStartedAt = now();
    navigationReason = reason || '';
    navigationSourceTitle = sourceTitle || getCurrentLessonTitle() || '';
    log('navigation begin:', navigationReason, navigationSourceTitle || '(no-title)');
  };

  const resetNavigationState = (reason = 'reset') => {
    if (navigationInProgress) {
      log('navigation reset:', reason, navigationReason, navigationSourceTitle || '(no-title)');
    }
    navigationInProgress = false;
    navigationStartedAt = 0;
    navigationReason = '';
    navigationSourceTitle = '';
  };

  const getSharedListPlayLock = () => readJsonStorage(STORAGE.listPlayLock, null);

  const isListPlayLocked = () => {
    const current = now();
    const shared = getSharedListPlayLock();

    if (shared?.until && current < Number(shared.until)) {
      listPlayLockUntil = Math.max(listPlayLockUntil, Number(shared.until));
      lastListPlayKey = shared.key || lastListPlayKey;
      return true;
    }

    if (shared?.until && current >= Number(shared.until)) {
      removeStorage(STORAGE.listPlayLock);
    }

    return current < listPlayLockUntil;
  };

  const beginListPlayLock = (key, title = '') => {
    lastListPlayKey = key || hashText(title || 'list-play');
    listPlayLockUntil = now() + CFG.listPlayQuietAfterClickMs;
    listActionQuietUntil = Math.max(listActionQuietUntil, listPlayLockUntil);
    setStorage(
      STORAGE.listPlayLock,
      JSON.stringify({
        key: lastListPlayKey,
        title: title || '',
        until: listPlayLockUntil,
        createdAt: now(),
      }),
    );
    log(
      'list play lock begin:',
      lastListPlayKey,
      title || '(no-title)',
      new Date(listPlayLockUntil).toLocaleTimeString(),
    );
  };

  const clearListPlayLock = (reason = 'clear') => {
    const shared = getSharedListPlayLock();
    if (listPlayLockUntil) {
      log('list play lock clear:', reason, lastListPlayKey || '(no-key)');
    }
    if (!shared?.key || !lastListPlayKey || shared.key === lastListPlayKey || reason === 'manual') {
      removeStorage(STORAGE.listPlayLock);
    }
    listPlayLockUntil = 0;
    lastListPlayKey = '';
  };

  const buildNotifyMarkdown = (level, title, lines = []) => {
    const safeLines = lines.filter(Boolean).map((line) => `> ${escapeMd(line)}`);
    return [
      `## NCME \\| ${escapeMd(level)} \\| ${escapeMd(title)}`,
      ...safeLines,
      `> 页面: ${escapeMd(location.pathname)}`,
      `> 时间: ${escapeMd(new Date().toLocaleString())}`,
    ].join('\n');
  };

  const buildNotifyText = (level, title, lines = []) => [
    `[NCME][${level}] ${title}`,
    ...lines.filter(Boolean),
    `页面: ${location.pathname}`,
    `时间: ${new Date().toLocaleString()}`,
  ].join('\n');

  const postWebhook = (payload) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CFG.notify.webhookUrl,
        data: body,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: CFG.notify.timeoutMs,
        onload: (resp) => resolve(resp),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error('webhook timeout')),
      });
      return;
    }

    fetch(CFG.notify.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    })
      .then(async (resp) => resolve({
        status: resp.status,
        responseText: await resp.text(),
      }))
      .catch(reject);
  });

  const sendNotify = async (level, title, lines = [], options = {}) => {
    if (!CFG.notify.enabled) return false;
    if (!CFG.notify.webhookUrl || /REPLACE_ME/.test(CFG.notify.webhookUrl)) return false;

    const notifyKey = options.key || `${level}:${title}`;
    if (!allowNotify(notifyKey, options.intervalMs || 0)) {
      return false;
    }

    const messageType =
      CFG.notify.messageType === 'markdown' && (!CFG.notify.mentionedMobiles || CFG.notify.mentionedMobiles.length === 0)
        ? 'markdown'
        : 'text';

    try {
      const payload = messageType === 'markdown'
        ? {
            msgtype: 'markdown',
            markdown: {
              content: buildNotifyMarkdown(level, title, lines),
            },
          }
        : {
            msgtype: 'text',
            text: {
              content: buildNotifyText(level, title, lines),
              mentioned_mobile_list: CFG.notify.mentionedMobiles,
            },
          };

      const resp = await postWebhook(payload);
      log('notify sent:', level, title, resp.status || resp.statusCode || 'ok');
      return true;
    } catch (err) {
      log('notify failed:', err);
      return false;
    }
  };

  const notifyError = (title, err, lines = [], options = {}) => {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err || '');
    return sendNotify('ERROR', title, [...lines, detail], {
      intervalMs: 60 * 1000,
      key: options.key || `error:${title}:${hashText(detail)}`,
    });
  };

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const isDisabled = (el) => {
    if (!el) return true;
    return !!(
      el.disabled ||
      el.getAttribute('disabled') !== null ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disabled') ||
      el.classList.contains('is-disabled')
    );
  };

  const getClickableTarget = (el) => {
    if (!el) return null;

    const selfText = norm(el.textContent || '');
    const textFallback =
      selfText &&
      selfText.length <= 20 &&
      (CFG.courseButtonText.test(selfText) || CFG.nextButtonText.test(selfText) || /重播/.test(selfText))
        ? el
        : null;

    if (el.matches?.('.next-modal-block, .next-body, .btn-block')) {
      const nestedNext = el.querySelector('.play-item.next-item, .next-item');
      if (nestedNext && isVisible(nestedNext) && /下一/.test(norm(nestedNext.textContent))) {
        return nestedNext;
      }
    }

    let cur = el;
    while (cur && cur !== document.body) {
      const curText = norm(cur.textContent || '');
      const curStyle = cur.ownerDocument?.defaultView?.getComputedStyle(cur);
      const sameShortText = !!(selfText && curText === selfText && cur !== el);
      const pointerLike = curStyle?.cursor === 'pointer';
      if (
        cur.matches?.(
          [
            'a',
            'button',
            '[role="button"]',
            '.btn',
            '.button',
            '.playbtn',
            '[class*="btn"]',
            '[class*="button"]',
            '.play-item',
            '.next-item',
            '.replay-item',
          ].join(',')
        ) ||
        typeof cur.onclick === 'function' ||
        cur.hasAttribute?.('tabindex') ||
        pointerLike ||
        sameShortText
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }

    return textFallback;
  };

  const getCourseListPlayEntries = () => {
    if (!isStudyCoursePage()) return [];

    return Array.from(document.querySelectorAll('.playbtn'))
      .filter((btn) => {
        const text = norm(btn.textContent || '');
        return text && CFG.courseButtonText.test(text) && isVisible(btn) && !isDisabled(btn);
      })
      .map((button) => {
        const detailRow = getCandidateRow(button);
        const rowText = norm(detailRow?.textContent || '');
        const title = extractLessonTitleFromText(rowText);
        const unitItem = button.closest('.courseStudyItem');
        const unitText = norm(unitItem?.textContent || '');
        return {
          button,
          detailRow,
          rowText,
          title,
          status: inferStudyStatus(rowText),
          unitItem,
          unitText,
          unitStatus: inferStudyStatus(unitText),
        };
      })
      .filter((entry) => entry.title);
  };

  const isPendingLessonText = (text) => {
    const value = norm(text || '');
    return /未学习|学习中/.test(value) || inferStudyStatus(value) === '未学习' || inferStudyStatus(value) === '学习中';
  };

  const getPendingPlayEntries = (includeHidden = false) =>
    Array.from(document.querySelectorAll('.courseStudyInfoDetail'))
      .map((detailRow) => {
        const rowText = norm(detailRow.textContent || '');
        const button = detailRow.querySelector('.playbtn');
        const title = extractLessonTitleFromText(rowText);
        return {
          button,
          detailRow,
          rowText,
          title,
          status: inferStudyStatus(rowText),
          buttonVisible: !!button && isVisible(button),
          rowVisible: isVisible(detailRow),
          unitText: norm(detailRow.closest('.courseStudyItem')?.textContent || '').slice(0, 180),
        };
      })
      .filter((entry) =>
        entry.button &&
        (includeHidden || entry.buttonVisible) &&
        !isDisabled(entry.button) &&
        isPendingLessonText(entry.rowText) &&
        !CFG.skipAutoPlayItemText.test(entry.rowText)
      )
      .sort((a, b) => a.detailRow.getBoundingClientRect().top - b.detailRow.getBoundingClientRect().top);

  const fireClick = (el) => {
    const doc = el?.ownerDocument || document;
    const view = doc.defaultView || window;
    const MouseCtor = view.MouseEvent || MouseEvent;
    const PointerCtor = view.PointerEvent;
    const rect = el.getBoundingClientRect();
    const point = {
      clientX: Math.round(rect.left + Math.max(1, rect.width / 2)),
      clientY: Math.round(rect.top + Math.max(1, rect.height / 2)),
      screenX: Math.round(rect.left + Math.max(1, rect.width / 2)),
      screenY: Math.round(rect.top + Math.max(1, rect.height / 2)),
      button: 0,
      buttons: 1,
    };

    if (PointerCtor) {
      for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'pointerup']) {
        el.dispatchEvent(new PointerCtor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          ...point,
        }));
      }
    }

    for (const type of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...point,
      };
      try {
        init.view = view;
      } catch (_) {
        // Ignore unsupported view assignment.
      }
      el.dispatchEvent(new MouseCtor(type, init));
    }
  };

  const clickEl = (el) => {
    const target = getClickableTarget(el);
    if (!target || !isVisible(target) || isDisabled(target)) return false;
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    log('click target:', target.tagName, target.className, norm(target.textContent));
    fireClick(target);
    target.click?.();
    return true;
  };

  const clickElOnce = (el) => {
    const target = getClickableTarget(el);
    if (!target || !isVisible(target) || isDisabled(target)) return false;
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    log('single click target:', target.tagName, target.className, norm(target.textContent));
    target.click?.();
    return true;
  };

  const forceClickEl = (el) => {
    if (!el || !isVisible(el) || isDisabled(el)) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    log('force click target:', el.tagName, el.className, norm(el.textContent).slice(0, 160));
    fireClick(el);
    el.click?.();
    return true;
  };

  const pushTrace = (type, data = {}) => {
    if (!traceEnabled) return;
    traceLog.push({
      time: new Date().toISOString(),
      path: location.href,
      type,
      ...data,
    });
    while (traceLog.length > 120) traceLog.shift();
    log('trace:', type, data);
  };

  const installTraceHooks = () => {
    if (traceHooksInstalled) return true;
    traceHooksInstalled = true;

    try {
      const originalFetch = PAGE_WINDOW.fetch;
      if (typeof originalFetch === 'function' && !originalFetch.__ncmeAutoWrapped) {
        const wrappedFetch = function (...args) {
          const url = String(args[0]?.url || args[0] || '');
          pushTrace('fetch', {
            url,
            method: String(args[1]?.method || args[0]?.method || 'GET'),
          });
          return originalFetch.apply(this, args).then((resp) => {
            pushTrace('fetch:response', {
              url: resp.url || url,
              status: resp.status,
            });
            return resp;
          });
        };
        wrappedFetch.__ncmeAutoWrapped = true;
        PAGE_WINDOW.fetch = wrappedFetch;
      }
    } catch (err) {
      log('fetch trace hook failed:', err);
    }

    try {
      const XHR = PAGE_WINDOW.XMLHttpRequest;
      if (XHR?.prototype && !XHR.prototype.__ncmeAutoWrapped) {
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url, ...rest) {
          this.__ncmeAutoTrace = { method: String(method || 'GET'), url: String(url || '') };
          return originalOpen.call(this, method, url, ...rest);
        };
        XHR.prototype.send = function (...args) {
          const meta = this.__ncmeAutoTrace || {};
          pushTrace('xhr', meta);
          this.addEventListener?.('loadend', () => {
            pushTrace('xhr:response', {
              ...meta,
              status: this.status,
              responseURL: this.responseURL,
            });
          });
          return originalSend.apply(this, args);
        };
        XHR.prototype.__ncmeAutoWrapped = true;
      }
    } catch (err) {
      log('xhr trace hook failed:', err);
    }

    return true;
  };

  const allDocs = () => {
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch (_) {
        // Ignore cross-origin frames.
      }
    }
    return docs;
  };

  const queryByText = (regex, selector = 'a,button,span,div,p') => {
    for (const doc of allDocs()) {
      for (const el of doc.querySelectorAll(selector)) {
        const text = norm(el.textContent);
        const hasChildMatch = Array.from(el.children || []).some((child) => {
          const childText = norm(child.textContent);
          return childText && regex.test(childText) && isVisible(child);
        });
        if (text && regex.test(text) && isVisible(el) && !hasChildMatch) {
          return el;
        }
      }
    }
    return null;
  };

  const queryVisible = (selector) => {
    for (const doc of allDocs()) {
      const nodes = Array.from(doc.querySelectorAll(selector));
      for (const el of nodes) {
        if (isVisible(el)) {
          return el;
        }
      }
    }
    return null;
  };

  const hasVisibleChildTextMatch = (el, predicate) =>
    Array.from(el.children || []).some((child) => isVisible(child) && predicate(norm(child.textContent || '')));

  const isUnitHeaderText = (text) =>
    CFG.unitHeaderText.test(text) && /(未学习|学习中|已完成)/.test(text);

  const getUnitHeaderElements = () => {
    const directItems = Array.from(document.querySelectorAll('.courseStudyItem'))
      .filter((el) => {
        const text = norm(el.textContent || '');
        return text && isVisible(el) && isUnitHeaderText(text);
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    if (directItems.length > 0) {
      return directItems;
    }

    const nodes = Array.from(document.querySelectorAll('div,span,p,a'));
    return nodes
      .filter((el) => {
        const text = norm(el.textContent || '');
        return text && isVisible(el) && isUnitHeaderText(text) && !hasVisibleChildTextMatch(el, isUnitHeaderText);
      })
      .map((el) => {
        let row = el;
        let cur = el.parentElement;
        for (let i = 0; cur && cur !== document.body && i < 6; i += 1) {
          const text = norm(cur.textContent || '');
          if (text && isUnitHeaderText(text)) {
            row = cur;
          }
          cur = cur.parentElement;
        }
        return row;
      })
      .filter((row, index, arr) => arr.indexOf(row) === index)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  };

  const getExpandTargetForUnitRow = (row) => {
    const rowRect = row.getBoundingClientRect();
    const candidates = Array.from(row.querySelectorAll('i,svg,img,span,div'))
      .filter((el) => isVisible(el))
      .map((el) => ({
        el,
        text: norm(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter((item) =>
        item.rect.left > rowRect.left + rowRect.width * 0.6 &&
        item.rect.width > 0 &&
        item.rect.width < 120 &&
        item.rect.height > 0 &&
        item.rect.height < 80 &&
        item.rect.top >= rowRect.top - 8 &&
        item.rect.top <= rowRect.top + Math.min(120, rowRect.height) &&
        item.rect.bottom <= rowRect.top + Math.min(140, rowRect.height + 20)
      )
      .sort((a, b) =>
        b.rect.left - a.rect.left ||
        a.text.length - b.text.length ||
        a.rect.width - b.rect.width
      );

    return candidates[0]?.el || row;
  };

  const getUnitHeaderClickTarget = (row) => {
    const rowRect = row.getBoundingClientRect();
    const candidates = Array.from(row.querySelectorAll('div,span,p,strong,b'))
      .filter((el) => isVisible(el))
      .map((el) => ({
        el,
        text: norm(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter((item) =>
        item.text &&
        isUnitHeaderText(item.text) &&
        item.rect.top >= rowRect.top - 8 &&
        item.rect.top <= rowRect.top + Math.min(120, rowRect.height) &&
        item.rect.width > 80
      )
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    return candidates[0]?.el || row;
  };

  const getVisibleCourseButtons = () =>
    Array.from(document.querySelectorAll('a,button,span,div'))
      .filter((el) => {
        const text = norm(el.textContent || '');
        return text && CFG.courseButtonText.test(text) && isVisible(el) && !isDisabled(el);
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

  const isUnitExpanded = (row, nextRowTop = Number.POSITIVE_INFINITY) => {
    const directButtons = Array.from(row.querySelectorAll('.playbtn'))
      .filter((btn) => isVisible(btn) && CFG.courseButtonText.test(norm(btn.textContent || '')));
    if (directButtons.length > 0) {
      return true;
    }

    const rowTop = row.getBoundingClientRect().top;
    return getVisibleCourseButtons().some((btn) => {
      const rect = btn.getBoundingClientRect();
      const rowText = norm(getCandidateRow(btn)?.textContent || '');
      return (
        rect.top > rowTop + 10 &&
        rect.top < nextRowTop - 10 &&
        !CFG.skipAutoPlayItemText.test(rowText)
      );
    });
  };

  const getUnitItemsDebug = () =>
    getUnitHeaderElements().map((row) => ({
      text: norm(row.textContent || '').slice(0, 200),
      status: inferStudyStatus(norm(row.textContent || '')),
      expanded: isUnitExpanded(row),
      top: Math.round(row.getBoundingClientRect().top),
      cls: row.className || '',
    }));

  const getPlayEntriesForUnitItem = (unitItem) => {
    if (!unitItem) return [];

    return Array.from(unitItem.querySelectorAll('.courseStudyInfoDetail'))
      .map((detailRow) => {
        const rowText = norm(detailRow.textContent || '');
        const button = detailRow.querySelector('.playbtn');
        const title = extractLessonTitleFromText(rowText);
        return {
          detailRow,
          rowText,
          button,
          title,
          status: inferStudyStatus(rowText),
        };
      })
      .filter((entry) =>
        entry.button &&
        isVisible(entry.button) &&
        !isDisabled(entry.button) &&
        entry.title &&
        !CFG.skipAutoPlayItemText.test(entry.rowText)
      )
      .sort((a, b) => a.detailRow.getBoundingClientRect().top - b.detailRow.getBoundingClientRect().top);
  };

  const getPlayEntriesForUnitScope = (unitItem, nextRowTop = Number.POSITIVE_INFINITY) => {
    if (!unitItem) return [];

    const directEntries = getPlayEntriesForUnitItem(unitItem);
    if (directEntries.length > 0) {
      return directEntries;
    }

    const rowTop = unitItem.getBoundingClientRect().top;
    return getCourseListPlayEntries()
      .filter((entry) => {
        const rect = entry.button.getBoundingClientRect();
        return (
          rect.top > rowTop + 10 &&
          rect.top < nextRowTop - 10 &&
          !CFG.skipAutoPlayItemText.test(entry.rowText)
        );
      })
      .sort((a, b) => a.button.getBoundingClientRect().top - b.button.getBoundingClientRect().top);
  };

  const getUnitHeaderLabel = (unitItem) => {
    if (!unitItem) return '';
    const lines = String(unitItem.textContent || '')
      .split('\n')
      .map((line) => norm(line))
      .filter(Boolean);
    return lines.find((line) => CFG.unitHeaderText.test(line)) || norm(unitItem.textContent || '').slice(0, 120);
  };

  const getPendingUnitElement = () =>
    getUnitHeaderElements().find((row) => {
      const text = norm(row.textContent || '');
      const status = inferStudyStatus(text);
      return status === '未学习' || status === '学习中' || CFG.unitPendingText.test(text);
    }) || null;

  const summarizeVue = (vm) => {
    if (!vm) return null;
    return {
      name: vm.$options?.name || vm.$options?._componentTag || '',
      tag: vm.$vnode?.tag || '',
      route: vm.$route ? {
        path: vm.$route.path,
        fullPath: vm.$route.fullPath,
        query: vm.$route.query,
      } : null,
      dataKeys: Object.keys(vm.$data || {}).slice(0, 80),
      propKeys: Object.keys(vm.$props || {}).slice(0, 80),
      methodKeys: Object.keys(vm.$options?.methods || {}).slice(0, 120),
    };
  };

  const getVueVmChainForElement = (el) => {
    const out = [];
    const seen = new Set();
    let cur = el;
    while (cur && cur !== document.documentElement) {
      let vm = cur.__vue__;
      while (vm && !seen.has(vm)) {
        seen.add(vm);
        out.push(vm);
        vm = vm.$parent;
      }
      cur = cur.parentElement;
    }
    return out;
  };

  const getVueChainForElement = (el) =>
    getVueVmChainForElement(el)
      .map(summarizeVue)
      .filter(Boolean);

  const getCourseStudyVm = () => {
    const unit = getPendingUnitElement() || document.querySelector('.courseStudyItem');
    const chain = getVueVmChainForElement(unit);
    return chain.find((vm) =>
      vm?.$options?.name === 'CourseStudyDetail' ||
      typeof vm?.goVideo === 'function' ||
      typeof vm?.btnClickFn === 'function' ||
      typeof vm?.changeShow === 'function'
    ) || null;
  };

  const liteValue = (value, depth = 0, seen = new WeakSet()) => {
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (depth >= 2) {
      if (Array.isArray(value)) return `[Array(${value.length})]`;
      return `[Object keys=${Object.keys(value).slice(0, 20).join(',')}]`;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 5).map((item) => liteValue(item, depth + 1, seen));
    }
    const out = {};
    for (const key of Object.keys(value).slice(0, 40)) {
      const item = value[key];
      if (typeof item === 'function') {
        out[key] = '[Function]';
      } else {
        out[key] = liteValue(item, depth + 1, seen);
      }
    }
    return out;
  };

  const getCourseStudyVmData = () => {
    const vm = getCourseStudyVm();
    if (!vm) return null;
    return {
      summary: summarizeVue(vm),
      props: liteValue(vm.$props || {}),
      data: liteValue(vm.$data || {}),
      courseList: liteValue(vm.courseList || vm.$data?.courseList || []),
      list: liteValue(vm.list || vm.$props?.list || []),
      curitem: liteValue(vm.curitem || vm.$props?.curitem || null),
      startInfo: liteValue(vm.startInfo || vm.$data?.startInfo || null),
    };
  };

  const getCourseStudyList = () => {
    const vm = getCourseStudyVm();
    if (!vm) return [];
    return (
      (Array.isArray(vm.courseList) && vm.courseList) ||
      (Array.isArray(vm.$data?.courseList) && vm.$data.courseList) ||
      (Array.isArray(vm.list) && vm.list) ||
      (Array.isArray(vm.$props?.list) && vm.$props.list) ||
      (Array.isArray(vm.curitem?.contentList) && vm.curitem.contentList) ||
      (Array.isArray(vm.$props?.curitem?.contentList) && vm.$props.curitem.contentList) ||
      []
    );
  };

  const getPendingCourseItemByVue = () =>
    getCourseStudyList().find((item) =>
      item &&
      !CFG.skipAutoPlayItemText.test(norm(item.name || '')) &&
      Number(item.studyStatus) !== 2
    ) || null;

  const expandPendingUnitByVue = () => {
    const vm = getCourseStudyVm();
    const list = getCourseStudyList();
    const item = getPendingCourseItemByVue();
    if (!vm || !item) return false;

    log('vue expand pending unit:', item.id, item.name, 'studyStatus=', item.studyStatus, 'isShow=', item.isShow);
    list.forEach((course) => {
      if (!course) return;
      if (typeof vm.$set === 'function') {
        vm.$set(course, 'isShow', course === item);
      } else {
        course.isShow = course === item;
      }
    });
    if (typeof vm.$forceUpdate === 'function') {
      vm.$forceUpdate();
    }
    vm.$nextTick?.(() => {
      log('vue expand nextTick:', item.id, item.name, 'isShow=', item.isShow);
      const pending = getPendingPlayEntries(false);
      log('visible pending after vue expand:', pending.length);
      if (pending.length > 0) {
        tryStartCourseFromList();
      }
    });
    return true;
  };

  const getCourseStudyMethodSources = () => {
    const vm = getCourseStudyVm();
    if (!vm) return null;
    const names = ['changeShow', 'goVideo', 'btnClickFn', 'goDetailInfo', 'goDetail', 'doPaper'];
    const out = {};
    for (const name of names) {
      const fn = vm[name] || vm.$options?.methods?.[name];
      out[name] = typeof fn === 'function' ? String(fn).slice(0, 4000) : null;
    }
    return out;
  };

  const getRouterState = () => {
    const nuxt = PAGE_WINDOW.$nuxt;
    const router = nuxt?.$router;
    return {
      location: location.href,
      nuxtRoute: nuxt?.$route ? {
        path: nuxt.$route.path,
        fullPath: nuxt.$route.fullPath,
        query: nuxt.$route.query,
      } : null,
      routerCurrent: router?.currentRoute ? {
        path: router.currentRoute.path,
        fullPath: router.currentRoute.fullPath,
        query: router.currentRoute.query,
      } : null,
    };
  };

  const shouldThrottleExpandAttempt = (key) => {
    if (!key) return false;
    if (key !== lastExpandAttemptKey) return false;
    return now() - lastExpandAttemptAt < 2500;
  };

  const markExpandAttempt = (key) => {
    lastExpandAttemptKey = key;
    lastExpandAttemptAt = now();
  };

  const clickUnitExpand = (row, target, nextRowTop = Number.POSITIVE_INFINITY) => {
    const attempts = [
      target,
      target?.parentElement || null,
      getUnitHeaderClickTarget(row),
      row,
    ].filter(Boolean);

    const seen = new Set();
    const queue = attempts.filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });

    if (queue.length === 0) {
      return false;
    }

    expandSequenceInProgress = true;

    const tryAt = (index) => {
      if (isUnitExpanded(row, nextRowTop)) {
        log('unit expanded after click sequence');
        expandSequenceInProgress = false;
        return;
      }

      if (index >= queue.length) {
        log('expand click sequence exhausted');
        expandSequenceInProgress = false;
        return;
      }

      const candidate = queue[index];
      log('try expand click candidate:', candidate.className || candidate.tagName, norm(candidate.textContent || '').slice(0, 80));
      clickEl(candidate);

      setTimeout(() => {
        tryAt(index + 1);
      }, 350);
    };

    tryAt(0);
    return true;
  };

  const scheduleUnitPlaybackStart = (unitItem, nextRowTop, snapshot, progressText) => {
    if (!unitItem || unitStartSequenceInProgress) {
      return false;
    }

    unitStartSequenceInProgress = true;

    const finish = (reason) => {
      unitStartSequenceInProgress = false;
      log('unit playback sequence finish:', reason);
      if (reason === 'exhausted') {
        listActionQuietUntil = now() + 60 * 1000;
      }
    };

    const tryStart = (attempt = 0) => {
      if (navigationInProgress) {
        finish('navigation-in-progress');
        return;
      }

      if (!isStudyCoursePage()) {
        finish('left-study-course');
        return;
      }

      const entries = getPlayEntriesForUnitScope(unitItem, nextRowTop);
      log(
        'unit play entries:',
        entries.length,
        entries.map((entry) => `${entry.status}:${entry.title}`).join(' | ').slice(0, 320)
      );

      const visiblePendingEntries = getPendingPlayEntries(false);
      const entry =
        entries.find((item) => isPendingLessonText(item.rowText)) ||
        visiblePendingEntries[0] ||
        null;

      if (!entry && attempt >= 1) {
        log(
          'no visible pending play entry, stop probing:',
          entries.map((item) => `${item.status}:${item.title}`).join(' | ').slice(0, 240),
          'globalPending=',
          visiblePendingEntries.length
        );
        finish('no-pending-entry');
        return;
      }
      if (entry) {
        log('click unit course button:', entry.title, entry.status, norm(entry.button.textContent));
        if (clickElOnce(entry.button)) {
          const parsed = parseLessonTitle(entry.title);
          beginNavigation(`list-play:${entry.status}`, entry.title);
          void sendNotify('LIST', '展开后进入视频', [
            snapshot?.courseTitle ? `课程: ${snapshot.courseTitle}` : '',
            parsed.unitLabel ? `单元: ${parsed.unitLabel}` : '',
            parsed.lessonName ? `内容: ${parsed.lessonName}` : entry.title ? `当前: ${entry.title}` : '',
            `整体进度: ${progressText}`,
            `状态: ${entry.status}`,
            `按钮: ${norm(entry.button.textContent)}`,
          ], {
            intervalMs: 5000,
            key: `unit-play:${hashText(entry.rowText || entry.title)}`,
          });
          removeStorage(STORAGE.returningToList);
          finish('clicked');
          return;
        }
      }

      if (attempt >= 2) {
        log('unit playback start sequence exhausted');
        finish('exhausted');
        return;
      }

      setTimeout(() => tryStart(attempt + 1), 500);
    };

    setTimeout(() => tryStart(0), 500);
    return true;
  };

  const tryExpandNextPendingUnit = (snapshot, progressText) => {
    if (expandSequenceInProgress) {
      log('expand sequence already running');
      return true;
    }

    if (now() < listActionQuietUntil) {
      log('list action quiet, skip pending unit probing');
      return true;
    }

    const headers = getUnitHeaderElements();
    log('unit headers:', headers.length);
    if (headers.length === 0) return false;

    for (let i = 0; i < headers.length; i += 1) {
      const row = headers[i];
      const rowText = norm(row.textContent || '');
      const status = inferStudyStatus(rowText);
      log('inspect unit:', status, rowText.slice(0, 120));
      if (!(status === '未学习' || status === '学习中' || CFG.unitPendingText.test(rowText))) {
        continue;
      }

      const nextRowTop = headers[i + 1]?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      if (isUnitExpanded(row, nextRowTop)) {
        log('unit already expanded:', rowText.slice(0, 120));
        scheduleUnitPlaybackStart(row, nextRowTop, snapshot, progressText);
        continue;
      }

      const expandKey = hashText(rowText.slice(0, 120));
      if (triedPendingUnits.has(expandKey)) {
        log('pending unit already tried, skip:', rowText.slice(0, 120));
        return false;
      }
      if (shouldThrottleExpandAttempt(expandKey)) {
        log('expand throttled:', rowText.slice(0, 120));
        return false;
      }

      const target = getExpandTargetForUnitRow(row);
      log('expand pending unit:', rowText.slice(0, 120), 'target:', target?.className || target?.tagName);
      markExpandAttempt(expandKey);
      triedPendingUnits.add(expandKey);
      if (clickUnitExpand(row, target, nextRowTop)) {
        void sendNotify('LIST', '展开下一个未学习单元', [
          snapshot?.courseTitle ? `课程: ${snapshot.courseTitle}` : '',
          `整体进度: ${progressText}`,
          `单元: ${rowText.slice(0, 160)}`,
        ], {
          intervalMs: 5000,
          key: `expand-unit:${hashText(rowText)}`,
        });
        scheduleUnitPlaybackStart(row, nextRowTop, snapshot, progressText);
        return true;
      }
    }

    return false;
  };

  const getCurrentLessonTitle = () => {
    const lines = getBodyLines();
    return lines.find((line) => isCourseItemTitle(line)) || '';
  };

  const getSidebarLessonTitles = () => {
    const lines = getBodyLines();
    const anchorIndex = Math.max(
      lines.lastIndexOf('讲义'),
      lines.lastIndexOf('问答'),
      lines.lastIndexOf('目录')
    );
    const candidateLines = anchorIndex >= 0 ? lines.slice(anchorIndex + 1) : lines;
    return uniq(candidateLines.filter((line) => isCourseItemTitle(line)));
  };

  const getPlaybackContext = () => {
    const currentTitle = getCurrentLessonTitle();
    const lessonTitles = getSidebarLessonTitles();
    const currentIndex = lessonTitles.indexOf(currentTitle);
    const nextTitle = currentIndex >= 0 ? lessonTitles[currentIndex + 1] || '' : '';
    return {
      currentTitle,
      lessonTitles,
      currentIndex,
      nextTitle,
    };
  };

  const buildLessonContextLines = (options = {}) => {
    const { currentTitle, lessonTitles, currentIndex, nextTitle } = getPlaybackContext();
    const parsed = parseLessonTitle(currentTitle);
    const course = getCourseProgressContext(currentTitle, {
      markCurrentDone: !!options.markCurrentDone,
    });

    return {
      currentTitle,
      currentIndex,
      nextTitle,
      lessonTitles,
      lines: [
        course.courseTitle ? `课程: ${course.courseTitle}` : '',
        parsed.unitLabel ? `单元: ${parsed.unitLabel}` : '',
        parsed.lessonName ? `内容: ${parsed.lessonName}` : currentTitle ? `当前: ${currentTitle}` : '',
        currentIndex >= 0 ? `讲次: ${currentIndex + 1} / ${lessonTitles.length}` : '',
        `整体进度: ${course.overallText}`,
        course.totalLessons > 0 ? `剩余视频: ${course.remainingLessons}` : '',
        nextTitle ? `下一讲: ${nextTitle}` : '下一讲: 无',
      ].filter(Boolean),
    };
  };

  const notifyLessonStart = (video) => {
    const { currentTitle, lines } = buildLessonContextLines();
    if (!currentTitle) return;

    void sendNotify('START', '开始观看', [
      ...lines,
      Number.isFinite(video?.duration) && video.duration > 0 ? `时长: ${formatSeconds(video.duration)}` : '',
    ], {
      intervalMs: 30 * 1000,
      key: `start:${hashText(currentTitle)}`,
    });
  };

  const notifyLessonProgress = (video) => {
    const { currentTitle, lines } = buildLessonContextLines();
    if (!currentTitle) return;

    void sendNotify('PROGRESS', '观看进度', [
      ...lines,
      `播放: ${formatSeconds(video.currentTime)} / ${formatSeconds(video.duration)}`,
    ], {
      intervalMs: CFG.notify.progressIntervalMs,
      key: `progress:${hashText(currentTitle)}`,
    });
  };

  const notifyLessonDone = (source = 'ended') => {
    const { currentTitle, lines } = buildLessonContextLines({ markCurrentDone: true });
    if (!currentTitle) return;

    void sendNotify('DONE', '本讲完成', [
      ...lines,
      `触发: ${source}`,
    ], {
      intervalMs: 30 * 1000,
      key: `done:${hashText(currentTitle)}`,
    });
  };

  const notifyUnitBoundary = (reason = 'boundary') => {
    const { currentTitle, lines } = buildLessonContextLines({ markCurrentDone: true });
    void sendNotify('UNIT', '当前单元视频已结束，返回课程列表', [
      ...lines,
      `原因: ${reason}`,
    ], {
      intervalMs: 30 * 1000,
      key: `unit:${hashText(currentTitle || reason)}`,
    });
  };

  const rememberCurrentLessonTitle = () => {
    const title = getCurrentLessonTitle();
    if (title) {
      setStorage(STORAGE.lastLessonTitle, title);
    }
  };

  const rememberListUrl = () => {
    if (/\/study-course\//.test(location.pathname)) {
      setStorage(STORAGE.listUrl, location.href);
    }
  };

  const goToCourseList = (reason = 'unknown') => {
    const listUrl = getStorage(STORAGE.listUrl) || CFG.fallbackCourseListUrl;
    log('go to course list:', reason, listUrl || '(history back)');
    beginNavigation(`list:${reason}`);
    setStorage(STORAGE.returningToList, '1');
    notifyUnitBoundary(reason);

    if (listUrl) {
      location.href = listUrl;
      return true;
    }

    if (document.referrer && /\/study-course\//.test(document.referrer)) {
      location.href = document.referrer;
      return true;
    }

    history.back();
    return true;
  };

  const findNextButton = () => {
    return (
      queryVisible('.next-modal-block .play-item.next-item') ||
      queryVisible('.next-body .play-item.next-item') ||
      queryVisible('.btn-block .next-item') ||
      queryVisible('.play-item.next-item') ||
      queryVisible('.next-item') ||
      queryByText(CFG.nextButtonText, 'button,a,span')
    );
  };

  const shouldReturnToListInsteadOfNext = () => {
    const { currentTitle, lessonTitles, currentIndex, nextTitle } = getPlaybackContext();
    if (!currentTitle || lessonTitles.length === 0 || currentIndex < 0) {
      return false;
    }

    if (!nextTitle) {
      log('no next lesson in current sidebar list');
      return true;
    }

    if (CFG.skipAutoPlayItemText.test(nextTitle)) {
      log('next item looks like exam:', nextTitle);
      return true;
    }

    return false;
  };

  const findPlayableVideos = () => {
    const videos = [];
    for (const doc of allDocs()) {
      videos.push(...doc.querySelectorAll('video'));
    }
    return videos.filter((v) => v && isVisible(v));
  };

  const isStudyCoursePage = () => /\/study-course\//.test(location.pathname);

  const isPlayerPage = () => /\/player\/record/.test(location.pathname);

  const isExamPage = () => {
    if (isStudyCoursePage()) {
      return false;
    }

    const path = String(location.pathname || '').toLowerCase();
    if (/(exam|test|paper|question|answer)/.test(path)) {
      return true;
    }

    const bodyText = norm(document.body?.innerText || '');
    const hasHardExamAction = /提交试卷|交卷|开始考试|继续考试|下一题|上一题|确认交卷|提交答案/.test(bodyText);
    const hasQuestionContext = /单选题|多选题|判断题|第\s*\d+\s*题|共\s*\d+\s*题|考试时间|剩余时间/.test(bodyText);
    const hasQuestionInputs = !!queryVisible('input[type="radio"],input[type="checkbox"],textarea');

    if (hasHardExamAction && (hasQuestionContext || hasQuestionInputs)) {
      return true;
    }

    return false;
  };

  const tryStartCourseFromList = () => {
    if (navigationInProgress) return true;
    if (now() < listActionQuietUntil || isListPlayLocked()) return true;

    const returningToList = getStorage(STORAGE.returningToList) === '1';
    const lastLessonTitle = getStorage(STORAGE.lastLessonTitle) || '';
    const snapshot = collectCourseSnapshot() || getCourseSnapshot();
    const progressText =
      snapshot && snapshot.totalLessons > 0
        ? `${snapshot.completedLessons} / ${snapshot.totalLessons}`
        : '未知';
    const entries = getCourseListPlayEntries()
      .sort((a, b) => a.button.getBoundingClientRect().top - b.button.getBoundingClientRect().top);

    for (const entry of entries) {
      if (CFG.skipAutoPlayItemText.test(entry.rowText)) {
        continue;
      }
      if (entry.status === '已完成') {
        continue;
      }
      if (returningToList && lastLessonTitle && entry.rowText.includes(lastLessonTitle)) {
        continue;
      }
      if (entry.status === '未学习' || entry.status === '学习中') {
        const lockKey = `list-play:${hashText(entry.rowText || entry.title || norm(entry.button.textContent))}`;
        if (isListPlayLocked() && lastListPlayKey === lockKey) return true;

        log('click course button:', entry.title, entry.status, norm(entry.button.textContent));
        beginListPlayLock(lockKey, entry.title);
        beginNavigation(`list-play:${entry.status}`, entry.title);
        if (clickElOnce(entry.button)) {
          const parsed = parseLessonTitle(entry.title);
          void sendNotify('LIST', '从课程列表进入视频', [
            snapshot?.courseTitle ? `课程: ${snapshot.courseTitle}` : '',
            parsed.unitLabel ? `单元: ${parsed.unitLabel}` : '',
            parsed.lessonName ? `内容: ${parsed.lessonName}` : entry.title ? `当前: ${entry.title}` : '',
            `整体进度: ${progressText}`,
            `状态: ${entry.status}`,
            `按钮: ${norm(entry.button.textContent)}`,
          ], {
            intervalMs: 5000,
            key: `list-click:${hashText(entry.rowText || norm(entry.button.textContent))}`,
          });
          removeStorage(STORAGE.returningToList);
          return true;
        }

        clearListPlayLock('click-failed');
        resetNavigationState('list-click-failed');
      }
    }

    if (CFG.autoExpandUnits && expandPendingUnitByVue()) {
      listActionQuietUntil = now() + 3000;
      void sendNotify('LIST', '展开下一个未学习单元', [
        snapshot?.courseTitle ? `课程: ${snapshot.courseTitle}` : '',
        `整体进度: ${progressText}`,
        '方式: Vue 数据 isShow',
      ], {
        intervalMs: 5000,
        key: 'vue-expand-pending-unit',
      });
      return true;
    }

    if (!CFG.autoExpandUnits) {
      log('no visible pending play entry; waiting for unit expansion');
      listActionQuietUntil = now() + 30 * 1000;
      void sendNotify('LIST', '等待展开未学习单元', [
        snapshot?.courseTitle ? `课程: ${snapshot.courseTitle}` : '',
        `整体进度: ${progressText}`,
        '说明: 未发现可见的未学习播放按钮，已停止猜测点击。',
      ], {
        intervalMs: 60 * 1000,
        key: 'wait-visible-pending-play',
      });
      return true;
    }

    return tryExpandNextPendingUnit(snapshot, progressText);

    return false;
  };

  const tryClickNext = async (source = 'unknown') => {
    if (navigationInProgress) return true;
    lastNextAttemptAt = now();

    if (source !== 'near-end' && shouldReturnToListInsteadOfNext()) {
      return goToCourseList(`boundary:${source}`);
    }

    await sleep(CFG.nextDelayMs);

    for (let i = 0; i < 10; i += 1) {
      if (navigationInProgress) return true;
      if (!/\/player\/record/.test(location.pathname)) return true;

      const nextBtn = findNextButton();

      if (clickEl(nextBtn)) {
        log('clicked next');
        beginNavigation(`next:${source}`);
        const { lines } = buildLessonContextLines();
        void sendNotify('NEXT', '已触发下一讲', [
          ...lines,
          `触发: ${source}`,
          `按钮: ${norm(nextBtn?.textContent || '')}`,
        ], {
          intervalMs: 5000,
          key: `next:${source}:${hashText(norm(nextBtn?.textContent || ''))}`,
        });
        return true;
      }

      await sleep(2000);
    }

    void notifyError('无法点击下一讲', new Error(`source=${source}`), [
      `路径: ${location.pathname}`,
    ], {
      key: `next-fail:${source}`,
    });

    if (source !== 'near-end' && /\/player\/record/.test(location.pathname)) {
      return goToCourseList(`fallback:${source}`);
    }

    if (tryStartCourseFromList()) {
      log('returned to list flow');
      return true;
    }

    return false;
  };

  const maybeHandleNextOverlay = () => {
    if (!/\/player\/record/.test(location.pathname)) return;
    if (navigationInProgress) return;

    const overlay =
      queryVisible('.next-modal-block') ||
      queryVisible('.next-body') ||
      queryVisible('.countdown');

    if (!overlay) return;

    if (now() - lastNextAttemptAt < 4000) return;

    log('next overlay detected');
    void tryClickNext('overlay');
  };

  const maybeRecoverNavigation = () => {
    if (!navigationInProgress) return;

    if (/\/study-course\//.test(location.pathname)) {
      if (navigationReason.startsWith('list-play:')) {
        if (isListPlayLocked()) return;
        resetNavigationState('list-play-lock-expired');
        return;
      }
      resetNavigationState('arrived-list');
      return;
    }

    if (!/\/player\/record/.test(location.pathname)) {
      resetNavigationState('left-player');
      return;
    }

    if (navigationReason.startsWith('list-play:')) {
      clearListPlayLock('arrived-player');
      resetNavigationState('arrived-player');
      return;
    }

    const currentTitle = getCurrentLessonTitle();
    if (
      navigationReason.startsWith('next:') &&
      currentTitle &&
      navigationSourceTitle &&
      currentTitle !== navigationSourceTitle
    ) {
      resetNavigationState('lesson-changed');
      return;
    }

    if (now() - navigationStartedAt < CFG.navigationTimeoutMs) {
      return;
    }

    if (navigationReason.startsWith('list:')) {
      const fallbackUrl = getStorage(STORAGE.listUrl) || CFG.fallbackCourseListUrl;
      if (fallbackUrl && location.href !== fallbackUrl) {
        beginNavigation('list:timeout-fallback', navigationSourceTitle);
        location.href = fallbackUrl;
        return;
      }
    }

    void sendNotify('WARN', '导航卡住，等待人工确认', [
      `导航原因: ${navigationReason || 'unknown'}`,
      navigationSourceTitle ? `来源: ${navigationSourceTitle}` : '',
      `当前页面: ${location.pathname}`,
    ], {
      intervalMs: 60 * 1000,
      key: `nav-stuck:${navigationReason}:${hashText(navigationSourceTitle)}`,
    });

    resetNavigationState('timeout');
  };

  const bindVideo = (video) => {
    if (!video || video.dataset.ncmeAutoBound === '1') return;
    video.dataset.ncmeAutoBound = '1';
    rememberCurrentLessonTitle();
    notifyLessonStart(video);

    const ensurePlaying = async () => {
      try {
        video.muted = true;
        video.volume = 0;
        video.autoplay = true;
        await video.play();
        log('video playing');
      } catch (err) {
        if (isBenignPlayAbort(err)) {
          log('video play interrupted:', err.message || err);
          return;
        }
        log('video play failed:', err);
        void notifyError('视频播放失败', err, [
          `标题: ${getCurrentLessonTitle() || 'unknown'}`,
        ], {
          key: `play-fail:${hashText(getCurrentLessonTitle() || 'unknown')}`,
        });
      }
    };

    video.addEventListener('pause', () => {
      if (!video.ended && !navigationInProgress) {
        void ensurePlaying();
      }
    });

    video.addEventListener('ended', () => {
      log('video ended');
      notifyLessonDone('ended');
      void tryClickNext('ended');
    });

    video.addEventListener('timeupdate', () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      if (video.currentTime > 0) {
        notifyLessonProgress(video);
      }
      if (video.duration - video.currentTime < 1.5 && findNextButton()) {
        void tryClickNext('near-end');
      }
    });

    void ensurePlaying();
  };

  const mainLoop = () => {
    rememberListUrl();
    maybeRecoverNavigation();

    if (/\/study-course\//.test(location.pathname)) {
      collectCourseSnapshot();
    }

    if (isExamPage()) {
      if (allowNotify('exam-log', 30 * 1000)) {
        log('exam page detected, skip automation');
      }
      const course = getCourseProgressContext();
      void sendNotify('WARN', '检测到考试页面，已停止自动处理', [
        course.courseTitle ? `课程: ${course.courseTitle}` : '',
        `整体进度: ${course.overallText}`,
        `路径: ${location.pathname}`,
      ], {
        intervalMs: 60 * 1000,
        key: 'exam-page',
      });
      return;
    }

    if (/\/player\/record/.test(location.pathname)) {
      rememberCurrentLessonTitle();
    }

    maybeHandleNextOverlay();

    const videos = findPlayableVideos();
    if (videos.length > 0) {
      videos.forEach(bindVideo);
      return;
    }

    if (/study-course/.test(location.pathname)) {
      tryStartCourseFromList();
    }
  };

  const runSafely = (label, fn) => {
    try {
      return fn();
    } catch (err) {
      logError(`${label} failed:`, err);
      void notifyError(`${label} failed`, err, [
        `页面: ${location.pathname}`,
      ], {
        key: `fatal:${label}:${hashText(String(err?.message || err || 'unknown'))}`,
      });
      return undefined;
    }
  };

  const boot = () => {
    log('userscript loaded', location.href);

    PAGE_WINDOW.__NCME_AUTO_DEBUG__ = {
      version: '0.2.0',
      CFG,
      mainLoop: () => runSafely('manual mainLoop', mainLoop),
      pauseListAutomation: (ms = 60000) => runSafely('manual pauseListAutomation', () => {
        listActionQuietUntil = now() + Number(ms || 60000);
        listPlayLockUntil = Math.max(listPlayLockUntil, listActionQuietUntil);
        return listActionQuietUntil;
      }),
      resumeListAutomation: () => runSafely('manual resumeListAutomation', () => {
        listActionQuietUntil = 0;
        clearListPlayLock('manual-resume');
        triedPendingUnits.clear();
        return true;
      }),
      clearListPlayLock: () => runSafely('manual clearListPlayLock', () => {
        clearListPlayLock('manual');
        return true;
      }),
      getListPlayLock: () => ({
        locked: isListPlayLocked(),
        until: listPlayLockUntil,
        key: lastListPlayKey,
        quietUntil: listActionQuietUntil,
        shared: getSharedListPlayLock(),
      }),
      startTrace: () => runSafely('manual startTrace', () => {
        traceLog.length = 0;
        traceEnabled = true;
        installTraceHooks();
        return true;
      }),
      stopTrace: () => runSafely('manual stopTrace', () => {
        traceEnabled = false;
        return traceLog.slice();
      }),
      getTrace: () => runSafely('manual getTrace', () => traceLog.slice()),
      getRouterState: () => runSafely('manual getRouterState', getRouterState),
      getCourseStudyVmData: () => runSafely('manual getCourseStudyVmData', getCourseStudyVmData),
      getCourseStudyMethodSources: () => runSafely('manual getCourseStudyMethodSources', getCourseStudyMethodSources),
      getCourseStudyList: () => runSafely('manual getCourseStudyList', () => liteValue(getCourseStudyList(), 0)),
      getPendingCourseItemByVue: () => runSafely('manual getPendingCourseItemByVue', () => liteValue(getPendingCourseItemByVue(), 0)),
      expandPendingUnitByVue: () => runSafely('manual expandPendingUnitByVue', expandPendingUnitByVue),
      getPendingUnitVueChain: () => runSafely('manual getPendingUnitVueChain', () => {
        const unit = getPendingUnitElement();
        return {
          unit: getUnitHeaderLabel(unit),
          chain: getVueChainForElement(unit),
        };
      }),
      getPendingUnitElementInfo: () => runSafely('manual getPendingUnitElementInfo', () => {
        const unit = getPendingUnitElement();
        if (!unit) return null;
        const target = getUnitHeaderClickTarget(unit) || unit;
        return {
          unit: getUnitHeaderLabel(unit),
          unitClass: unit.className || '',
          targetClass: target.className || '',
          targetText: norm(target.textContent || ''),
          rect: unit.getBoundingClientRect().toJSON?.() || {
            top: unit.getBoundingClientRect().top,
            left: unit.getBoundingClientRect().left,
            width: unit.getBoundingClientRect().width,
            height: unit.getBoundingClientRect().height,
          },
        };
      }),
      tryStartCourseFromList: () => runSafely('manual tryStartCourseFromList', tryStartCourseFromList),
      tryExpandNextPendingUnit: () => runSafely('manual tryExpandNextPendingUnit', () => {
        const snapshot = collectCourseSnapshot() || getCourseSnapshot();
        const progressText =
          snapshot && snapshot.totalLessons > 0
            ? `${snapshot.completedLessons} / ${snapshot.totalLessons}`
            : '未知';
        return tryExpandNextPendingUnit(snapshot, progressText);
      }),
      getCourseListPlayEntries: () => runSafely('manual getCourseListPlayEntries', getCourseListPlayEntries),
      getPendingPlayEntries: (includeHidden = false) => runSafely('manual getPendingPlayEntries', () => getPendingPlayEntries(!!includeHidden)),
      getCourseSnapshot: () => runSafely('manual getCourseSnapshot', () => collectCourseSnapshot() || getCourseSnapshot()),
      getUnitItems: () => runSafely('manual getUnitItems', getUnitItemsDebug),
      getPlayEntriesForUnitItem: () => runSafely('manual getPlayEntriesForUnitItem', () => {
        const unit = getUnitHeaderElements().find((row) => inferStudyStatus(norm(row.textContent || '')) === '未学习');
        return getPlayEntriesForUnitItem(unit);
      }),
      getPlayEntriesForPendingUnitScope: () => runSafely('manual getPlayEntriesForPendingUnitScope', () => {
        const headers = getUnitHeaderElements();
        const index = headers.findIndex((row) => inferStudyStatus(norm(row.textContent || '')) === '未学习');
        if (index < 0) return [];
        const unit = headers[index];
        const nextRowTop = headers[index + 1]?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
        return getPlayEntriesForUnitScope(unit, nextRowTop);
      }),
      clickPendingUnitHeader: () => runSafely('manual clickPendingUnitHeader', () => {
        const unit = getUnitHeaderElements().find((row) => inferStudyStatus(norm(row.textContent || '')) === '未学习');
        if (!unit) return null;
        const target = getUnitHeaderClickTarget(unit) || unit;
        forceClickEl(target) || forceClickEl(unit);
        return {
          target: target.className || target.tagName,
          unit: getUnitHeaderLabel(unit),
        };
      }),
      clickFirstPlaybtn: () => runSafely('manual clickFirstPlaybtn', () => {
        const entries = getCourseListPlayEntries();
        const entry = entries.find((item) => item.status === '未学习' || item.status === '学习中');
        if (!entry) return null;
        clickElOnce(entry.button);
        return {
          title: entry.title,
          status: entry.status,
          text: norm(entry.button.textContent),
        };
      }),
      clickNextPendingUnit: () => runSafely('manual clickNextPendingUnit', () => {
        const snapshot = collectCourseSnapshot() || getCourseSnapshot();
        const progressText =
          snapshot && snapshot.totalLessons > 0
            ? `${snapshot.completedLessons} / ${snapshot.totalLessons}`
            : '未知';
        return tryExpandNextPendingUnit(snapshot, progressText);
      }),
    };
    log('debug hook exposed on page window');

    installWindowOpenGuard();
    runSafely('boot mainLoop', mainLoop);
    setInterval(() => runSafely('interval mainLoop', mainLoop), CFG.scanIntervalMs);

    const observer = new MutationObserver(() => runSafely('mutation mainLoop', mainLoop));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
    });

    window.addEventListener('focus', () => runSafely('focus mainLoop', mainLoop));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) runSafely('visibility mainLoop', mainLoop);
    });
  };

  boot();
})();
