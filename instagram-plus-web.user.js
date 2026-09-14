// ==UserScript==
// @name         Instagram Plus (Web)
// @namespace    https://greasyfork.org/
// @version      1.8.2
// @description  Instagram Web enhancements: story, post and reel downloads, follow/unfollow alerts, bio fonts, Story viewer search, and follower comparison.
// @author       Jasermomm
// @match        https://www.instagram.com/*
// @icon         https://www.instagram.com/static/images/ico/favicon-200.png/ab6eff595bb1.png
// @run-at       document-start
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @connect      instagram.com
// @noframes
// @license      MIT
// ==/UserScript==

/* global exportFunction: readonly */

(() => {
  'use strict';

  const APP = 'igp-web';
  const VERSION = '1.8.2';
  const PAGE = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const pageFunction = fn => typeof exportFunction === 'function' ? exportFunction(fn, PAGE) : fn;
  const SETTINGS_KEY = `${APP}:settings:v2`;
  const POSITION_KEY = `${APP}:launcher-position:v3`;
  const DEFAULTS = Object.freeze({
    bioFonts: true,
    viewerSearch: true,
    storyPreview: false,
    relationshipNotifier: true,
    storyDownloads: true,
    postDownloads: true,
    reelDownloads: true,
    desktopNotifications: false,
  });

  const state = {
    settings: loadJSON(SETTINGS_KEY, DEFAULTS),
    launcherPosition: loadJSON(POSITION_KEY, null),
    rootHost: null,
    root: null,
    panelOpen: false,
    scanTimer: null,
    lastURL: location.href,
    suppressLauncherClickUntil: 0,
    focusedIGPInput: null,
    storySession: null,
    followerCompareRunning: false,
    compareController: null,
    relationshipAccount: null,
    relationshipRunning: false,
    relationshipController: null,
    relationshipStatus: '',
    relationshipNextCheck: 0,
    mediaBindings: new Map(),
    mediaController: null,
    failedMediaURLs: new Set(),
    modalClosers: new Map(),
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback ? { ...fallback } : null;
      if (fallback === DEFAULTS) return Object.fromEntries(Object.entries(DEFAULTS).map(([name, value]) => [name, typeof parsed[name] === 'boolean' ? parsed[name] : value]));
      return { ...(fallback || {}), ...parsed };
    } catch {
      return fallback ? { ...fallback } : null;
    }
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function saveSettings() { saveJSON(SETTINGS_KEY, state.settings); }
  function saveLauncherPosition() { saveJSON(POSITION_KEY, state.launcherPosition); }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function escapeHTML(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function viewport() {
    const vv = window.visualViewport;
    return vv
      ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
      : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  function normalizeUsername(value) {
    return String(value || '').trim().replace(/^@/, '').toLocaleLowerCase();
  }

  function getProfileUsernameFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.origin !== location.origin) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return null;
      const blocked = new Set([
        'accounts', 'direct', 'explore', 'reels', 'stories', 'about-us', 'legal',
        'help', 'web', 'docs', 'api', 'graphql', 'developer', 'privacy', 'terms'
      ]);
      return blocked.has(parts[0].toLowerCase()) ? null : parts[0];
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Anonymous Story mode — Credit to Mobile46
  // ---------------------------------------------------------------------------
  function bodyContainsViewSeenAt(body) {
    const seenVariable = value => {
      if (!value || typeof value !== 'object') return false;
      const stack = [[value,0]];
      while (stack.length) {
        const [object,depth] = stack.pop();
        if (Object.hasOwn(object, 'viewSeenAt')) return true;
        if (depth < 8) for (const child of Object.values(object)) if (child && typeof child === 'object') stack.push([child,depth + 1]);
      }
      return false;
    };
    try {
      if (typeof body === 'string') {
        try { return seenVariable(JSON.parse(body)); } catch {}
        body = new URLSearchParams(body);
      }
      if (body instanceof URLSearchParams || body instanceof PAGE.URLSearchParams || body instanceof FormData || body instanceof PAGE.FormData) {
        if (body.has('viewSeenAt')) return true;
        const variables = body.get('variables');
        if (typeof variables === 'string') return seenVariable(JSON.parse(variables));
      }
    } catch {}
    return false;
  }

  function installStorySeenGuard() {
    if (PAGE.__IGP_STORY_SEEN_GUARD__) return;
    PAGE.__IGP_STORY_SEEN_GUARD__ = true;
    const originalXMLSend = PAGE.XMLHttpRequest.prototype.send;
    PAGE.XMLHttpRequest.prototype.send = pageFunction(function (...args) {
      if (state.settings.storyPreview && bodyContainsViewSeenAt(args[0])) {
        this.abort();
        queueMicrotask(() => {
          this.dispatchEvent(new ProgressEvent('abort'));
          this.dispatchEvent(new ProgressEvent('loadend'));
        });
        return;
      }
      return originalXMLSend.apply(this, args);
    });
  }

  installStorySeenGuard();

  // ---------------------------------------------------------------------------
  // Main UI
  // ---------------------------------------------------------------------------
  const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const ICONS = Object.freeze({
    plus: '<rect x="4" y="4" width="16" height="16" rx="5"/><path d="M12 8v8m-4-4h8"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
    activity: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    compare: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
    story: '<circle cx="12" cy="12" r="9" stroke-dasharray="11 3"/><circle cx="12" cy="12" r="5"/>',
    post: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    reel: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 8h18M7 3l3 5m4-5 3 5m-7 3 5 3-5 3Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  });
  function icon(name, size = 24) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.plus}</svg>`;
  }
  const THEME_CSS = `
    :host{--bg:#fff;--fg:#262626;--muted:#737373;--bd:#dbdbdb;--soft:#f5f5f5;--soft2:#efefef;--strong:#262626;--inverse:#fff;--accent:#0095f6;--shadow:0 8px 32px #0002;color-scheme:light;font:14px/1.4 ${UI_FONT}}
    :host([data-theme="dark"]){--bg:#262626;--fg:#f5f5f5;--muted:#a8a8a8;--bd:#363636;--soft:#303030;--soft2:#3a3a3a;--strong:#f5f5f5;--inverse:#121212;--shadow:0 8px 32px #0005;color-scheme:dark}
  `;
  const GLOBAL_CSS = `${THEME_CSS}
    :host{all:initial;font:14px/1.4 ${UI_FONT};color:var(--fg)}
    *{box-sizing:border-box;font-family:${UI_FONT}}button,input,select{font:inherit}button{color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}
    button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
    svg{display:block;flex:none}button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    #igp-launcher{position:fixed;width:46px;height:46px;display:grid;place-items:center;border:1px solid var(--bd);border-radius:50%;background:var(--bg);color:var(--fg);box-shadow:0 3px 14px #0002;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;z-index:2147483646;transition:box-shadow .18s,background .18s}
    #igp-launcher:hover{background:var(--soft);box-shadow:0 4px 18px #0003}
    #igp-launcher svg{transition:transform .2s}#igp-launcher[aria-expanded="true"] svg{transform:rotate(45deg)}
    #igp-launcher.dragging{cursor:grabbing;box-shadow:0 9px 24px #0003}
    #igp-panel{position:fixed;width:min(292px,calc(100vw - 28px));max-height:calc(100dvh - 28px);overflow:auto;overscroll-behavior:contain;border:1px solid var(--bd);border-radius:16px;background:var(--bg);color:var(--fg);box-shadow:var(--shadow);z-index:2147483646;visibility:hidden;opacity:0;pointer-events:none;transform:translateY(-4px);transition:opacity .14s,transform .14s,visibility .14s}
    #igp-panel.open{visibility:visible;opacity:1;pointer-events:auto;transform:none}
    .head{display:flex;align-items:center;justify-content:space-between;padding:17px 18px 12px}.title{font-size:15px;font-weight:650}.version{font-size:11px;color:var(--muted)}
    .quick-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 12px 14px}
    .menu-action{display:flex;gap:9px;align-items:center;justify-content:center;border:0;border-radius:10px;padding:12px 8px;background:var(--soft);font-size:13px;font-weight:600}.menu-action:hover{background:var(--soft2)}
    .download-settings{border-block:1px solid var(--bd);padding:9px 12px 14px}.section-label{display:flex;align-items:center;justify-content:space-between;margin:0 4px 5px;color:var(--muted);font-size:12px}
    .download-toggles{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.chip{position:relative;cursor:pointer}.chip input{position:absolute;opacity:0;width:1px;height:1px}.chip span{display:flex;flex-direction:column;align-items:center;gap:7px;padding:10px 4px;border:1px solid var(--bd);border-radius:10px;color:var(--muted);font-size:12px}.chip input:checked+span{background:var(--soft);color:var(--fg);border-color:var(--fg)}.chip input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
    .list{padding:6px 16px 10px}.setting{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;cursor:pointer}.setting strong{font-size:13px;font-weight:400}.setting small{color:var(--muted);font-size:11px}
    .switch{position:relative;width:32px;height:20px;flex:none}.switch input{position:absolute;opacity:0;width:1px;height:1px}.slider{position:absolute;inset:0;border-radius:20px;background:var(--bd);transition:background .16s}.slider:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .16s}.switch input:checked+.slider{background:var(--strong)}.switch input:checked+.slider:before{transform:translateX(12px);background:var(--inverse)}.switch input:focus-visible+.slider{outline:2px solid var(--accent);outline-offset:3px}
    .igp-icon-btn{width:34px;height:34px;display:inline-grid;place-items:center;border:0;border-radius:50%;background:transparent;color:var(--fg);flex:none}.igp-icon-btn:hover{background:var(--soft2)}.igp-icon-btn[aria-pressed="true"]{color:var(--accent)}
    .igp-modal-backdrop{position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;border:0;z-index:2147483647;display:grid;place-items:center;padding:20px;pointer-events:auto;background:#0009;animation:igpFade .14s ease}
    .igp-modal-backdrop::backdrop{background:transparent}
    .igp-modal{width:min(420px,100%);max-height:calc(100dvh - 40px);display:flex;flex-direction:column;overflow:hidden;border-radius:12px;background:var(--bg);color:var(--fg);box-shadow:var(--shadow);animation:igpPop .18s ease}
    .igp-modal-head{flex:none;display:grid;grid-template-columns:34px 1fr 34px;align-items:center;min-height:48px;padding:5px 9px;border-bottom:1px solid var(--bd)}.igp-modal-title{text-align:center;font-size:16px;font-weight:600}.igp-modal-body{min-height:0;overflow:auto;overscroll-behavior:contain}
    .igp-note{padding:14px 16px;color:var(--muted);font-size:12px;line-height:1.5}.igp-note:empty{display:none}.igp-actions{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 16px}.igp-actions button{border:0;border-radius:8px;padding:9px 12px;background:var(--soft);font-size:13px}.igp-actions button:hover{background:var(--soft2)}
    .igp-downloads{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.igp-downloads button{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;min-height:46px}.igp-downloads button:only-child,.igp-downloads .igp-save-all{grid-column:1/-1}.igp-downloads .igp-save-all{background:var(--accent);color:white;font-weight:600}.igp-downloads img{display:block;width:100%;height:160px;object-fit:cover;border-radius:5px}.igp-downloads button[data-saved]{color:var(--muted)}
    .igp-history-tools{display:flex;align-items:center;gap:3px;padding:6px 12px}.igp-history-tools time{flex:1;color:var(--muted);font-size:11px}.igp-help{margin:0 16px 14px;color:var(--muted);font-size:12px}.igp-help summary{cursor:pointer}.igp-help p{line-height:1.5}
    .igp-event{display:block;padding:13px 16px;border-top:1px solid var(--bd);color:var(--fg);text-decoration:none;font-size:13px}.igp-event time{display:block;margin-top:4px;color:var(--muted);font-size:11px}
    .igp-search-wrap{flex:none;padding:12px 16px}.igp-search{width:100%;height:36px;border:0;border-radius:8px;background:var(--soft2);color:var(--fg);padding:0 12px;font-size:14px}.igp-search::placeholder{color:var(--muted)}
    .igp-tabs{flex:none;display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--bd)}.igp-tab{border:0;border-bottom:1px solid transparent;background:none;color:var(--muted);padding:13px 4px;font-size:12px;font-weight:600}.igp-tab.active{border-bottom-color:var(--fg);color:var(--fg)}
    .igp-results{min-height:120px;overflow:auto;overscroll-behavior:contain;padding:4px 0}.igp-person{display:grid;grid-template-columns:44px minmax(0,1fr) 24px;gap:12px;align-items:center;padding:8px 16px;color:var(--fg);text-decoration:none}.igp-person:hover{background:var(--soft)}.igp-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;background:var(--soft2)}.igp-person-text{min-width:0}.igp-username,.igp-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.igp-username{font-weight:600}.igp-name{color:var(--muted)}.igp-heart{text-align:center;color:#ff3040}
    .igp-empty,.igp-progress{padding:32px 18px;text-align:center;color:var(--muted);font-size:13px}.igp-progress strong{display:block;color:var(--fg);font-size:15px}.igp-progress span{display:block;margin-top:7px}.igp-spinner{width:24px;height:24px;margin:0 auto 14px;border:2px solid var(--bd);border-top-color:var(--fg);border-radius:50%;animation:igpSpin .7s linear infinite}
    #igp-toasts{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);width:min(360px,calc(100vw - 32px));pointer-events:auto;z-index:2147483647}.igp-toast{display:block;width:100%;margin-top:6px;padding:12px 16px;border:0;border-radius:8px;background:var(--strong);color:var(--inverse);box-shadow:var(--shadow);text-align:left;font-size:13px}
    @keyframes igpSpin{to{transform:rotate(360deg)}}@keyframes igpFade{from{opacity:0}to{opacity:1}}@keyframes igpPop{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}
    @media(prefers-reduced-motion:reduce){*,*:before{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  `;

  function syncTheme() {
    if (!state.rootHost || !document.body) return;
    const style = getComputedStyle(document.body);
    const primary = style.getPropertyValue('--ig-primary-background').trim();
    const rgb = (primary || style.backgroundColor).match(/[\d.]+/g)?.map(Number);
    const dark = rgb && rgb.length >= 3 && !(rgb.length === 4 && rgb[3] === 0)
      ? rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 128
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = dark ? 'dark' : 'light';
    for (const host of [state.rootHost, ...document.querySelectorAll('[data-igp-bio-toolbar-host],[data-igp-viewer-button-host]')]) {
      if (host.dataset.theme !== theme) host.dataset.theme = theme;
    }
  }

  function ensureRoot() {
    if (state.rootHost?.isConnected || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = `${APP}-root`;
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${GLOBAL_CSS}</style><button id="igp-launcher" type="button" aria-label="Instagram Plus settings" aria-controls="igp-panel" aria-expanded="false" title="Instagram Plus · drag to move">${icon('plus',28)}</button><div id="igp-panel" role="region" aria-label="Instagram Plus settings" inert></div>`;
    document.documentElement.appendChild(host);
    state.rootHost = host; state.root = root;
    for (const type of ['click','pointerdown','pointerup','dblclick']) root.addEventListener(type,event=>event.stopPropagation());
    const launcher = root.getElementById('igp-launcher');
    installLauncherDrag(launcher);
    launcher.addEventListener('click', event => {
      if (Date.now() < state.suppressLauncherClickUntil) { event.preventDefault(); return; }
      state.panelOpen = !state.panelOpen; renderPanel();
      if (state.panelOpen && event.detail === 0) root.querySelector('#igp-panel button')?.focus();
    });
    applyLauncherPosition(); renderPanel(); syncTheme();
  }

  function launcherBounds(launcher) {
    const vp = viewport(), margin = 14;
    return { minX: vp.left + margin, maxX: Math.max(vp.left + margin, vp.left + vp.width - (launcher.offsetWidth || 46) - margin),
      minY: vp.top + margin, maxY: Math.max(vp.top + margin, vp.top + vp.height - (launcher.offsetHeight || 46) - margin) };
  }

  function applyLauncherPosition() {
    const launcher = state.root?.getElementById('igp-launcher');
    if (!launcher) return;
    state.cancelLauncherMotion?.();
    const b = launcherBounds(launcher);
    const x = clamp(Number.isFinite(state.launcherPosition?.x) ? state.launcherPosition.x : b.maxX, b.minX, b.maxX);
    const y = clamp(Number.isFinite(state.launcherPosition?.y) ? state.launcherPosition.y : b.minY, b.minY, b.maxY);
    launcher.style.left = `${x}px`; launcher.style.top = `${y}px`;
    state.launcherPosition = { x, y }; saveLauncherPosition();
  }

  function installLauncherDrag(launcher) {
    let drag = null, frame = 0;
    const point = () => ({ x: parseFloat(launcher.style.left) || 0, y: parseFloat(launcher.style.top) || 0 });
    const move = (x, y) => {
      const b = launcherBounds(launcher);
      x = clamp(x,b.minX,b.maxX); y = clamp(y,b.minY,b.maxY);
      launcher.style.left = `${x}px`; launcher.style.top = `${y}px`;
      state.launcherPosition = { x, y };
      if (state.panelOpen) positionPanel();
    };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; };
    state.cancelLauncherMotion = () => {
      stop();
      if (drag?.moved) state.suppressLauncherClickUntil = Date.now() + 400;
      const id = drag?.id; drag = null; launcher.classList.remove('dragging');
      if (id !== undefined && launcher.hasPointerCapture?.(id)) launcher.releasePointerCapture(id);
    };
    launcher.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag || event.isPrimary === false) return;
      stop();
      drag = { id:event.pointerId, startX:event.clientX, startY:event.clientY, ...point(), lastX:event.clientX, lastY:event.clientY, at:performance.now(), vx:0, vy:0, moved:false };
      try { launcher.setPointerCapture?.(event.pointerId); } catch {}
    });
    launcher.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX-drag.startX, dy = event.clientY-drag.startY;
      if (!drag.moved && Math.hypot(dx,dy) <= 5) return;
      drag.moved = true; launcher.classList.add('dragging'); event.preventDefault();
      const now = performance.now(), dt = Math.max(8,now-drag.at);
      drag.vx = clamp((event.clientX-drag.lastX)/dt,-1.5,1.5);
      drag.vy = clamp((event.clientY-drag.lastY)/dt,-1.5,1.5);
      drag.lastX = event.clientX; drag.lastY = event.clientY; drag.at = now;
      move(drag.x+dx,drag.y+dy);
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const ended = drag; drag = null;
      launcher.classList.remove('dragging');
      if (launcher.hasPointerCapture?.(event.pointerId)) launcher.releasePointerCapture(event.pointerId);
      if (!ended.moved) return;
      state.suppressLauncherClickUntil = Date.now()+400;
      if (event.type !== 'pointerup') { saveLauncherPosition(); return; }
      const p = point(), b = launcherBounds(launcher);
      const fresh = performance.now()-ended.at < 90;
      const projectedX = clamp(p.x+(fresh ? ended.vx*120 : 0),b.minX,b.maxX);
      const x = projectedX < (b.minX+b.maxX)/2 ? b.minX : b.maxX;
      const y = clamp(p.y+(fresh ? ended.vy*100 : 0),b.minY,b.maxY);
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { move(x,y); saveLauncherPosition(); return; }
      // Project the release velocity, then settle without oscillation or offscreen bounce.
      const start = performance.now();
      const settle = now => {
        const t = Math.min(1,(now-start)/360), ease = 1-Math.pow(1-t,3);
        move(p.x+(x-p.x)*ease,p.y+(y-p.y)*ease);
        if (t < 1) frame = requestAnimationFrame(settle);
        else { frame = 0; saveLauncherPosition(); }
      };
      frame = requestAnimationFrame(settle);
    };
    for (const type of ['pointerup','pointercancel','lostpointercapture']) launcher.addEventListener(type,finish);
    launcher.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); state.cancelLauncherMotion();
      const p = point(), b = launcherBounds(launcher), step = event.shiftKey ? 40 : 10;
      move(event.key === 'Home' ? b.maxX : p.x+(event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
        event.key === 'Home' ? b.minY : p.y+(event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
      saveLauncherPosition();
    });
  }

  function positionPanel() {
    const panel = state.root?.getElementById('igp-panel'), launcher = state.root?.getElementById('igp-launcher');
    if (!panel || !launcher) return;
    const vp = viewport(), b = launcher.getBoundingClientRect(), w = panel.offsetWidth || 292, h = panel.offsetHeight || 400, margin = 14;
    const left = clamp(b.right-w,vp.left+margin,Math.max(vp.left+margin,vp.left+vp.width-w-margin));
    const below = b.bottom+10;
    const top = below+h <= vp.top+vp.height-margin ? below : clamp(b.top-h-10,vp.top+margin,Math.max(vp.top+margin,vp.top+vp.height-h-margin));
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }

  function renderPanel() {
    if (!state.root) return;
    const panel = state.root.getElementById('igp-panel');
    const hadFocus = panel.contains(state.root.activeElement);
    panel.classList.toggle('open',state.panelOpen); panel.inert = !state.panelOpen;
    state.root.getElementById('igp-launcher').setAttribute('aria-expanded',String(state.panelOpen));
    const rows = [['bioFonts','Bio fonts'],['viewerSearch','Viewer search'],['relationshipNotifier','Activity alerts'],['storyPreview','Story preview']];
    panel.innerHTML = `<div class="head"><span class="title">Instagram Plus</span><span class="version">${VERSION}</span></div>
      <div class="quick-actions"><button id="igp-activity" class="menu-action" type="button">${icon('activity',19)} Activity</button><button id="igp-compare-followers" class="menu-action" type="button" ${state.followerCompareRunning ? 'disabled' : ''}>${icon('compare',19)} ${state.followerCompareRunning ? 'Loading…' : 'Compare'}</button></div>
      <div class="download-settings"><div class="section-label">Downloads<button id="igp-download-current" class="igp-icon-btn" aria-label="Download current media" title="Download current media" type="button">${icon('download',18)}</button></div><div class="download-toggles">
      ${[['storyDownloads','Stories','story'],['postDownloads','Posts','post'],['reelDownloads','Reels','reel']].map(([key,label,glyph])=>`<label class="chip"><input type="checkbox" data-key="${key}" aria-label="${label} downloads" ${state.settings[key] ? 'checked' : ''}><span>${icon(glyph,21)}${label}</span></label>`).join('')}</div></div>
      <div class="list">${rows.map(([key,label])=>`<label class="setting"><strong>${label}</strong><span class="switch"><input type="checkbox" data-key="${key}" ${state.settings[key] ? 'checked' : ''}><span class="slider"></span></span></label>`).join('')}</div>`;
    panel.querySelectorAll('input[data-key]').forEach(input => input.addEventListener('change', () => {
      state.settings[input.dataset.key] = input.checked; saveSettings(); cleanupDisabledFeatures();
      if (input.dataset.key === 'relationshipNotifier') { state.relationshipController?.abort(); state.relationshipNextCheck = 0; relationshipTick(); }
      scheduleScan(0);
    }));
    panel.querySelector('#igp-compare-followers').addEventListener('click',runFollowerCompare);
    panel.querySelector('#igp-activity').addEventListener('click',openRelationshipHistory);
    panel.querySelector('#igp-download-current').addEventListener('click', () => {
      const target = currentMediaTarget();
      if (target && mediaEnabled(target.reference)) void openMediaDownload(target);
      else showToast('Open a story, post or reel with downloads enabled.');
    });
    if (!state.panelOpen && hadFocus) state.root.getElementById('igp-launcher').focus({preventScroll:true});
    if (state.panelOpen) requestAnimationFrame(positionPanel);
  }


  function cleanupDisabledFeatures() {
    if (!state.settings.bioFonts) {
      document.querySelectorAll('[data-igp-bio-toolbar-host]').forEach(el => el.remove());
    }
    if (!state.settings.viewerSearch) clearStorySession();
    clearMediaButtons();
    state.mediaController?.abort();
    removeModal('igp-media-modal');
  }

  // ---------------------------------------------------------------------------
  // Reusable modal UI
  // ---------------------------------------------------------------------------
  function removeModal(id) {
    const close = state.modalClosers.get(id);
    if (close) close(); else state.root?.getElementById(id)?.remove();
  }

  function createModalShell(id, title, { closeLabel = '×', onClose = null } = {}) {
    ensureRoot();
    removeModal(id);
    const previousFocus = state.root.activeElement || document.activeElement;
    // A top-layer dialog stays above Instagram's own story / profile overlays.
    const backdrop = document.createElement('dialog');
    backdrop.id = id;
    backdrop.className = 'igp-modal-backdrop';
    backdrop.setAttribute('aria-label',title);
    backdrop.setAttribute('aria-modal','true');
    backdrop.innerHTML = `
      <section class="igp-modal">
        <div class="igp-modal-head">
          <span></span>
          <div class="igp-modal-title">${escapeHTML(title)}</div>
          <button class="igp-icon-btn" type="button" aria-label="Close">${closeLabel === '×' ? icon('close',22) : escapeHTML(closeLabel)}</button>
        </div>
        <div class="igp-modal-body"></div>
      </section>`;
    state.root.appendChild(backdrop);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      state.modalClosers.delete(id);
      if (backdrop.open) backdrop.close();
      backdrop.remove();
      if (typeof onClose === 'function') onClose();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    state.modalClosers.set(id, close);
    backdrop.addEventListener('cancel', event => { event.preventDefault(); close(); });
    backdrop.addEventListener('close', close);
    // Do not pass extension controls to Instagram's delegated UI listeners.
    backdrop.addEventListener('click',event=>event.stopPropagation());
    backdrop.addEventListener('pointerup',event=>event.stopPropagation());
    backdrop.querySelector('.igp-icon-btn').addEventListener('click', close);
    backdrop.addEventListener('pointerdown', event => {
      event.stopPropagation();
      if (event.target === backdrop) close();
    });
    backdrop.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...backdrop.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && state.root.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && state.root.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    if (typeof backdrop.showModal === 'function') backdrop.showModal();
    else backdrop.setAttribute('open','');
    backdrop.querySelector('.igp-icon-btn').focus({ preventScroll: true });
    return { backdrop, body: backdrop.querySelector('.igp-modal-body'), close };
  }

  function renderPeopleList(container, people, { showLiked = false } = {}) {
    if (!people.length) {
      container.innerHTML = `<div class="igp-empty">No accounts found</div>`;
      return;
    }
    container.innerHTML = people.map(person => `
      <a class="igp-person" href="${escapeHTML(person.href || `/${person.username}/`)}">
        ${person.avatar
          ? `<img class="igp-avatar" src="${escapeHTML(person.avatar)}" alt="" loading="lazy">`
          : `<span class="igp-avatar"></span>`}
        <span class="igp-person-text">
          <span class="igp-username">${escapeHTML(person.username)}</span>
          ${person.displayName ? `<span class="igp-name">${escapeHTML(person.displayName)}</span>` : ''}
        </span>
        ${showLiked && person.liked ? `<span class="igp-heart" aria-label="Liked your Story">♥</span>` : '<span></span>'}
      </a>`).join('');
  }

  function bindIGPInput(input, onInput) {
    input.addEventListener('focus', () => { state.focusedIGPInput = input; });
    input.addEventListener('blur', () => {
      if (state.focusedIGPInput === input) state.focusedIGPInput = null;
    });
    input.addEventListener('input', onInput);
    input.addEventListener('search', onInput);
  }

  // ---------------------------------------------------------------------------
  // Bio fonts
  // ---------------------------------------------------------------------------
  const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const az = 'abcdefghijklmnopqrstuvwxyz';
  const DIG = '0123456789';
  const BASE = AZ + az + DIG;
  const cpRange = (start, n) => Array.from({ length: n }, (_, i) => String.fromCodePoint(start + i)).join('');
  const FONT_MAPS = Object.freeze({
    Normal: BASE,
    'Serif Bold': cpRange(0x1D400,26) + cpRange(0x1D41A,26) + cpRange(0x1D7CE,10),
    'Serif Bold Italic': cpRange(0x1D468,26) + cpRange(0x1D482,26) + DIG,
    'Sans Serif': cpRange(0x1D5A0,26) + cpRange(0x1D5BA,26) + cpRange(0x1D7E2,10),
    'Sans Bold': cpRange(0x1D5D4,26) + cpRange(0x1D5EE,26) + cpRange(0x1D7EC,10),
    'Sans Italic': cpRange(0x1D608,26) + cpRange(0x1D622,26) + DIG,
    'Sans Bold Italic': cpRange(0x1D63C,26) + cpRange(0x1D656,26) + DIG,
    Monospace: cpRange(0x1D670,26) + cpRange(0x1D68A,26) + cpRange(0x1D7F6,10),
    'Double-Struck': '𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡',
    Script: '𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏' + DIG,
    'Script Bold': cpRange(0x1D4D0,26) + cpRange(0x1D4EA,26) + DIG,
    Fraktur: '𝔄𝔅ℭ𝔇𝔈𝔉𝔊ℌℑ𝔍𝔎𝔏𝔐𝔑𝔒𝔓𝔔ℜ𝔖𝔗𝔘𝔙𝔚𝔛𝔜ℨ𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨𝔩𝔪𝔫𝔬𝔭𝔮𝔯𝔰𝔱𝔲𝔳𝔴𝔵𝔶𝔷' + DIG,
    'Fraktur Bold': cpRange(0x1D56C,26) + cpRange(0x1D586,26) + DIG,
    Fullwidth: cpRange(0xFF21,26) + cpRange(0xFF41,26) + cpRange(0xFF10,10),
    Circled: 'ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ⓪①②③④⑤⑥⑦⑧⑨',
  });

  const REVERSE_FONT = (() => {
    const map = new Map();
    const base = [...BASE];
    for (const styled of Object.values(FONT_MAPS)) {
      [...styled].forEach((char, i) => map.set(char, base[i] ?? char));
    }
    return map;
  })();

  function normalizeFancyText(text) {
    return [...text].map(char => REVERSE_FONT.get(char) ?? char).join('');
  }

  function convertFont(text, style) {
    const target = [...(FONT_MAPS[style] || FONT_MAPS.Normal)];
    const index = new Map([...BASE].map((char, i) => [char, i]));
    return [...normalizeFancyText(text)]
      .map(char => index.has(char) ? (target[index.get(char)] ?? char) : char)
      .join('');
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function looksLikeBioTextarea(textarea) {
    const attrs = [
      textarea.getAttribute('aria-label'),
      textarea.getAttribute('name'),
      textarea.getAttribute('placeholder'),
      textarea.id,
    ].filter(Boolean).join(' ').toLowerCase();
    if (attrs.includes('bio')) return true;
    const parentText = textarea.parentElement?.parentElement?.innerText?.slice(0, 220).toLowerCase() || '';
    return parentText.includes('bio') || (/\/accounts\/(edit|center|professional_account)/.test(location.pathname) && document.querySelectorAll('textarea').length <= 2);
  }

  function enhanceBioFonts() {
    if (!state.settings.bioFonts) return;
    document.querySelectorAll('[data-igp-bio-toolbar-host]').forEach(host => {
      if (!host.igpBioField?.isConnected || host.previousElementSibling !== host.igpBioField) host.remove();
    });
    document.querySelectorAll('textarea').forEach(textarea => {
      if (!looksLikeBioTextarea(textarea)) return;
      const previous = textarea.nextElementSibling;
      if (previous?.hasAttribute('data-igp-bio-toolbar-host')) {
        if (previous.igpBioField === textarea) return;
        previous.remove();
      }
      const host = document.createElement('span');
      host.igpBioField = textarea;
      host.dataset.igpBioToolbarHost = '1';
      host.style.cssText = 'display:block;margin-top:7px';
      const shadow = host.attachShadow({ mode: 'open' });
      host.dataset.theme = state.rootHost?.dataset.theme || 'light';
      shadow.innerHTML = `<style>${THEME_CSS}
        .wrap{display:flex;align-items:center;gap:8px;color:var(--fg)}
        select,button{border:0;background:var(--soft);color:var(--fg);border-radius:8px;min-height:32px;padding:5px 9px;font:400 12px ${UI_FONT}}
        button{cursor:pointer;color:var(--accent);display:grid;place-items:center}select:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      </style>
      <div class="wrap">
        <select aria-label="Bio font">${Object.keys(FONT_MAPS).map(name => `<option>${escapeHTML(name)}</option>`).join('')}</select>
        <button type="button" aria-label="Apply bio font" title="Apply font">${icon('check',18)}</button>
      </div>`;
      const select = shadow.querySelector('select');
      shadow.querySelector('button').addEventListener('click', () => {
        const value = textarea.value || '';
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? 0;
        const selected = end > start;
        const source = selected ? value.slice(start, end) : value;
        const converted = convertFont(source, select.value);
        const next = selected ? value.slice(0, start) + converted + value.slice(end) : converted;
        setNativeValue(textarea, next);
        textarea.focus();
        if (selected) textarea.setSelectionRange(start, start + converted.length);
      });
      textarea.insertAdjacentElement('afterend', host);
    });
  }

  // ---------------------------------------------------------------------------
  // Generic Instagram list extraction helpers
  // ---------------------------------------------------------------------------
  function scorePersonRow(element, dialog) {
    if (!(element instanceof Element) || !element.parentElement || element === dialog) return -1e9;
    const r = element.getBoundingClientRect();
    const dr = dialog.getBoundingClientRect();
    if (r.height < 34 || r.height > 150 || r.width < Math.min(170, dr.width * .42)) return -1e9;
    const profileAnchors = [...element.querySelectorAll('a[href]')].filter(a => getProfileUsernameFromHref(a.href));
    if (profileAnchors.length < 1 || profileAnchors.length > 4) return -1e9;
    const imgCount = element.querySelectorAll('img').length;
    let score = 0;
    if (r.height >= 42 && r.height <= 112) score += 5;
    if (profileAnchors.length <= 2) score += 4;
    if (imgCount >= 1) score += 4;
    if (r.width >= dr.width * .62) score += 2;
    if (element.matches('li,[role="button"],[role="link"]')) score += 1;

    const siblings = [...element.parentElement.children].filter(isVisible);
    const peers = siblings.filter(sibling =>
      [...sibling.querySelectorAll('a[href]')].some(a => getProfileUsernameFromHref(a.href))
    ).length;
    if (peers >= 2) score += 7;
    return score;
  }

  function findPersonRow(anchor, dialog) {
    let element = anchor;
    let best = null;
    let bestScore = -1e9;
    for (let depth = 0; depth < 11 && element && element !== dialog; depth++, element = element.parentElement) {
      const score = scorePersonRow(element, dialog);
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }
    return bestScore >= 6 ? best : (anchor.closest('li,[role="button"],[role="link"]') || anchor.parentElement);
  }

  function extractPerson(anchor, dialog, { detectLiked = false } = {}) {
    const username = getProfileUsernameFromHref(anchor.href);
    if (!username) return null;
    const row = findPersonRow(anchor, dialog);
    if (!row) return null;

    const normalized = normalizeUsername(username);
    const lines = [...new Set((row.innerText || '').split(/\n+/).map(line => line.trim()).filter(Boolean))];
    const ignored = new Set([
      'follow', 'following', 'remove', 'message', 'requested', 'follow back',
      'liked your story', 'liked your photo', 'liked your reel'
    ]);
    const displayName = lines.find(line => {
      const lower = line.toLocaleLowerCase();
      return normalizeUsername(line) !== normalized && !ignored.has(lower) && line.length <= 120;
    }) || '';

    const image = row.querySelector('img');
    const avatar = image?.currentSrc || image?.src || '';
    const href = new URL(anchor.href, location.origin).pathname;

    let liked = false;
    if (detectLiked) {
      const text = (row.innerText || '').toLocaleLowerCase();
      liked = /liked\s+(your\s+)?story/.test(text)
        || !!row.querySelector('[aria-label*="liked" i],[aria-label="like" i],[title*="liked" i]');
    }

    return {
      key: normalized,
      username,
      displayName,
      avatar,
      href,
      liked,
      search: `${username} ${displayName}`.toLocaleLowerCase(),
    };
  }

  function collectPeopleBatch(dialog, map, options = {}) {
    const anchors = [...dialog.querySelectorAll('a[href]')].filter(anchor => getProfileUsernameFromHref(anchor.href));
    for (const anchor of anchors) {
      const person = extractPerson(anchor, dialog, options);
      if (!person) continue;
      const existing = map.get(person.key);
      if (!existing) {
        map.set(person.key, { ...person, order: map.size });
      } else {
        if (!existing.avatar && person.avatar) existing.avatar = person.avatar;
        if (!existing.displayName && person.displayName) existing.displayName = person.displayName;
        if (person.liked) existing.liked = true;
      }
    }
    return map.size;
  }

  function findBestScroller(dialog) {
    const candidates = [dialog, ...dialog.querySelectorAll('div,ul')].filter(element => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return element.clientHeight >= 100
        && element.scrollHeight > element.clientHeight + 35
        && /(auto|scroll)/.test(style.overflowY);
    });
    let best = null;
    let bestScore = -1;
    for (const element of candidates) {
      const profileCount = [...element.querySelectorAll('a[href]')].filter(a => getProfileUsernameFromHref(a.href)).length;
      const score = profileCount * 1000 + Math.min(100000, element.scrollHeight - element.clientHeight);
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }
    return best;
  }

  async function walkInstagramList(dialog, map, {
    target = null,
    detectLiked = false,
    onProgress = null,
    maxPasses = 4,
    cancelled = () => false,
  } = {}) {
    collectPeopleBatch(dialog, map, { detectLiked });
    let scroller = findBestScroller(dialog);

    if (!scroller) {
      for (let i = 0; i < 20 && dialog.isConnected && !cancelled(); i++) {
        await sleep(120);
        collectPeopleBatch(dialog, map, { detectLiked });
        scroller = findBestScroller(dialog);
        if (scroller) break;
      }
    }

    if (!scroller) {
      onProgress?.(map.size, target);
      return;
    }

    for (let pass = 0; pass < maxPasses && dialog.isConnected && !cancelled(); pass++) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(170);
      collectPeopleBatch(dialog, map, { detectLiked });

      let stable = 0;
      let bottomStable = 0;
      let lastCount = map.size;

      for (let round = 0; round < 260 && dialog.isConnected && !cancelled(); round++) {
        collectPeopleBatch(dialog, map, { detectLiked });
        onProgress?.(map.size, target);
        if (target && map.size >= target) return;

        if (!scroller.isConnected) {
          scroller = findBestScroller(dialog);
          if (!scroller) {
            await sleep(140);
            continue;
          }
        }

        const oldHeight = scroller.scrollHeight;
        const oldTop = scroller.scrollTop;
        const step = Math.max(150, Math.floor(scroller.clientHeight * .42));
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.min(maxTop, oldTop + step);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(120);

        collectPeopleBatch(dialog, map, { detectLiked });
        onProgress?.(map.size, target);
        const count = map.size;
        if (count === lastCount) stable += 1; else stable = 0;
        lastCount = count;

        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
        if (atBottom) {
          await sleep(190);
          collectPeopleBatch(dialog, map, { detectLiked });
          onProgress?.(map.size, target);
          const grew = scroller.scrollHeight > oldHeight + 3 || map.size > count;
          bottomStable = grew ? 0 : bottomStable + 1;
        } else {
          bottomStable = 0;
        }

        if (!target && bottomStable >= 8 && stable >= 8) return;
        if (target && bottomStable >= 10 && stable >= 10) break;
      }

      if (target && map.size >= target) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Story viewer indexing + custom search modal
  // ---------------------------------------------------------------------------
  function isStoryRoute() {
    return location.pathname.startsWith('/stories/');
  }

  function storyRouteKey() {
    return isStoryRoute() ? `${location.pathname}${location.search}` : null;
  }

  function parseSeenByTarget(dialog = null) {
    const texts = [];
    if (dialog) texts.push(dialog.innerText || '');
    if (document.body) texts.push(document.body.innerText || '');
    const patterns = [
      /seen by\s+([\d,.]+)/i,
      /([\d,.]+)\s+(?:viewers|views)\b/i,
      /(?:viewers|views)\s*[·:\-]?\s*([\d,.]+)/i,
    ];
    for (const text of texts) {
      for (const re of patterns) {
        const m = text.match(re);
        if (!m) continue;
        const n = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0 && n < 10000000) return n;
      }
    }
    return null;
  }

  function isStoryViewerDialog(dialog) {
    if (!(dialog instanceof Element) || !isVisible(dialog) || !isStoryRoute()) return false;
    const profileLinks = [...dialog.querySelectorAll('a[href]')].filter(a => getProfileUsernameFromHref(a.href));
    if (!profileLinks.length) return false;
    const text = (dialog.innerText || '').slice(0, 1800).toLocaleLowerCase();
    return /seen by|viewers|views|likes/.test(text) || profileLinks.length >= 3;
  }

  function clearStorySession({ preserveNativeDialog = false } = {}) {
    const session = state.storySession;
    if (!session) return;
    session.cancelled = true;
    state.focusedIGPInput = null;
    removeModal('igp-story-viewer-modal');
    session.buttonHost?.remove();
    if (session.dialog?.isConnected && !preserveNativeDialog) {
      session.dialog.style.removeProperty('visibility');
      session.dialog.style.removeProperty('pointer-events');
    }
    state.storySession = null;
  }

  function makeViewerButton(session) {
    const host = document.createElement('div');
    host.dataset.igpViewerButtonHost = '1';
    host.style.cssText = 'display:block;padding:8px 12px;flex:none;position:relative;z-index:20;';
    const shadow = host.attachShadow({ mode: 'open' });
    host.dataset.theme = state.rootHost?.dataset.theme || 'light';
    shadow.innerHTML = `<style>${THEME_CSS}
      button{display:flex;align-items:center;gap:9px;width:100%;height:36px;border:0;border-radius:8px;padding:0 12px;background:var(--soft2);color:var(--muted);cursor:pointer;font:400 14px ${UI_FONT}}
      button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{cursor:progress;opacity:.72}
    </style><button type="button" disabled>${icon('search',17)}<span>Loading…</span></button>`;
    session.buttonHost = host;
    session.button = shadow.querySelector('button');
    session.button.addEventListener('click', () => openStoryViewerModal(session));
    return host;
  }

  function placeViewerButton(session) {
    if (!session.dialog?.isConnected || !session.buttonHost) return;
    if (session.buttonHost.isConnected && session.buttonHost.closest('[role="dialog"]') === session.dialog) return;
    const candidates = [...session.dialog.children];
    const scrollable = findBestScroller(session.dialog);
    if (scrollable?.parentElement) {
      scrollable.parentElement.insertBefore(session.buttonHost, scrollable);
      return;
    }
    const first = candidates.find(isVisible);
    if (first) session.dialog.insertBefore(session.buttonHost, first);
    else session.dialog.prepend(session.buttonHost);
  }

  function updateViewerButton(session) {
    if (!session.button) return;
    const loaded = session.entries.size;
    if (session.loading) {
      session.button.disabled = true;
      session.button.querySelector('span').textContent = session.target ? `Loading ${loaded}/${session.target}` : `Loading ${loaded}`;
      return;
    }
    const complete = session.target ? loaded >= session.target : loaded > 0;
    session.button.disabled = !complete;
    session.button.querySelector('span').textContent = complete ? `Search ${loaded} viewers` : `Loading ${loaded}/${session.target || '?'}`;
  }

  async function startStoryViewerSession(dialog) {
    clearStorySession();
    const session = {
      routeKey: storyRouteKey(),
      dialog,
      entries: new Map(),
      target: parseSeenByTarget(dialog),
      loading: true,
      cancelled: false,
      buttonHost: null,
      button: null,
    };
    state.storySession = session;
    makeViewerButton(session);
    placeViewerButton(session);
    updateViewerButton(session);

    await walkInstagramList(dialog, session.entries, {
      target: session.target,
      detectLiked: true,
      maxPasses: 5,
      cancelled: () => session.cancelled || state.storySession !== session,
      onProgress: () => {
        if (!session.cancelled) {
          if (!session.target) session.target = parseSeenByTarget(dialog);
          updateViewerButton(session);
          placeViewerButton(session);
        }
      },
    });

    if (session.cancelled || state.storySession !== session || !dialog.isConnected) return;
    session.loading = false;
    if (!session.target) session.target = parseSeenByTarget(dialog);
    updateViewerButton(session);
    placeViewerButton(session);
  }

  function openStoryViewerModal(session) {
    if (!session || session.loading || !session.entries.size) return;
    const people = [...session.entries.values()].sort((a, b) => a.order - b.order);
    if (session.dialog?.isConnected) {
      session.dialog.style.setProperty('visibility', 'hidden', 'important');
      session.dialog.style.setProperty('pointer-events', 'none', 'important');
    }

    const modal = createModalShell('igp-story-viewer-modal', 'Viewers', {
      onClose: () => {
        state.focusedIGPInput = null;
        if (session.dialog?.isConnected) {
          session.dialog.style.removeProperty('visibility');
          session.dialog.style.removeProperty('pointer-events');
        }
      },
    });
    modal.body.innerHTML = `
      <div class="igp-search-wrap"><input class="igp-search" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search ${people.length} viewers"></div>
      <div class="igp-results"></div>`;
    const input = modal.body.querySelector('.igp-search');
    const results = modal.body.querySelector('.igp-results');

    const render = () => {
      const q = input.value.trim().toLocaleLowerCase();
      const filtered = q ? people.filter(person => person.search.includes(q)) : people;
      renderPeopleList(results, filtered, { showLiked: true });
    };
    bindIGPInput(input, render);
    render();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function enhanceStoryViewerSearch() {
    if (!state.settings.viewerSearch) return;
    if (!isStoryRoute()) {
      if (state.storySession) clearStorySession();
      return;
    }

    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isStoryViewerDialog);
    const dialog = dialogs.at(-1);
    if (!dialog) return;

    const session = state.storySession;
    if (!session || session.dialog !== dialog || session.routeKey !== storyRouteKey()) {
      void startStoryViewerSession(dialog).catch(() => {
        if (state.storySession?.dialog === dialog) clearStorySession();
      });
    } else {
      placeViewerButton(session);
      updateViewerButton(session);
    }
  }

  // ---------------------------------------------------------------------------
  // Follower comparison uses complete lists without navigating or scrolling.
  // ---------------------------------------------------------------------------
  async function runFollowerCompare() {
    if (state.followerCompareRunning) {
      const active = state.root?.getElementById('igp-follow-compare-modal');
      if (active?.isConnected) { if (!active.open) active.showModal?.(); active.querySelector('button')?.focus(); return; }
      state.compareController?.abort();
    }
    const accountId = loggedInAccountID();
    state.panelOpen = false;
    state.followerCompareRunning = true;
    const controller = new AbortController();
    state.compareController = controller;
    let modal;
    const progress = (label,count,total) => {
      const status = modal?.body.querySelector('[data-compare-progress]');
      if (status && !controller.signal.aborted) status.textContent = `${label} ${count}/${total}`;
    };
    const collect = async () => {
      const counts = await fetchRelationshipCounts(accountId, controller.signal);
      const followers = await fetchRelationshipList(accountId, 'followers', counts.followers, controller.signal,(count,total)=>progress('Followers',count,total));
      const following = await fetchRelationshipList(accountId, 'following', counts.following, controller.signal,(count,total)=>progress('Following',count,total));
      const after = await fetchRelationshipCounts(accountId, controller.signal);
      if (counts.followers !== after.followers || counts.following !== after.following) throw new Error('Your lists changed while loading. Try again.');
      return { followers, following };
    };
    try {
      renderPanel();
      modal = createModalShell('igp-follow-compare-modal', 'Compare', { onClose: () => controller.abort() });
      modal.body.innerHTML = '<div class="igp-progress" role="status"><div class="igp-spinner"></div><span data-compare-progress>Loading followers…</span></div>';
      if (!accountId) throw new Error('Sign in to Instagram, then try Compare again.');
      const record = readRelationships(accountId);
      if (record?.retryAfter > Date.now()) throw new Error('Instagram checks are paused after a failed request. Try again after the retry time shown in Friend Activity.');
      const result = navigator.locks?.request
        ? await navigator.locks.request(`${APP}:relationship-check:${accountId}`, { ifAvailable: true }, lock => {
          if (!lock) throw new Error('Another tab is checking followers. Try again when it finishes.');
          return collect();
        }) : await collect();
      if (controller.signal.aborted || accountId !== loggedInAccountID() || !modal.backdrop.isConnected) return;
      const groups = [
        { label: "Don't follow you", people: Object.values(result.following).filter(person => !Object.hasOwn(result.followers, person.id)) },
        { label: "You don't follow", people: Object.values(result.followers).filter(person => !Object.hasOwn(result.following, person.id)) },
      ];
      groups.forEach(group => group.people.sort((a,b) => a.username.localeCompare(b.username)));
      modal.body.innerHTML = `<div class="igp-tabs">${groups.map((group,i) => `<button type="button" class="igp-tab ${i ? '' : 'active'}" data-tab="${i}">${escapeHTML(group.label)} · ${group.people.length}</button>`).join('')}</div><div class="igp-search-wrap"><input class="igp-search" type="search" placeholder="Search accounts" aria-label="Search accounts"></div><div class="igp-results"></div>`;
      let active = 0;
      const input = modal.body.querySelector('input');
      const render = () => renderPeopleList(modal.body.querySelector('.igp-results'), groups[active].people.filter(person => person.username.toLocaleLowerCase().includes(input.value.trim().toLocaleLowerCase())));
      bindIGPInput(input, render);
      modal.body.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
        active = Number(button.dataset.tab);
        modal.body.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
        input.value = ''; render();
      }));
      render();
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error.message || 'Could not load complete lists. Try again.';
        if (modal?.backdrop.isConnected) modal.body.innerHTML = `<div class="igp-note" role="alert">${escapeHTML(message)}</div>`;
        else showToast(message);
      }
    } finally {
      if (state.compareController === controller) { state.compareController = null; state.followerCompareRunning = false; }
      renderPanel();
    }
  }

  // Relationship snapshots and notifications.

  const RELATIONSHIP_INTERVAL = 15 * 60 * 1000;
  const RELATIONSHIP_HISTORY_LIMIT = 200;

  function cookieValue(name) {
    const entry = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
    try { return entry ? decodeURIComponent(entry.slice(name.length + 1)) : ''; } catch { return ''; }
  }

  function loggedInAccountID() {
    const id = cookieValue('ds_user_id');
    return /^\d+$/.test(id) ? id : null;
  }

  function relationshipKey(id) { return `${APP}:relationships:v1:${id}`; }

  function readRelationships(id) {
    const value = loadJSON(relationshipKey(id), null);
    if (value?.accountId !== id || value.schema !== 1) return null;
    const personOK = person => person && /^\d+$/.test(person.id) && /^[\w.]{1,30}$/.test(person.username);
    const mapOK = map => map && typeof map === 'object' && !Array.isArray(map) && Object.entries(map).every(([key,person]) => personOK(person) && key === person.id);
    if (value.initializedAt && (!mapOK(value.followers) || !mapOK(value.following))) return null;
    value.pending = { followers: mapOK(value.pending?.followers) ? value.pending.followers : {}, following: mapOK(value.pending?.following) ? value.pending.following : {} };
    value.history = Array.isArray(value.history) ? value.history.filter(event => event && personOK(event.person) && ['followers','following'].includes(event.kind) && ['added','removed'].includes(event.change) && Number.isFinite(event.at)).slice(0,RELATIONSHIP_HISTORY_LIMIT) : [];
    for (const key of ['checkedAt','lastAttemptAt','nextCheckAt','retryAfter','failures']) if (Object.hasOwn(value,key) && (!Number.isFinite(value[key]) || value[key] < 0)) value[key] = 0;
    return value;
  }

  function writeRelationships(id, value) {
    // Unlike optional UI preferences, a failed snapshot write must be reported.
    localStorage.setItem(relationshipKey(id), JSON.stringify(value));
  }

  function relationshipDiff(previous, snapshot, now = Date.now()) {
    const events = [];
    const pending = { followers: {}, following: {} };
    for (const kind of ['followers', 'following']) {
      const before = previous?.[kind] || {};
      const missing = previous?.pending?.[kind] || {};
      const after = snapshot[kind];
      if (!previous?.initializedAt) continue;
      for (const [id, person] of Object.entries(after)) {
        if (!Object.hasOwn(before, id) && !Object.hasOwn(missing, id)) {
          events.push({ kind, change: 'added', person, at: now });
        }
      }
      for (const [id, person] of Object.entries({ ...missing, ...before })) {
        if (Object.hasOwn(after, id)) continue;
        // A disappearance must survive two complete checks before it is reported.
        if (Object.hasOwn(missing, id)) events.push({ kind, change: 'removed', person, at: now });
        else pending[kind][id] = person;
      }
    }
    return { events, pending };
  }

  function relationshipEventText(event) {
    const name = `@${event.person.username}`;
    if (event.kind === 'followers') return event.change === 'added' ? `${name} now follows you` : `${name} no longer follows you`;
    return event.change === 'added' ? `You now follow ${name}` : `You no longer follow ${name}`;
  }

  function showToast(message, onClick = null) {
    ensureRoot();
    let region = state.root.getElementById('igp-toasts');
    if (!region) {
      region = document.createElement('div');
      region.id = 'igp-toasts';
      region.setAttribute('aria-live', 'polite');
      state.root.appendChild(region);
    }
    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'igp-toast';
    toast.textContent = message;
    toast.addEventListener('click', () => { toast.remove(); onClick?.(); });
    region.appendChild(toast);
    while (region.children.length > 3) region.firstElementChild.remove();
    setTimeout(() => toast.remove(), 12000);
  }

  function notifyRelationships(events) {
    if (!events.length) return;
    const message = events.length === 1 ? relationshipEventText(events[0]) : `${events.length} relationship changes. Open Friend Activity for details.`;
    showToast(message, openRelationshipHistory);
    if (state.settings.desktopNotifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const notification = new Notification('Instagram Plus · Friend Activity', { body: message, tag: `${APP}-relationships` });
        notification.onclick = () => { window.focus(); openRelationshipHistory(); notification.close(); };
      } catch { /* In-page history and alerts still work when system notifications do not. */ }
    }
  }

  async function instagramJSON(path, accountId, signal) {
    if (loggedInAccountID() !== accountId || signal.aborted) throw new DOMException('Account changed', 'AbortError');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 20000);
    try {
      const response = await fetch(path, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'X-IG-App-ID': '936619743392459', 'X-CSRFToken': cookieValue('csrftoken'), 'Accept': 'application/json' },
      });
      if (loggedInAccountID() !== accountId) throw new DOMException('Account changed', 'AbortError');
      if (!response.ok) {
        const error = new Error(response.status === 429 ? 'Instagram asked us to slow down. Checks are paused for one hour.' : `Instagram could not complete the check (HTTP ${response.status}).`);
        error.rateLimited = response.status === 429;
        throw error;
      }
      const data = await response.json();
      if (data.status !== 'ok') throw new Error('Instagram did not return a complete response. Try again later.');
      return data;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  async function fetchRelationshipCounts(accountId, signal) {
    const data = await instagramJSON(`/api/v1/users/${accountId}/info/`, accountId, signal);
    const user = data.user;
    if (!user || String(user.pk ?? user.pk_id ?? user.id) !== accountId ||
      !Number.isSafeInteger(user.follower_count) || user.follower_count < 0 ||
      !Number.isSafeInteger(user.following_count) || user.following_count < 0) {
      throw new Error('Instagram did not provide exact account totals. Your saved baseline was kept.');
    }
    return { followers: user.follower_count, following: user.following_count };
  }

  async function fetchRelationshipList(accountId, kind, expected, signal, onProgress = null) {
    const people = Object.create(null);
    const cursors = new Set();
    let cursor = '';
    let count = 0;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ count: '200' });
      if (cursor) query.set('max_id', cursor);
      const data = await instagramJSON(`/api/v1/friendships/${accountId}/${kind}/?${query}`, accountId, signal);
      if (!Array.isArray(data.users)) {
        throw new Error(`Instagram returned an incomplete ${kind} list. Your saved baseline was kept.`);
      }
      for (const user of data.users) {
        const id = String(user.pk ?? user.pk_id ?? user.id ?? '');
        if (!/^\d+$/.test(id) || !/^[\w.]{1,30}$/.test(user.username || '')) throw new Error(`Instagram returned an unreadable ${kind} entry.`);
        if (!Object.hasOwn(people,id)) count++;
        people[id] = { id, username: user.username };
      }
      state.relationshipStatus = `Checking ${kind}: ${count} of ${expected}…`;
      onProgress?.(count,expected);
      updateRelationshipHistory();
      if (count > expected) throw new Error('Your relationships changed during the check. We will retry later.');
      const next = data.next_max_id == null ? '' : String(data.next_max_id);
      if (!next) {
        if (data.more_available === true || count !== expected) throw new Error(`Only ${count} of ${expected} ${kind} were returned. Your saved baseline was kept.`);
        return people;
      }
      if (!data.users.length || cursors.has(next)) throw new Error(`Instagram repeated a ${kind} page. Your saved baseline was kept.`);
      cursors.add(next);
      cursor = next;
      await sleep(750);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    }
    throw new Error('This account is too large to check in one pass. No relationship changes were recorded.');
  }

  async function checkRelationships(force = false) {
    const accountId = loggedInAccountID();
    if (!state.settings.relationshipNotifier || !accountId || state.relationshipRunning) return;
    state.relationshipRunning = true;
    const controller = new AbortController();
    state.relationshipController = controller;
    const run = async () => {
      const previous = readRelationships(accountId);
      const now = Date.now();
      // Persist the schedule so refreshing or opening another tab cannot hammer Instagram.
      const due = previous?.nextCheckAt || 0;
      if (due > now && (!force || previous?.retryAfter > now || now - (previous?.lastAttemptAt || 0) < 60000)) {
        state.relationshipNextCheck = due;
        state.relationshipStatus = `Next check after ${new Date(due).toLocaleTimeString()}.`;
        return;
      }
      const attempt = { ...(previous || {}), schema: 1, accountId, lastAttemptAt: now, nextCheckAt: now + RELATIONSHIP_INTERVAL };
      writeRelationships(accountId, attempt);
      state.relationshipNextCheck = attempt.nextCheckAt;
      state.relationshipStatus = previous?.initializedAt ? 'Checking relationships…' : 'Creating your first baseline…';
      updateRelationshipHistory();
      try {
        const counts = await fetchRelationshipCounts(accountId, controller.signal);
        const followers = await fetchRelationshipList(accountId, 'followers', counts.followers, controller.signal);
        const following = await fetchRelationshipList(accountId, 'following', counts.following, controller.signal);
        const after = await fetchRelationshipCounts(accountId, controller.signal);
        if (counts.followers !== after.followers || counts.following !== after.following) throw new Error('Your relationships changed during the check. Your saved baseline was kept.');
        if (controller.signal.aborted || loggedInAccountID() !== accountId || !state.settings.relationshipNotifier) return;
        const at = Date.now();
        const snapshot = { followers, following };
        const diff = relationshipDiff(previous, snapshot, at);
        // Read history again: another tab may have cleared it while this check ran.
        const history = readRelationships(accountId)?.history || [];
        const record = { ...attempt, ...snapshot, pending: diff.pending, initializedAt: previous?.initializedAt || at,
          checkedAt: at, nextCheckAt: at + RELATIONSHIP_INTERVAL, retryAfter: 0, failures: 0, error: '',
          history: [...diff.events, ...history].slice(0, RELATIONSHIP_HISTORY_LIMIT) };
        writeRelationships(accountId, record);
        state.relationshipNextCheck = record.nextCheckAt;
        state.relationshipStatus = previous?.initializedAt ? 'Check complete.' : 'Baseline saved. Future changes will appear here.';
        notifyRelationships(diff.events);
      } catch (error) {
        if (controller.signal.aborted || loggedInAccountID() !== accountId) return;
        const failures = (previous?.failures || 0) + 1;
        const delay = error.rateLimited ? 60 * 60 * 1000 : Math.min(60 * 60 * 1000, RELATIONSHIP_INTERVAL * 2 ** Math.min(failures - 1, 2));
        const retryAfter = Date.now() + delay;
        const message = error.name === 'AbortError' ? 'Instagram took too long to respond. Your saved baseline was kept.' : error.message;
        writeRelationships(accountId, { ...attempt, history: readRelationships(accountId)?.history || [], failures, retryAfter, nextCheckAt: retryAfter, error: message });
        state.relationshipNextCheck = retryAfter;
        state.relationshipStatus = message;
        if (force) showToast(message);
      }
    };
    try {
      if (navigator.locks?.request) {
        await navigator.locks.request(`${APP}:relationship-check:${accountId}`, { ifAvailable: true }, async lock => {
          if (lock) await run();
          else state.relationshipStatus = 'Another Instagram tab is checking relationships.';
        });
      } else {
        // The persisted schedule still limits duplicate checks on older browsers.
        await run();
      }
    } catch {
      state.relationshipStatus = 'Could not save relationship history. Allow site storage or free some browser storage, then retry.';
      state.relationshipNextCheck = Date.now() + RELATIONSHIP_INTERVAL;
      if (force) showToast(state.relationshipStatus);
    } finally {
      state.relationshipRunning = false;
      state.relationshipController = null;
      updateRelationshipHistory();
    }
  }

  function relationshipTick() {
    const accountId = loggedInAccountID();
    if (accountId !== state.relationshipAccount) {
      state.relationshipController?.abort();
      state.relationshipAccount = accountId;
      state.relationshipNextCheck = 0;
      state.relationshipStatus = '';
      state.compareController?.abort();
      state.mediaController?.abort();
      removeModal('igp-media-modal');
      removeModal('igp-follow-compare-modal');
      scheduleScan();
      state.root?.getElementById('igp-toasts')?.remove();
      updateRelationshipHistory();
    }
    if (!document.hidden && state.settings.relationshipNotifier && accountId && Date.now() >= state.relationshipNextCheck) void checkRelationships();
  }

  function updateRelationshipHistory() {
    const body = state.root?.querySelector('#igp-relationship-modal .igp-modal-body');
    if (body) renderRelationshipHistory(body);
  }

  function renderRelationshipHistory(body) {
    const accountId = loggedInAccountID();
    const record = accountId ? readRelationships(accountId) : null;
    const events = Array.isArray(record?.history) ? record.history : [];
    const pendingCount = Object.values(record?.pending || {}).reduce((sum, value) => sum + Object.keys(value).length, 0);
    const status = !accountId ? 'Sign in to Instagram to start tracking.' : !state.settings.relationshipNotifier ? 'Tracking is off. Enable Friend Activity Notifier in IG+.' : state.relationshipStatus || record?.error || (record?.initializedAt ? 'Tracking is on.' : 'Waiting to create your first baseline.');
    body.innerHTML = `
      <div class="igp-note" role="status">${escapeHTML(status)}${pendingCount ? `<br>${pendingCount} awaiting confirmation` : ''}</div>
      <div class="igp-history-tools">
        <time>${record?.checkedAt ? escapeHTML(new Date(record.checkedAt).toLocaleString()) : ''}</time>
        <button class="igp-icon-btn" type="button" data-activity-check aria-label="Check now" title="Check now" ${!accountId || !state.settings.relationshipNotifier || state.relationshipRunning ? 'disabled' : ''}>${icon('refresh',19)}</button>
        <button class="igp-icon-btn" type="button" data-activity-desktop aria-label="Desktop alerts" title="Desktop alerts" aria-pressed="${state.settings.desktopNotifications}">${icon('bell',19)}</button>
        <button class="igp-icon-btn" type="button" data-activity-clear aria-label="Clear history" title="Clear history" ${events.length ? '' : 'disabled'}>${icon('trash',19)}</button>
      </div>
      <details class="igp-help"><summary>How it works</summary><p>Checks run every 15 minutes while Instagram is visible. The first check saves a baseline. Missing accounts need two complete checks. A disappearance can also mean account removal, deactivation or blocking; Instagram does not tell us why.</p></details>
      <div>${events.length ? events.map(event => `<a class="igp-event" href="/${encodeURIComponent(event.person.username)}/"><span>${escapeHTML(relationshipEventText(event))}</span><time>${escapeHTML(new Date(event.at).toLocaleString())}</time></a>`).join('') : '<div class="igp-empty">No changes recorded yet</div>'}</div>`;
    body.querySelector('[data-activity-check]').addEventListener('click', () => void checkRelationships(true));
    body.querySelector('[data-activity-clear]').addEventListener('click', () => {
      const current = readRelationships(accountId);
      if (current) {
        try { writeRelationships(accountId, { ...current, history: [] }); } catch { showToast('Could not clear history. Browser storage is unavailable.'); }
      }
      updateRelationshipHistory();
    });
    body.querySelector('[data-activity-desktop]').addEventListener('click', async () => {
      if (state.settings.desktopNotifications) state.settings.desktopNotifications = false;
      else {
        try {
          if (typeof Notification === 'undefined') throw new Error();
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') { showToast('Desktop alerts are unavailable. In-page alerts and history still work.'); return; }
          state.settings.desktopNotifications = true;
        } catch { showToast('This browser does not support desktop alerts here.'); return; }
      }
      saveSettings();
      updateRelationshipHistory();
    });
  }

  function openRelationshipHistory() {
    state.panelOpen = false;
    renderPanel();
    const modal = createModalShell('igp-relationship-modal', 'Friend Activity');
    renderRelationshipHistory(modal.body);
  }

  // ---------------------------------------------------------------------------
  // Media downloads. Resolve only the selected media, on an explicit click.
  // No playback interception, background harvesting or third-party services.
  // ---------------------------------------------------------------------------
  const MEDIA_LIMIT = 250 * 1024 * 1024;
  const MEDIA_TIMEOUT = 90000;

  function shortcodeToID(code) {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(code)) return null;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let value = 0n;
    for (const char of code) value = value * 64n + BigInt(alphabet.indexOf(char));
    return value > 0n ? String(value) : null;
  }

  function parseMediaReference(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return null;
      let match = url.pathname.match(/^\/(?:[A-Za-z0-9_.]{1,30}\/)?(p|reel|reels)\/([A-Za-z0-9_-]{1,16})\/?$/);
      if (match) {
        const id = shortcodeToID(match[2]);
        return id ? { kind: match[1] === 'p' ? 'post' : 'reel', id, code: match[2], key: `media:${id}` } : null;
      }
      match = url.pathname.match(/^\/stories\/([A-Za-z0-9_.]{1,30})(?:\/(\d+))?\/?$/);
      return match && match[1] !== 'highlights' ? { kind: 'story', id: match[2] || null, username: match[1], key: `story:${match[2] || match[1]}` } : null;
    } catch { return null; }
  }

  function mediaEnabled(reference) { return !!reference && state.settings[`${reference.kind}Downloads`]; }

  function allowedMediaURL(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, location.origin);
      if (url.protocol === 'blob:') return url.origin === location.origin ? url.href : null;
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      return ['cdninstagram.com', 'fbcdn.net', 'instagram.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null;
    } catch { return null; }
  }

  function bestMediaVariant(variants) {
    if (!Array.isArray(variants)) return null;
    return variants.filter(item => item && allowedMediaURL(item.url) && !state.failedMediaURLs.has(allowedMediaURL(item.url))).sort((a,b) =>
      (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0)
      || (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0] || null;
  }

  function mediaItems(data, reference) {
    const candidates = Array.isArray(data?.items) ? data.items : [];
    const item = candidates.find(value => {
      const id = String(value?.pk ?? value?.pk_id ?? value?.id ?? '').split('_')[0];
      return id === reference.id || reference.code && value?.code === reference.code;
    });
    if (!item) throw new Error('Instagram returned a different item. Nothing was downloaded.');
    const children = Number(item.media_type) === 8 ? item.carousel_media : [item];
    if (!Array.isArray(children) || !children.length || children.length > 100) throw new Error('Instagram did not return the complete media.');
    if (Number(item.carousel_media_count) > children.length) throw new Error('Instagram returned an incomplete carousel.');
    return children.map((child,index) => {
      const kind = Number(child.media_type) === 2 || Array.isArray(child.video_versions) && child.video_versions.length ? 'video' : 'image';
      const best = bestMediaVariant(kind === 'video' ? child.video_versions : child.image_versions2?.candidates);
      if (!best || reference.kind === 'reel' && kind !== 'video') throw new Error('The original media is unavailable. Reload the item and try again.');
      const preview = bestMediaVariant(child.image_versions2?.candidates);
      return { url: allowedMediaURL(best.url), kind, index: index + 1, width: Number(best.width || child.original_width) || 0, height: Number(best.height || child.original_height) || 0, preview: preview ? allowedMediaURL(preview.url) : null };
    });
  }

  // Instagram embeds original files in its JSON payloads even when the player
  // uses a MediaSource blob. Read those payloads on demand; do not intercept playback.
  function compactMedia(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 2) return null;
    const id = String(value.pk ?? value.id ?? '').split('_')[0];
    if (!/^\d+$/.test(id)) return null;
    const variants = values => Array.isArray(values) ? values.slice(0,30).filter(item => item && allowedMediaURL(item.url)).map(item => ({ url: allowedMediaURL(item.url), width: Number(item.width) || 0, height: Number(item.height) || 0, bitrate: Number(item.bitrate) || 0, type: item.type })) : [];
    return {
      pk: id, code: typeof value.code === 'string' ? value.code : '',
      media_type: Number(value.media_type), original_width: Number(value.original_width) || 0, original_height: Number(value.original_height) || 0,
      video_versions: variants(value.video_versions), image_versions2: { candidates: variants(value.image_versions2?.candidates) },
      carousel_media_count: Number(value.carousel_media_count) || 0,
      carousel_media: Array.isArray(value.carousel_media) ? value.carousel_media.slice(0,100).map(child => compactMedia(child,depth + 1)).filter(Boolean) : null,
    };
  }

  function collectMediaRecords(data) {
    const records = new Map();
    const stack = [{ value: data, depth: 0, owner: '', story: false }];
    const visited = new WeakSet();
    let nodes = 0;
    while (stack.length && nodes++ < 40000 && records.size < 300) {
      const context = stack.pop();
      const value = context.value;
      if (!value || typeof value !== 'object' || context.depth > 40 || visited.has(value)) continue;
      visited.add(value);
      const story = context.story || ['user_reel','highlight_reel'].includes(value.reel_type);
      const owner = typeof value.user?.username === 'string' ? value.user.username : context.owner;
      if (value.image_versions2 || value.video_versions || Number(value.media_type) === 8) {
        const media = compactMedia(value);
        if (media) {
          records.set(media.pk, { media, owner, story });
          // Keep carousel children attached to their parent, in their original order.
          continue;
        }
      }
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key,child] = entries[i];
        if (child && typeof child === 'object' && !['viewers','caption','comments','user','owner'].includes(key)) stack.push({ value: child, depth: context.depth + 1, owner, story: story || key === 'reels_media' || key === 'xdt_api__v1__feed__reels_media' });
      }
    }
    return [...records.values()];
  }

  function documentMediaRecords(root = document) {
    const records = new Map();
    let budget = 8 * 1024 * 1024;
    for (const script of root.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent || '';
      if (text.length > budget) continue;
      budget -= text.length;
      if (!/video_versions|image_versions2|carousel_media/.test(text)) continue;
      try { for (const record of collectMediaRecords(JSON.parse(text))) records.set(record.media.pk,record); } catch {}
    }
    return [...records.values()];
  }

  function matchMediaRecords(records, reference, fallback) {
    if (reference.id) {
      const record = records.find(record => record.media.pk === reference.id || reference.code && record.media.code === reference.code);
      return record ? { items: mediaItems({ items: [record.media] },reference), fallback: false } : null;
    }
    if (reference.kind !== 'story' || !reference.username) return null;
    let stories = records.filter(record => record.story && normalizeUsername(record.owner) === normalizeUsername(reference.username));
    if (!stories.length) return null;
    // A displayed image can identify its exact story. A streaming blob cannot.
    if (fallback?.kind === 'image') {
      const path = new URL(fallback.url).pathname;
      const exact = stories.filter(record => record.media.image_versions2.candidates.some(item => new URL(item.url).pathname === path));
      if (exact.length === 1) stories = exact;
    }
    const items = stories.flatMap(record => mediaItems({ items: [record.media] },{ ...reference, id: record.media.pk }).map(item => ({ ...item, mediaId: record.media.pk })));
    return { items: items.map((item,index) => ({ ...item, index: index + 1 })), fallback: false, storyChoices: stories.length > 1 };
  }

  async function fetchMediaPage(reference, accountId, signal) {
    const path = reference.kind === 'story' ? `/stories/${encodeURIComponent(reference.username)}/` : `/${reference.kind === 'reel' ? 'reel' : 'p'}/${encodeURIComponent(reference.code)}/`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) throw new DOMException('Cancelled','AbortError');
    signal.addEventListener('abort',abort,{ once: true });
    const timer = setTimeout(abort,20000);
    try {
      const response = await fetch(path,{ credentials:'same-origin', cache:'no-store', signal:controller.signal, headers:{ Accept:'text/html' } });
      if (!response.ok) {
        const error = new Error('Instagram could not load the original media.'); error.rateLimited = response.status === 429; throw error;
      }
      if (Number(response.headers.get('Content-Length')) > 8 * 1024 * 1024) throw new Error('The media page was too large.');
      const html = await response.text();
      if (html.length > 8 * 1024 * 1024) throw new Error('The media page was too large.');
      if (signal.aborted || accountId !== loggedInAccountID()) throw new DOMException('Cancelled','AbortError');
      const template = document.createElement('template');
      template.innerHTML = html; // Inert template: scripts and image loads never execute.
      return documentMediaRecords(template.content);
    } finally { clearTimeout(timer); signal.removeEventListener('abort',abort); }
  }

  function visibleMediaArea(element) {
    if (!isVisible(element) || element.closest('[hidden],[aria-hidden="true"]')) return 0;
    const rect = element.getBoundingClientRect();
    const vp = viewport();
    const width = Math.max(0, Math.min(rect.right, vp.left + vp.width) - Math.max(rect.left, vp.left));
    const height = Math.max(0, Math.min(rect.bottom, vp.top + vp.height) - Math.max(rect.top, vp.top));
    if (width < 150 || height < 150 || width * height < rect.width * rect.height * 0.65) return 0;
    return width * height;
  }

  function articleReference(article) {
    const references = [...article.querySelectorAll('a[href]')].map(anchor => parseMediaReference(anchor.href)).filter(ref => ref && ref.kind !== 'story');
    const unique = [...new Map(references.map(ref => [ref.key, ref])).values()];
    return unique.length === 1 ? unique[0] : null;
  }

  function currentMediaTarget() {
    const reference = parseMediaReference(location.href);
    if (!reference) {
      if (!/^\/reels?\/?$/.test(location.pathname)) {
        if (location.pathname.startsWith('/direct/') || location.pathname.startsWith('/stories/')) return null;
        const candidates = [...document.querySelectorAll('article')].map(scope => ({ scope, reference: articleReference(scope) })).filter(target => target.reference && mediaEnabled(target.reference) && visibleIntersection(target.scope) > 0);
        return candidates.sort((a,b) => visibleIntersection(b.scope) - visibleIntersection(a.scope))[0] || null;
      }
      const videos = [...document.querySelectorAll('main video, [role="main"] video')].filter(video => visibleMediaArea(video));
      if (videos.length !== 1) return { reference: { kind:'reel', id:null, key:'visible-reel' }, path:location.pathname };
      const video = videos[0];
      // The reels feed sometimes has no shortcode in the address bar.
      let parent = video.parentElement;
      for (let depth = 0; parent && depth < 8 && !parent.matches('main,[role="main"]'); depth++, parent = parent.parentElement) {
        const linked = articleReference(parent);
        if (linked) return { reference: { ...linked, kind: 'reel' }, scope: parent };
      }
      return { reference: { kind: 'reel', id: null, key: 'visible-reel' }, video, path: location.pathname };
    }
    const articles = [...document.querySelectorAll('article')].filter(article => articleReference(article)?.key === reference.key && isVisible(article));
    // A modal post can coexist with a feed copy; pick the one in view.
    const scope = articles.sort((a,b) => visibleIntersection(b) - visibleIntersection(a))[0] || null;
    return { reference, scope };
  }

  function visibleIntersection(element) {
    if (!isVisible(element)) return 0;
    const r = element.getBoundingClientRect(), vp = viewport();
    return Math.max(0,Math.min(r.right,vp.left + vp.width) - Math.max(r.left,vp.left)) * Math.max(0,Math.min(r.bottom,vp.top + vp.height) - Math.max(r.top,vp.top));
  }

  function domMediaItem(target) {
    // Fallback is deliberately scoped: never use a neighbouring post or avatar.
    if (target.video) {
      const video = target.video;
      if (!video.isConnected || target.path !== location.pathname || !visibleMediaArea(video)) return null;
      const url = allowedMediaURL(video.currentSrc || video.src || video.querySelector('source[src]')?.src);
      return url ? { url, kind: 'video', index: 1, width: video.videoWidth, height: video.videoHeight } : null;
    }
    const current = parseMediaReference(location.href);
    let scope = target.scope;
    if (scope) {
      if (!scope.isConnected || articleReference(scope)?.key !== target.reference.key) return null;
    } else {
      if (current?.key !== target.reference.key) return null;
      scope = [...document.querySelectorAll('[role="dialog"]')].find(isVisible) || document.querySelector('main,[role="main"]');
      if (!scope) return null;
    }
    const allVideos = [...scope.querySelectorAll('video')];
    const videos = allVideos.filter(element => visibleMediaArea(element));
    if (allVideos.length) {
      if (videos.length !== 1) return null;
      const video = videos[0];
      const url = allowedMediaURL(video.currentSrc || video.src || video.querySelector('source[src]')?.src);
      return url ? { url, kind: 'video', index: 1, width: video.videoWidth, height: video.videoHeight } : null;
    }
    if (target.reference.kind === 'reel') return null;
    const images = [...scope.querySelectorAll('img')].filter(element => {
      const linked = parseMediaReference(element.closest('a[href]')?.href || '');
      return visibleMediaArea(element) && !/profile (?:picture|photo)|avatar/i.test(element.alt || '') && !element.closest('header,nav') && (!linked || linked.key === target.reference.key);
    });
    if (images.length !== 1) return null;
    const img = images[0];
    const url = allowedMediaURL(img.currentSrc || img.src);
    return url ? { url, kind: 'image', index: 1, width: img.naturalWidth, height: img.naturalHeight } : null;
  }

  async function resolveMedia(target, signal) {
    const accountId = loggedInAccountID();
    // Capture the fallback before awaiting: a story may advance while loading.
    const fallback = domMediaItem(target);
    try {
      const fromDocument = matchMediaRecords(documentMediaRecords(),target.reference,fallback);
      if (fromDocument) return fromDocument;
    } catch { /* Expired or incomplete embedded metadata can be refreshed below. */ }
    if (!target.reference.id && target.reference.kind !== 'story') {
      if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (fallback) return { items: [fallback], fallback: true };
      throw new Error('Open this reel directly or wait for its video to load, then try again.');
    }
    try {
      if (target.reference.id) {
        const data = await instagramJSON(`/api/v1/media/${target.reference.id}/info/`, accountId, signal);
        return { items: mediaItems(data, target.reference), fallback: false };
      }
    } catch (error) {
      if (signal.aborted || accountId !== loggedInAccountID()) throw new DOMException('Download cancelled', 'AbortError');
      if (error.rateLimited) throw new Error('Instagram is limiting requests. Please wait before retrying.');
    }
    try {
      const fromPage = matchMediaRecords(await fetchMediaPage(target.reference,accountId,signal),target.reference,fallback);
      if (fromPage) return fromPage;
    } catch (error) {
      if (signal.aborted || accountId !== loggedInAccountID()) throw new DOMException('Download cancelled','AbortError');
      if (error.rateLimited) throw new Error('Instagram is limiting requests. Please wait before retrying.');
    }
    if (fallback && !state.failedMediaURLs.has(fallback.url) && (fallback.kind === 'image' || !fallback.url.startsWith('blob:'))) return { items: [fallback], fallback: true };
    throw new Error('Instagram did not expose a downloadable file. Reload or open this item directly, then try again.');
  }

  async function mediaExtension(blob, expectedKind) {
    if (!blob?.size || blob.size > MEDIA_LIMIT) throw new Error('The file is empty or exceeds the 250 MB download limit.');
    const bytes = new Uint8Array(await blob.slice(0,64).arrayBuffer());
    const ascii = (start,end) => String.fromCharCode(...bytes.slice(start,end));
    let extension = null;
    if (expectedKind === 'image') {
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = 'jpg';
      else if (bytes[0] === 0x89 && ascii(1,8) === 'PNG\r\n\x1a\n') extension = 'png';
      else if (/^GIF8[79]a$/.test(ascii(0,6))) extension = 'gif';
      else if (ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') extension = 'webp';
      else if (ascii(4,8) === 'ftyp' && /avif|avis/.test(ascii(8,32))) extension = 'avif';
      else if (ascii(4,8) === 'ftyp' && /heic|heix|hevc|hevx/.test(ascii(8,32))) extension = 'heic';
    } else if (expectedKind === 'video') {
      if (ascii(4,8) === 'ftyp' && /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|qt  )$/.test(ascii(8,12))) extension = ascii(8,12) === 'qt  ' ? 'mov' : 'mp4';
      else if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && ascii(4,64).includes('webm')) extension = 'webm';
    }
    if (!extension) throw new Error('The response was not a supported photo or video. No file was saved.');
    return extension;
  }

  function privilegedMediaBlob(url, signal) {
    return new Promise((resolve,reject) => {
      const request = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest.bind(GM) : null;
      if (!request) { reject(new Error('Enable the script’s media-host permissions in your userscript manager, then reload Instagram.')); return; }
      let handle;
      let settled = false;
      const finish = (error, blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(blob);
      };
      const abort = () => { handle?.abort?.(); finish(new DOMException('Download cancelled', 'AbortError')); };
      const timer = setTimeout(() => { handle?.abort?.(); finish(new Error('The download timed out. Try again.')); }, MEDIA_TIMEOUT);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      try {
        handle = request({
          method: 'GET', url, responseType: 'blob', anonymous: true, timeout: MEDIA_TIMEOUT,
          onload: response => {
            if (response.status < 200 || response.status >= 300) { if ([403,404].includes(response.status)) rememberFailedMediaURL(url); finish(new Error('The media link expired or is unavailable. Close this window and retry.')); return; }
            if (response.finalUrl && !allowedMediaURL(response.finalUrl)) { finish(new Error('Unexpected media redirect.')); return; }
            const blob = response.response;
            if (!blob || typeof blob.slice !== 'function' || !blob.size || blob.size > MEDIA_LIMIT) { finish(new Error('The file is empty or exceeds the 250 MB download limit.')); return; }
            finish(null,blob);
          },
          onprogress: event => { if (event.loaded > MEDIA_LIMIT || event.total > MEDIA_LIMIT) { finish(new Error('This file exceeds the 250 MB download limit.')); handle?.abort?.(); } },
          onerror: () => finish(new Error('The media download failed. Check your connection and try again.')),
          ontimeout: () => finish(new Error('The download timed out. Try again.')),
          onabort: () => finish(new DOMException('Download cancelled', 'AbortError')),
        });
        // Some managers return a thenable; callbacks still own completion.
        handle?.catch?.(error => finish(error));
      } catch (error) { finish(error); }
    });
  }

  async function fetchMediaBlob(value, signal) {
    const url = allowedMediaURL(value);
    if (!url) throw new Error('Unsupported media URL.');
    if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, MEDIA_TIMEOUT);
    try {
      let response;
      try { response = await fetch(url, { credentials: 'omit', signal: controller.signal, referrerPolicy: 'no-referrer' }); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        if (url.startsWith('blob:')) throw new Error('Instagram is streaming this video without exposing a file. Reload the item and retry.');
        clearTimeout(timeout);
        return await privilegedMediaBlob(url, signal);
      }
      if (!response.ok) {
        if ([403,404].includes(response.status)) rememberFailedMediaURL(url);
        throw new Error('The media link expired or is unavailable. Close this window and retry.');
      }
      if (response.url && !allowedMediaURL(response.url)) throw new Error('Unexpected media redirect.');
      if (Number(response.headers.get('Content-Length')) > MEDIA_LIMIT) { controller.abort(); throw new Error('This file exceeds the 250 MB download limit.'); }
      if (!response.body?.getReader) {
        const blob = await response.blob();
        if (blob.size > MEDIA_LIMIT) throw new Error('This file exceeds the 250 MB download limit.');
        return blob;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MEDIA_LIMIT) { await reader.cancel(); throw new Error('This file exceeds the 250 MB download limit.'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      return new Blob(chunks, { type: response.headers.get('Content-Type') || '' });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  function mediaFilename(reference, item, extension) {
    const identity = `${reference.username ? `${reference.username}-` : ''}${item.mediaId || reference.code || reference.id || Date.now()}`.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0,100);
    return `instagram-${reference.kind}-${identity}-${String(item.index).padStart(2,'0')}.${extension}`;
  }

  function rememberFailedMediaURL(url) {
    state.failedMediaURLs.add(url);
    if (state.failedMediaURLs.size > 64) state.failedMediaURLs.delete(state.failedMediaURLs.values().next().value);
  }

  async function saveMediaItem(reference, item, accountId, signal) {
    const blob = await fetchMediaBlob(item.url, signal);
    const extension = await mediaExtension(blob, item.kind);
    if (signal.aborted || loggedInAccountID() !== accountId || !mediaEnabled(reference)) throw new DOMException('Download cancelled', 'AbortError');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = mediaFilename(reference,item,extension);
    anchor.hidden = true;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }

  async function openMediaDownload(target) {
    if (!mediaEnabled(target?.reference)) return;
    state.mediaController?.abort();
    const controller = new AbortController();
    const accountId = loggedInAccountID();
    state.mediaController = controller;
    state.panelOpen = false; renderPanel();
    const modal = createModalShell('igp-media-modal', `Download ${target.reference.kind}`, { onClose: () => {
      controller.abort();
      if (state.mediaController === controller) state.mediaController = null;
    } });
    modal.body.innerHTML = '<div class="igp-progress" role="status"><div class="igp-spinner"></div>Loading…</div>';
    try {
      const resolved = await resolveMedia(target,controller.signal);
      if (controller.signal.aborted || !modal.backdrop.isConnected) return;
      const { items } = resolved;
      const note = document.createElement('div');
      note.className = 'igp-note'; note.setAttribute('role','status');
      note.textContent = resolved.storyChoices ? `Choose a story · @${target.reference.username}` : resolved.fallback ? 'Visible item · displayed quality' : `${items.length} ${items.length === 1 ? 'item' : 'items'} · Original quality`;
      modal.body.replaceChildren(note);
      const actions = document.createElement('div'); actions.className = 'igp-actions igp-downloads'; modal.body.appendChild(actions);
      const buttons = [];
      const saved = new Set();
      let busy = false;
      const download = async selection => {
        if (busy) return;
        busy = true; buttons.forEach(button => { button.disabled = true; });
        let completed = 0;
        try {
          for (const item of selection) {
            note.textContent = `Saving ${item.index}/${items.length}…`;
            await saveMediaItem(target.reference,item,accountId,controller.signal);
            saved.add(item.index); completed++;
            if (selection.length > 1) await sleep(350);
          }
          note.textContent = `${completed} ${completed === 1 ? 'file' : 'files'} sent to Downloads`;
          note.title = 'If prompted, allow multiple downloads in your browser.';
          for (const button of buttons) if (saved.has(Number(button.dataset.index))) {
            button.dataset.saved = 'true';
            button.querySelector('svg')?.remove(); button.insertAdjacentHTML('afterbegin',icon('check',18));
            button.querySelector('span').textContent = `${items.length > 1 ? `${button.dataset.index} · ` : ''}Saved`;
          }
        } catch (error) {
          if (!controller.signal.aborted) note.textContent = `${completed ? `${completed} file(s) sent. ` : ''}${error.name === 'AbortError' ? 'The download timed out. Close this window and retry.' : error.message}`;
        } finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
      };
      for (const item of items) {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.index = item.index;
        const label = `${items.length > 1 ? `${item.index} · ` : ''}${item.kind === 'video' ? 'Video' : 'Photo'}`;
        button.innerHTML = `${icon('download',18)}<span>${label}</span>`;
        button.setAttribute('aria-label',`Download ${label}`);
        button.title = item.width && item.height ? `${item.width} × ${item.height}` : `Download ${label}`;
        if (resolved.storyChoices && item.preview) {
          const preview = document.createElement('img'); preview.src = item.preview; preview.alt = `Story ${item.index} preview`; preview.loading = 'lazy'; preview.referrerPolicy = 'no-referrer';
          button.prepend(preview);
        }
        button.addEventListener('click', () => void download([item]));
        buttons.push(button); actions.appendChild(button);
      }
      if (items.length > 1) {
        const all = document.createElement('button'); all.type = 'button'; all.className = 'igp-save-all'; all.textContent = `Save all (${items.length})`;
        all.addEventListener('click', () => {
          const remaining = items.filter(item => !saved.has(item.index));
          if (remaining.length) void download(remaining); else note.textContent = 'All files sent to Downloads';
        });
        buttons.push(all); actions.prepend(all);
      }
    } catch (error) {
      if (!controller.signal.aborted) modal.body.innerHTML = `<div class="igp-note" role="alert">${escapeHTML(error.message || 'Could not load this media. Try again.')}</div>`;
    }
  }

  function clearMediaButtons() {
    for (const host of state.mediaBindings.values()) host.remove();
    state.mediaBindings.clear();
  }

  function inMediaViewport(element) {
    if (!isVisible(element)) return false;
    const r = element.getBoundingClientRect(), vp = viewport();
    return r.bottom > vp.top && r.top < vp.top+vp.height && r.right > vp.left && r.left < vp.left+vp.width;
  }

  function storyControlScope() {
    // Story players can be portals outside MAIN (which may be hidden/empty).
    // Locate the active header from its real controls, not the page landmark.
    const labels = ['Menu','More options','More','Pause','Play','Close'];
    const controls = [...document.querySelectorAll('svg[aria-label],button[aria-label],[role="button"][aria-label]')]
      .filter(el => labels.includes(el.getAttribute('aria-label')) && inMediaViewport(el));
    controls.sort((a,b) => labels.indexOf(a.getAttribute('aria-label'))-labels.indexOf(b.getAttribute('aria-label')) ||
      Math.abs(a.getBoundingClientRect().left-innerWidth/2)-Math.abs(b.getBoundingClientRect().left-innerWidth/2));
    for (const control of controls) {
      let branch = control.closest('button,[role="button"]');
      for (let depth=0; branch?.parentElement && depth<8; depth++,branch=branch.parentElement) {
        const parent = branch.parentElement, r = parent.getBoundingClientRect();
        if (r.height > 120) break;
        if (r.width >= 120 && r.height >= 24 && inMediaViewport(parent) && !parent.closest('button,[role="button"],a[href]')) return parent;
      }
    }
    return null;
  }

  function mediaActionSlot(scope, kind) {
    // Instagram's generated classes change frequently; anchor to its accessible
    // controls and climb only as far as their shared action row / rail.
    const labels = kind === 'story' ? ['Menu','More options','More'] : ['Share','Save','More options','More'];
    const route = parseMediaReference(location.href);
    const candidates = [...scope.querySelectorAll('svg[aria-label],button[aria-label],[role="button"][aria-label]')]
      .filter(el => {
        const article = el.closest('article');
        return labels.includes(el.getAttribute('aria-label')) && inMediaViewport(el) &&
          (!route || !article || articleReference(article)?.key === route.key);
      });
    candidates.sort((a,b) => labels.indexOf(a.getAttribute('aria-label'))-labels.indexOf(b.getAttribute('aria-label')) ||
      Math.abs(a.getBoundingClientRect().top-innerHeight/2)-Math.abs(b.getBoundingClientRect().top-innerHeight/2));
    for (const candidate of candidates) {
      let branch = candidate.closest('button,[role="button"]');
      if (!branch || !scope.contains(branch)) continue;
      for (let depth = 0; depth < 7 && branch.parentElement && branch !== scope; depth++, branch = branch.parentElement) {
        const parent = branch.parentElement, r = parent.getBoundingClientRect(), style = getComputedStyle(parent);
        if (parent.closest('button,[role="button"],a[href]')) continue;
        const controls = parent.querySelectorAll('svg[aria-label],button[aria-label]');
        const unique = new Set([...controls].map(el => el.getAttribute('aria-label')));
        const compact = kind === 'reel' ? r.width <= 150 || r.height <= 90 : r.height <= 100;
        if ((unique.size >= 2 || kind === 'story' && parent === scope) && compact && (style.display.includes('flex') || style.display.includes('grid'))) {
          return { parent, before:kind === 'story' ? branch : branch.nextSibling, color:getComputedStyle(candidate).color, native:true };
        }
      }
    }
    if (kind === 'story' && scope === storyControlScope()) {
      return {parent:scope,before:scope.firstChild,color:getComputedStyle(scope).color,native:true};
    }
    // During loading or an unfamiliar layout, use an inline control in the media
    // section. The next scan moves it into native actions as soon as they arrive.
    const header = scope.querySelector('header');
    const parent = header && inMediaViewport(header) && !header.closest('a,button,[role="button"]') ? header : scope;
    if (parent.closest('a,button,[role="button"]')) return null;
    return { parent, before:parent.firstChild, color:kind === 'story' ? '#fff' : getComputedStyle(parent).color, native:false };
  }

  function enhanceMediaDownloads() {
    if (location.pathname.startsWith('/direct/')) { clearMediaButtons(); return; }
    const targets = new Map(), direct = currentMediaTarget(), routeReference = parseMediaReference(location.href);
    if (!isStoryRoute()) for (const article of document.querySelectorAll('article')) {
      const reference = articleReference(article);
      const selected = routeReference?.key === reference?.key ? routeReference : reference;
      if (mediaEnabled(selected) && (!routeReference || reference?.key === routeReference.key) && inMediaViewport(article)) targets.set(article,{ reference:selected, scope:article });
    }
    if (mediaEnabled(direct?.reference) && !targets.has(direct.scope)) {
      const scope = direct.reference.kind === 'story' ? storyControlScope() : direct.scope || [...document.querySelectorAll('[role="dialog"],main')].find(el => inMediaViewport(el) && el.querySelector('video,img,svg[aria-label]')) || document.querySelector('main');
      if (scope && !scope.closest('[data-igp-media-host]')) targets.set(scope,direct);
    }
    for (const [scope,host] of state.mediaBindings) {
      if (!targets.has(scope) || !host.isConnected) { host.remove(); state.mediaBindings.delete(scope); }
    }
    for (const [scope,target] of targets) {
      const kind = target.reference.kind, slot = mediaActionSlot(scope,kind);
      if (!slot) continue;
      let host = state.mediaBindings.get(scope);
      if (!host) {
        host = document.createElement('span'); host.setAttribute('data-igp-media-host','');
        host.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;vertical-align:middle;pointer-events:auto;';
        const shadow = host.attachShadow({mode:'open'});
        shadow.innerHTML = `<style>:host{color:inherit}button{display:grid;place-items:center;width:36px;height:36px;padding:6px;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer;touch-action:manipulation}button:hover{opacity:.6}button:focus-visible{outline:2px solid #0095f6;outline-offset:2px}svg{display:block;pointer-events:none}:host([data-kind="story"]) button{width:30px;height:30px;padding:5px}:host([data-kind="story"]) svg{width:20px;height:20px}</style><button type="button">${icon('download')}</button>`;
        shadow.querySelector('button').addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          const article = scope.matches('article') ? articleReference(scope) : null, route = parseMediaReference(location.href);
          const fresh = scope.matches('article') ? {reference:route?.key === article?.key ? route : article,scope} : currentMediaTarget();
          if (fresh && mediaEnabled(fresh.reference)) void openMediaDownload(fresh);
        });
        // Keep Instagram's delegated media/player handlers away from our control.
        for (const type of ['pointerdown','pointerup','dblclick','keydown','keyup']) host.addEventListener(type,event=>event.stopPropagation());
        state.mediaBindings.set(scope,host);
      }
      if (host.dataset.kind !== kind) host.dataset.kind = kind;
      const placement = slot.native ? 'native' : 'inline';
      if (host.dataset.placement !== placement) host.dataset.placement = placement;
      const button = host.shadowRoot.querySelector('button'), label = `Download ${kind}`;
      if (button.getAttribute('aria-label') !== label) { button.setAttribute('aria-label',label); button.title = label; }
      if (host.style.color !== slot.color) host.style.color = slot.color;
      // Avoid repeated mutations when our host is already immediately after the anchor.
      if (host.parentElement !== slot.parent || (slot.before !== host && host.nextSibling !== slot.before)) slot.parent.insertBefore(host,slot.before);
    }
  }

  // Keep native editing, composition, selection and undo inside our search fields.
  window.addEventListener('keydown', event => {
    const input = state.focusedIGPInput;
    if (!['Escape','Tab'].includes(event.key) && input?.isConnected && event.composedPath().includes(input)) {
      event.stopImmediatePropagation();
    }
  }, true);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function handleURLChange() {
    const previous = state.lastURL;
    const next = location.href;
    if (previous === next) return;
    state.lastURL = next;
    clearMediaButtons();

    const oldStory = previous.includes('/stories/');
    const newStory = next.includes('/stories/');
    if (oldStory && (!newStory || storyRouteKey() !== state.storySession?.routeKey)) clearStorySession();
  }

  function scan() {
    ensureRoot();
    syncTheme();
    handleURLChange();
    enhanceMediaDownloads();
    enhanceBioFonts();
    enhanceStoryViewerSearch();
  }

  function scheduleScan(delay = 80) {
    if (state.scanTimer !== null) return;
    state.scanTimer = setTimeout(() => { state.scanTimer = null; scan(); }, delay);
  }

  function installRouteWatcher() {
    const notify = () => {
      handleURLChange();
      scheduleScan(20);
    };
    for (const method of ['pushState', 'replaceState']) {
      const original = PAGE.history[method];
      if (typeof original === 'function') {
        PAGE.history[method] = pageFunction(function (...args) {
          const result = original.apply(this, args);
          queueMicrotask(notify);
          return result;
        });
      }
    }
    addEventListener('popstate', notify, true);
  }

  function boot() {
    state.relationshipAccount = loggedInAccountID();
    ensureRoot();
    installRouteWatcher();
    new MutationObserver(records => {
      if (records.some(record => !record.target.closest?.('[data-igp-media-host],[data-igp-bio-toolbar-host]'))) scheduleScan(150);
    })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'href', 'aria-label', 'hidden'] });
    const themeObserver = new MutationObserver(() => scheduleScan(0));
    themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});
    const watchBodyTheme = () => { if (document.body) themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','style','data-theme']}); };
    if (document.body) watchBodyTheme(); else document.addEventListener('DOMContentLoaded',watchBodyTheme,{once:true});
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change',() => scheduleScan(0));
    document.addEventListener('loadedmetadata', () => scheduleScan(), true);
    document.addEventListener('play', () => scheduleScan(), true);
    document.addEventListener('scroll', () => scheduleScan(180), { capture: true, passive: true });
    document.addEventListener('visibilitychange', relationshipTick);
    addEventListener('pagehide', () => {
      state.cancelLauncherMotion?.();
      state.relationshipController?.abort();
      state.compareController?.abort();
      state.mediaController?.abort();
    });
    addEventListener('storage', event => {
      if (event.key === SETTINGS_KEY) {
        state.settings = loadJSON(SETTINGS_KEY, DEFAULTS);
        if (!state.settings.relationshipNotifier) state.relationshipController?.abort();
        cleanupDisabledFeatures();
        renderPanel();
        scheduleScan();
      }
      if (event.key?.startsWith(`${APP}:relationships:`)) updateRelationshipHistory();
    });
    setInterval(relationshipTick, 30000);
    // Recover route hooks and story portals that become visible using CSS alone.
    // A connected, visible story control needs no additional scan here.
    setInterval(() => {
      if (document.hidden) return;
      const missingStoryControl = isStoryRoute() && state.settings.storyDownloads &&
        ![...state.mediaBindings.values()].some(host => host.dataset.kind === 'story' && host.isConnected && inMediaViewport(host));
      if (location.href !== state.lastURL || missingStoryControl) scheduleScan(0);
    },1000);
    setTimeout(relationshipTick, 5000);

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.modalClosers.size) {
        event.preventDefault(); event.stopImmediatePropagation();
        [...state.modalClosers.values()].at(-1)();
        return;
      }
      if (event.key === 'Escape' && state.panelOpen) {
        state.panelOpen = false;
        renderPanel();
        state.root.getElementById('igp-launcher').focus({preventScroll:true});
      }
    }, true);

    document.addEventListener('click', event => {
      const path = event.composedPath?.() || [];
      if (state.root && path.includes(state.root.getElementById('igp-launcher'))) return;
      if (state.panelOpen && !path.includes(state.rootHost)) {
        state.panelOpen = false;
        renderPanel();
      }
    }, true);

    const keepInside = () => {
      applyLauncherPosition();
      if (state.panelOpen) positionPanel();
    };
    addEventListener('resize', keepInside);
    window.visualViewport?.addEventListener('resize', keepInside);
    window.visualViewport?.addEventListener('scroll', () => state.panelOpen && positionPanel());
    scheduleScan(0);
  }

  if (document.documentElement) {
    boot();
  } else {
    function handleReadyState() {
      if (document.documentElement && !state.rootHost) {
        document.removeEventListener('readystatechange', handleReadyState);
        boot();
      }
    }
    document.addEventListener('readystatechange', handleReadyState, false);
  }
})();
