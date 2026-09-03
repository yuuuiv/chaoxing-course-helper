// ==UserScript==
// @name         超星选课助手
// @namespace    https://github.com/yuuuiv
// @version      v1.0.1
// @description  自动读取超星选课规则和课程列表，支持动态目标数量、定时严格并发报名、有限重试和结果核验。
// @author       yuuuiv
// @license      MIT
// @match        https://appcd.chaoxing.com/selection/pc/index*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const API_ROOT = '/selection/';
  const SETTINGS_KEY = 'chaoxing-course-helper-settings-v1';
  const PANEL_POSITION_KEY = 'chaoxing-course-helper-panel-position-v1';
  const PANEL_HIDDEN_KEY = 'chaoxing-course-helper-panel-hidden-v1';
  const DEFAULT_RETRY_INTERVAL_MS = 1000;
  const MIN_RETRY_INTERVAL_MS = 500;
  const MAX_RETRY_INTERVAL_MS = 10000;
  const DEFAULT_MAX_ATTEMPTS = 12;
  const MAX_ATTEMPTS_LIMIT = 60;

  const state = {
    plan: null,
    courses: [],
    counts: new Map(),
    enrolledIds: new Set(),
    running: false,
    runToken: 0,
    clockOffsetMs: 0,
    clockSampleAt: 0,
    targetLimit: 1,
    countdownTimer: null,
    logs: []
  };

  const ui = {};

  const addStyle = typeof GM_addStyle === 'function'
    ? GM_addStyle
    : (css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      };

  addStyle(`
    #cxch-panel, #cxch-panel *, #cxch-dock, #cxch-dock * { box-sizing: border-box; }
    #cxch-panel {
      --cxch-ink: #101828;
      --cxch-muted: #667085;
      --cxch-line: #e4e7ec;
      --cxch-paper: #ffffff;
      --cxch-tint: #f5f7fa;
      --cxch-accent: #4f46e5;
      --cxch-accent-2: #2563eb;
      --cxch-red: #e11d48;
      position: fixed;
      z-index: 2147483000;
      top: 92px;
      right: 22px;
      width: min(384px, calc(100vw - 24px));
      max-height: calc(100vh - 24px);
      overflow: auto;
      color: var(--cxch-ink);
      background: var(--cxch-paper);
      border: 1px solid var(--cxch-line);
      border-radius: 18px;
      box-shadow: 0 24px 48px -12px rgba(16, 24, 40, .18), 0 4px 10px rgba(16, 24, 40, .06);
      font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    #cxch-panel button, #cxch-panel input, #cxch-panel select { font: inherit; }
    #cxch-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 16px 14px;
      color: #fff;
      background: linear-gradient(135deg, var(--cxch-accent-2), var(--cxch-accent));
      border-radius: 17px 17px 0 0;
      cursor: move;
      user-select: none;
      touch-action: none;
    }
    #cxch-title { font-size: 15px; font-weight: 700; letter-spacing: .01em; }
    #cxch-subtitle { margin-top: 3px; font-size: 11px; color: rgba(255,255,255,.82); letter-spacing: .04em; }
    #cxch-hide {
      flex-shrink: 0;
      padding: 6px 10px;
      color: #fff;
      background: rgba(255,255,255,.14);
      border: 1px solid rgba(255,255,255,.3);
      border-radius: 8px;
      cursor: pointer;
      transition: background .15s ease;
    }
    #cxch-hide:hover { background: rgba(255,255,255,.24); }
    #cxch-body { padding: 16px; }
    #cxch-plan {
      padding: 12px 13px;
      background: var(--cxch-tint);
      border: 1px solid var(--cxch-line);
      border-radius: 12px;
    }
    #cxch-plan-name { font-size: 13.5px; font-weight: 700; }
    #cxch-plan-meta { margin-top: 4px; color: var(--cxch-muted); font-size: 11.5px; }
    .cxch-section-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 18px 1px 8px;
      color: var(--cxch-muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    #cxch-refresh {
      padding: 3px 8px;
      color: var(--cxch-accent);
      background: transparent;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      letter-spacing: 0;
      text-transform: none;
      font-weight: 600;
      transition: background .15s ease;
    }
    #cxch-refresh:hover:not(:disabled) { background: rgba(79,70,229,.08); }
    .cxch-slot {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      align-items: center;
      gap: 9px;
      margin-bottom: 8px;
    }
    .cxch-slot-number {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      color: var(--cxch-accent);
      background: rgba(79,70,229,.1);
      border-radius: 9px;
      font-family: Consolas, monospace;
      font-size: 11.5px;
      font-weight: 700;
    }
    .cxch-slot select, .cxch-control input, .cxch-control select {
      width: 100%;
      min-width: 0;
      height: 36px;
      padding: 0 10px;
      color: var(--cxch-ink);
      background: var(--cxch-paper);
      border: 1px solid #d0d5dd;
      border-radius: 9px;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .cxch-slot select:focus, .cxch-control input:focus, .cxch-control select:focus {
      border-color: var(--cxch-accent);
      box-shadow: 0 0 0 3px rgba(79,70,229,.14);
    }
    .cxch-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .cxch-control label { display: block; margin: 0 0 5px 2px; color: var(--cxch-muted); font-size: 11.5px; }
    .cxch-control-wide { grid-column: 1 / -1; }
    #cxch-clock { margin-top: 8px; color: var(--cxch-muted); font-size: 11.5px; }
    #cxch-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 15px; }
    #cxch-actions button {
      min-height: 40px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 700;
      font-size: 13.5px;
      transition: filter .15s ease, background .15s ease;
    }
    #cxch-start {
      color: #fff;
      background: linear-gradient(135deg, var(--cxch-accent-2), var(--cxch-accent));
      border: 0;
    }
    #cxch-start:hover:not(:disabled) { filter: brightness(1.06); }
    #cxch-stop {
      color: var(--cxch-red);
      background: #fff;
      border: 1px solid #fecdd6;
    }
    #cxch-stop:hover:not(:disabled) { background: #fff1f2; }
    #cxch-actions button:disabled, #cxch-refresh:disabled { cursor: not-allowed; opacity: .45; }
    #cxch-status {
      margin-top: 14px;
      padding: 10px 11px;
      color: #1d4ed8;
      background: #eff4ff;
      border-left: 3px solid var(--cxch-accent-2);
      border-radius: 8px;
      font-size: 12px;
    }
    #cxch-status[data-kind="error"] { color: #be123c; background: #fff1f2; border-left-color: var(--cxch-red); }
    #cxch-status[data-kind="success"] { color: #067647; background: #ecfdf3; border-left-color: #16a34a; }
    #cxch-log {
      margin: 9px 0 0;
      padding: 9px 11px;
      max-height: 132px;
      overflow: auto;
      color: #475467;
      background: var(--cxch-tint);
      border: 1px solid var(--cxch-line);
      border-radius: 9px;
      font: 11px/1.6 Consolas, "Microsoft YaHei UI", monospace;
      white-space: pre-wrap;
    }
    #cxch-note { margin-top: 11px; color: var(--cxch-muted); font-size: 10.5px; line-height: 1.5; }
    #cxch-dock {
      position: fixed;
      z-index: 2147483000;
      right: 16px;
      bottom: 18px;
      display: none;
      padding: 10px 14px;
      color: #fff;
      background: linear-gradient(135deg, #2563eb, #4f46e5);
      border: 0;
      border-radius: 999px;
      box-shadow: 0 12px 24px -6px rgba(79,70,229,.45);
      cursor: pointer;
      font: 600 12.5px "Segoe UI", "Microsoft YaHei UI", sans-serif;
      transition: filter .15s ease;
    }
    #cxch-dock:hover { filter: brightness(1.06); }
    @media (max-width: 520px), (max-height: 680px) {
      #cxch-panel { top: 12px; right: 12px; max-height: calc(100vh - 24px); }
      #cxch-body { padding: 13px; }
      .cxch-section-label { margin-top: 12px; }
      #cxch-log { max-height: 84px; }
    }
    @media (prefers-reduced-motion: reduce) {
      #cxch-panel *, #cxch-dock { scroll-behavior: auto !important; transition: none !important; }
    }
  `);

  function getValue(key, fallback) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback; }
    catch (_) { return fallback; }
  }

  function setValue(key, value) {
    try { if (typeof GM_setValue === 'function') GM_setValue(key, value); }
    catch (_) {}
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function sleep(ms, token) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (!state.running || token !== state.runToken) {
          clearTimeout(timer);
          clearInterval(check);
          reject(new Error('已停止'));
        }
      }, Math.min(100, ms));
      setTimeout(() => clearInterval(check), ms + 10);
    });
  }

  function serverNow() {
    return Date.now() + state.clockOffsetMs;
  }

  function updateClockSample(payload, startedAt, endedAt) {
    const timestamp = Number(payload?.timestamp);
    if (!Number.isFinite(timestamp)) return;
    const midpoint = (startedAt + endedAt) / 2;
    state.clockOffsetMs = Math.round(timestamp - midpoint);
    state.clockSampleAt = Date.now();
    renderClock();
  }

  async function requestJson(path, options = {}) {
    const startedAt = Date.now();
    const response = await pageWindow.fetch(`${API_ROOT}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        ...(options.headers || {})
      }
    });
    const endedAt = Date.now();
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      if (/<!doctype|<html/i.test(text)) throw new Error('接口返回了网页，登录可能已失效');
      throw new Error(`接口返回非 JSON 内容（HTTP ${response.status}）`);
    }
    updateClockSample(payload, startedAt, endedAt);
    if (!response.ok) {
      const error = new Error(payload?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function postForm(path, data) {
    const body = new URLSearchParams();
    Object.entries(data).forEach(([key, value]) => body.set(key, value ?? ''));
    return requestJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString()
    });
  }

  async function waitForPlan(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const plan = pageWindow.vm?.plan;
      if (plan?.id) return plan;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('没有读取到当前选课计划，请刷新页面后重试');
  }

  async function loadCoursePage(pageNum) {
    return postForm('pc/getCoursesByTypeIdAndClassId', {
      planId: state.plan.id,
      typeId: '',
      searchName: '',
      pageNum
    });
  }

  async function loadEnrollmentState() {
    const [chosenResult, stateResult] = await Promise.all([
      requestJson(`enroll/getUserEnrollCourseList?planId=${encodeURIComponent(state.plan.id)}`),
      requestJson(`enroll/getUserEnroll?planId=${encodeURIComponent(state.plan.id)}&opType=1`)
    ]);

    const chosen = chosenResult?.data?.courseList || [];
    const enrollments = stateResult?.data?.courseEnrollList || [];
    state.enrolledIds = new Set([
      ...chosen.map((item) => Number(item.id ?? item.courseId)),
      ...enrollments.map((item) => Number(item.courseId ?? item.id))
    ].filter(Number.isFinite));

    state.counts = new Map(
      (stateResult?.data?.courseEnrollNumList || []).map((item) => [
        Number(item.course_id ?? item.courseId),
        Number(item.count) || 0
      ])
    );
    return { chosen, enrollments };
  }

  function courseSortKey(course) {
    const time = course.courseTimeList?.[0];
    return [Number(time?.day ?? 99), String(time?.startTime || '99:99'), String(course.name || '')];
  }

  function compareCourses(a, b) {
    const ak = courseSortKey(a);
    const bk = courseSortKey(b);
    return ak[0] - bk[0] || ak[1].localeCompare(bk[1]) || ak[2].localeCompare(bk[2], 'zh-CN');
  }

  async function loadCatalog() {
    setStatus('正在读取课程目录…');
    ui.refresh.disabled = true;
    try {
      const first = await loadCoursePage(1);
      const pages = Math.max(1, Number(first.pages) || 1);
      const rest = pages > 1
        ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => loadCoursePage(index + 2)))
        : [];
      const unique = new Map();
      [first, ...rest].flatMap((page) => page.list || []).forEach((course) => unique.set(Number(course.id), course));
      state.courses = [...unique.values()].sort(compareCourses);
      await loadEnrollmentState();
      updateTargetLimit();
      renderCourseSelects();
      setStatus(`已读取 ${state.courses.length} 门课程`, 'success');
      addLog(`课程目录刷新完成：${state.courses.length} 门`);
    } finally {
      ui.refresh.disabled = state.running;
    }
  }

  function selectedTargets() {
    return ui.selects
      .map((select) => ({ courseId: Number(select.value) }))
      .filter((target) => Number.isFinite(target.courseId));
  }

  function selectedIds() {
    return selectedTargets().map((target) => target.courseId);
  }

  function courseLabel(course) {
    const used = state.counts.get(Number(course.id)) || 0;
    const capacity = Number(course.enroll);
    const remaining = Number.isFinite(capacity) ? Math.max(0, capacity - used) : '?';
    const enrolled = state.enrolledIds.has(Number(course.id)) ? ' · 已选' : '';
    return `[${course.typeName || '未分类'}] ${course.name} · 余 ${remaining}/${course.enroll ?? '?'} · ID ${course.id}${enrolled}`;
  }

  function renderCourseSelects() {
    const previous = ui.selects.map((select) => select.value);
    const picked = new Set(previous.filter(Boolean));
    ui.selects.forEach((select, selectIndex) => {
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = state.courses.length ? '不选择' : '尚未读取课程';
      select.appendChild(placeholder);

      const groups = new Map();
      for (const course of state.courses) {
        const groupName = course.typeName || '其他课程';
        if (!groups.has(groupName)) groups.set(groupName, []);
        groups.get(groupName).push(course);
      }
      for (const [groupName, courses] of groups) {
        const group = document.createElement('optgroup');
        group.label = groupName;
        for (const course of courses) {
          const option = document.createElement('option');
          option.value = String(course.id);
          option.textContent = courseLabel(course);
          option.disabled = picked.has(option.value) && option.value !== previous[selectIndex];
          group.appendChild(option);
        }
        select.appendChild(group);
      }
      if (state.courses.some((course) => String(course.id) === previous[selectIndex])) {
        select.value = previous[selectIndex];
      }
    });
  }

  function countBasedTargetLimit() {
    const quota = Math.floor(Number(state.plan?.maxQuota));
    if (!Number.isFinite(quota) || quota < 1) return 1;
    if (Number(state.plan?.enrollMode) === 1) return Math.max(0, quota - state.enrolledIds.size);
    const positiveHours = state.courses.map((course) => Number(course.hour)).filter((hour) => hour > 0);
    const minimumHour = positiveHours.length ? Math.min(...positiveHours) : 1;
    return Math.max(0, Math.floor(quota / minimumHour));
  }

  function updateTargetLimit() {
    const previousCount = Number(ui.targetCount?.value) || 1;
    state.targetLimit = countBasedTargetLimit();
    ui.targetCount.replaceChildren();
    if (state.targetLimit === 0) {
      const option = document.createElement('option');
      option.value = '0';
      option.textContent = '已达到计划上限';
      ui.targetCount.appendChild(option);
      renderTargetSlots(0);
      return;
    }
    for (let count = 1; count <= state.targetLimit; count += 1) {
      const option = document.createElement('option');
      option.value = String(count);
      option.textContent = `${count} 门`;
      ui.targetCount.appendChild(option);
    }
    const nextCount = clamp(previousCount, 1, state.targetLimit);
    ui.targetCount.value = String(nextCount);
    if (ui.selects.length !== nextCount) renderTargetSlots(nextCount);
  }

  function renderTargetSlots(count, targets = null) {
    const previous = targets || ui.selects.map((select) => ({ courseId: Number(select.value) }));
    ui.slots.replaceChildren();
    ui.selects = [];

    for (let index = 0; index < count; index += 1) {
      const row = document.createElement('label');
      row.className = 'cxch-slot';
      const number = document.createElement('span');
      number.className = 'cxch-slot-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const select = document.createElement('select');
      select.setAttribute('aria-label', `目标课程 ${index + 1}`);
      select.addEventListener('change', () => {
        renderCourseSelects();
        saveSettings();
      });

      row.append(number, select);
      ui.slots.appendChild(row);
      ui.selects.push(select);
    }

    renderCourseSelects();
    ui.selects.forEach((select, index) => {
      const id = Number(previous[index]?.courseId);
      if (state.courses.some((course) => Number(course.id) === id)) select.value = String(id);
    });
    renderCourseSelects();
  }

  function saveSettings() {
    setValue(SETTINGS_KEY, {
      planId: Number(state.plan?.id),
      targetCount: Number(ui.targetCount?.value) || 0,
      targets: selectedTargets(),
      startAt: ui.startAt.value,
      retryIntervalMs: Number(ui.retryInterval.value),
      maxAttempts: Number(ui.maxAttempts.value)
    });
  }

  function restoreSettings() {
    const settings = getValue(SETTINGS_KEY, {});
    const samePlan = Number(settings.planId) === Number(state.plan.id);
    const legacyIds = Array.isArray(settings.courseIds) ? settings.courseIds : [];
    const targets = samePlan && Array.isArray(settings.targets)
      ? settings.targets
      : (samePlan ? legacyIds.map((courseId) => ({ courseId })) : []);
    const desiredCount = state.targetLimit === 0 ? 0 : clamp(
      Number(settings.targetCount) || targets.length || 1,
      1,
      state.targetLimit
    );
    ui.targetCount.value = String(desiredCount);
    renderTargetSlots(desiredCount, targets);
    ui.startAt.value = samePlan && settings.startAt ? settings.startAt : toDateTimeLocal(planStartDate());
    ui.retryInterval.value = clamp(
      Number(settings.retryIntervalMs) || DEFAULT_RETRY_INTERVAL_MS,
      MIN_RETRY_INTERVAL_MS,
      MAX_RETRY_INTERVAL_MS
    );
    ui.maxAttempts.value = clamp(
      Number(settings.maxAttempts) || DEFAULT_MAX_ATTEMPTS,
      1,
      MAX_ATTEMPTS_LIMIT
    );
  }

  function planStartDate() {
    const raw = state.plan?.startDate || state.plan?.starTimeStr;
    if (!raw) return new Date();
    const parsed = new Date(String(raw).replace('T', ' ').replace(/-/g, '/'));
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  function toDateTimeLocal(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function parseStartAt() {
    const parsed = new Date(ui.startAt.value);
    if (Number.isNaN(parsed.getTime())) throw new Error('开始时间格式不正确');
    return parsed.getTime();
  }

  function setStatus(message, kind = 'info') {
    ui.status.textContent = message;
    ui.status.dataset.kind = kind;
  }

  function addLog(message) {
    const now = new Date();
    const stamp = now.toLocaleTimeString('zh-CN', { hour12: false });
    state.logs.push(`[${stamp}] ${message}`);
    state.logs = state.logs.slice(-12);
    ui.log.textContent = state.logs.join('\n');
    ui.log.scrollTop = ui.log.scrollHeight;
    console.log('[超星选课助手]', message);
  }

  function renderClock() {
    if (!ui.clock) return;
    const offset = state.clockSampleAt ? `${state.clockOffsetMs >= 0 ? '+' : ''}${state.clockOffsetMs} ms` : '未校准';
    ui.clock.textContent = `服务器时间差：${offset}；等待阶段不发送网络请求`;
  }

  function setRunning(running) {
    state.running = running;
    ui.start.disabled = running;
    ui.stop.disabled = !running;
    ui.refresh.disabled = running;
    ui.targetCount.disabled = running;
    ui.selects.forEach((select) => { select.disabled = running; });
    ui.startAt.disabled = running;
    ui.retryInterval.disabled = running;
    ui.maxAttempts.disabled = running;
  }

  function classifyMessage(message) {
    const text = String(message || '未知结果');
    if (/已报名|已选/.test(text)) return 'verify';
    if (/报满|已满|没有余量|冲突|上限|超过|不符合|无权限|不存在|已结束|关闭|未发布|性别|班级/.test(text)) return 'permanent';
    return 'retry';
  }

  async function joinCourse(courseId) {
    try {
      const result = await postForm('enroll/joinCourse', {
        planId: state.plan.id,
        courseId,
        opType: 1
      });
      return {
        courseId,
        ok: Number(result?.code) === 1,
        message: result?.message || (Number(result?.code) === 1 ? '报名成功' : '报名失败'),
        kind: Number(result?.code) === 1 ? 'success' : classifyMessage(result?.message)
      };
    } catch (error) {
      const status = Number(error?.status);
      return {
        courseId,
        ok: false,
        message: error?.message || '网络请求失败',
        kind: status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'permanent' : 'retry'
      };
    }
  }

  async function verifyTargets(targetIds) {
    await loadEnrollmentState();
    return new Set(targetIds.filter((id) => state.enrolledIds.has(Number(id))));
  }

  function formatCountdown(ms) {
    const safe = Math.max(0, ms);
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor((safe % 3600000) / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const tenths = Math.floor((safe % 1000) / 100);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }

  async function waitUntil(targetTime, token) {
    while (state.running && token === state.runToken) {
      const remaining = targetTime - serverNow();
      if (remaining <= 0) return;
      setStatus(`已布置，距离并发报名 ${formatCountdown(remaining)}`);
      await sleep(Math.min(200, remaining), token);
    }
    throw new Error('已停止');
  }

  async function runEnrollment(token, targets, intervalMs, maxAttempts) {
    const targetIds = targets.map((target) => target.courseId);
    const courseMap = new Map(state.courses.map((course) => [Number(course.id), course]));
    const pending = new Set(targetIds);
    const succeeded = new Set();
    const failed = new Map();

    for (let attempt = 1; attempt <= maxAttempts && pending.size; attempt += 1) {
      if (!state.running || token !== state.runToken) throw new Error('已停止');
      setStatus(`第 ${attempt}/${maxAttempts} 轮：并发提交 ${pending.size} 门课程…`);
      const concurrentTargets = [...pending];
      addLog(`第 ${attempt} 轮严格并发：${concurrentTargets.map((id) => courseMap.get(id)?.name || id).join('、')}`);

      const results = await Promise.all(concurrentTargets.map((courseId) => {
        if (!state.running || token !== state.runToken) throw new Error('已停止');
        return joinCourse(courseId);
      }));
      for (const result of results) {
        const name = courseMap.get(result.courseId)?.name || `课程 ${result.courseId}`;
        addLog(`${name}：${result.message}`);
        if (result.ok) {
          succeeded.add(result.courseId);
          pending.delete(result.courseId);
        } else if (result.kind === 'permanent') {
          failed.set(result.courseId, result.message);
          pending.delete(result.courseId);
        }
      }

      try {
        const verified = await verifyTargets(targetIds);
        for (const id of verified) {
          succeeded.add(id);
          pending.delete(id);
          failed.delete(id);
        }
      } catch (error) {
        addLog(`结果核验暂时失败：${error.message}`);
      }

      if (pending.size && attempt < maxAttempts) {
        setStatus(`仍有 ${pending.size} 门待确认，${intervalMs} ms 后重试`);
        await sleep(intervalMs, token);
      }
    }

    for (const id of pending) failed.set(id, '达到最大尝试次数，仍未确认成功');
    const successNames = [...succeeded].map((id) => courseMap.get(id)?.name || id);
    const failedNames = [...failed].map(([id, reason]) => `${courseMap.get(id)?.name || id}（${reason}）`);

    if (succeeded.size === targetIds.length) {
      setStatus(`全部确认成功：${successNames.join('、')}`, 'success');
    } else if (succeeded.size) {
      setStatus(`部分成功 ${succeeded.size}/${targetIds.length}；请查看日志`, 'error');
    } else {
      setStatus('没有课程确认成功；请查看日志', 'error');
    }
    if (successNames.length) addLog(`已确认：${successNames.join('、')}`);
    if (failedNames.length) addLog(`未成功：${failedNames.join('；')}`);
    renderCourseSelects();
  }

  async function start() {
    if (state.running) return;
    const expectedCount = Number(ui.targetCount.value) || 0;
    const targets = selectedTargets();
    if (targets.length !== expectedCount) {
      setStatus(`请选择完整的 ${expectedCount} 门目标课程`, 'error');
      return;
    }
    if (new Set(targets.map((target) => target.courseId)).size !== targets.length) {
      setStatus('目标课程不能重复', 'error');
      return;
    }

    let targetTime;
    try { targetTime = parseStartAt(); }
    catch (error) { setStatus(error.message, 'error'); return; }

    const intervalMs = clamp(Number(ui.retryInterval.value) || DEFAULT_RETRY_INTERVAL_MS, MIN_RETRY_INTERVAL_MS, MAX_RETRY_INTERVAL_MS);
    const maxAttempts = clamp(Number(ui.maxAttempts.value) || DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_LIMIT);
    ui.retryInterval.value = intervalMs;
    ui.maxAttempts.value = maxAttempts;
    saveSettings();

    try {
      await loadEnrollmentState();
    } catch (error) {
      setStatus(`启动前检查失败：${error.message}`, 'error');
      return;
    }

    const newTargets = targets.filter((target) => !state.enrolledIds.has(target.courseId));
    const maxQuota = Number(state.plan.maxQuota);
    if (Number.isFinite(maxQuota) && state.enrolledIds.size + newTargets.length > maxQuota) {
      setStatus(`已选 ${state.enrolledIds.size} 门，再选 ${newTargets.length} 门会超过上限 ${maxQuota}`, 'error');
      return;
    }

    if (!newTargets.length) {
      setStatus('所选课程都已经报名，无需再次提交', 'success');
      return;
    }

    state.runToken += 1;
    const token = state.runToken;
    setRunning(true);
    addLog(`已布置 ${newTargets.length} 门课程；单门成功后不再重试`);

    try {
      await waitUntil(targetTime, token);
      await runEnrollment(token, newTargets, intervalMs, maxAttempts);
    } catch (error) {
      if (error.message !== '已停止') {
        setStatus(`运行中止：${error.message}`, 'error');
        addLog(`运行中止：${error.message}`);
      }
    } finally {
      if (token === state.runToken) setRunning(false);
    }
  }

  function stop() {
    if (!state.running) return;
    state.runToken += 1;
    setRunning(false);
    setStatus('已停止；不会继续发送报名请求');
    addLog('用户手动停止');
  }

  function createPanel() {
    const panel = document.createElement('section');
    panel.id = 'cxch-panel';
    panel.setAttribute('aria-label', '超星选课助手');
    panel.innerHTML = `
      <header id="cxch-header">
        <div><div id="cxch-title">超星选课助手</div><div id="cxch-subtitle">定时 · 并发提交 · 结果核验</div></div>
        <button id="cxch-hide" type="button">隐藏</button>
      </header>
      <div id="cxch-body">
        <div id="cxch-plan"><div id="cxch-plan-name">正在读取选课计划…</div><div id="cxch-plan-meta"></div></div>
        <div class="cxch-section-label"><span>目标课程</span><button id="cxch-refresh" type="button">刷新目录</button></div>
        <div class="cxch-control cxch-control-wide"><label for="cxch-target-count">计划选择数量（按当前计划剩余额度生成）</label><select id="cxch-target-count"><option value="1">1 门</option></select></div>
        <div id="cxch-slots"></div>
        <div class="cxch-section-label"><span>执行设置</span></div>
        <div class="cxch-grid">
          <div class="cxch-control cxch-control-wide"><label for="cxch-start-at">开始时间（本地时区）</label><input id="cxch-start-at" type="datetime-local" step="1"></div>
          <div class="cxch-control"><label for="cxch-retry-interval">重试间隔（ms）</label><input id="cxch-retry-interval" type="number" min="500" max="10000" step="100" value="1000"></div>
          <div class="cxch-control"><label for="cxch-max-attempts">最多尝试轮数</label><input id="cxch-max-attempts" type="number" min="1" max="60" step="1" value="12"></div>
        </div>
        <div id="cxch-clock"></div>
        <div id="cxch-actions"><button id="cxch-start" type="button">布置并等待</button><button id="cxch-stop" type="button" disabled>停止</button></div>
        <div id="cxch-status" role="status" aria-live="polite">准备中…</div>
        <pre id="cxch-log" aria-label="运行日志"></pre>
        <div id="cxch-note">成功以“已选课程”接口核验为准。脚本不会保存登录凭据，也不会绕过验证码或平台限制。</div>
      </div>`;

    ui.slots = panel.querySelector('#cxch-slots');
    ui.selects = [];

    const dock = document.createElement('button');
    dock.id = 'cxch-dock';
    dock.type = 'button';
    dock.textContent = '选课助手';
    document.body.append(panel, dock);

    ui.panel = panel;
    ui.dock = dock;
    ui.header = panel.querySelector('#cxch-header');
    ui.hide = panel.querySelector('#cxch-hide');
    ui.planName = panel.querySelector('#cxch-plan-name');
    ui.planMeta = panel.querySelector('#cxch-plan-meta');
    ui.refresh = panel.querySelector('#cxch-refresh');
    ui.targetCount = panel.querySelector('#cxch-target-count');
    ui.startAt = panel.querySelector('#cxch-start-at');
    ui.retryInterval = panel.querySelector('#cxch-retry-interval');
    ui.maxAttempts = panel.querySelector('#cxch-max-attempts');
    ui.clock = panel.querySelector('#cxch-clock');
    ui.start = panel.querySelector('#cxch-start');
    ui.stop = panel.querySelector('#cxch-stop');
    ui.status = panel.querySelector('#cxch-status');
    ui.log = panel.querySelector('#cxch-log');

    ui.refresh.addEventListener('click', () => loadCatalog().catch((error) => setStatus(`刷新失败：${error.message}`, 'error')));
    ui.targetCount.addEventListener('change', () => {
      renderTargetSlots(Number(ui.targetCount.value) || 0);
      saveSettings();
    });
    ui.start.addEventListener('click', start);
    ui.stop.addEventListener('click', stop);
    ui.hide.addEventListener('click', (event) => { event.stopPropagation(); setPanelHidden(true); });
    dock.addEventListener('click', () => setPanelHidden(false));
    [ui.startAt, ui.retryInterval, ui.maxAttempts].forEach((control) => control.addEventListener('change', saveSettings));
    setupDrag(panel, ui.header);
    restorePanelPosition();
    setPanelHidden(Boolean(getValue(PANEL_HIDDEN_KEY, false)), false);
  }

  function setPanelHidden(hidden, persist = true) {
    ui.panel.style.display = hidden ? 'none' : 'block';
    ui.dock.style.display = hidden ? 'block' : 'none';
    if (persist) setValue(PANEL_HIDDEN_KEY, hidden);
  }

  function panelBounds(left, top) {
    const rect = ui.panel.getBoundingClientRect();
    return {
      left: clamp(left, 0, Math.max(0, window.innerWidth - rect.width)),
      top: clamp(top, 0, Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight)))
    };
  }

  function restorePanelPosition() {
    const position = getValue(PANEL_POSITION_KEY, null);
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const point = panelBounds(position.left, position.top);
    ui.panel.style.left = `${point.left}px`;
    ui.panel.style.top = `${point.top}px`;
    ui.panel.style.right = 'auto';
  }

  function setupDrag(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const point = panelBounds(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
      panel.style.left = `${point.left}px`;
      panel.style.top = `${point.top}px`;
      panel.style.right = 'auto';
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const rect = panel.getBoundingClientRect();
      setValue(PANEL_POSITION_KEY, { left: rect.left, top: rect.top });
      drag = null;
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    window.addEventListener('resize', () => {
      if (panel.style.display === 'none') return;
      const rect = panel.getBoundingClientRect();
      const point = panelBounds(rect.left, rect.top);
      panel.style.left = `${point.left}px`;
      panel.style.top = `${point.top}px`;
      panel.style.right = 'auto';
    });
  }

  async function init() {
    createPanel();
    renderClock();
    try {
      state.plan = await waitForPlan();
      ui.planName.textContent = state.plan.name || `选课计划 ${state.plan.id}`;
      ui.planMeta.textContent = `计划 ID ${state.plan.id} · ${state.plan.starTimeStr || '未知开始时间'} — ${state.plan.endTimeStr || '未知结束时间'} · 上限 ${state.plan.maxQuota ?? '?'}`;
      await loadCatalog();
      restoreSettings();
    } catch (error) {
      setStatus(error.message, 'error');
      addLog(error.message);
    }
  }

  init();
})();
