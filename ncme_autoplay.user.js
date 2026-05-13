// ==UserScript==
// @name         NCME Auto Play Helper
// @namespace    https://www.ncme.org.cn/
// @version      0.3.4
// @description  自动静音播放视频，并在当前页面可见时尝试进入下一节。
// @match        https://www.ncme.org.cn/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      qyapi.weixin.qq.com
// @connect      api.openai.com
// @connect      open.bigmodel.cn
// @connect      localhost
// @connect      127.0.0.1
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
  let lastActivePlayerHeartbeatAt = 0;
  let examHooksInstalled = false;
  let examShieldInstalled = false;
  let examAutoStarted = false;
  let examSubmitInProgress = false;
  let examCompletedAt = 0;
  let examSessionKey = '';
  let examReportHandledKey = '';
  let examDynamicAnswerFailedAt = 0;
  let examDynamicAnswerFailedKey = '';
  let traceHooksInstalled = false;
  let traceEnabled = false;
  let learningOpenClickGuardInstalled = false;
  const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const triedPendingUnits = new Set();
  const traceLog = [];
  const examRuntime = {
    apiLog: [],
    context: {},
    lastPaperData: null,
    lastReportData: null,
    lastSubmitPayload: null,
    lastSubmitResponse: null,
  };

  const STORAGE = {
    listUrl: 'ncme.auto.listUrl',
    lastLessonTitle: 'ncme.auto.lastLessonTitle',
    returningToList: 'ncme.auto.returningToList',
    notifyPrefix: 'ncme.auto.notify.',
    courseSnapshot: 'ncme.auto.courseSnapshot',
    listPlayLock: 'ncme.auto.listPlayLock',
    activePlayer: 'ncme.auto.activePlayer',
    examPayloads: 'ncme.auto.examPayloads',
    examPlan: 'ncme.auto.examPlan',
    expectedExam: 'ncme.auto.expectedExam',
    examParamMap: 'ncme.auto.examParamMap',
    examAnswerBank: 'ncme.auto.examAnswerBank',
    examAnswerDraft: 'ncme.auto.examAnswerDraft',
    aiConfig: 'ncme.auto.aiConfig',
    autoStopped: 'ncme.auto.stopped',
    afterExamReturnUrl: 'ncme.auto.afterExamReturnUrl',
  };

  const CFG = {
    scanIntervalMs: 3000,
    nextDelayMs: 2000,
    navigationTimeoutMs: 12000,
    listPlayQuietAfterClickMs: 30 * 1000,
    activePlayerStaleMs: 20 * 1000,
    activePlayerHeartbeatMs: 5000,
    examAutoStartDelayMs: 1500,
    examReportReturnDelayMs: 2500,
    debug: true,
    autoExpandUnits: true,
    reuseLearningPlayerTab: true,
    notifyTimeZone: 'Asia/Shanghai',
    courseButtonText: /立即播放|继续学习|开始学习|去学习|去播放/,
    nextButtonText: /下一节|下一课|下一讲|下一个|继续学习|继续播放/,
    examMarkerText: /考试|测验|答题|提交试卷|交卷/,
    listStatusText: /未学习|学习中|未完成/,
    courseItemTitleText: /^(单元\s*\d+|课程\s*\d+|第?\d+\s*[讲课节章]).+/,
    skipAutoPlayItemText: /课程考核|考核|考试|测验|答题/,
    unitHeaderText: /(?:\(|（)必修(?:\)|）)/,
    unitPendingText: /未学习|学习中/,
    fallbackCourseListUrl: 'https://www.ncme.org.cn/study-course/10085?projectType=4&periodId=10140',
    notify: {
      enabled: false,
      webhookUrl: 'REPLACE_ME',
      mentionedMobiles: [],
      messageType: 'markdown',
      timeoutMs: 15000,
      progressIntervalMs: 5 * 60 * 1000,
      sendLevels: {
        START: true,
        DONE: true,
        ERROR: true,
        WARN: true,
        EXAM: false,
        LIST: false,
        PROGRESS: false,
        UNIT: false,
        NEXT: false,
      },
    },
    exam: {
      enabled: true,
      autoSubmit: true,
      autoSelectBySheet: true,
      autoAnswerByBank: true,
      autoAnswerByAi: true,
      minPassingScore: 80,
      stopOnLowScore: true,
      answerSheets: {
        1: 'ABCCB',
        2: 'CBBCC',
        3: 'BCBBA',
        4: 'BCCBB',
        5: 'BDCBC',
        6: 'DCBDC',
        7: 'CBCBB',
        8: 'ACCBC',
        9: 'CBBBB',
        10: 'BBBCB',
      },
      topicIdToPaperNo: {
        '76474': 1,
        '76473': 2,
      },
      paperIdToPaperNo: {
        '28502224': 1,
        '28502225': 2,
      },
      paperIdSequenceBase: 28502223,
    },
    ai: {
      enabled: false,
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      apiKey: '',
      model: 'glm-4-flash',
      timeoutMs: 30000,
      temperature: 0,
      maxTokens: 32,
      maxQuestionsPerRequest: 10,
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

  const resolvePageUrl = (url) => {
    try {
      return new URL(String(url || ''), location.href);
    } catch (_) {
      return null;
    }
  };

  const shouldReuseLearningOpen = (url) => {
    if (!CFG.reuseLearningPlayerTab || !isStudyCoursePage()) return false;
    const parsed = resolvePageUrl(url);
    return !!parsed && parsed.origin === location.origin && /\/player\/record/.test(parsed.pathname || '');
  };

  const navigateLearningOpenInCurrentTab = (url, source = 'window.open') => {
    const parsed = resolvePageUrl(url);
    if (!parsed) return false;
    rememberListUrl();
    clearActivePlayer(`reuse-current-tab:${source}`);
    beginNavigation(`reuse-player:${source}`, parsed.href);
    log('reuse current tab for player:', parsed.href);
    location.assign(parsed.href);
    return true;
  };

  const installLearningOpenClickGuard = () => {
    if (learningOpenClickGuardInstalled) return;
    learningOpenClickGuardInstalled = true;
    document.addEventListener(
      'click',
      (event) => {
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor || !shouldReuseLearningOpen(anchor.href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        navigateLearningOpenInCurrentTab(anchor.href, 'anchor');
      },
      true,
    );
  };

  const installWindowOpenGuard = () => {
    installLearningOpenClickGuard();
    const currentOpen = PAGE_WINDOW.open;
    if (typeof currentOpen !== 'function' || currentOpen.__ncmeAutoGuarded) return;

    const guardedOpen = function guardedOpen(url, target, features) {
      const normalizedUrl = String(url || '');
      const current = now();
      if (shouldReuseLearningOpen(normalizedUrl) && navigateLearningOpenInCurrentTab(normalizedUrl, 'window.open')) {
        return PAGE_WINDOW;
      }

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

  const compact = (s) => norm(s).replace(/\s+/g, '');

  const getExamActionText = (el) => norm(el?.value || el?.innerText || el?.textContent || '');

  const getExamActionCompactText = (el) => compact(el?.value || el?.innerText || el?.textContent || '');

  const now = () => Date.now();

  const hashText = (text) => encodeURIComponent(norm(text)).slice(0, 120) || 'empty';

  const escapeCss = (value) => {
    const text = String(value || '');
    if (PAGE_WINDOW.CSS?.escape) {
      return PAGE_WINDOW.CSS.escape(text);
    }
    return text.replace(/["\\]/g, '\\$&');
  };

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

  const safeJsonParse = (value, fallback = null) => {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(String(value));
    } catch (_) {
      return fallback;
    }
  };

  const normalizeAnswerLetters = (value) => {
    if (Array.isArray(value)) {
      return value.map(normalizeAnswerLetters).join('');
    }
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-F]/g, '')
      .split('')
      .filter((letter, index, arr) => arr.indexOf(letter) === index)
      .join('');
  };

  const normalizeAnswerSequence = (value) =>
    String(value || '').toUpperCase().replace(/[^A-F]/g, '');

  const normalizeOptionText = (value) =>
    norm(String(value || '').replace(/^[A-F][\s).:、．-]*/i, ''));

  const getExamAnswerBank = () =>
    readJsonStorage(STORAGE.examAnswerBank, {
      version: 1,
      updatedAt: 0,
      items: {},
    });

  const saveExamAnswerBank = (bank) => {
    const next = bank && typeof bank === 'object' ? bank : {};
    next.version = next.version || 1;
    next.updatedAt = now();
    next.items = next.items && typeof next.items === 'object' ? next.items : {};
    setStorage(STORAGE.examAnswerBank, JSON.stringify(next));
    return next;
  };

  const getQuestionCode = (question) =>
    String(
      question?.code ??
      question?.questionCode ??
      question?.id ??
      question?.questionId ??
      question?.questionNum ??
      question?.no ??
      ''
    ).trim();

  const getQuestionText = (question) => {
    const value =
      question?.title ??
      question?.questionTitle ??
      question?.content ??
      question?.questionContent ??
      question?.stem ??
      question?.name ??
      '';
    return norm(String(value || '').replace(/<[^>]+>/g, ' '));
  };

  const extractOptionList = (question) => {
    const sources = [
      question?.optionalContent,
      question?.optionContent,
      question?.option,
      question?.optionList,
      question?.questionOptionList,
      question?.options,
      question?.choiceList,
      question?.choices,
      question?.items,
      question?.answerList,
      question?.answers,
      question?.selectList,
    ].filter(Boolean);

    const out = [];
    const push = (letter, text) => {
      const key = String(letter || '').toUpperCase().replace(/[^A-F]/g, '').slice(0, 1);
      if (!key) return;
      const optionText = normalizeOptionText(text);
      if (out.some((item) => item.letter === key)) return;
      out.push({ letter: key, text: optionText || key });
    };

    for (const source of sources) {
      if (Array.isArray(source)) {
        source.forEach((item, index) => {
          if (typeof item === 'string') {
            const match = item.match(/^\s*([A-F])[\s).:、．-]*(.*)$/i);
            push(match?.[1] || String.fromCharCode(65 + index), match?.[2] || item);
            return;
          }
          push(
            item?.optionCode ?? item?.code ?? item?.label ?? item?.key ?? String.fromCharCode(65 + index),
            item?.optionContent ?? item?.content ?? item?.text ?? item?.name ?? item?.title ?? ''
          );
        });
        continue;
      }

      if (typeof source === 'object') {
        Object.keys(source)
          .sort()
          .forEach((key, index) => {
            const letter = /^[A-F]$/i.test(key) ? key : String.fromCharCode(65 + index);
            push(letter, source[key]);
          });
        continue;
      }

      const plainText = String(source).replace(/<[^>]+>/g, ' ');
      const inlineMatches = Array.from(
        plainText.matchAll(/(?:^|[\s;；|])([A-F])[\s).:：、．-]+([\s\S]*?)(?=(?:[\s;；|][A-F][\s).:：、．-]+)|$)/gi)
      );
      if (inlineMatches.length >= 2) {
        inlineMatches.forEach((match) => push(match[1], match[2]));
        continue;
      }

      String(source)
        .split(/\n|<br\s*\/?>|<\/p>|<\/li>/i)
        .map((item) => norm(item.replace(/<[^>]+>/g, ' ')))
        .filter(Boolean)
        .forEach((item, index) => {
          const match = item.match(/^\s*([A-F])[\s).:、．-]*(.*)$/i);
          if (match) push(match[1], match[2]);
          else if (index < 6) push(String.fromCharCode(65 + index), item);
        });
    }

    return out.sort((a, b) => a.letter.localeCompare(b.letter));
  };

  const buildQuestionInfo = (question, index = 0) => {
    const code = getQuestionCode(question);
    const text = getQuestionText(question);
    const options = extractOptionList(question);
    const optionSignature = options.map((item) => `${item.letter}:${item.text}`).join('|');
    return {
      index: index + 1,
      code,
      text,
      options,
      key: `hash:${hashText(`${text}|${optionSignature}`)}`,
      codeKey: code ? `code:${code}` : '',
    };
  };

  const filterAnswerByQuestionOptions = (answer, questionInfo) => {
    const normalized = normalizeAnswerLetters(answer);
    if (!normalized) return '';
    const optionLetters = new Set((questionInfo?.options || []).map((item) => item.letter).filter(Boolean));
    if (!optionLetters.size) return normalized;
    return normalized
      .split('')
      .filter((letter) => optionLetters.has(letter))
      .join('');
  };

  const getBankAnswerForQuestion = (questionInfo) => {
    const bank = getExamAnswerBank();
    const items = bank.items || {};
    const hit = (questionInfo.codeKey && items[questionInfo.codeKey]) || items[questionInfo.key] || null;
    const answer = filterAnswerByQuestionOptions(hit?.answer || '', questionInfo);
    if (!answer) return null;
    return {
      answer,
      source: hit.source || 'bank',
      updatedAt: hit.updatedAt || 0,
    };
  };

  const writeBankAnswers = (records, source = 'verified') => {
    const valid = (records || []).filter((item) => item?.questionInfo && filterAnswerByQuestionOptions(item.answer, item.questionInfo));
    if (!valid.length) return 0;

    const bank = getExamAnswerBank();
    bank.items = bank.items && typeof bank.items === 'object' ? bank.items : {};

    for (const item of valid) {
      const questionInfo = item.questionInfo;
      const answer = filterAnswerByQuestionOptions(item.answer, questionInfo);
      if (!answer) continue;
      const payload = {
        answer,
        source,
        verified: true,
        question: questionInfo.text || '',
        options: questionInfo.options || [],
        code: questionInfo.code || '',
        topicId: String(item.topicId || ''),
        paperId: String(item.paperId || ''),
        updatedAt: now(),
      };
      bank.items[questionInfo.key] = payload;
      if (questionInfo.codeKey) {
        bank.items[questionInfo.codeKey] = payload;
      }
    }

    saveExamAnswerBank(bank);
    return valid.length;
  };

  const saveExamAnswerDraft = (items, source = 'unknown') => {
    const context = getExamContext();
    const payload = {
      sessionKey: buildExamSessionKey(),
      source,
      context,
      items: (items || []).map((item) => ({
        questionInfo: item.questionInfo,
        answer: filterAnswerByQuestionOptions(item.answer, item.questionInfo),
        source: item.source || source,
      })).filter((item) => item.questionInfo && item.answer),
      updatedAt: now(),
    };
    setStorage(STORAGE.examAnswerDraft, JSON.stringify(payload));
    return payload;
  };

  const getExamAnswerDraft = () => readJsonStorage(STORAGE.examAnswerDraft, null);

  const clearExamAnswerDraft = () => removeStorage(STORAGE.examAnswerDraft);

  const getAiConfig = () => ({
    ...CFG.ai,
    ...(readJsonStorage(STORAGE.aiConfig, {}) || {}),
  });

  const setAiConfig = (value) => {
    const parsed = safeJsonParse(value, value);
    if (!parsed || typeof parsed !== 'object') return false;
    setStorage(STORAGE.aiConfig, JSON.stringify(parsed));
    return getAiConfig();
  };

  const getAiConfigProblem = (ai = getAiConfig()) => {
    if (!ai.enabled) return 'AI disabled';
    if (!ai.endpoint) return 'AI endpoint missing';
    if (!ai.model) return 'AI model missing';
    if (/api\.openai\.com/i.test(String(ai.endpoint || '')) && !ai.apiKey) return 'AI apiKey missing';
    return '';
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
    const match = text.match(/^(单元\s*\d+|课程\s*\d+|第?\d+\s*[讲课节章])[-—–:：]?\s*(.*)$/);
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

  const getExamPlan = () => readJsonStorage(STORAGE.examPlan, null);

  const getExamParamMap = () =>
    readJsonStorage(STORAGE.examParamMap, {
      byTopicId: {},
      byPaperId: {},
      items: [],
    }) || { byTopicId: {}, byPaperId: {}, items: [] };

  const setExamParamMap = (value) => {
    const next = value || {};
    next.byTopicId = next.byTopicId || {};
    next.byPaperId = next.byPaperId || {};
    next.items = Array.isArray(next.items) ? next.items : [];
    setStorage(STORAGE.examParamMap, JSON.stringify(next));
    return next;
  };

  const derivePaperNoFromPaperId = (paperId) => {
    const numeric = Number(String(paperId || '').trim());
    const base = Number(CFG.exam.paperIdSequenceBase || 0);
    if (!Number.isFinite(numeric) || !Number.isFinite(base) || base <= 0) return 0;
    const paperNo = numeric - base;
    return CFG.exam.answerSheets[paperNo] ? paperNo : 0;
  };

  const rememberExamParamMapping = (context = {}, paperNo = 0, source = '') => {
    const resolvedPaperNo = Number(paperNo || 0);
    if (!resolvedPaperNo || !CFG.exam.answerSheets[resolvedPaperNo]) return false;

    const topicId = String(context.topicId || '').trim();
    const paperId = String(context.paperId || '').trim();
    if (!topicId && !paperId) return false;

    const map = getExamParamMap();
    if (topicId) map.byTopicId[topicId] = resolvedPaperNo;
    if (paperId) map.byPaperId[paperId] = resolvedPaperNo;

    const key = `${topicId || '-'}|${paperId || '-'}`;
    const existing = map.items.find((item) => item.key === key);
    const item = {
      key,
      topicId,
      paperId,
      paperNo: resolvedPaperNo,
      source: source || 'runtime',
      updatedAt: now(),
    };
    if (existing) {
      Object.assign(existing, item);
    } else {
      map.items.push(item);
    }
    while (map.items.length > 80) map.items.shift();
    setExamParamMap(map);
    return true;
  };

  const setExamPlan = (plan) => {
    try {
      localStorage.setItem(STORAGE.examPlan, JSON.stringify(plan));
    } catch (_) {
      // Ignore storage failures.
    }
  };

  const getExpectedExam = () => {
    const data = readJsonStorage(STORAGE.expectedExam, null);
    if (!data?.updatedAt) return data;
    if (now() - Number(data.updatedAt) > 30 * 60 * 1000) {
      removeStorage(STORAGE.expectedExam);
      return null;
    }
    return data;
  };

  const setExpectedExam = (paperNo, meta = {}) => {
    if (!paperNo) return false;
    setStorage(STORAGE.expectedExam, JSON.stringify({
      paperNo: Number(paperNo) || 0,
      updatedAt: now(),
      ...meta,
    }));
    return true;
  };

  const clearExpectedExam = () => removeStorage(STORAGE.expectedExam);

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

  const getProgressText = (snapshot) =>
    snapshot && Number(snapshot.totalLessons) > 0
      ? `${snapshot.completedLessons} / ${snapshot.totalLessons}`
      : '未知';

  const escapeMd = (text) => String(text || '').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');

  const formatNotifyTime = (date = new Date()) => {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: CFG.notifyTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date).replace(/\//g, '-');
    } catch (_) {
      return date.toISOString();
    }
  };

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
      const sharedDuration = Number(shared.until) - Number(shared.createdAt || current);
      if (sharedDuration > CFG.listPlayQuietAfterClickMs + 5000) {
        removeStorage(STORAGE.listPlayLock);
        return false;
      }

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
      formatNotifyTime(new Date(listPlayLockUntil)),
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

  const getListActionLockKey = (prefix, entry) =>
    `${prefix}:${hashText(entry?.rowText || entry?.title || norm(entry?.button?.textContent || ''))}`;

  const isSameListActionLocked = (lockKey) =>
    isListPlayLocked() && lastListPlayKey === lockKey;

  const beginLockedListAction = (lockKey, navigationReasonValue, entry) => {
    beginListPlayLock(lockKey, entry?.title || '');
    beginNavigation(navigationReasonValue, entry?.title || '');
  };

  const clickListEntryAction = (entry, options = {}) => {
    const kind = options.kind || 'play';
    const isExam = kind === 'exam';
    const lockPrefix = isExam ? 'list-exam' : 'list-play';
    const lockKey = getListActionLockKey(lockPrefix, entry);
    if (isSameListActionLocked(lockKey)) return true;

    log(isExam ? 'click exam button:' : 'click course button:', entry.title, entry.status, norm(entry.button?.textContent || ''));
    beginLockedListAction(lockKey, `${lockPrefix}:${entry.status || 'pending'}`, entry);
    if (isExam && options.expectedExamSource) {
      setExpectedExamFromEntry(entry, options.expectedExamSource);
    }

    if (clickElOnce(entry.button)) {
      void notifyListEntry(options.notifyTitle || (isExam ? '从课程目录进入试卷' : '从课程列表进入视频'), entry, options.snapshot, options.progressText, {
        keyPrefix: options.keyPrefix || (isExam ? 'list-exam-click' : 'list-click'),
      });
      removeStorage(STORAGE.returningToList);
      return true;
    }

    const failureReason = options.failureReason || (isExam ? 'exam-click-failed' : 'list-click-failed');
    clearListPlayLock(failureReason);
    resetNavigationState(failureReason);
    return false;
  };

  const getActivePlayer = () => readJsonStorage(STORAGE.activePlayer, null);

  const isActivePlayerFresh = () => {
    const active = getActivePlayer();
    if (!active?.updatedAt) return false;

    const age = now() - Number(active.updatedAt);
    if (age <= CFG.activePlayerStaleMs) return true;

    removeStorage(STORAGE.activePlayer);
    return false;
  };

  const markActivePlayer = (reason = 'heartbeat') => {
    if (!/\/player\/record/.test(location.pathname)) return;
    const current = now();
    if (current - lastActivePlayerHeartbeatAt < CFG.activePlayerHeartbeatMs && reason === 'heartbeat') return;

    lastActivePlayerHeartbeatAt = current;
    setStorage(
      STORAGE.activePlayer,
      JSON.stringify({
        tabId,
        reason,
        title: getCurrentLessonTitle() || '',
        url: location.href,
        updatedAt: current,
      }),
    );
  };

  const clearActivePlayer = (reason = 'clear') => {
    const active = getActivePlayer();
    if (!active || !active.tabId || active.tabId === tabId || reason === 'manual') {
      removeStorage(STORAGE.activePlayer);
      log('active player clear:', reason);
    }
  };

  const pushExamApiLog = (item) => {
    examRuntime.apiLog.push({
      time: new Date().toISOString(),
      ...item,
    });
    while (examRuntime.apiLog.length > 80) examRuntime.apiLog.shift();
  };

  const absorbExamUrlContext = (rawUrl) => {
    const urlText = String(rawUrl || '').trim();
    if (!urlText) return;

    try {
      const parsed = new URL(urlText, location.origin);
      const params = parsed.searchParams;
      for (const key of ['paperId', 'periodId', 'sourceType', 'topicId', 'batchId', 'examinationCode']) {
        const value = params.get(key);
        if (value) {
          examRuntime.context[key] = value;
        }
      }
      const inferredPaperNo =
        derivePaperNoFromPaperId(examRuntime.context.paperId) ||
        Number(getExpectedExam()?.paperNo || 0);
      rememberExamParamMapping(examRuntime.context, inferredPaperNo, `url:${parsed.pathname}`);
    } catch (_) {
      // Ignore invalid URL parsing.
    }
  };

  const absorbExamContext = (value) => {
    const data = safeJsonParse(value, value);
    if (!data || typeof data !== 'object') return;

    const keys = [
      'examinationCode',
      'periodId',
      'sourceType',
      'topicId',
      'batchId',
      'evaluationType',
      'practiceMode',
      'useTime',
      'userToken',
      'userIdentification',
    ];

    for (const key of keys) {
      if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
        examRuntime.context[key] = data[key];
      }
    }

    if (Array.isArray(data.questions)) {
      examRuntime.context.questions = data.questions;
    }

    if (data.data && typeof data.data === 'object') {
      absorbExamContext(data.data);
    }
  };

  const installExamApiHooks = () => {
    if (examHooksInstalled) return true;
    examHooksInstalled = true;

    const isExamApiUrl = (url) =>
      /\/resourceApi\//.test(String(url || '')) &&
      /(?:exam|paper|qbank|report|score|analysis|result)/i.test(String(url || ''));
    const isReportApiUrl = (url) => /(?:report|score|analysis|result)/i.test(String(url || ''));

    try {
      const originalFetch = PAGE_WINDOW.fetch;
      if (typeof originalFetch === 'function' && !originalFetch.__ncmeAutoExamWrapped) {
        const wrappedFetch = function (...args) {
          const url = String(args[0]?.url || args[0] || '');
          const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
          const body = args[1]?.body || args[0]?.body || '';

          if (!isExamApiUrl(url)) {
            return originalFetch.apply(this, args);
          }

          absorbExamUrlContext(url);
          const requestBody = safeJsonParse(body, body);
          absorbExamContext(requestBody);
          pushExamApiLog({
            kind: 'fetch',
            stage: 'request',
            url,
            method,
            body: liteValue(requestBody, 0),
          });

          return originalFetch.apply(this, args).then(async (resp) => {
            let text = '';
            let json = null;
            try {
              text = await resp.clone().text();
              json = safeJsonParse(text, null);
            } catch (_) {
              // Ignore clone/text failures.
            }
            absorbExamContext(json);
            if (isReportApiUrl(url)) {
              examRuntime.lastReportData = json || text;
            } else if (/submitPaper/.test(url)) {
              examRuntime.lastSubmitPayload = requestBody;
              examRuntime.lastSubmitResponse = json || text;
            } else if (/paper/.test(url)) {
              examRuntime.lastPaperData = json || text;
            }
            pushExamApiLog({
              kind: 'fetch',
              stage: 'response',
              url: resp.url || url,
              method,
              status: resp.status,
              body: liteValue(json || text, 0),
            });
            return resp;
          });
        };
        wrappedFetch.__ncmeAutoExamWrapped = true;
        PAGE_WINDOW.fetch = wrappedFetch;
      }
    } catch (err) {
      log('exam fetch hook failed:', err);
    }

    try {
      const XHR = PAGE_WINDOW.XMLHttpRequest;
      if (XHR?.prototype && !XHR.prototype.__ncmeAutoExamWrapped) {
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url, ...rest) {
          this.__ncmeExamTrace = {
            method: String(method || 'GET').toUpperCase(),
            url: String(url || ''),
          };
          return originalOpen.call(this, method, url, ...rest);
        };
        XHR.prototype.send = function (body) {
          const meta = this.__ncmeExamTrace || {};
          if (!isExamApiUrl(meta.url)) {
            return originalSend.call(this, body);
          }

          absorbExamUrlContext(meta.url);
          const requestBody = safeJsonParse(body, body);
          absorbExamContext(requestBody);
          pushExamApiLog({
            kind: 'xhr',
            stage: 'request',
            url: meta.url,
            method: meta.method,
            body: liteValue(requestBody, 0),
          });

          this.addEventListener?.('loadend', () => {
            let json = null;
            const text = typeof this.responseText === 'string' ? this.responseText : '';
            if (text) {
              json = safeJsonParse(text, null);
            }
            absorbExamContext(json);
            if (isReportApiUrl(meta.url)) {
              examRuntime.lastReportData = json || text;
            } else if (/submitPaper/.test(meta.url)) {
              examRuntime.lastSubmitPayload = requestBody;
              examRuntime.lastSubmitResponse = json || text;
            } else if (/paper/.test(meta.url)) {
              examRuntime.lastPaperData = json || text;
            }
            pushExamApiLog({
              kind: 'xhr',
              stage: 'response',
              url: this.responseURL || meta.url,
              method: meta.method,
              status: this.status,
              body: liteValue(json || text, 0),
            });
          });

          return originalSend.call(this, body);
        };
        XHR.prototype.__ncmeAutoExamWrapped = true;
      }
    } catch (err) {
      log('exam xhr hook failed:', err);
    }

    return true;
  };

  const installExamFocusShield = () => {
    if (examShieldInstalled) return true;
    examShieldInstalled = true;

    const stop = (event) => {
      try {
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
      } catch (_) {
        // Ignore event guard failures.
      }
    };

    const defineGetter = (obj, key, getter) => {
      try {
        Object.defineProperty(obj, key, {
          configurable: true,
          enumerable: true,
          get: getter,
        });
      } catch (_) {
        // Ignore defineProperty failures.
      }
    };

    for (const type of ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange']) {
      document.addEventListener(type, stop, true);
      PAGE_WINDOW.addEventListener(type, stop, true);
    }
    for (const type of ['blur', 'pagehide', 'freeze']) {
      PAGE_WINDOW.addEventListener(type, stop, true);
    }

    defineGetter(document, 'hidden', () => false);
    defineGetter(document, 'visibilityState', () => 'visible');
    defineGetter(document, 'webkitHidden', () => false);
    defineGetter(document, 'webkitVisibilityState', () => 'visible');

    try {
      document.hasFocus = () => true;
    } catch (_) {
      // Ignore assignment failures.
    }

    try {
      PAGE_WINDOW.onblur = null;
      document.onvisibilitychange = null;
      document.onwebkitvisibilitychange = null;
    } catch (_) {
      // Ignore handler cleanup failures.
    }

    log('exam focus shield installed');
    return true;
  };

  const buildNotifyMarkdown = (level, title, lines = []) => {
    const safeLines = lines.filter(Boolean).map((line) => `> ${escapeMd(line)}`);
    return [
      `## NCME \\| ${escapeMd(level)} \\| ${escapeMd(title)}`,
      ...safeLines,
      `> 页面: ${escapeMd(location.pathname)}`,
      `> 时间(${escapeMd(CFG.notifyTimeZone)}): ${escapeMd(formatNotifyTime())}`,
    ].join('\n');
  };

  const buildNotifyText = (level, title, lines = []) => [
    `[NCME][${level}] ${title}`,
    ...lines.filter(Boolean),
    `页面: ${location.pathname}`,
    `时间(${CFG.notifyTimeZone}): ${formatNotifyTime()}`,
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

  const postAiChatCompletion = (messages) => new Promise((resolve, reject) => {
    const ai = getAiConfig();
    const problem = getAiConfigProblem(ai);
    if (problem) {
      reject(new Error(problem));
      return;
    }

    const headers = {
      'Content-Type': 'application/json',
    };
    if (ai.apiKey) {
      headers.Authorization = `Bearer ${ai.apiKey}`;
    }

    const requestPayload = {
      model: ai.model,
      messages,
      temperature: ai.temperature ?? 0,
    };
    if (ai.maxTokens) {
      requestPayload.max_tokens = ai.maxTokens;
    }
    const body = JSON.stringify(requestPayload);

    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: ai.endpoint,
        data: body,
        headers,
        timeout: ai.timeoutMs || 30000,
        onload: (resp) => {
          const json = safeJsonParse(resp.responseText, null);
          if (resp.status >= 200 && resp.status < 300 && json) {
            resolve(json);
            return;
          }
          reject(new Error(`AI request failed: ${resp.status} ${String(resp.responseText || '').slice(0, 200)}`));
        },
        onerror: () => reject(new Error('AI request failed')),
        ontimeout: () => reject(new Error('AI request timeout')),
      });
      return;
    }

    fetch(ai.endpoint, {
      method: 'POST',
      headers,
      body,
      credentials: 'omit',
    })
      .then(async (resp) => {
        const text = await resp.text();
        const json = safeJsonParse(text, null);
        if (!resp.ok || !json) {
          throw new Error(`AI request failed: ${resp.status} ${text.slice(0, 200)}`);
        }
        return json;
      })
      .then(resolve)
      .catch(reject);
  });

  const parseAiAnswers = (content) => {
    const text = String(content || '').replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, '')).trim();
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = safeJsonParse(jsonText, null);
    if (typeof parsed?.answers === 'string') {
      const sequence = normalizeAnswerSequence(parsed.answers);
      return Object.fromEntries(sequence.split('').map((answer, index) => [index + 1, answer]));
    }

    if (/^[A-F\s,;|]+$/i.test(text)) {
      const sequence = normalizeAnswerSequence(text);
      return Object.fromEntries(sequence.split('').map((answer, index) => [index + 1, answer]));
    }

    const compactSequence = text.match(/\b[A-F]{2,}\b/i)?.[0] || '';
    if (compactSequence) {
      const sequence = normalizeAnswerSequence(compactSequence);
      return Object.fromEntries(sequence.split('').map((answer, index) => [index + 1, answer]));
    }

    const rows = Array.isArray(parsed?.answers) ? parsed.answers : Array.isArray(parsed) ? parsed : [];
    const out = {};
    rows.forEach((row) => {
      if (typeof row === 'string') {
        const answer = normalizeAnswerLetters(row);
        if (answer) out[Object.keys(out).length + 1] = answer;
        return;
      }
      const index = Number(row.index ?? row.no ?? row.question ?? row.q);
      const answer = normalizeAnswerLetters(row.answer ?? row.choice ?? row.letter ?? '');
      if (index > 0 && answer) {
        out[index] = answer;
      }
    });
    return out;
  };

  const buildAiQuestionPromptBlock = (item) => [
    `题号: ${item.index}`,
    `题目: ${item.text}`,
    `可选字母: ${item.options.map((option) => option.letter).join(', ')}`,
    ...item.options.map((option) => `${option.letter}. ${option.text}`),
  ].join('\n');

  const parseAiSingleAnswer = (content, questionInfo) => {
    const text = String(content || '').replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, '')).trim();
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = safeJsonParse(jsonText, null);
    const candidates = [];

    if (parsed && typeof parsed === 'object') {
      candidates.push(parsed.answer, parsed.choice, parsed.letter);
      if (Array.isArray(parsed.answers)) {
        parsed.answers.forEach((item) => {
          if (typeof item === 'string') {
            candidates.push(item);
          } else if (item && typeof item === 'object') {
            candidates.push(item.answer, item.choice, item.letter);
          }
        });
      } else {
        candidates.push(parsed.answers);
      }
    }

    const mapped = parseAiAnswers(content);
    candidates.push(mapped?.[questionInfo.index], mapped?.[1], text);

    for (const candidate of candidates) {
      const answer = filterAnswerByQuestionOptions(candidate, questionInfo);
      if (answer) return answer;
    }

    return '';
  };

  const askAiForSingleExamAnswer = async (questionInfo) => {
    const messages = [
      {
        role: 'system',
        content:
          '你是专业的搜题答题助手。用户会给你一道选择题和选项，你必须只从给定选项字母中选择最可能正确的一项。' +
          '严格返回 JSON，不要解释，不要 Markdown。',
      },
      {
        role: 'user',
        content: [
          '请回答下面这道题。',
          buildAiQuestionPromptBlock(questionInfo),
          '返回格式必须是：{"answer":"A"}',
          `answer 只能是这些字母之一：${questionInfo.options.map((option) => option.letter).join(', ')}`,
        ].join('\n\n'),
      },
    ];

    const result = await postAiChatCompletion(messages);
    const content = result?.choices?.[0]?.message?.content || result?.choices?.[0]?.text || '';
    const answer = parseAiSingleAnswer(content, questionInfo);
    log('AI single exam answer:', `Q${questionInfo.index}:${answer || '(empty)'}`, String(content || '').slice(0, 120));
    return answer;
  };

  const askAiForExamAnswersOneByOne = async (questionInfos) => {
    const mapped = {};
    for (const item of questionInfos || []) {
      if (!item?.text || !item?.options?.length) continue;
      try {
        const answer = await askAiForSingleExamAnswer(item);
        if (answer) mapped[item.index] = answer;
      } catch (err) {
        log('AI single answer failed:', `Q${item.index}`, err);
      }
      await sleep(150);
    }
    return mapped;
  };

  const askAiForExamAnswers = async (questionInfos) => {
    const pending = (questionInfos || []).filter((item) => item?.text && item?.options?.length);
    if (!pending.length) return {};

    const ai = getAiConfig();
    const mapped = {};
    const chunkSize = Math.max(1, Number(ai.maxQuestionsPerRequest || CFG.ai.maxQuestionsPerRequest || 10) || 10);

    for (let offset = 0; offset < pending.length; offset += chunkSize) {
      const chunk = pending.slice(offset, offset + chunkSize);
      const messages = [
        {
          role: 'system',
          content:
            '你是专业的搜题答题助手。用户会给你一组选择题和选项。' +
            '请逐题判断答案，必须只从每题给定的可选字母中选择。' +
            '严格返回 JSON，不要解释，不要 Markdown。',
        },
        {
          role: 'user',
          content: [
            `共有 ${chunk.length} 道题。返回 answers 数组，必须覆盖每一道题。`,
            'JSON 格式示例：{"answers":[{"index":1,"answer":"A"},{"index":2,"answer":"B"}]}',
            ...chunk.map(buildAiQuestionPromptBlock),
          ].join('\n\n'),
        },
      ];

      const result = await postAiChatCompletion(messages);
      const content = result?.choices?.[0]?.message?.content || result?.choices?.[0]?.text || '';
      const answers = parseAiAnswers(content);
      chunk.forEach((item, position) => {
        const rawAnswer = answers[item.index] || answers[position + 1] || '';
        const answer = filterAnswerByQuestionOptions(rawAnswer, item);
        if (answer) mapped[item.index] = answer;
      });
      log('AI exam answer batch:', `${offset + 1}-${offset + chunk.length}/${pending.length}`, Object.keys(mapped).map((key) => `Q${key}:${mapped[key]}`).join(' | ') || '(empty)');
    }

    log('AI exam answers:', Object.keys(mapped).map((key) => `Q${key}:${mapped[key]}`).join(' | ') || '(empty)');
    return mapped;
  };

  const sendNotify = async (level, title, lines = [], options = {}) => {
    if (!CFG.notify.enabled) return false;
    if (!CFG.notify.webhookUrl || /REPLACE_ME/.test(CFG.notify.webhookUrl)) return false;
    if (!options.force && CFG.notify.sendLevels && CFG.notify.sendLevels[level] === false) return false;

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

  const notifyListEntry = (title, entry, snapshot, progressText, options = {}) => {
    const parsed = parseLessonTitle(entry?.title || '');
    return sendNotify('LIST', title, [
      snapshot?.courseTitle ? `课程: ${snapshot.courseTitle}` : '',
      parsed.unitLabel ? `单元: ${parsed.unitLabel}` : '',
      parsed.lessonName ? `内容: ${parsed.lessonName}` : entry?.title ? `当前: ${entry.title}` : '',
      `整体进度: ${progressText || '未知'}`,
      entry?.status ? `状态: ${entry.status}` : '',
      entry?.button ? `按钮: ${norm(entry.button.textContent || '')}` : '',
    ], {
      intervalMs: options.intervalMs ?? 5000,
      key: `${options.keyPrefix || 'list-entry'}:${hashText(entry?.rowText || entry?.title || norm(entry?.button?.textContent || ''))}`,
    });
  };

  const notifyListStatus = (title, snapshot, progressText, lines = [], options = {}) =>
    sendNotify('LIST', title, [
      snapshot?.courseTitle ? `课程: ${snapshot.courseTitle}` : '',
      `整体进度: ${progressText || '未知'}`,
      ...lines,
    ], {
      intervalMs: options.intervalMs ?? 5000,
      key: options.key || `${title}:${hashText(lines.join('|'))}`,
    });

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

  const getDetailRowEntries = (root = document) =>
    Array.from(root.querySelectorAll('.courseStudyInfoDetail'));

  const sortEntriesByTop = (entries) =>
    entries.sort((a, b) =>
      (a.detailRow || a.button).getBoundingClientRect().top -
      (b.detailRow || b.button).getBoundingClientRect().top
    );

  const getPlayEntryFromDetailRow = (detailRow) => {
    const rowText = norm(detailRow?.textContent || '');
    const button = detailRow?.querySelector?.('.playbtn') || null;
    const title = extractLessonTitleFromText(rowText);
    const unitItem = detailRow?.closest?.('.courseStudyItem') || button?.closest?.('.courseStudyItem') || null;
    const unitText = norm(unitItem?.textContent || '');
    return {
      button,
      detailRow,
      rowText,
      title,
      status: inferStudyStatus(rowText),
      buttonVisible: !!button && isVisible(button),
      rowVisible: !!detailRow && isVisible(detailRow),
      unitItem,
      unitText,
      unitStatus: inferStudyStatus(unitText),
    };
  };

  const isPlayableEntry = (entry, { includeHidden = false, requirePending = false } = {}) =>
    !!entry?.button &&
    (includeHidden || isVisible(entry.button)) &&
    !isDisabled(entry.button) &&
    (!requirePending || isPendingLessonText(entry.rowText)) &&
    !CFG.skipAutoPlayItemText.test(entry.rowText || '');

  const getExamActionButton = (detailRow) =>
    Array.from(detailRow?.querySelectorAll?.('.playbtn,button,a,[role="button"],.el-button,span,div') || [])
      .find((candidate) =>
        isVisible(candidate) &&
        !isDisabled(candidate) &&
        isExamActionText(candidate.textContent || candidate.value || '')
      ) || null;

  const getExamEntryFromDetailRow = (detailRow) => {
    const rowText = norm(detailRow?.textContent || '');
    return {
      button: getExamActionButton(detailRow),
      detailRow,
      rowText,
      title: extractExamTitleFromText(rowText) || extractLessonTitleFromText(rowText) || rowText.split(' ').slice(0, 6).join(' '),
      status: inferExamProgress(rowText),
    };
  };

  const isExamEntryVisible = (entry) =>
    !!entry?.button &&
    isVisible(entry.button) &&
    !isDisabled(entry.button) &&
    /(?:\u8bfe\u7a0b\u8003\u6838|\u8003\u6838|\u8bd5\u5377|\u8003\u8bd5|\u6d4b\u9a8c|\u7b54\u9898)/.test(entry.rowText || '');

  const getCourseListPlayEntries = () => {
    if (!isStudyCoursePage()) return [];

    return Array.from(document.querySelectorAll('.playbtn'))
      .filter((btn) => {
        const text = norm(btn.textContent || '');
        return text && CFG.courseButtonText.test(text) && isVisible(btn) && !isDisabled(btn);
      })
      .map((button) => {
        const detailRow = getCandidateRow(button);
        const unitItem = button.closest('.courseStudyItem');
        const unitText = norm(unitItem?.textContent || '');
        return {
          ...getPlayEntryFromDetailRow(detailRow),
          unitItem,
          unitText,
          unitStatus: inferStudyStatus(unitText),
          button,
        };
      })
      .filter((entry) => entry.title);
  };

  const isPendingLessonText = (text) => {
    const value = norm(text || '');
    return /未学习|学习中/.test(value) || inferStudyStatus(value) === '未学习' || inferStudyStatus(value) === '学习中';
  };

  const getPendingPlayEntries = (includeHidden = false) =>
    sortEntriesByTop(
      getDetailRowEntries()
        .map(getPlayEntryFromDetailRow)
        .filter((entry) => isPlayableEntry(entry, { includeHidden, requirePending: true }))
    );

  const isExamActionText = (text) => /^(?:\u53bb\u505a\u9898|\u53bb\u7b54\u9898|\u53bb\u8003\u8bd5|\u5f00\u59cb\u8003\u8bd5|\u5f00\u59cb\u7b54\u9898|\u7ee7\u7eed\u8003\u8bd5|\u7ee7\u7eed\u7b54\u9898|\u7acb\u5373\u7b54\u9898|\u7acb\u5373\u8003\u8bd5)$/.test(compact(text || ''));

  const inferExamProgress = (text) => {
    const value = norm(text || '');
    if (/\u5df2\u901a\u8fc7/.test(value)) return '\u5df2\u901a\u8fc7';
    if (/\u672a\u901a\u8fc7/.test(value)) return '\u672a\u901a\u8fc7';
    if (/\u5b66\u4e60\u4e2d/.test(value)) return '\u5b66\u4e60\u4e2d';
    if (/\u672a\u5b66\u4e60/.test(value)) return '\u672a\u5b66\u4e60';
    if (/\u5df2\u5b8c\u6210/.test(value)) return '\u5df2\u5b8c\u6210';
    return inferStudyStatus(value);
  };

  const extractExamTitleFromText = (text) => {
    const lines = String(text || '')
      .split('\n')
      .map((line) => norm(line))
      .filter(Boolean);

    return lines.find((line) =>
      /(?:\u8bfe\u7a0b\u8003\u6838|\u8003\u6838|\u8bd5\u5377|\u8003\u8bd5|\u6d4b\u9a8c|\u7b54\u9898)/.test(line) &&
      !/(?:\u4efb\u52a1\u70b9|\u5b8c\u6210\u6807\u51c6|\u8003\u8bd5\u533a\u95f4|\u7acb\u5373\u64ad\u653e|\u53bb\u505a\u9898|\u5df2\u901a\u8fc7|\u672a\u901a\u8fc7|\u5df2\u5b8c\u6210)/.test(line)
    ) || '';
  };

  const getCourseListExamEntries = () => {
    if (!isStudyCoursePage()) return [];

    return sortEntriesByTop(
      getDetailRowEntries()
        .map(getExamEntryFromDetailRow)
        .filter((entry) => entry.button && /(?:\u8bfe\u7a0b\u8003\u6838|\u8003\u6838|\u8bd5\u5377|\u8003\u8bd5|\u6d4b\u9a8c|\u7b54\u9898)/.test(entry.rowText))
    );
  };

  const getPendingExamEntry = () =>
    getCourseListExamEntries().find((entry) => !/^(?:\u5df2\u901a\u8fc7|\u5df2\u5b8c\u6210)$/.test(entry.status)) || null;

  const isPendingExamEntry = (entry) =>
    !!entry && !/^(?:\u5df2\u901a\u8fc7|\u5df2\u5b8c\u6210)$/.test(String(entry.status || ''));

  const getExamEntriesForUnitItem = (unitItem) => {
    if (!unitItem) return [];

    return sortEntriesByTop(
      getDetailRowEntries(unitItem)
        .map(getExamEntryFromDetailRow)
        .filter(isExamEntryVisible)
    );
  };

  const getExamEntriesForUnitScope = (unitItem, nextRowTop = Number.POSITIVE_INFINITY) => {
    if (!unitItem) return [];

    const directEntries = getExamEntriesForUnitItem(unitItem);
    if (directEntries.length > 0) {
      return directEntries;
    }

    const rowTop = unitItem.getBoundingClientRect().top;
    return getCourseListExamEntries()
      .filter((entry) => {
        const rect = entry.button.getBoundingClientRect();
        return rect.top > rowTop + 10 && rect.top < nextRowTop - 10;
      })
      .sort((a, b) => a.button.getBoundingClientRect().top - b.button.getBoundingClientRect().top);
  };

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

  const queryAllDeep = (selector) => {
    const out = [];
    const seen = new Set();

    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };

    const walkRoot = (root) => {
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch (_) {
        nodes = [];
      }
      nodes.forEach(add);

      let all = [];
      try {
        all = Array.from(root.querySelectorAll('*'));
      } catch (_) {
        all = [];
      }
      for (const el of all) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot);
        }
      }
    };

    for (const doc of allDocs()) {
      walkRoot(doc);
    }

    return out;
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

    return sortEntriesByTop(
      getDetailRowEntries(unitItem)
        .map(getPlayEntryFromDetailRow)
        .filter((entry) => entry.title && isPlayableEntry(entry))
    );
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

  const getEntryTop = (entry) => {
    const target = entry?.detailRow || entry?.button || null;
    if (!target) return Number.POSITIVE_INFINITY;
    return target.getBoundingClientRect().top;
  };

  const getUnitBoundsForTop = (targetTop, unitItem = null, nextRowTop = Number.POSITIVE_INFINITY) => {
    let top = unitItem?.getBoundingClientRect?.().top ?? Number.NEGATIVE_INFINITY;
    let bottom = Number.isFinite(nextRowTop) ? nextRowTop : Number.POSITIVE_INFINITY;
    const headers = getUnitHeaderElements()
      .map((row) => ({ row, top: row.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top);
    const prev = headers.filter((item) => item.top <= targetTop + 5).pop();
    const next = headers.find((item) => item.top > targetTop + 5);
    if (prev) top = prev.top;
    if (next) bottom = next.top;
    return { top, bottom };
  };

  const getPendingVideosBeforeExamEntry = (examEntry, unitItem = null, nextRowTop = Number.POSITIVE_INFINITY) => {
    const examTop = getEntryTop(examEntry);
    if (!Number.isFinite(examTop)) return [];
    const bounds = getUnitBoundsForTop(examTop, unitItem, nextRowTop);
    return getPendingPlayEntries(false)
      .filter((entry) => {
        const top = getEntryTop(entry);
        return top > bounds.top + 5 && top < examTop - 5 && top < bounds.bottom - 5;
      })
      .sort((a, b) => getEntryTop(a) - getEntryTop(b));
  };

  const getUnitHeaderLabel = (unitItem) => {
    if (!unitItem) return '';
    const lines = String(unitItem.textContent || '')
      .split('\n')
      .map((line) => norm(line))
      .filter(Boolean);
    return lines.find((line) => CFG.unitHeaderText.test(line)) || norm(unitItem.textContent || '').slice(0, 120);
  };

  const isPendingUnitRow = (row) => {
    const text = norm(row?.textContent || '');
    const status = inferStudyStatus(text);
    return status === '未学习' || status === '学习中' || CFG.unitPendingText.test(text);
  };

  const getPendingUnitElement = () =>
    getUnitHeaderElements().find(isPendingUnitRow) || null;

  const getCurrentPendingUnitScope = () => {
    const headers = getUnitHeaderElements();
    const index = headers.findIndex(isPendingUnitRow);
    const unit = index >= 0 ? headers[index] : null;
    return {
      headers,
      index,
      unit,
      top: unit?.getBoundingClientRect().top ?? Number.NEGATIVE_INFINITY,
      nextTop: index >= 0
        ? headers[index + 1]?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY
        : Number.POSITIVE_INFINITY,
    };
  };

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

  const getStudyItemTitle = (item) =>
    norm(
      item?.name ||
      item?.title ||
      item?.materialName ||
      item?.topicName ||
      item?.paperName ||
      item?.contentName ||
      item?.resourceName ||
      ''
    );

  const getStudyItemKeyCandidates = (item) =>
    uniq(
      [
        item?.topicId,
        item?.id,
        item?.materialId,
        item?.contentId,
        item?.resourceId,
        item?.paperId,
        item?.questionId,
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );

  const isExamLikeStudyItem = (item) => {
    const text = norm([
      getStudyItemTitle(item),
      item?.typeDesc || '',
      item?.moduleTypeDesc || '',
      item?.contentTypeDesc || '',
      item?.resourceTypeDesc || '',
      item?.categoryName || '',
    ].join(' '));

    return (
      !!text &&
      (
        CFG.skipAutoPlayItemText.test(text) ||
        /(?:\u8bfe\u7a0b\u8003\u6838|\u8003\u6838|\u8bd5\u5377|\u8003\u8bd5|\u6d4b\u9a8c|\u7b54\u9898)/.test(text)
      )
    );
  };

  const getExamPlanEntryByTitle = (title, plan = getExamPlan()) => {
    const text = norm(title || '');
    if (!text || !plan?.units?.length) return null;
    const hash = hashText(text);

    for (const unit of plan.units) {
      for (const item of unit.items || []) {
        if (item.kind !== 'exam') continue;
        if (item.titleHash === hash) return item;
        if (item.title && (item.title.includes(text) || text.includes(item.title))) {
          return item;
        }
      }
    }

    return null;
  };

  const setExpectedExamFromEntry = (entry, source) => {
    const plannedExam = getExamPlanEntryByTitle(entry?.title) || getExamPlanEntryByTitle(entry?.rowText);
    if (!plannedExam?.paperNo) return null;
    setExpectedExam(plannedExam.paperNo, {
      title: plannedExam.title || entry?.title || '',
      source,
    });
    log('expected exam paper set:', plannedExam.paperNo, plannedExam.title || entry?.title || '');
    return plannedExam;
  };

  const collectExamPlanFromCourseStudy = () => {
    if (!isStudyCoursePage()) return null;

    const courseList = getCourseStudyList();
    if (!Array.isArray(courseList) || courseList.length === 0) {
      return null;
    }

    let paperNo = 0;
    const units = [];
    const byTopicId = {};
    const byTitleHash = {};

    for (const unit of courseList) {
      if (!unit || typeof unit !== 'object') continue;
      const unitTitle = getStudyItemTitle(unit);
      const materialSources = uniq([
        ...(Array.isArray(unit.materialList) ? unit.materialList : []),
        ...(Array.isArray(unit.topicList) ? unit.topicList : []),
        ...(Array.isArray(unit.contentList) ? unit.contentList : []),
      ]);

      const items = [];
      for (const material of materialSources) {
        if (!material || typeof material !== 'object') continue;
        const title = getStudyItemTitle(material);
        if (!title) continue;

        const isExam = isExamLikeStudyItem(material);
        const ids = getStudyItemKeyCandidates(material);
        const item = {
          kind: isExam ? 'exam' : 'video',
          title,
          titleHash: hashText(title),
          ids,
          status: inferExamProgress(norm([
            title,
            material?.studyStatusDesc || '',
            material?.statusDesc || '',
            material?.progressDesc || '',
            String(material?.studyStatus ?? ''),
          ].join(' '))),
        };

        if (isExam) {
          paperNo += 1;
          item.paperNo = paperNo;
          ids.forEach((id) => {
            byTopicId[id] = paperNo;
          });
          byTitleHash[item.titleHash] = paperNo;
        }

        items.push(item);
      }

      units.push({
        title: unitTitle,
        studyStatus: Number(unit.studyStatus ?? -1),
        isShow: !!unit.isShow,
        items,
      });
    }

    const plan = {
      courseTitle: extractCourseTitleFromPage(),
      updatedAt: now(),
      examCount: paperNo,
      byTopicId,
      byTitleHash,
      units,
    };

    setExamPlan(plan);
    return plan;
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
      const pendingExam = getPendingExamEntry();
      log('visible pending after vue expand:', pending.length);
      if (pending.length > 0 || pendingExam) {
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

  const resolveUnitScopedAction = (unitItem, nextRowTop) => {
    const entries = getPlayEntriesForUnitScope(unitItem, nextRowTop);
    const examEntries = getExamEntriesForUnitScope(unitItem, nextRowTop);
    const examEntry = examEntries.find((item) => isPendingExamEntry(item)) || null;
    const blockingVideoEntry = examEntry
      ? getPendingVideosBeforeExamEntry(examEntry, unitItem, nextRowTop)[0] || null
      : null;
    const videoEntry = entries.find((item) => isPendingLessonText(item.rowText)) || blockingVideoEntry || null;

    return {
      entries,
      examEntries,
      examEntry,
      blockingVideoEntry,
      videoEntry,
      entry: videoEntry || examEntry || null,
      isExamEntry: !!examEntry && !videoEntry,
    };
  };

  const logUnitScopedAction = (action) => {
    log(
      'unit play entries:',
      action.entries.length,
      action.entries.map((entry) => `${entry.status}:${entry.title}`).join(' | ').slice(0, 320)
    );
    log(
      'unit exam entries:',
      action.examEntries.length,
      action.examEntries.map((entry) => `${entry.status}:${entry.title}`).join(' | ').slice(0, 320)
    );
    if (action.blockingVideoEntry && !action.entries.includes(action.blockingVideoEntry)) {
      log('exam blocked by pending video before exam:', action.blockingVideoEntry.title || action.blockingVideoEntry.rowText.slice(0, 120));
    }
  };

  const clickUnitScopedEntry = (entry, isExamEntry, snapshot, progressText) => {
    log(isExamEntry ? 'click unit exam button:' : 'click unit course button:', entry.title, entry.status, norm(entry.button?.textContent || ''));
    if (isExamEntry) {
      setExpectedExamFromEntry(entry, 'unit-schedule');
    }
    if (!clickElOnce(entry.button)) return false;

    beginNavigation(isExamEntry ? `list-exam:${entry.status}` : `list-play:${entry.status}`, entry.title);
    void notifyListEntry(isExamEntry ? '展开后进入试卷' : '展开后进入视频', entry, snapshot, progressText, {
      keyPrefix: isExamEntry ? 'unit-exam' : 'unit-play',
    });
    removeStorage(STORAGE.returningToList);
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

      const action = resolveUnitScopedAction(unitItem, nextRowTop);
      logUnitScopedAction(action);
      const { entry, isExamEntry } = action;

      if (!entry && attempt >= 1) {
        log(
          'no scoped pending unit action, stop probing:',
          action.entries.map((item) => `${item.status}:${item.title}`).join(' | ').slice(0, 240),
          'exam=',
          action.examEntries.map((item) => `${item.status}:${item.title}`).join(' | ').slice(0, 240)
        );
        finish('no-pending-entry');
        return;
      }
      if (entry) {
        if (clickUnitScopedEntry(entry, isExamEntry, snapshot, progressText)) {
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
        void notifyListStatus('展开下一个未学习单元', snapshot, progressText, [
          `单元: ${rowText.slice(0, 160)}`,
        ], {
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

  const getCourseListUrl = () => {
    const stored = getStorage(STORAGE.listUrl) || '';
    if (/\/study-course\//.test(stored)) return stored;
    if (document.referrer && /\/study-course\//.test(document.referrer)) return document.referrer;
    return CFG.fallbackCourseListUrl;
  };

  const isExamReportPath = (path = location.pathname) => /\/qbank\/do\/report\/paper/.test(String(path || ''));

  const setAfterExamReturnUrl = () => {
    const url = getCourseListUrl();
    if (url && /\/study-course\//.test(url)) {
      setStorage(STORAGE.afterExamReturnUrl, url);
    }
    return url;
  };

  const isAutomationStopped = () => !!readJsonStorage(STORAGE.autoStopped, null);

  const stopAutomation = (reason, detail = {}) => {
    const payload = {
      reason: reason || 'stopped',
      detail,
      url: location.href,
      updatedAt: now(),
    };
    setStorage(STORAGE.autoStopped, JSON.stringify(payload));
    listActionQuietUntil = now() + 24 * 60 * 60 * 1000;
    listPlayLockUntil = Math.max(listPlayLockUntil, listActionQuietUntil);
    navigationInProgress = false;
    examAutoStarted = false;
    examSubmitInProgress = false;
    return payload;
  };

  const resumeAutomation = () => {
    removeStorage(STORAGE.autoStopped);
    listActionQuietUntil = 0;
    clearListPlayLock('manual-resume');
    return true;
  };

  const goToCourseList = (reason = 'unknown') => {
    const listUrl = getCourseListUrl();
    log('go to course list:', reason, listUrl || '(history back)');
    clearActivePlayer(`return-list:${reason}`);
    beginNavigation(`list:${reason}`);
    setStorage(STORAGE.returningToList, '1');
    if (!/^exam-report$/.test(String(reason || ''))) {
      notifyUnitBoundary(reason);
    }

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

    if (isExamReportPage()) {
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

  const getExamPayloadConfigs = () => readJsonStorage(STORAGE.examPayloads, {});

  const setExamPayloadConfigs = (value) => {
    setStorage(STORAGE.examPayloads, JSON.stringify(value || {}));
    return true;
  };

  const getUserAuthInfo = () => {
    const nuxt = PAGE_WINDOW.$nuxt;
    const userInfo =
      nuxt?.$store?.state?.userInfo ||
      nuxt?.context?.store?.state?.userInfo ||
      null;

    const token = userInfo?.token || '';
    const tokenHead = userInfo?.tokenHead || '';

    return {
      token,
      tokenHead,
      header: token ? `${tokenHead || ''}${token}`.trim() : '',
    };
  };

  const getExamContext = () => {
    const route = PAGE_WINDOW.$nuxt?.$route || null;
    const query = route?.query || {};
    const urlQuery = new URLSearchParams(location.search || '');
    return {
      ...examRuntime.context,
      periodId: examRuntime.context.periodId || query.periodId || urlQuery.get('periodId') || '',
      sourceType: examRuntime.context.sourceType || query.sourceType || query.projectType || urlQuery.get('sourceType') || '',
      topicId: examRuntime.context.topicId || query.topicId || query.id || urlQuery.get('topicId') || '',
      paperId: examRuntime.context.paperId || query.paperId || urlQuery.get('paperId') || '',
      batchId: examRuntime.context.batchId || query.batchId || urlQuery.get('batchId') || '',
      examinationCode: examRuntime.context.examinationCode || query.examinationCode || urlQuery.get('examinationCode') || '',
      route: route ? {
        path: route.path,
        fullPath: route.fullPath,
        query,
      } : null,
    };
  };

  const selectExamPayloadConfig = () => {
    const configs = getExamPayloadConfigs();
    const context = getExamContext();
    const keys = [
      `topicId:${context.topicId}`,
      String(context.topicId || ''),
      `periodId:${context.periodId}:topicId:${context.topicId}`,
      'default',
    ].filter(Boolean);

    for (const key of keys) {
      if (configs[key]) {
        return { key, config: configs[key] };
      }
    }

    if (Array.isArray(configs.questions)) {
      return { key: 'root', config: configs };
    }

    return { key: '', config: null };
  };

  const buildExamSubmitPayload = () => {
    const { key, config } = selectExamPayloadConfig();
    if (!config) return null;

    const context = getExamContext();
    const auth = getUserAuthInfo();
    const basePayload = config.payload && typeof config.payload === 'object' ? { ...config.payload } : {};
    const questions = Array.isArray(config.questions)
      ? config.questions
      : Array.isArray(basePayload.questions)
        ? basePayload.questions
        : [];

    const payload = {
      examinationCode: basePayload.examinationCode ?? config.examinationCode ?? context.examinationCode ?? '',
      periodId: String(basePayload.periodId ?? config.periodId ?? context.periodId ?? ''),
      sourceType: String(basePayload.sourceType ?? config.sourceType ?? context.sourceType ?? ''),
      topicId: String(basePayload.topicId ?? config.topicId ?? context.topicId ?? ''),
      batchId: basePayload.batchId ?? config.batchId ?? context.batchId ?? '',
      userToken: basePayload.userToken ?? config.userToken ?? auth.token ?? '',
      userIdentification: basePayload.userIdentification ?? config.userIdentification ?? '',
      questions,
      evaluationType: basePayload.evaluationType ?? config.evaluationType ?? context.evaluationType ?? 1,
      practiceMode: basePayload.practiceMode ?? config.practiceMode ?? context.practiceMode ?? 2,
      useTime: basePayload.useTime ?? config.useTime ?? context.useTime ?? 5,
      isForceSubmit: basePayload.isForceSubmit ?? config.isForceSubmit ?? 0,
    };

    if (!payload.questions || payload.questions.length === 0) {
      return null;
    }

    return {
      key,
      payload,
    };
  };

  const getExamPageTitle = () => {
    const selectors = [
      '.title-body',
      '.paper-title',
      '.exam-title',
      '.questionTitle',
      'h1',
      'h2',
      'h3',
    ];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const text = norm(el.textContent || '');
        if (text && /试卷|考试|测验|答题/.test(text)) {
          return text;
        }
      }
    }

    return getBodyLines().find((line) => /试卷|考试|测验|答题/.test(line)) || '';
  };

  const extractExamPaperNumber = (text) => {
    const value = norm(text || '');
    if (!value) return 0;
    const compactValue = value.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '');

    const patterns = [
      /\u8bd5\u5377\s*([0-9]{1,2})/,
      /\u8bfe\u7a0b\s*([0-9]{1,2})/,
      /\u5355\u5143\s*([0-9]{1,2})/,
      /\u7ae0\u8282\s*([0-9]{1,2})/,
      /\u7b2c\s*([0-9]{1,2})\s*(?:\u5957|\u4efd)/,
      /试卷\s*([0-9]{1,2})/,
      /课程\s*([0-9]{1,2})/,
      /单元\s*([0-9]{1,2})/,
      /章节\s*([0-9]{1,2})/,
      /第\s*([0-9]{1,2})\s*套/,
      /第\s*([0-9]{1,2})\s*份/,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) {
        return Number(match[1]) || 0;
      }
      const compactMatch = compactValue.match(pattern);
      if (compactMatch) {
        return Number(compactMatch[1]) || 0;
      }
    }

    return 0;
  };

  const getMappedExamPaperNo = (context, title = '') => {
    const topicId = String(context?.topicId || '').trim();
    const paperId = String(context?.paperId || '').trim();
    if (topicId && CFG.exam.topicIdToPaperNo?.[topicId]) {
      return Number(CFG.exam.topicIdToPaperNo[topicId]) || 0;
    }
    if (paperId && CFG.exam.paperIdToPaperNo?.[paperId]) {
      return Number(CFG.exam.paperIdToPaperNo[paperId]) || 0;
    }

    const runtimeMap = getExamParamMap();
    if (topicId && runtimeMap.byTopicId?.[topicId]) {
      return Number(runtimeMap.byTopicId[topicId]) || 0;
    }
    if (paperId && runtimeMap.byPaperId?.[paperId]) {
      return Number(runtimeMap.byPaperId[paperId]) || 0;
    }

    const paperNoBySequence = derivePaperNoFromPaperId(paperId);
    if (paperNoBySequence) {
      return paperNoBySequence;
    }

    const plan = getExamPlan();
    if (title) {
      const planned = getExamPlanEntryByTitle(title, plan);
      if (planned?.paperNo) {
        return Number(planned.paperNo) || 0;
      }
    }

    if (topicId && plan?.byTopicId?.[topicId]) {
      return Number(plan.byTopicId[topicId]) || 0;
    }

    return 0;
  };

  const getExamAnswerSheet = () => {
    const rawTitle = getExamPageTitle();
    const bodyLines = getBodyLines();
    const betterTitle =
      bodyLines.find((line) =>
        /(?:\u57fa\u7840\u7ec4\u5377|\u8bd5\u5377\s*\d+|[\u8bd5\u8003\u6d4b]\u5377|\u8bfe\u7a0b\u8003\u6838)/.test(line)
      ) || '';
    const title = betterTitle || rawTitle;
    const context = getExamContext();
    const plan = getExamPlan();
    const expected = getExpectedExam();

    const detectedPaperNo = extractExamPaperNumber(title);
    const mappedPaperNo = getMappedExamPaperNo(context, title);
    const planPaperNo =
      Number(plan?.byTopicId?.[String(context.topicId || '')] || 0) ||
      Number(plan?.byTitleHash?.[hashText(title)] || 0) ||
      Number(getExamPlanEntryByTitle(title, plan)?.paperNo || 0);
    const expectedPaperNo = Number(expected?.paperNo || 0);
    const paperNo = detectedPaperNo || mappedPaperNo || planPaperNo || expectedPaperNo;
    const sequence = CFG.exam.answerSheets[paperNo] || '';
    rememberExamParamMapping(context, paperNo, 'sheet');
    return {
      title,
      detectedPaperNo,
      mappedPaperNo,
      paperNo,
      sequence,
      answers: sequence ? sequence.split('') : [],
    };
  };

  const formatScoreValue = (value) => {
    if (value == null || value === '') return '';
    const text = String(value).trim();
    if (!text) return '';
    const numeric = Number(text.replace(/[^\d.%-]/g, ''));
    if (Number.isFinite(numeric)) {
      return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, '');
    }
    return text;
  };

  const formatPercentValue = (value) => {
    if (value == null || value === '') return '';
    const text = String(value).trim();
    if (!text) return '';
    if (/%$/.test(text)) return text;
    const numeric = Number(text.replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(numeric)) return text;
    const percent = numeric <= 1 ? numeric * 100 : numeric;
    const rounded = Math.round(percent * 100) / 100;
    return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '')}%`;
  };

  const parseMetricNumber = (value) => {
    if (value == null || value === '') return NaN;
    const text = String(value).trim();
    if (!text) return NaN;
    const numeric = Number(text.replace(/[^\d.-]/g, ''));
    return Number.isFinite(numeric) ? numeric : NaN;
  };

  const getReportScoreForThreshold = (summary) => {
    const accuracy = parseMetricNumber(summary?.accuracy);
    if (Number.isFinite(accuracy)) return accuracy;

    const score = parseMetricNumber(summary?.score);
    if (!Number.isFinite(score)) return NaN;

    const total = parseMetricNumber(summary?.totalCount);
    if (Number.isFinite(total) && total > 0 && score >= 0 && score <= total) {
      return Math.round((score / total) * 10000) / 100;
    }

    return score;
  };

  const findNestedScalarByKey = (root, regex, depth = 0, seen = new WeakSet()) => {
    if (root == null || depth > 6) return undefined;
    if (typeof root !== 'object') return undefined;
    if (seen.has(root)) return undefined;
    seen.add(root);

    for (const [key, value] of Object.entries(root)) {
      if (regex.test(String(key || '')) && (typeof value === 'string' || typeof value === 'number')) {
        return value;
      }
    }

    for (const value of Object.values(root)) {
      if (value && typeof value === 'object') {
        const nested = findNestedScalarByKey(value, regex, depth + 1, seen);
        if (nested !== undefined) return nested;
      }
    }

    return undefined;
  };

  const firstMatchValue = (text, patterns) => {
    const value = String(text || '');
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return '';
  };

  const buildExamSessionKey = () => {
    const context = getExamContext();
    const parts = [
      context.periodId,
      context.sourceType,
      context.topicId,
      context.paperId || context.examinationCode,
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean);

    if (parts.length > 0) {
      return parts.join('|');
    }

    const title = getExamPageTitle() || document.title || location.pathname;
    return `path:${location.pathname}|title:${hashText(title)}`;
  };

  const syncExamSessionState = () => {
    const nextKey = buildExamSessionKey();
    if (!nextKey) return '';

    if (examSessionKey && examSessionKey !== nextKey) {
      log('exam session changed:', examSessionKey, '->', nextKey);
      resetExamAutomationState('session-change');
      examReportHandledKey = '';
    }

    examSessionKey = nextKey;
    return examSessionKey;
  };

  const clearExamSessionState = (reason = 'clear') => {
    if (examSessionKey || examReportHandledKey) {
      log('exam session clear:', reason, examSessionKey || '(empty)');
    }
    examSessionKey = '';
    examReportHandledKey = '';
    clearExpectedExam();
    clearExamAnswerDraft();
  };

  const getExamReportSummary = () => {
    const bodyText = norm(document.body?.innerText || '');
    const responseCandidates = [
      safeJsonParse(examRuntime.lastReportData, examRuntime.lastReportData),
      safeJsonParse(examRuntime.lastPaperData, examRuntime.lastPaperData),
      safeJsonParse(examRuntime.lastSubmitResponse, examRuntime.lastSubmitResponse),
    ].filter((item) => item !== undefined && item !== null && item !== '');
    const context = getExamContext();
    const sheet = getExamAnswerSheet();

    const findFromResponses = (regex) => {
      for (const item of responseCandidates) {
        const value = findNestedScalarByKey(item, regex);
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return undefined;
    };

    const responseScore = findFromResponses(
      /(?:^|_)(?:score|mark|grade)(?:$|_)|[\u5f97\u5206\u5206\u6570\u6210\u7ee9]/i,
    );
    const responseAccuracy = findFromResponses(
      /(?:correct.*rate|accuracy|right.*rate|scoreRate|correctRate|accuracyRate|rightRate)|[\u6b63\u786e\u7387\u7b54\u5bf9\u7387]/i,
    );
    const responseCorrectCount = findFromResponses(
      /(?:correct.*count|right.*count|correctNum|rightNum|rightCount)|(?:\u6b63\u786e.*\u9898\u6570|\u7b54\u5bf9.*\u9898)/i,
    );
    const responseTotalCount = findFromResponses(
      /(?:total.*count|question.*count|allCount|totalNum|questionNum)|(?:\u603b\u9898\u6570|\u603b\u5171.*\u9898)/i,
    );

    const textScore = firstMatchValue(bodyText, [
      /\u5f97\u5206\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/,
      /\u6210\u7ee9\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/,
      /\u5206\u6570\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/,
    ]);
    const textAccuracy = firstMatchValue(bodyText, [
      /\u6b63\u786e\u7387\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?%?)/,
      /\u7b54\u5bf9\u7387\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?%?)/,
    ]);
    const textCorrectCount = firstMatchValue(bodyText, [
      /\u7b54\u5bf9\s*([0-9]+)\s*\u9898/,
      /\u505a\u5bf9\s*([0-9]+)\s*\u9898/,
      /\u6b63\u786e\s*([0-9]+)\s*\u9898/,
    ]);
    const textTotalCount = firstMatchValue(bodyText, [
      /\u5171\s*([0-9]+)\s*\u9898/,
      /\u603b\u5171\s*([0-9]+)\s*\u9898/,
      /\u603b\u9898\u6570\s*[:：]?\s*([0-9]+)/,
    ]);

    const score = formatScoreValue(responseScore ?? textScore);
    let accuracy = formatPercentValue(responseAccuracy ?? textAccuracy);
    const correctCount = formatScoreValue(responseCorrectCount ?? textCorrectCount);
    const totalCount = formatScoreValue(responseTotalCount ?? textTotalCount);

    if (!accuracy && correctCount && totalCount) {
      const correctNum = Number(correctCount);
      const totalNum = Number(totalCount);
      if (Number.isFinite(correctNum) && Number.isFinite(totalNum) && totalNum > 0) {
        accuracy = formatPercentValue((correctNum / totalNum) * 100);
      }
    }

    const title = getExamPageTitle() || sheet.title || document.title || '';
    const passed =
      /\u5df2\u901a\u8fc7|\u901a\u8fc7|\u5408\u683c/.test(bodyText) &&
      !/\u672a\u901a\u8fc7|\u4e0d\u5408\u683c/.test(bodyText);

    return {
      title,
      paperNo: sheet.paperNo || 0,
      topicId: String(context.topicId || ''),
      periodId: String(context.periodId || ''),
      score,
      accuracy,
      correctCount,
      totalCount,
      passed,
      bodyText,
    };
  };

  const getExamReportSummaryV2 = () => {
    const bodyText = norm(document.body?.innerText || '');
    const context = getExamContext();
    const sheet = getExamAnswerSheet();
    const responses = [
      safeJsonParse(examRuntime.lastReportData, examRuntime.lastReportData),
      safeJsonParse(examRuntime.lastPaperData, examRuntime.lastPaperData),
      safeJsonParse(examRuntime.lastSubmitResponse, examRuntime.lastSubmitResponse),
    ].filter((item) => item !== undefined && item !== null && item !== '');

    const findResponseValue = (regex) => {
      for (const item of responses) {
        const value = findNestedScalarByKey(item, regex);
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return undefined;
    };

    const responseScore = findResponseValue(
      /(?:^|_)(?:score|mark|grade|paperScore|userScore|totalScore|finalScore)(?:$|_)|[\u5f97\u5206\u5206\u6570\u6210\u7ee9]/i,
    );
    const responseAccuracy = findResponseValue(
      /(?:correct.*rate|accuracy|right.*rate|scoreRate|correctRate|accuracyRate|rightRate)|[\u6b63\u786e\u7387\u7b54\u5bf9\u7387]/i,
    );
    const responseCorrectCount = findResponseValue(
      /(?:correct.*count|right.*count|correctNum|rightNum|rightCount)|(?:\u6b63\u786e.*\u9898\u6570|\u7b54\u5bf9.*\u9898)/i,
    );
    const responseTotalCount = findResponseValue(
      /(?:total.*count|question.*count|allCount|totalNum|questionNum)|(?:\u603b\u9898\u6570|\u603b\u5171.*\u9898)/i,
    );

    const textScore = firstMatchValue(bodyText, [
      /([0-9]+(?:\.[0-9]+)?)\s*\u5f97\u5206/,
      /\u5f97\u5206\D{0,20}([0-9]+(?:\.[0-9]+)?)/,
      /\u6210\u7ee9\D{0,20}([0-9]+(?:\.[0-9]+)?)/,
      /\u5206\u6570\D{0,20}([0-9]+(?:\.[0-9]+)?)/,
      /([0-9]+(?:\.[0-9]+)?)\s*\u5206(?!\s*\u949f)/,
    ]);
    const textAccuracy = firstMatchValue(bodyText, [
      /\u6b63\u786e\u7387\D{0,20}([0-9]+(?:\.[0-9]+)?%?)/,
      /\u7b54\u5bf9\u7387\D{0,20}([0-9]+(?:\.[0-9]+)?%?)/,
    ]);
    const textCorrectCount = firstMatchValue(bodyText, [
      /\u7b54\u5bf9\s*([0-9]+)\s*\u9898/,
      /\u505a\u5bf9\s*([0-9]+)\s*\u9898/,
      /\u6b63\u786e\s*([0-9]+)\s*\u9898/,
    ]);
    const textTotalCount = firstMatchValue(bodyText, [
      /\u5171\s*([0-9]+)\s*\u9898/,
      /\u603b\u5171\s*([0-9]+)\s*\u9898/,
      /\u603b\u9898\u6570\D{0,20}([0-9]+)/,
    ]);

    const fractionMatch = bodyText.match(/([0-9]+)\s*\/\s*([0-9]+)\s*(?:\u6b63\u786e\u9898\u6570|\u6b63\u786e|\u9898)/);
    const cardRight = firstMatchValue(bodyText, [/\u7b54\u5bf9\s*[:\uff1a]?\s*([0-9]+)/]);
    const cardWrong = firstMatchValue(bodyText, [/\u7b54\u9519\s*[:\uff1a]?\s*([0-9]+)/]);
    const cardEmpty = firstMatchValue(bodyText, [/\u672a\u7b54\s*[:\uff1a]?\s*([0-9]+)/]);
    const cardTotal = [cardRight, cardWrong, cardEmpty]
      .map((item) => Number(item))
      .reduce((sum, item) => (Number.isFinite(item) ? sum + item : sum), 0);

    const score = formatScoreValue(textScore || responseScore);
    const correctCount = formatScoreValue(fractionMatch?.[1] || cardRight || textCorrectCount || responseCorrectCount);
    const totalCount = formatScoreValue(
      fractionMatch?.[2] ||
      (cardTotal > 0 ? cardTotal : '') ||
      textTotalCount ||
      responseTotalCount
    );
    let accuracy = '';

    if (correctCount && totalCount) {
      const correctNum = Number(correctCount);
      const totalNum = Number(totalCount);
      if (Number.isFinite(correctNum) && Number.isFinite(totalNum) && totalNum > 0) {
        accuracy = formatPercentValue((correctNum / totalNum) * 100);
      }
    }
    if (!accuracy) {
      accuracy = formatPercentValue(textAccuracy || responseAccuracy);
    }

    const thresholdScore = getReportScoreForThreshold({ score, accuracy });
    const textPassed = /\u5df2\u901a\u8fc7|\u901a\u8fc7|\u5408\u683c/.test(bodyText) &&
      !/\u672a\u901a\u8fc7|\u4e0d\u5408\u683c/.test(bodyText);
    const passed = Number.isFinite(thresholdScore)
      ? thresholdScore >= Number(CFG.exam.minPassingScore || 80)
      : textPassed;

    return {
      title: sheet.title || getExamPageTitle() || document.title || '',
      paperNo: sheet.paperNo || 0,
      topicId: String(context.topicId || ''),
      periodId: String(context.periodId || ''),
      score,
      accuracy,
      correctCount,
      totalCount,
      passed,
      bodyText,
    };
  };

  const isExamReportPage = () => {
    if (isExamReportPath()) return true;

    const bodyText = norm(document.body?.innerText || '');
    if (!bodyText) return false;

    const path = String(location.pathname || '').toLowerCase();
    const pathHint = /(report|result|analysis|score)/.test(path);
    const hasReportHint = /(?:\u505a\u9898\u62a5\u544a|\u7b54\u9898\u62a5\u544a|\u8003\u8bd5\u7ed3\u679c|\u6210\u7ee9\u62a5\u544a|\u8003\u8bd5\u62a5\u544a)/.test(bodyText);
    const hasScoreHint = /(?:\u5f97\u5206|\u6210\u7ee9|\u5206\u6570)/.test(bodyText);
    const hasAccuracyHint = /(?:\u6b63\u786e\u7387|\u7b54\u5bf9\u7387|\u7b54\u5bf9\s*\d+\s*\u9898)/.test(bodyText);
    const hasQuestionInputs = !!queryVisible('input[type="radio"],input[type="checkbox"],textarea');
    const hasSubmitButton = findExamSubmitButtons().length > 0;

    return !hasQuestionInputs && !hasSubmitButton && ((hasScoreHint && hasAccuracyHint) || hasReportHint || (pathHint && hasScoreHint));
  };

  const parseReportNumber = (value) => {
    const match = String(value || '').match(/[0-9]+(?:\.[0-9]+)?/);
    return match ? Number(match[0]) : NaN;
  };

  const isFullCorrectReport = (summary) => {
    const score = parseReportNumber(summary?.score);
    const accuracy = parseReportNumber(summary?.accuracy);
    const correct = parseReportNumber(summary?.correctCount);
    const total = parseReportNumber(summary?.totalCount);
    if (Number.isFinite(correct) && Number.isFinite(total) && total > 0 && correct >= total) return true;
    if (Number.isFinite(accuracy) && accuracy >= 100) return true;
    if (Number.isFinite(score) && score >= 100) return true;
    return false;
  };

  const collectReportQuestionObjects = (value, out = [], depth = 0, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || depth > 6) return out;
    if (seen.has(value)) return out;
    seen.add(value);

    if (Array.isArray(value)) {
      value.slice(0, 200).forEach((item) => collectReportQuestionObjects(item, out, depth + 1, seen));
      return out;
    }

    const correctAnswer = normalizeAnswerLetters(
      value.answer ??
      value.correctAnswer ??
      value.rightAnswer ??
      value.standardAnswer ??
      value.resultAnswer ??
      ''
    );
    const userAnswer = normalizeAnswerLetters(
      value.userAnswer ??
      value.myAnswer ??
      value.chooseAnswer ??
      value.selectedAnswer ??
      value.userOption ??
      ''
    );
    const hasQuestion = !!(getQuestionText(value) || getQuestionCode(value));
    if (hasQuestion && (correctAnswer || userAnswer)) {
      out.push(value);
    }

    Object.keys(value).slice(0, 80).forEach((key) => {
      try {
        collectReportQuestionObjects(value[key], out, depth + 1, seen);
      } catch (_) {
        // Ignore getter errors.
      }
    });
    return out;
  };

  const getCorrectBankRecordsFromReport = () => {
    const roots = [
      getExamQuestionModel()?.questions,
      safeJsonParse(examRuntime.lastReportData, examRuntime.lastReportData),
      safeJsonParse(examRuntime.lastPaperData, examRuntime.lastPaperData),
      safeJsonParse(examRuntime.lastSubmitResponse, examRuntime.lastSubmitResponse),
    ].filter(Boolean);

    const context = getExamContext();
    const objects = uniq(roots.flatMap((root) => collectReportQuestionObjects(root)));
    const records = [];

    objects.forEach((question, index) => {
      const correctAnswer = normalizeAnswerLetters(
        question.answer ??
        question.correctAnswer ??
        question.rightAnswer ??
        question.standardAnswer ??
        question.resultAnswer ??
        ''
      );
      const userAnswer = normalizeAnswerLetters(
        question.userAnswer ??
        question.myAnswer ??
        question.chooseAnswer ??
        question.selectedAnswer ??
        question.userOption ??
        ''
      );
      const statusText = norm([
        question.resultDesc,
        question.statusDesc,
        question.userDoQuestionStatusDesc,
        question.correctDesc,
        question.isCorrect,
        question.status,
        question.userDoQuestionStatus,
      ].join(' '));
      const markedCorrect =
        /correct|right|true|\u6b63\u786e|\u7b54\u5bf9/.test(statusText) &&
        !/wrong|false|\u9519\u8bef|\u7b54\u9519|\u672a\u7b54/.test(statusText);
      const answer = correctAnswer || (markedCorrect ? userAnswer : '');
      if (!answer) return;
      if (correctAnswer && userAnswer && correctAnswer !== userAnswer && !markedCorrect) {
        records.push({
          questionInfo: buildQuestionInfo(question, index),
          answer: correctAnswer,
          topicId: context.topicId,
          paperId: context.paperId,
        });
        return;
      }
      if (correctAnswer || markedCorrect) {
        records.push({
          questionInfo: buildQuestionInfo(question, index),
          answer,
          topicId: context.topicId,
          paperId: context.paperId,
        });
      }
    });

    return records;
  };

  const updateAnswerBankFromReport = (summary) => {
    const draft = getExamAnswerDraft();
    const draftItems = Array.isArray(draft?.items) ? draft.items : [];
    const context = getExamContext();
    let saved = 0;

    if (draftItems.length && isFullCorrectReport(summary)) {
      saved += writeBankAnswers(
        draftItems.map((item) => ({
          questionInfo: item.questionInfo,
          answer: item.answer,
          topicId: context.topicId || draft.context?.topicId || '',
          paperId: context.paperId || draft.context?.paperId || '',
        })),
        `verified:${draft.source || 'draft'}`
      );
    } else {
      saved += writeBankAnswers(getCorrectBankRecordsFromReport(), 'report');
    }

    if (saved > 0) {
      log('exam answer bank updated:', saved);
    }
    clearExamAnswerDraft();
    return saved;
  };

  const handleExamReportPage = async () => {
    const sessionKey = syncExamSessionState();
    const summary = getExamReportSummaryV2();
    if (!summary) return false;
    if (!summary.score && !summary.accuracy && !summary.correctCount && !summary.totalCount) {
      log('exam report summary not ready yet');
      return false;
    }

    const reportKey = [
      sessionKey || 'no-session',
      summary.score || 'no-score',
      summary.accuracy || 'no-accuracy',
      summary.correctCount || 'no-correct',
      summary.totalCount || 'no-total',
    ].join('|');

    if (examReportHandledKey === reportKey) {
      return true;
    }

    examReportHandledKey = reportKey;
    examAutoStarted = false;
    examSubmitInProgress = false;
    examCompletedAt = now();
    clearExpectedExam();
    const savedAnswers = updateAnswerBankFromReport(summary);

    const lines = [
      summary.title ? `\u8bd5\u5377: ${summary.title}` : '',
      summary.paperNo ? `paper: ${summary.paperNo}` : '',
      summary.score ? `\u5f97\u5206: ${summary.score}` : '',
      summary.accuracy ? `\u6b63\u786e\u7387: ${summary.accuracy}` : '',
      summary.correctCount && summary.totalCount ? `\u7b54\u5bf9: ${summary.correctCount} / ${summary.totalCount}` : '',
      savedAnswers ? `\u5199\u5165\u7b54\u6848\u5e93: ${savedAnswers}` : '',
      summary.passed ? `\u7ed3\u679c: \u5df2\u901a\u8fc7` : '',
    ].filter(Boolean);

    const thresholdScore = getReportScoreForThreshold(summary);
    if (CFG.exam.stopOnLowScore && Number.isFinite(thresholdScore) && thresholdScore < Number(CFG.exam.minPassingScore || 80)) {
      const stopped = stopAutomation('exam-score-low', {
        score: thresholdScore,
        minPassingScore: CFG.exam.minPassingScore,
        paperNo: summary.paperNo || 0,
        topicId: summary.topicId || '',
      });
      log('exam score below threshold, automation stopped:', thresholdScore, stopped);
      void sendNotify('\u0045\u0052\u0052\u004f\u0052', '\u7b54\u6848\u6709\u8bef\uff0c\u5df2\u505c\u6b62\u811a\u672c', [
        ...lines,
        `\u7ed3\u679c: \u672a\u901a\u8fc7`,
        `\u9608\u503c: ${CFG.exam.minPassingScore}`,
        `\u5f53\u524d\u9875: ${location.href}`,
      ], {
        intervalMs: 0,
        key: `exam-score-low:${hashText(reportKey)}`,
      });
      return true;
    }

    void sendNotify('\u0045\u0058\u0041\u004d', '\u8003\u8bd5\u62a5\u544a', lines, {
      intervalMs: 5000,
      key: `exam-report:${hashText(reportKey)}`,
      force: true,
    });

    await sleep(CFG.examReportReturnDelayMs);
    goToCourseList('exam-report');
    return true;
  };

  const extractExamOptionLettersFromText = (text) => {
    const value = norm(text || '');
    if (!value) return [];

    const out = [];
    const seen = new Set();
    const regex = /(?:^|[^A-Z])([A-F])(?:[\s).:：、]|$)/ig;
    let match = regex.exec(value);
    while (match) {
      const letter = String(match[1] || '').toUpperCase();
      if (letter && !seen.has(letter)) {
        seen.add(letter);
        out.push(letter);
      }
      match = regex.exec(value);
    }

    if (out.length === 0 && /^[A-F]$/i.test(value.charAt(0))) {
      out.push(value.charAt(0).toUpperCase());
    }
    return out;
  };

  const getExamCurrentQuestionIndex = () => {
    const activeSelectors = [
      '.active',
      '.is-active',
      '.current',
      '.on',
      '.cur',
      '.selected',
      '.now',
      '.doing',
    ].join(',');

    for (const doc of allDocs()) {
      for (const el of doc.querySelectorAll(activeSelectors)) {
        if (!isVisible(el)) continue;
        const text = norm(el.textContent || '');
        if (/^\d{1,2}$/.test(text)) {
          return Number(text) || 0;
        }
        const questionMatch = text.match(/第\s*(\d{1,2})\s*题/);
        if (questionMatch) {
          return Number(questionMatch[1]) || 0;
        }
      }
    }

    for (const line of getBodyLines()) {
      const matchers = [
        line.match(/第\s*(\d{1,2})\s*题/),
        line.match(/题号\s*[:：]?\s*(\d{1,2})/),
        line.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/),
      ];
      for (const match of matchers) {
        if (!match) continue;
        const index = Number(match[1]) || 0;
        if (index > 0 && index <= 99) {
          return index;
        }
      }
    }

    const model = getExamQuestionModel();
    if (model?.questions?.length) {
      const unansweredIndex = model.questions.findIndex((question) => {
        const answers = Array.isArray(question?.userAnswer) ? question.userAnswer.filter(Boolean) : [];
        return answers.length === 0;
      });
      if (unansweredIndex >= 0) {
        return unansweredIndex + 1;
      }
      return 1;
    }

    return 0;
  };

  const getExamQuestionSignature = () => {
    const lines = getBodyLines()
      .filter((line) => !/开始考试|继续考试|提交试卷|确认交卷|上一题|下一题|交卷|考试时间|剩余时间/.test(line))
      .slice(0, 16);
    return hashText(lines.join(' | '));
  };

  const getExamTextOptionClickTarget = (el, letter) => {
    let cur = el;
    let best = el;
    for (let i = 0; cur && cur !== document.body && i < 6; i += 1) {
      const text = norm(cur.textContent || '');
      const letters = extractExamOptionLettersFromText(text);
      if (letters.length > 1) break;
      if (letters[0] === letter && text.length <= 260) {
        best = cur;
      }
      cur = cur.parentElement;
    }
    return best;
  };

  const getExamRawOptionCandidates = () => {
    const out = [];
    const seen = new Set();

    const pushCandidate = (candidate) => {
      if (!candidate?.target || !candidate.letter) return;
      if (!isVisible(candidate.target) || isDisabled(candidate.target)) return;
      const rect = candidate.target.getBoundingClientRect();
      const key = [
        candidate.letter,
        Math.round(rect.top),
        Math.round(rect.left),
        candidate.target.tagName,
        candidate.target.className || '',
      ].join(':');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        ...candidate,
        top: rect.top,
        left: rect.left,
        text: norm(candidate.target.textContent || candidate.text || ''),
      });
    };

    for (const doc of allDocs()) {
      for (const input of doc.querySelectorAll('input[type="radio"],input[type="checkbox"]')) {
        if (!isExamInputUsable(input)) continue;
        const letter = detectOptionLetter(input);
        if (!letter) continue;
        pushCandidate({
          input,
          letter,
          target: getExamOptionClickTarget(input),
          source: 'input',
        });
      }
    }

    const selectors = 'label,button,a,span,div,p,li';
    for (const doc of allDocs()) {
      for (const el of doc.querySelectorAll(selectors)) {
        if (!isVisible(el) || isDisabled(el)) continue;

        const text = norm(el.textContent || '');
        if (!text || text.length > 120) continue;
        if (/开始考试|继续考试|提交试卷|确认交卷|上一题|下一题|交卷/.test(text)) continue;

        const letters = extractExamOptionLettersFromText(text);
        if (letters.length !== 1) continue;

        const hasChildOption = Array.from(el.children || []).some((child) =>
          isVisible(child) && extractExamOptionLettersFromText(norm(child.textContent || '')).length > 0
        );
        if (hasChildOption) continue;

        pushCandidate({
          input: null,
          letter: letters[0],
          target: getExamTextOptionClickTarget(el, letters[0]),
          source: 'text',
          text,
        });
      }
    }

    return out.sort((a, b) => a.top - b.top || a.left - b.left);
  };

  const getExamOptionScope = (el) => {
    if (!el) return null;

    let cur = el;
    let best = el.parentElement || el;
    let bestScore = 0;

    for (let i = 0; cur && cur !== document.body && i < 8; i += 1) {
      const text = norm(cur.innerText || cur.textContent || '');
      const score = extractExamOptionLettersFromText(text).length;
      if (score >= bestScore) {
        best = cur;
        bestScore = score;
      }
      if (score >= 3) {
        break;
      }
      cur = cur.parentElement;
    }

    return best;
  };

  const getExamCurrentQuestionOptions = () => {
    const raw = getExamRawOptionCandidates();
    if (raw.length === 0) {
      return {
        scope: null,
        items: [],
        letters: [],
      };
    }

    const scopes = new Map();
    for (const item of raw) {
      const scope = getExamOptionScope(item.target) || item.target;
      const rect = scope.getBoundingClientRect();
      const key = `${scope.tagName}:${Math.round(rect.top)}:${Math.round(rect.left)}:${scope.className || ''}`;
      if (!scopes.has(key)) {
        scopes.set(key, {
          scope,
          top: rect.top,
          left: rect.left,
          items: [],
          letterSet: new Set(),
        });
      }
      const group = scopes.get(key);
      if (group.letterSet.has(item.letter)) continue;
      group.letterSet.add(item.letter);
      group.items.push(item);
    }

    const ranked = Array.from(scopes.values())
      .map((group) => ({
        ...group,
        letters: Array.from(group.letterSet).sort(),
      }))
      .sort((a, b) => {
        if (b.letters.length !== a.letters.length) return b.letters.length - a.letters.length;
        return a.top - b.top || a.left - b.left;
      });

    const best = ranked[0] || null;
    if (!best) {
      return {
        scope: null,
        items: [],
        letters: [],
      };
    }

    return {
      scope: best.scope,
      items: best.items.sort((a, b) => a.left - b.left || a.top - b.top),
      letters: best.letters,
    };
  };

  const isExamQuestionObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const hasQuestionMeta =
      value.questionNum !== undefined ||
      value.no !== undefined ||
      value.code !== undefined ||
      value.title !== undefined ||
      value.optionalContent !== undefined;
    const hasAnswerField =
      value.userAnswer !== undefined ||
      value.userDoQuestionStatus !== undefined ||
      value.status !== undefined;
    return hasQuestionMeta && hasAnswerField;
  };

  const collectExamQuestionModels = (value, path = 'root', depth = 0, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object') return [];
    if (seen.has(value) || depth > 4) return [];
    seen.add(value);

    const models = [];
    if (Array.isArray(value)) {
      const questions = value.filter(isExamQuestionObject);
      if (questions.length >= 3) {
        models.push({
          path,
          questions: value,
          questionCount: questions.length,
        });
      }

      value.slice(0, 20).forEach((item, index) => {
        models.push(...collectExamQuestionModels(item, `${path}[${index}]`, depth + 1, seen));
      });
      return models;
    }

    Object.keys(value).slice(0, 25).forEach((key) => {
      try {
        models.push(...collectExamQuestionModels(value[key], `${path}.${key}`, depth + 1, seen));
      } catch (_) {
        // Ignore getter errors.
      }
    });
    return models;
  };

  const getExamVmCandidates = () => {
    const seeds = uniq([
      ...getExamRawOptionCandidates().map((item) => item.target),
      queryVisible('.questionTitle'),
      queryVisible('[class*="question"]'),
      queryVisible('[class*="paper"]'),
      document.body,
    ].filter(Boolean));

    const seenVm = new Set();
    const candidates = [];

    for (const seed of seeds) {
      for (const vm of getVueVmChainForElement(seed)) {
        if (!vm || seenVm.has(vm)) continue;
        seenVm.add(vm);

        const roots = [
          { source: '$data', value: vm.$data || null },
          { source: '$props', value: vm.$props || null },
        ];

        for (const root of roots) {
          if (!root.value || typeof root.value !== 'object') continue;
          const models = collectExamQuestionModels(root.value, root.source);
          for (const model of models) {
            candidates.push({
              vm,
              root: root.source,
              path: model.path,
              questions: model.questions,
              questionCount: model.questionCount,
            });
          }
        }
      }
    }

    return candidates.sort((a, b) => b.questionCount - a.questionCount);
  };

  const getExamQuestionModel = () => {
    const candidate = getExamVmCandidates()[0] || null;
    if (!candidate) return null;
    return {
      vm: candidate.vm,
      root: candidate.root,
      path: candidate.path,
      questions: candidate.questions,
      summary: summarizeVue(candidate.vm),
    };
  };

  const applyExamAnswersToModel = (answers, source = 'model') => {
    const model = getExamQuestionModel();
    const answerList = (answers || []).map(normalizeAnswerLetters);
    if (!answerList.length || !model?.questions?.length) return false;

    const questions = model.questions;
    const vm = model.vm;
    let applied = 0;
    const details = [];
    const draftItems = [];

    for (let i = 0; i < Math.min(answerList.length, questions.length); i += 1) {
      const question = questions[i];
      const questionInfo = buildQuestionInfo(question, i);
      const answer = filterAnswerByQuestionOptions(answerList[i], questionInfo);
      if (!question || !answer) continue;

      const current = Array.isArray(question.userAnswer) ? question.userAnswer : [];
      if (typeof vm?.$set === 'function') {
        vm.$set(question, 'userAnswer', [answer]);
      } else {
        question.userAnswer = [answer];
      }

      if (Array.isArray(current) && current.__ob__ && Array.isArray(question.userAnswer)) {
        current.splice(0, current.length, answer);
        question.userAnswer = current;
      }

      if (question.userDoQuestionStatus !== undefined) {
        if (typeof vm?.$set === 'function') {
          vm.$set(question, 'userDoQuestionStatus', 1);
        } else {
          question.userDoQuestionStatus = 1;
        }
      }

      applied += 1;
      details.push(`Q${i + 1}:${answer}:${question.code || question.questionNum || question.no || ''}`);
      draftItems.push({
        questionInfo,
        answer,
        source,
      });
    }

    if (draftItems.length) {
      saveExamAnswerDraft(draftItems, source);
    }

    vm?.$forceUpdate?.();
    vm?.$nextTick?.(() => {
      log('exam model nextTick applied:', model.path, details.join(' | '));
    });
    log('exam answers applied by vue model:', source, model.path, `${applied}/${Math.min(answerList.length, questions.length)}`, details.join(' | '));
    return applied > 0;
  };

  const applyExamAnswersByModel = () => {
    const sheet = getExamAnswerSheet();
    if (!sheet.answers.length) return false;
    return applyExamAnswersToModel(sheet.answers, 'sheet');
  };

  const answerExamByBankOrAi = async () => {
    const sessionKey = buildExamSessionKey();
    if (examDynamicAnswerFailedKey === sessionKey && now() - examDynamicAnswerFailedAt < 60 * 1000) {
      return false;
    }

    const model = getExamQuestionModel();
    const questions = model?.questions || [];
    if (!questions.length) return false;

    const questionInfos = questions.map((question, index) => buildQuestionInfo(question, index));
    const answers = new Array(questionInfos.length).fill('');
    const sources = new Array(questionInfos.length).fill('');
    const unknown = [];

    if (CFG.exam.autoAnswerByBank) {
      questionInfos.forEach((questionInfo, index) => {
        const hit = getBankAnswerForQuestion(questionInfo);
        if (hit?.answer) {
          answers[index] = hit.answer;
          sources[index] = hit.source || 'bank';
        } else {
          unknown.push(questionInfo);
        }
      });
    } else {
      unknown.push(...questionInfos);
    }

    const ai = getAiConfig();
    const aiProblem = getAiConfigProblem(ai);
    let incompleteReason = '';
    const invalidAnswers = [];

    if (unknown.length && CFG.exam.autoAnswerByAi && !aiProblem) {
      try {
        const aiAnswers = await askAiForExamAnswers(unknown);
        const unresolved = [];
        unknown.forEach((questionInfo) => {
          const rawAnswer = aiAnswers[questionInfo.index] || '';
          const answer = filterAnswerByQuestionOptions(rawAnswer, questionInfo);
          if (!answer) {
            if (normalizeAnswerLetters(rawAnswer)) {
              invalidAnswers.push(`Q${questionInfo.index}:${normalizeAnswerLetters(rawAnswer)}`);
            }
            unresolved.push(questionInfo);
            return;
          }
          answers[questionInfo.index - 1] = answer;
          sources[questionInfo.index - 1] = 'ai';
        });

        if (unresolved.length) {
          log('AI batch answers need single-question repair:', unresolved.map((item) => `Q${item.index}`).join(','));
          const repairedAnswers = await askAiForExamAnswersOneByOne(unresolved);
          unresolved.forEach((questionInfo) => {
            const rawAnswer = repairedAnswers[questionInfo.index] || '';
            const answer = filterAnswerByQuestionOptions(rawAnswer, questionInfo);
            if (!answer) return;
            answers[questionInfo.index - 1] = answer;
            sources[questionInfo.index - 1] = 'ai-repair';
          });
        }
      } catch (err) {
        log('AI answer failed:', err);
        incompleteReason = err?.message || String(err || 'AI answer failed');
      }
    } else if (unknown.length && CFG.exam.autoAnswerByAi) {
      incompleteReason = aiProblem;
    } else if (unknown.length) {
      incompleteReason = 'AI fallback disabled';
    }

    const completed = answers.filter(Boolean).length;
    if (completed === 0 || completed < questions.length) {
      examDynamicAnswerFailedKey = sessionKey;
      examDynamicAnswerFailedAt = now();
      const invalidText = invalidAnswers.length ? ` invalid=${invalidAnswers.join(',')}` : '';
      log('bank/AI answers incomplete:', `${completed}/${questions.length}`, `${incompleteReason || 'answer missing'}${invalidText}`);
      return false;
    }

    const applied = applyExamAnswersToModel(answers, sources.includes('ai') ? 'ai' : 'bank');
    if (applied) {
      examDynamicAnswerFailedKey = '';
      examDynamicAnswerFailedAt = 0;
      saveExamAnswerDraft(
        questionInfos.map((questionInfo, index) => ({
          questionInfo,
          answer: answers[index],
          source: sources[index] || 'unknown',
        })),
        sources.includes('ai') ? 'ai' : 'bank'
      );
      log('bank/AI answers applied:', answers.map((answer, index) => `Q${index + 1}:${answer}:${sources[index] || '?'}`).join(' | '));
    }
    return applied;
  };

  const navigateExamToSubmit = async (maxSteps = 8) => {
    for (let i = 0; i < maxSteps; i += 1) {
      if (findExamSubmitButtons().length > 0) {
        return true;
      }
      const nextButton = findExamNextButton();
      if (!nextButton) {
        return false;
      }
      log('exam navigate to submit, click next:', norm(nextButton.textContent || ''));
      clickElOnce(nextButton);
      await sleep(600);
    }
    return findExamSubmitButtons().length > 0;
  };

  const findExamStartButton = () =>
    queryByText(/开始考试|继续考试|进入考试|开始答题|继续答题/, 'button,a,span,div');

  const findExamNextButton = () =>
    queryByText(/下一题|下一页|下一步|继续答题|继续考试/, 'button,a,span,div');

  const getExamInputVisibilityTarget = (input) =>
    input.closest('label') ||
    (input.id ? document.querySelector(`label[for="${escapeCss(input.id)}"]`) : null) ||
    input.parentElement ||
    input;

  const isExamInputUsable = (input) => {
    if (!input || input.disabled) return false;
    const target = getExamInputVisibilityTarget(input);
    return !!target && isVisible(target);
  };

  const getExamQuestionGroupKey = (input, index) => {
    const name = String(input.name || input.getAttribute('name') || '').trim();
    if (name) return `${input.type}:${name}`;

    const container = input.closest('[class*="question"],[class*="topic"],li,.el-form-item,fieldset,table,tr');
    if (container) {
      return `container:${container.tagName}:${Math.round(container.getBoundingClientRect().top)}`;
    }

    return `fallback:${index}`;
  };

  const extractExamOptionLetterFromText = (text) => {
    const value = norm(text || '');
    if (!value) return '';

    const match = value.match(/(?:^|[^A-Z])([A-F])(?:[\s).:：、]|$)/i);
    if (match) return match[1].toUpperCase();
    if (/^[A-F]$/i.test(value.charAt(0))) return value.charAt(0).toUpperCase();
    return '';
  };

  const detectOptionLetter = (input) => {
    const texts = uniq([
      input.id ? document.querySelector(`label[for="${escapeCss(input.id)}"]`)?.textContent : '',
      input.closest('label')?.textContent || '',
      input.parentElement?.textContent || '',
      input.parentElement?.parentElement?.textContent || '',
    ].map((item) => norm(item || '')).filter(Boolean));

    for (const text of texts) {
      const match = text.match(/(?:^|[\s(（【\[])([A-F])(?:[、.．:：\s)）】\]-]|$)/i);
      if (match) return match[1].toUpperCase();
      if (/^[A-F]$/i.test(text.charAt(0))) return text.charAt(0).toUpperCase();
    }

    return '';
  };

  const getExamOptionClickTarget = (input) =>
    (input.id ? document.querySelector(`label[for="${escapeCss(input.id)}"]`) : null) ||
    input.closest('label') ||
    input.parentElement ||
    input;

  const getExamTextOptionGroups = () => {
    const groups = new Map();
    const selectors = 'label,button,a,span,div,p,li';

    for (const doc of allDocs()) {
      for (const el of doc.querySelectorAll(selectors)) {
        if (!isVisible(el) || isDisabled(el)) continue;

        const text = norm(el.textContent || '');
        if (!text || text.length > 120) continue;

        const letter = extractExamOptionLetterFromText(text);
        if (!letter) continue;

        const hasChildOption = Array.from(el.children || []).some((child) =>
          isVisible(child) && !!extractExamOptionLetterFromText(norm(child.textContent || ''))
        );
        if (hasChildOption) continue;

        const container =
          el.closest('[class*="question"],[class*="topic"],[class*="subject"],[class*="problem"],.el-form-item,fieldset,table,tr,ul,ol,li') ||
          el.parentElement ||
          el;
        const top = container?.getBoundingClientRect?.().top ?? Number.POSITIVE_INFINITY;
        const key = `${container.tagName}:${Math.round(top)}`;

        if (!groups.has(key)) {
          groups.set(key, {
            key: `text:${key}`,
            type: 'text',
            inputs: [],
            top,
          });
        }

        const group = groups.get(key);
        if (group.inputs.some((item) => item.letter === letter)) continue;
        group.inputs.push({
          input: null,
          letter,
          target: getClickableTarget(el) || el,
        });
      }
    }

    return Array.from(groups.values())
      .filter((group) => group.inputs.length >= 2)
      .sort((a, b) => a.top - b.top);
  };

  const getExamQuestionGroups = () => {
    const groups = new Map();
    const inputs = [];

    for (const doc of allDocs()) {
      inputs.push(...Array.from(doc.querySelectorAll('input[type="radio"],input[type="checkbox"]')));
    }

    inputs.forEach((input, index) => {
      if (!isExamInputUsable(input)) return;
      const key = getExamQuestionGroupKey(input, index);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          type: String(input.type || ''),
          inputs: [],
          top: Number.POSITIVE_INFINITY,
        });
      }
      const group = groups.get(key);
      const target = getExamInputVisibilityTarget(input);
      const top = target?.getBoundingClientRect?.().top ?? Number.POSITIVE_INFINITY;
      group.top = Math.min(group.top, top);
      group.inputs.push({
        input,
        letter: detectOptionLetter(input),
        target: getExamOptionClickTarget(input),
      });
    });

    const inputGroups = Array.from(groups.values())
      .map((group) => ({
        ...group,
        inputs: group.inputs.filter((item) => item.letter),
      }))
      .filter((group) => group.inputs.length > 0)
      .sort((a, b) => a.top - b.top);

    if (inputGroups.length > 0) {
      return inputGroups;
    }

    return getExamTextOptionGroups();
  };

  const chooseExamOption = (item) => {
    if (!item) return false;

    const target = item.target;
    if (target && isVisible(target) && !isDisabled(target)) {
      if (item.input && clickElOnce(target)) {
        return true;
      }
      if (!item.input && forceClickEl(target)) {
        return true;
      }
    }

    try {
      if (item.input) {
        item.input.checked = true;
        item.input.dispatchEvent(new Event('input', { bubbles: true }));
        item.input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    } catch (_) {
      return false;
    }

    return false;
  };

  const getExamVisibleOptionSequences = () => {
    const raw = getExamRawOptionCandidates()
      .filter((item) => /^[A-D]$/.test(item.letter))
      .sort((a, b) => a.top - b.top || a.left - b.left);

    const groups = [];
    let current = [];
    const flush = () => {
      const letters = Array.from(new Set(current.map((item) => item.letter)));
      if (current.length >= 2 && letters.length >= 2) {
        groups.push(current);
      }
      current = [];
    };

    for (const item of raw) {
      if (item.letter === 'A' && current.some((candidate) => candidate.letter === 'A')) {
        flush();
      }
      if (!current.some((candidate) => candidate.letter === item.letter)) {
        current.push(item);
      }
      if (current.length >= 4) {
        flush();
      }
    }
    flush();

    return groups.map((items, index) => ({
      index: index + 1,
      letters: items.map((item) => item.letter),
      items,
      top: Math.min(...items.map((item) => item.top)),
    }));
  };

  const answerExamByVisibleOptionSequences = () => {
    if (!CFG.exam.autoSelectBySheet) return false;

    const sheet = getExamAnswerSheet();
    if (!sheet.paperNo || !sheet.answers.length) return false;

    const groups = getExamVisibleOptionSequences();
    if (groups.length === 0) return false;

    let applied = 0;
    const details = [];
    const count = Math.min(sheet.answers.length, groups.length);
    for (let i = 0; i < count; i += 1) {
      const answer = String(sheet.answers[i] || '').toUpperCase();
      const group = groups[i];
      const option = group.items.find((item) => item.letter === answer);
      if (!option) {
        details.push(`Q${i + 1}:${answer}:missing:${group.letters.join('')}`);
        continue;
      }
      if (chooseExamOption(option)) {
        applied += 1;
        details.push(`Q${i + 1}:${answer}:ok`);
      } else {
        details.push(`Q${i + 1}:${answer}:fail`);
      }
    }

    log('exam visible option sequence applied:', `${applied}/${count}`, details.join(' | '));
    return applied > 0;
  };

  const answerExamBySheet = () => {
    if (!CFG.exam.autoSelectBySheet) return false;

    const sheet = getExamAnswerSheet();
    if (!sheet.paperNo || !sheet.answers.length) return false;

    const groups = getExamQuestionGroups();
    if (groups.length === 0) {
      log('exam question groups not found yet');
      return false;
    }

    let applied = 0;
    const details = [];
    for (let i = 0; i < Math.min(groups.length, sheet.answers.length); i += 1) {
      const answer = String(sheet.answers[i] || '').toUpperCase();
      const group = groups[i];
      const option = group.inputs.find((item) => item.letter === answer);
      if (!option) {
        details.push(`Q${i + 1}:${answer}:missing`);
        continue;
      }
      if (chooseExamOption(option)) {
        applied += 1;
        details.push(`Q${i + 1}:${answer}:ok`);
      } else {
        details.push(`Q${i + 1}:${answer}:fail`);
      }
    }

    log('exam answer sheet applied:', sheet.paperNo, `${applied}/${Math.min(groups.length, sheet.answers.length)}`, details.join(' | '));
    return applied > 0;
  };

  const waitForExamQuestionChange = async (prevSignature, prevIndex, timeoutMs = 8000) => {
    const startedAt = now();
    while (now() - startedAt < timeoutMs) {
      await sleep(400);
      const currentIndex = getExamCurrentQuestionIndex();
      const currentSignature = getExamQuestionSignature();
      if (currentIndex && prevIndex && currentIndex !== prevIndex) {
        return true;
      }
      if (currentSignature && prevSignature && currentSignature !== prevSignature) {
        return true;
      }
    }
    return false;
  };

  const answerExamStepByStep = async () => {
    const sheet = getExamAnswerSheet();
    if (!sheet.paperNo || !sheet.answers.length) return false;

    const startButton = findExamStartButton();
    if (startButton) {
      log('exam start button detected:', norm(startButton.textContent || ''));
      clickElOnce(startButton);
      await sleep(Math.max(1000, CFG.examAutoStartDelayMs));
    }

    let answeredCount = 0;
    let expectedIndex = getExamCurrentQuestionIndex() || 1;
    const stepLimit = Math.max(sheet.answers.length * 2, 6);

    for (let step = 0; step < stepLimit; step += 1) {
      const currentIndex = getExamCurrentQuestionIndex() || expectedIndex;
      const answer = sheet.answers[currentIndex - 1];
      if (!answer) {
        log('exam current question index out of range:', currentIndex, sheet.answers.length);
        break;
      }

      const optionState = getExamCurrentQuestionOptions();
      log(
        'exam current option scope:',
        `Q${currentIndex}`,
        optionState.letters.join(',') || 'none',
        optionState.items.map((item) => `${item.letter}:${item.text.slice(0, 40)}`).join(' | ')
      );

      const option = optionState.items.find((item) => item.letter === answer);
      if (!option) {
        log('exam target option missing:', `Q${currentIndex}`, answer, optionState.letters.join(',') || 'none');
        return false;
      }

      if (!chooseExamOption(option)) {
        log('exam choose option failed:', `Q${currentIndex}`, answer);
        return false;
      }

      answeredCount += 1;
      log('exam step answered:', `Q${currentIndex}`, answer);
      await sleep(600);

      if (currentIndex >= sheet.answers.length) {
        return answeredCount > 0;
      }

      const nextButton = findExamNextButton();
      if (!nextButton) {
        log('exam next button not found after answer:', `Q${currentIndex}`);
        return answeredCount > 0;
      }

      const prevSignature = getExamQuestionSignature();
      clickElOnce(nextButton);
      await waitForExamQuestionChange(prevSignature, currentIndex);
      expectedIndex = currentIndex + 1;
    }

    return answeredCount > 0;
  };

  const findExamSubmitButtons = () => {
    const candidates = [];
    const selectors = 'button,a,span,div,[role="button"],input[type="button"],input[type="submit"],.el-button';
    const regex = /^(?:\u63d0\u4ea4|\u63d0\u4ea4\u8bd5\u5377|\u63d0\u4ea4\u7b54\u6848|\u786e\u8ba4\u4ea4\u5377|\u786e\u8ba4\u63d0\u4ea4|\u4ea4\u5377|\u5b8c\u6210\u7b54\u9898|\u6211\u8981\u4ea4\u5377)$/;
    for (const el of queryAllDeep(selectors)) {
      const text = getExamActionText(el);
      const compactText = getExamActionCompactText(el);
      if (!text || !regex.test(compactText) || !isVisible(el) || isDisabled(el)) continue;
      if (text.length > 30) continue;
      const target = getClickableTarget(el) || el;
      if (target && isVisible(target) && !isDisabled(target)) {
        candidates.push(target);
      }
    }

    const styled = findExamPrimaryActionButtons();
    return uniq([...candidates, ...styled]).sort((a, b) => {
      const aText = getExamActionCompactText(a);
      const bText = getExamActionCompactText(b);
      const aExact = /^(?:\u63d0\u4ea4|\u4ea4\u5377|\u63d0\u4ea4\u8bd5\u5377|\u786e\u8ba4\u63d0\u4ea4|\u786e\u8ba4\u4ea4\u5377)$/.test(aText) ? 0 : 1;
      const bExact = /^(?:\u63d0\u4ea4|\u4ea4\u5377|\u63d0\u4ea4\u8bd5\u5377|\u786e\u8ba4\u63d0\u4ea4|\u786e\u8ba4\u4ea4\u5377)$/.test(bText) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aScore = Number(a.dataset.ncmeExamActionScore || 0);
      const bScore = Number(b.dataset.ncmeExamActionScore || 0);
      if (aScore !== bScore) return bScore - aScore;
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });
  };

  const parseRgb = (value) => {
    const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
    if (!match) return null;
    return {
      r: Number(match[1]) || 0,
      g: Number(match[2]) || 0,
      b: Number(match[3]) || 0,
      a: match[4] === undefined ? 1 : Number(match[4]) || 0,
    };
  };

  const isBlueColor = (value) => {
    const rgb = parseRgb(value);
    if (!rgb || rgb.a < 0.2) return false;
    return rgb.b >= 150 && rgb.r <= 120 && rgb.g >= 80 && rgb.g <= 180;
  };

  const findExamPrimaryActionButtons = () => {
    const scored = [];
    for (const el of queryAllDeep('button,a,span,div,[role="button"],input[type="button"],input[type="submit"],.el-button')) {
      if (!isVisible(el) || isDisabled(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 28 || rect.width > 420 || rect.height > 90) continue;

      const view = el.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(el);
      const text = getExamActionText(el);
      const compactText = getExamActionCompactText(el);
      const cls = String(el.className || '');
      const bgBlue = isBlueColor(style.backgroundColor);
      const borderBlue = isBlueColor(style.borderColor);
      const looksClickable =
        style.cursor === 'pointer' ||
        typeof el.onclick === 'function' ||
        el.matches?.('button,a,[role="button"],input,.el-button,[class*="btn"],[class*="button"]');
      const looksSubmitText = /(?:\u63d0\u4ea4|\u4ea4\u5377|submit)/i.test(compactText);
      const rightSide = rect.left > (view.innerWidth || document.documentElement.clientWidth || 0) * 0.45;
      const wideButton = rect.width >= 120 && rect.height >= 34;

      let score = 0;
      if (bgBlue) score += 60;
      if (borderBlue) score += 20;
      if (looksSubmitText) score += 100;
      if (looksClickable) score += 20;
      if (rightSide) score += 20;
      if (wideButton) score += 20;
      if (/primary|submit|sure|confirm|btn|button|el-button/i.test(cls)) score += 15;
      if (/(?:\u4fdd\u5b58\u8fdb\u5ea6|\u8fd4\u56de|\u8ba1\u7b97\u5668|\u7b54\u9898\u5361|\u6536\u8d77)/.test(compactText)) score -= 80;
      if (/^[A-D]$/.test(text)) score -= 100;

      if (score < 70) continue;

      const target = getClickableTarget(el) || el;
      if (!target || !isVisible(target) || isDisabled(target)) continue;
      target.dataset.ncmeExamActionScore = String(score);
      scored.push(target);
    }

    return uniq(scored);
  };

  const findExamConfirmButtons = () => {
    const candidates = [];
    const regex = /^(?:\u786e\u5b9a|\u786e\u8ba4|\u63d0\u4ea4|\u4ea4\u5377|\u7ed3\u675f|\u7ed3\u675f\u7ec3\u4e60|\u662f|\u7ee7\u7eed|\u77e5\u9053\u4e86)$/;
    const dialogScopes = [];
    for (const doc of allDocs()) {
      dialogScopes.push(...Array.from(doc.querySelectorAll('.el-message-box,.el-dialog,[role="dialog"],.modal,.dialog')));
    }

    for (const scope of dialogScopes.filter(Boolean)) {
      for (const el of Array.from(scope.querySelectorAll?.('button,a,span,div,[role="button"],input[type="button"],input[type="submit"],.el-button') || [])) {
        const text = getExamActionText(el);
        const compactText = getExamActionCompactText(el);
        if (!text || text.length > 20 || (!regex.test(text) && !regex.test(compactText))) continue;
        if (!isVisible(el) || isDisabled(el)) continue;
        const target = getClickableTarget(el) || el;
        if (target && isVisible(target) && !isDisabled(target)) {
          candidates.push(target);
        }
      }
    }

    if (candidates.length > 0) {
      return uniq(candidates).sort((a, b) => {
        const aText = getExamActionCompactText(a);
        const bText = getExamActionCompactText(b);
        const scoreText = (text) => {
          if (/^\u7ed3\u675f\u7ec3\u4e60$/.test(text)) return 0;
          if (/^\u7ed3\u675f$/.test(text)) return 1;
          if (/^\u786e\u8ba4$/.test(text)) return 2;
          if (/^\u786e\u5b9a$/.test(text)) return 3;
          if (/^\u63d0\u4ea4$/.test(text)) return 4;
          if (/^\u4ea4\u5377$/.test(text)) return 5;
          return 9;
        };
        const diff = scoreText(aText) - scoreText(bText);
        if (diff !== 0) return diff;
        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      });
    }

    return uniq(findExamPrimaryActionButtons()).sort((a, b) => {
      const aScore = Number(a.dataset.ncmeExamActionScore || 0);
      const bScore = Number(b.dataset.ncmeExamActionScore || 0);
      if (aScore !== bScore) return bScore - aScore;
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });
  };

  const submitExamByUi = async () => {
    const buttons = findExamSubmitButtons();
    const first = buttons[0];
    if (!first) return false;

    setAfterExamReturnUrl();
    log('submit exam by ui:', getExamActionText(first));
    forceClickEl(first) || clickElOnce(first);
    await sleep(1200);

    const confirms = [
      ...findExamConfirmButtons().filter((el) => el !== first),
      ...findExamSubmitButtons().filter((el) => el !== first),
    ];
    const confirm = confirms.find((el) => /(?:\u7ed3\u675f\u7ec3\u4e60|\u7ed3\u675f|\u786e\u8ba4|\u786e\u5b9a|\u63d0\u4ea4|\u4ea4\u5377)/.test(getExamActionCompactText(el))) || confirms[0];
    if (confirm) {
      log('confirm submit exam by ui:', getExamActionText(confirm));
      forceClickEl(confirm) || clickElOnce(confirm);
      await sleep(800);
    }
    return true;
  };

  const submitExamPaper = async (payload) => {
    setAfterExamReturnUrl();
    const auth = getUserAuthInfo();
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      channel: 'pc',
    };
    if (auth.header) {
      headers.authorization = auth.header;
    }

    const resp = await fetch('/resourceApi/web/exam/paper/submitPaper', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    const json = safeJsonParse(text, null);
    examRuntime.lastSubmitPayload = payload;
    examRuntime.lastSubmitResponse = json || text;
    pushExamApiLog({
      kind: 'auto-submit',
      stage: 'response',
      url: '/resourceApi/web/exam/paper/submitPaper',
      method: 'POST',
      status: resp.status,
      body: liteValue(json || text, 0),
    });
    return {
      ok: resp.ok,
      status: resp.status,
      data: json || text,
    };
  };

  const maybeAutoSubmitExam = async () => {
    if (!CFG.exam.enabled || !CFG.exam.autoSubmit) return false;
    if (examSubmitInProgress) return true;
    if (examAutoStarted) return true;

    const built = buildExamSubmitPayload();
    if (!built) return false;

    const context = getExamContext();
    if (!context.periodId || !context.sourceType || !context.topicId) {
      log('exam context incomplete, wait for more api data');
      return false;
    }

    examAutoStarted = true;
    examSubmitInProgress = true;

    try {
      log('auto submit exam start:', built.key, context.topicId, built.payload.questions.length);
      void sendNotify('EXAM', '开始自动提交考试答案', [
        context.topicId ? `topicId: ${context.topicId}` : '',
        context.periodId ? `periodId: ${context.periodId}` : '',
        `questions: ${built.payload.questions.length}`,
        built.key ? `config: ${built.key}` : '',
      ], {
        intervalMs: 5000,
        key: `exam-start:${hashText(String(context.topicId || built.key || 'default'))}`,
      });
      const result = await submitExamPaper(built.payload);
      examCompletedAt = now();
      log('auto submit exam result:', result.status, result.data);
      void sendNotify('EXAM', '考试答案已自动提交', [
        context.topicId ? `topicId: ${context.topicId}` : '',
        `status: ${result.status}`,
      ], {
        intervalMs: 5000,
        key: `exam-submit:${hashText(String(context.topicId || built.key || 'default'))}`,
      });
      return true;
    } catch (err) {
      examAutoStarted = false;
      logError('auto submit exam failed:', err);
      void notifyError('考试自动提交失败', err, [
        context.topicId ? `topicId: ${context.topicId}` : '',
        context.periodId ? `periodId: ${context.periodId}` : '',
      ], {
        key: `exam-submit-failed:${hashText(String(context.topicId || 'unknown'))}`,
      });
      return false;
    } finally {
      examSubmitInProgress = false;
    }
  };

  const maybeAutoHandleExam = async () => {
    if (!CFG.exam.enabled) return false;
    if (examSubmitInProgress) return true;
    if (examAutoStarted) return true;

    const directSubmitDone = await maybeAutoSubmitExam();
    if (directSubmitDone) return true;

    if (!CFG.exam.autoSelectBySheet) return false;

    const sheet = getExamAnswerSheet();
    if (!sheet.paperNo || !sheet.sequence) {
      const context = getExamContext();
      log(
        'exam paper number not recognized, skip sheet answering',
        'title=',
        sheet.title || '(empty)',
        'detected=',
        sheet.detectedPaperNo || 0,
        'resolved=',
        sheet.paperNo || 0,
        'topicId=',
        context.topicId || '(empty)'
      );
      examAutoStarted = true;
      const dynamicAnswered = await answerExamByBankOrAi();
      if (!dynamicAnswered) {
        examAutoStarted = false;
        return false;
      }
      await sleep(CFG.nextDelayMs);
      await navigateExamToSubmit(getExamQuestionModel()?.questions?.length + 2 || 8);
      const submitted = await submitExamByUi();
      if (submitted) {
        examCompletedAt = now();
      } else {
        examAutoStarted = false;
      }
      return submitted;
    }

    examAutoStarted = true;
    try {
      let answered = false;
      const visibleAnswered = answerExamByVisibleOptionSequences();
      if (visibleAnswered) {
        answered = true;
        await sleep(800);
      } else {
        const modelAnswered = applyExamAnswersByModel();
        if (modelAnswered) {
          answered = true;
          await sleep(800);
        } else {
          const groups = getExamQuestionGroups();
          answered = groups.length >= sheet.answers.length
            ? answerExamBySheet()
            : await answerExamStepByStep();
        }
      }
      if (!answered) {
        answered = await answerExamByBankOrAi();
      }
      if (!answered) {
        examAutoStarted = false;
        return false;
      }

      void sendNotify('EXAM', '已按答案表自动作答', [
        sheet.paperNo ? `paper: ${sheet.paperNo}` : '',
        sheet.sequence ? `answers: ${sheet.sequence}` : '',
      ], {
        intervalMs: 5000,
        key: `exam-sheet-answered:${sheet.paperNo}`,
      });

      await sleep(CFG.nextDelayMs);
      await navigateExamToSubmit(sheet.answers.length + 2);
      const submitted = await submitExamByUi();
      if (submitted) {
        examCompletedAt = now();
        void sendNotify('EXAM', '已自动提交考试页面', [
          sheet.paperNo ? `paper: ${sheet.paperNo}` : '',
        ], {
          intervalMs: 5000,
          key: `exam-sheet-submit:${sheet.paperNo}`,
        });
      } else {
        examAutoStarted = false;
      }
      return submitted;
    } catch (err) {
      examAutoStarted = false;
      logError('sheet exam automation failed:', err);
      void notifyError('考试页面自动作答失败', err, [
        sheet.paperNo ? `paper: ${sheet.paperNo}` : '',
        sheet.sequence ? `answers: ${sheet.sequence}` : '',
      ], {
        key: `exam-sheet-failed:${sheet.paperNo || 'unknown'}`,
      });
      return false;
    }
  };

  const resetExamAutomationState = () => {
    examAutoStarted = false;
    examSubmitInProgress = false;
    examCompletedAt = 0;
    examRuntime.lastSubmitPayload = null;
    examRuntime.lastSubmitResponse = null;
    return true;
  };

  const getPlayableEntriesForCurrentScope = (scope, returningToList, lastLessonTitle) =>
    getCourseListPlayEntries()
      .filter((entry) => {
        if (CFG.skipAutoPlayItemText.test(entry.rowText)) return false;
        if (entry.status === '已完成') return false;
        if (returningToList && lastLessonTitle && entry.rowText.includes(lastLessonTitle)) return false;
        if (!isPendingLessonText(entry.rowText)) return false;
        if (!scope.unit) return true;
        const rect = entry.button.getBoundingClientRect();
        return rect.top > scope.top + 10 && rect.top < scope.nextTop - 10;
      })
      .sort((a, b) => a.button.getBoundingClientRect().top - b.button.getBoundingClientRect().top);

  const resolveCourseListAction = (context) => {
    const { scope, snapshot, progressText, returningToList, lastLessonTitle } = context;

    const examEntry = scope.unit
      ? getExamEntriesForUnitScope(scope.unit, scope.nextTop).find((item) => isPendingExamEntry(item))
      : getPendingExamEntry();
    if (examEntry) {
      const pendingVideoBeforeExam =
        (scope.unit ? getPlayEntriesForUnitScope(scope.unit, scope.nextTop) : []).find((item) => isPendingLessonText(item.rowText)) ||
        getPendingVideosBeforeExamEntry(examEntry, scope.unit, scope.nextTop)[0] ||
        null;
      if (!pendingVideoBeforeExam) {
        return {
          type: 'exam',
          entry: examEntry,
          execute: () => clickListEntryAction(examEntry, {
            kind: 'exam',
            snapshot,
            progressText,
            notifyTitle: '从课程目录进入试卷',
            keyPrefix: 'list-exam-click',
            expectedExamSource: 'list-exam-click',
            failureReason: 'exam-click-failed',
          }),
        };
      }
      log('skip exam because pending video exists before exam:', pendingVideoBeforeExam.title || pendingVideoBeforeExam.rowText.slice(0, 120));
    }

    const playEntry = getPlayableEntriesForCurrentScope(scope, returningToList, lastLessonTitle)[0] || null;
    if (playEntry) {
      return {
        type: 'play',
        entry: playEntry,
        execute: () => clickListEntryAction(playEntry, {
          kind: 'play',
          snapshot,
          progressText,
          notifyTitle: '从课程列表进入视频',
          keyPrefix: 'list-click',
          failureReason: 'list-click-failed',
        }),
      };
    }

    return null;
  };

  const tryStartCourseFromList = () => {
    if (navigationInProgress) return true;
    if (now() < listActionQuietUntil || isListPlayLocked()) return true;
    if (isActivePlayerFresh()) {
      log('active player detected, skip list automation');
      return true;
    }

    const returningToList = getStorage(STORAGE.returningToList) === '1';
    const lastLessonTitle = getStorage(STORAGE.lastLessonTitle) || '';
    const snapshot = collectCourseSnapshot() || getCourseSnapshot();
    const progressText = getProgressText(snapshot);
    const currentScope = getCurrentPendingUnitScope();
    const action = resolveCourseListAction({
      scope: currentScope,
      snapshot,
      progressText,
      returningToList,
      lastLessonTitle,
    });
    if (action) return action.execute();

    if (CFG.autoExpandUnits && expandPendingUnitByVue()) {
      listActionQuietUntil = now() + 3000;
      void notifyListStatus('展开下一个未学习单元', snapshot, progressText, [
        '方式: Vue 数据 isShow',
      ], {
        key: 'vue-expand-pending-unit',
      });
      return true;
    }

    if (!CFG.autoExpandUnits) {
      log('no visible pending play entry; waiting for unit expansion');
      listActionQuietUntil = now() + 30 * 1000;
      void notifyListStatus('等待展开未学习单元', snapshot, progressText, [
        '说明: 未发现可见的未学习播放按钮，已停止猜测点击。',
      ], {
        intervalMs: 60 * 1000,
        key: 'wait-visible-pending-play',
      });
      return true;
    }

    return tryExpandNextPendingUnit(snapshot, progressText);
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
      if (navigationReason.startsWith('list-exam:')) {
        clearListPlayLock('arrived-exam');
        resetNavigationState('arrived-exam');
        return;
      }
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
    markActivePlayer('bind-video');
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
      markActivePlayer('heartbeat');
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

    const onExamReportPage = isExamReportPage();
    const onExamPage = !onExamReportPage && isExamPage();

    if (isAutomationStopped() && !onExamReportPage) {
      if (allowNotify('automation-stopped-log', 60 * 1000)) {
        log('automation stopped, skip main loop:', readJsonStorage(STORAGE.autoStopped, {}));
      }
      return;
    }

    if (!onExamReportPage && !onExamPage && (examSessionKey || examAutoStarted || examSubmitInProgress || examCompletedAt)) {
      resetExamAutomationState('leave-exam-surface');
      clearExamSessionState('leave-exam-surface');
    }

    if (/\/study-course\//.test(location.pathname)) {
      collectCourseSnapshot();
      collectExamPlanFromCourseStudy();
    }

    if (onExamReportPage) {
      syncExamSessionState();
      installExamApiHooks();
      if (allowNotify('exam-report-log', 30 * 1000)) {
        log('exam report page detected, automation enabled');
      }
      void handleExamReportPage();
      return;
    }

    if (onExamPage) {
      syncExamSessionState();
      if (allowNotify('exam-log', 30 * 1000)) {
        log('exam page detected, automation enabled');
      }
      installExamApiHooks();
      installExamFocusShield();
      void maybeAutoHandleExam();
      return;
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
      markActivePlayer('main-loop');
    }

    maybeHandleNextOverlay();

    const videos = findPlayableVideos();
    if (videos.length > 0) {
      markActivePlayer('video-found');
      videos.forEach(bindVideo);
      return;
    }

    if (/study-course/.test(location.pathname)) {
      if (isActivePlayerFresh()) {
        log('active player detected, course list listener paused');
        return;
      }
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
      version: '0.3.4',
      CFG,
      mainLoop: () => runSafely('manual mainLoop', mainLoop),
      pauseListAutomation: (ms = 60000) => runSafely('manual pauseListAutomation', () => {
        listActionQuietUntil = now() + Number(ms || 60000);
        listPlayLockUntil = Math.max(listPlayLockUntil, listActionQuietUntil);
        return listActionQuietUntil;
      }),
      resumeListAutomation: () => runSafely('manual resumeListAutomation', () => {
        resumeAutomation();
        clearActivePlayer('manual');
        triedPendingUnits.clear();
        return true;
      }),
      getAutomationStopped: () => runSafely('manual getAutomationStopped', () => readJsonStorage(STORAGE.autoStopped, null)),
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
      getActivePlayer: () => ({
        fresh: isActivePlayerFresh(),
        active: getActivePlayer(),
        tabId,
      }),
      clearActivePlayer: () => runSafely('manual clearActivePlayer', () => {
        clearActivePlayer('manual');
        return true;
      }),
      getExamState: () => runSafely('manual getExamState', () => ({
        context: liteValue(getExamContext(), 0),
        sheet: liteValue(getExamAnswerSheet(), 0),
        currentQuestionIndex: getExamCurrentQuestionIndex(),
        questionModel: liteValue((() => {
          const model = getExamQuestionModel();
          if (!model) return null;
          return {
            root: model.root,
            path: model.path,
            summary: model.summary,
            questions: model.questions.map((question) => ({
              code: question.code,
              questionNum: question.questionNum,
              no: question.no,
              text: getQuestionText(question),
              options: extractOptionList(question),
              userAnswer: question.userAnswer,
              status: question.status,
              userDoQuestionStatus: question.userDoQuestionStatus,
            })),
          };
        })(), 0),
        currentQuestionOptions: liteValue({
          letters: getExamCurrentQuestionOptions().letters,
          items: getExamCurrentQuestionOptions().items.map((item) => ({
            letter: item.letter,
            text: item.text,
            source: item.source,
          })),
        }, 0),
        questionGroups: liteValue(getExamQuestionGroups().map((group) => ({
          key: group.key,
          type: group.type,
          options: group.inputs.map((item) => item.letter),
        })), 0),
        selectedConfig: liteValue(selectExamPayloadConfig(), 0),
        lastPaperData: liteValue(examRuntime.lastPaperData, 0),
        lastSubmitPayload: liteValue(examRuntime.lastSubmitPayload, 0),
        lastSubmitResponse: liteValue(examRuntime.lastSubmitResponse, 0),
        reportSummary: liteValue(getExamReportSummaryV2(), 0),
        sessionKey: examSessionKey,
        submitInProgress: examSubmitInProgress,
        autoStarted: examAutoStarted,
        completedAt: examCompletedAt,
      })),
      getExamAnswerSheet: () => runSafely('manual getExamAnswerSheet', getExamAnswerSheet),
      getExamReportSummary: () => runSafely('manual getExamReportSummary', () => liteValue(getExamReportSummaryV2(), 0)),
      getExamApiLog: () => runSafely('manual getExamApiLog', () => examRuntime.apiLog.slice()),
      getExamCurrentQuestionIndex: () => runSafely('manual getExamCurrentQuestionIndex', getExamCurrentQuestionIndex),
      getExamQuestionModel: () => runSafely('manual getExamQuestionModel', () => {
        const model = getExamQuestionModel();
        if (!model) return null;
        return liteValue({
          root: model.root,
          path: model.path,
          summary: model.summary,
          questions: model.questions.map((question) => ({
            code: question.code,
            questionNum: question.questionNum,
            no: question.no,
            text: getQuestionText(question),
            options: extractOptionList(question),
            userAnswer: question.userAnswer,
            status: question.status,
            userDoQuestionStatus: question.userDoQuestionStatus,
          })),
        }, 0);
      }),
      getExamCurrentQuestionOptions: () => runSafely('manual getExamCurrentQuestionOptions', () => liteValue({
        letters: getExamCurrentQuestionOptions().letters,
        items: getExamCurrentQuestionOptions().items.map((item) => ({
          letter: item.letter,
          text: item.text,
          source: item.source,
        })),
      }, 0)),
      getExamRawOptionCandidates: () => runSafely('manual getExamRawOptionCandidates', () => liteValue(
        getExamRawOptionCandidates().map((item) => ({
          letter: item.letter,
          text: item.text,
          source: item.source,
          top: Math.round(item.top),
          left: Math.round(item.left),
          tag: item.target?.tagName || '',
          cls: item.target?.className || '',
        })),
        0
      )),
      getExamVisibleOptionSequences: () => runSafely('manual getExamVisibleOptionSequences', () => liteValue(
        getExamVisibleOptionSequences().map((group) => ({
          index: group.index,
          letters: group.letters,
          items: group.items.map((item) => ({
            letter: item.letter,
            text: item.text,
            source: item.source,
            tag: item.target?.tagName || '',
            cls: item.target?.className || '',
          })),
        })),
        0
      )),
      findExamSubmitButtons: () => runSafely('manual findExamSubmitButtons', () => liteValue(
        findExamSubmitButtons().map((el) => ({
          tag: el.tagName,
          cls: el.className || '',
          text: norm(el.textContent || ''),
          score: el.dataset?.ncmeExamActionScore || '',
        })),
        0
      )),
      findExamPrimaryActionButtons: () => runSafely('manual findExamPrimaryActionButtons', () => liteValue(
        findExamPrimaryActionButtons().map((el) => ({
          tag: el.tagName,
          cls: el.className || '',
          text: norm(el.textContent || ''),
          score: el.dataset?.ncmeExamActionScore || '',
          rect: {
            top: Math.round(el.getBoundingClientRect().top),
            left: Math.round(el.getBoundingClientRect().left),
            width: Math.round(el.getBoundingClientRect().width),
            height: Math.round(el.getBoundingClientRect().height),
          },
        })),
        0
      )),
      findExamConfirmButtons: () => runSafely('manual findExamConfirmButtons', () => liteValue(
        findExamConfirmButtons().map((el) => ({
          tag: el.tagName,
          cls: el.className || '',
          text: norm(el.textContent || ''),
          score: el.dataset?.ncmeExamActionScore || '',
        })),
        0
      )),
      answerExamByVisibleOptionSequences: () => runSafely('manual answerExamByVisibleOptionSequences', answerExamByVisibleOptionSequences),
      applyExamAnswersByModel: () => runSafely('manual applyExamAnswersByModel', applyExamAnswersByModel),
      answerExamByBankOrAi: () => runSafely('manual answerExamByBankOrAi', answerExamByBankOrAi),
      getExamAnswerBank: () => runSafely('manual getExamAnswerBank', () => liteValue(getExamAnswerBank(), 0)),
      clearExamAnswerBank: () => runSafely('manual clearExamAnswerBank', () => {
        removeStorage(STORAGE.examAnswerBank);
        return true;
      }),
      getExamAnswerDraft: () => runSafely('manual getExamAnswerDraft', () => liteValue(getExamAnswerDraft(), 0)),
      clearExamAnswerDraft: () => runSafely('manual clearExamAnswerDraft', () => {
        clearExamAnswerDraft();
        return true;
      }),
      getAiConfig: () => runSafely('manual getAiConfig', () => {
        const cfg = getAiConfig();
        return {
          ...cfg,
          apiKey: cfg.apiKey ? '***' : '',
          problem: getAiConfigProblem(cfg),
        };
      }),
      setAiConfig: (value) => runSafely('manual setAiConfig', () => {
        const cfg = setAiConfig(value);
        return cfg
          ? {
              ...cfg,
              apiKey: cfg.apiKey ? '***' : '',
              problem: getAiConfigProblem(cfg),
            }
          : false;
      }),
      setExamPayloadConfigs: (value) => runSafely('manual setExamPayloadConfigs', () => {
        const parsed = safeJsonParse(value, value);
        setExamPayloadConfigs(parsed);
        return true;
      }),
      getExamPayloadConfigs: () => runSafely('manual getExamPayloadConfigs', getExamPayloadConfigs),
      clearExamPayloadConfigs: () => runSafely('manual clearExamPayloadConfigs', () => {
        removeStorage(STORAGE.examPayloads);
        return true;
      }),
      installExamFocusShield: () => runSafely('manual installExamFocusShield', installExamFocusShield),
      resetExamAutomation: () => runSafely('manual resetExamAutomation', resetExamAutomationState),
      autoHandleExam: () => runSafely('manual autoHandleExam', maybeAutoHandleExam),
      handleExamReportPage: () => runSafely('manual handleExamReportPage', handleExamReportPage),
      autoSubmitExam: () => runSafely('manual autoSubmitExam', maybeAutoSubmitExam),
      answerExamStepByStep: () => runSafely('manual answerExamStepByStep', answerExamStepByStep),
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
      getExamPlan: () => runSafely('manual getExamPlan', () => liteValue(getExamPlan() || collectExamPlanFromCourseStudy(), 0)),
      getExamParamMap: () => runSafely('manual getExamParamMap', () => liteValue(getExamParamMap(), 0)),
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
        return tryExpandNextPendingUnit(snapshot, getProgressText(snapshot));
      }),
      getCourseListPlayEntries: () => runSafely('manual getCourseListPlayEntries', getCourseListPlayEntries),
      getCourseListExamEntries: () => runSafely('manual getCourseListExamEntries', () => liteValue(
        getCourseListExamEntries().map((entry) => ({
          title: entry.title,
          status: entry.status,
          rowText: entry.rowText,
          buttonText: norm(entry.button?.textContent || ''),
        })),
        0
      )),
      getPendingPlayEntries: (includeHidden = false) => runSafely('manual getPendingPlayEntries', () => getPendingPlayEntries(!!includeHidden)),
      getCourseSnapshot: () => runSafely('manual getCourseSnapshot', () => collectCourseSnapshot() || getCourseSnapshot()),
      getUnitItems: () => runSafely('manual getUnitItems', getUnitItemsDebug),
      getPlayEntriesForUnitItem: () => runSafely('manual getPlayEntriesForUnitItem', () => {
        return getPlayEntriesForUnitItem(getPendingUnitElement());
      }),
      getPlayEntriesForPendingUnitScope: () => runSafely('manual getPlayEntriesForPendingUnitScope', () => {
        const scope = getCurrentPendingUnitScope();
        return scope.unit ? getPlayEntriesForUnitScope(scope.unit, scope.nextTop) : [];
      }),
      clickPendingUnitHeader: () => runSafely('manual clickPendingUnitHeader', () => {
        const unit = getPendingUnitElement();
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
        const entry = entries.find((item) => isPendingLessonText(item.rowText));
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
        return tryExpandNextPendingUnit(snapshot, getProgressText(snapshot));
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
