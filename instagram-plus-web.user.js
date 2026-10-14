// ==UserScript==
// @name         Instagram Plus (Web)
// @namespace    https://greasyfork.org/
// @version      2.4.0
// @description  Instagram media downloads, viewer, video controls, native follower comparison, Friend Activity, Story tools and bio fonts.
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

// Established media, Story and bio engine.
(() => {
  'use strict';

  const APP = 'igp-web';
  const VERSION = '1.9.0';
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
    mediaViewer: true,
    videoControls: true,
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
    mediaJobKey: null,
    viewerController: null,
    videoPreferencesApplied: new WeakMap(),
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
    downloadAll: '<path d="M8 3H3v14h3m2-10h13v14H8Z M14.5 10v7m-3-3 3 3 3-3"/>',
    expand: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
    controls: '<path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    pip: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 11h7v7h-7Z"/>',
    volume: '<path d="M3 9h4l5-4v14l-5-4H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    minus: '<path d="M5 12h14"/>',
    zoom: '<path d="M5 12h14M12 5v14"/>',
    previous: '<path d="m15 5-7 7 7 7"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
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
    :host{--bg:#fff;--fg:#161616;--muted:#666;--bd:#e6e6e6;--soft:#f5f5f5;--soft2:#efefef;--strong:#262626;--inverse:#fff;--accent:#006fc4;--shadow:0 8px 32px #0002;color-scheme:light;font:14px/1.4 ${UI_FONT}}
    :host([data-theme="dark"]){--bg:#161616;--fg:#fafafa;--muted:#adadad;--bd:#353535;--soft:#232323;--soft2:#303030;--accent:#53b5ff;--strong:#f5f5f5;--inverse:#121212;--shadow:0 8px 32px #0005;color-scheme:dark}
  `;
  const GLOBAL_CSS = `${THEME_CSS}
    :host{all:initial;font:14px/1.4 ${UI_FONT};color:var(--fg)}
    *{box-sizing:border-box;font-family:${UI_FONT}}button,input,select{font:inherit}button{color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}
    button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
    svg{display:block;flex:none}button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    .head{display:flex;align-items:center;justify-content:space-between;padding:17px 18px 12px}.title{font-size:15px;font-weight:650}.version{font-size:11px;color:var(--muted)}
    .quick-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 12px 14px}
    .menu-action{display:flex;gap:9px;align-items:center;justify-content:center;border:0;border-radius:10px;padding:12px 8px;background:var(--soft);font-size:13px;font-weight:600}.menu-action:hover{background:var(--soft2)}
    .download-settings{border-block:1px solid var(--bd);padding:9px 12px 14px}.section-label{display:flex;align-items:center;justify-content:space-between;margin:0 4px 5px;color:var(--muted);font-size:12px}
    .download-toggles{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.chip{position:relative;cursor:pointer}.chip input{position:absolute;opacity:0;width:1px;height:1px}.chip span{display:flex;flex-direction:column;align-items:center;gap:7px;padding:10px 4px;border:1px solid var(--bd);border-radius:10px;color:var(--muted);font-size:12px}.chip input:checked+span{background:var(--soft);color:var(--fg);border-color:var(--fg)}.chip input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
    .list{padding:6px 16px 10px}.setting{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;cursor:pointer}.setting strong{font-size:13px;font-weight:400}.setting small{color:var(--muted);font-size:11px}
    .switch{position:relative;width:32px;height:20px;flex:none}.switch input{position:absolute;opacity:0;width:1px;height:1px}.slider{position:absolute;inset:0;border-radius:20px;background:var(--bd);transition:background .16s}.slider:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .16s}.switch input:checked+.slider{background:var(--strong)}.switch input:checked+.slider:before{transform:translateX(12px);background:var(--inverse)}.switch input:focus-visible+.slider{outline:2px solid var(--accent);outline-offset:3px}
    .igp-icon-btn{width:44px;height:44px;display:inline-grid;place-items:center;border:0;border-radius:50%;background:transparent;color:var(--fg);flex:none}.igp-icon-btn:hover{background:var(--soft2)}.igp-icon-btn[aria-pressed="true"]{color:var(--accent)}
    .igp-modal-backdrop{position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;border:0;z-index:2147483647;display:grid;place-items:center;padding:20px;pointer-events:auto;background:#0009;animation:igpFade .14s ease}
    .igp-modal-backdrop::backdrop{background:transparent}
    .igp-modal{width:min(420px,100%);max-height:calc(100dvh - 40px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--bd);border-radius:20px;background:var(--bg);color:var(--fg);box-shadow:var(--shadow);animation:igpPop .18s ease}
    .igp-modal-head{flex:none;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;min-height:64px;padding:8px 12px;border-bottom:1px solid var(--bd)}.igp-modal-title{text-align:center;font-size:16px;font-weight:600}.igp-modal-body{min-height:0;overflow:auto;overscroll-behavior:contain}
    .igp-note{padding:14px 16px;color:var(--muted);font-size:12px;line-height:1.5}.igp-note:empty{display:none}.igp-actions{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 16px}.igp-actions button{min-height:44px;border:0;border-radius:12px;padding:12px 14px;background:var(--soft);font-size:13px}.igp-actions button:hover{background:var(--soft2)}
    .igp-downloads{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.igp-downloads button{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;min-height:46px}.igp-downloads button:only-child,.igp-downloads .igp-save-all{grid-column:1/-1}.igp-downloads .igp-save-all{background:var(--strong);color:var(--inverse);font-weight:600}.igp-downloads img{display:block;width:100%;height:160px;object-fit:cover;border-radius:5px}.igp-downloads button[data-saved]{color:var(--muted)}
    .igp-history-tools{display:flex;align-items:center;gap:3px;padding:6px 12px}.igp-history-tools time{flex:1;color:var(--muted);font-size:11px}.igp-help{margin:0 16px 14px;color:var(--muted);font-size:12px}.igp-help summary{cursor:pointer}.igp-help p{line-height:1.5}
    .igp-event{display:block;padding:13px 16px;border-top:1px solid var(--bd);color:var(--fg);text-decoration:none;font-size:13px}.igp-event time{display:block;margin-top:4px;color:var(--muted);font-size:11px}
    .igp-search-wrap{flex:none;padding:12px 16px}.igp-search{width:100%;height:44px;border:0;border-radius:12px;background:var(--soft2);color:var(--fg);padding:0 12px;font-size:14px}.igp-search::placeholder{color:var(--muted)}
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
    // The published 1.9 engine remains responsible for proven features. The
    // v2.2 shell owns the launcher and settings interface.
    root.innerHTML = `<style>${GLOBAL_CSS}</style><div id="igp-toasts" aria-live="polite"></div>`;
    document.documentElement.appendChild(host);
    state.rootHost = host; state.root = root;
    for (const type of ['click','pointerdown','pointerup','dblclick']) root.addEventListener(type,event=>event.stopPropagation());
    syncTheme();
  }

  function renderPanel() {
    // Kept as a compatibility hook for the unchanged 1.9 feature callbacks.
  }


  function cleanupDisabledFeatures() {
    if (!state.settings.bioFonts) {
      document.querySelectorAll('[data-igp-bio-toolbar-host]').forEach(el => el.remove());
    }
    if (!state.settings.viewerSearch) clearStorySession();
    clearMediaButtons();
    state.mediaController?.abort();
    removeModal('igp-media-modal');
    removeModal('igp-viewer-modal');
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
      const focusable = [...backdrop.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')].filter(isVisible);
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
  function runFollowerCompare() { PAGE.__IGP_NATIVE_SOCIAL__?.openComparison?.(); }

  // Relationship snapshots and notifications.

  const RELATIONSHIP_INTERVAL = 6 * 60 * 60 * 1000;
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
        const error = new Error(response.status === 429 ? 'Instagram asked us to slow down. Optional checks are paused for six hours.' : `Instagram could not complete the check (HTTP ${response.status}).`);
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

  function checkRelationships(force = false) { return force ? PAGE.__IGP_NATIVE_SOCIAL__?.check?.() : Promise.resolve(); }
  function relationshipTick() {
    const accountId = loggedInAccountID();
    if (accountId !== state.relationshipAccount) {
      state.relationshipAccount = accountId;
      state.compareController?.abort(); state.mediaController?.abort();
      removeModal('igp-media-modal'); removeModal('igp-viewer-modal');
      scheduleScan();
    }
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
      <details class="igp-help"><summary>How it works</summary><p>Complete lists loaded through Instagram are compared locally. The first check saves a baseline. Missing accounts need two complete checks. A disappearance can also mean account removal, deactivation or blocking; Instagram does not tell us why.</p></details>
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
      let match = url.pathname.match(/^\/(?:[A-Za-z0-9_.]{1,30}\/)?(p|reel|reels)\/([A-Za-z0-9_-]{1,128})\/?$/);
      if (match) {
        const id = shortcodeToID(match[2]);
        return { kind: match[1] === 'p' ? 'post' : 'reel', id, code: match[2], key: `media:${id || match[2]}` };
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
    if (reference.id || reference.code) {
      const matches = records.filter(record => record.media.pk === reference.id || reference.code &&
        (record.media.code === reference.code || !reference.id && record.media.code.length >= 11 && reference.code.startsWith(record.media.code)));
      const record = matches.length === 1 ? matches[0] : null;
      return record ? { items: mediaItems({ items: [record.media] },{...reference,id:record.media.pk}), fallback: false } : null;
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
        const candidates = [...document.querySelectorAll('article')].map(scope => ({ scope, reference: articleReference(scope) })).filter(target => target.reference && visibleIntersection(target.scope) > 0);
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
      scope = current.kind === 'story' ? mediaSurface(target) : [...document.querySelectorAll('[role="dialog"]')].find(isVisible) || document.querySelector('main,[role="main"]');
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
    const scope = target.scope || mediaSurface(target);
    const carousel = !!scope?.querySelector('[aria-label*="next" i],[aria-label*="slide" i],button[title*="next" i]');
    if (fallback && !carousel && !state.failedMediaURLs.has(fallback.url) && (fallback.kind === 'image' || !fallback.url.startsWith('blob:'))) {
      return {items:[fallback],fallback:true};
    }
    if (!target.reference.id && !target.reference.code && target.reference.kind !== 'story') {
      if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (fallback && (fallback.kind === 'image' || !fallback.url.startsWith('blob:'))) return { items: [fallback], fallback: true };
      throw new Error('Open this reel directly or wait for its video to load, then try again.');
    }
    try {
      const fromPage = matchMediaRecords(await fetchMediaPage(target.reference,accountId,signal),target.reference,fallback);
      if (fromPage) return fromPage;
    } catch (error) {
      if (signal.aborted || accountId !== loggedInAccountID()) throw new DOMException('Download cancelled','AbortError');
      if (error.rateLimited) throw new Error('Instagram needs a break. Try again later.');
    }
    try {
      if (target.reference.id) {
        const data = await instagramJSON(`/api/v1/media/${target.reference.id}/info/`, accountId, signal);
        return { items: mediaItems(data, target.reference), fallback: false };
      }
    } catch (error) {
      if (signal.aborted || accountId !== loggedInAccountID()) throw new DOMException('Download cancelled', 'AbortError');
      if (error.rateLimited) throw new Error('Instagram needs a break. Try again later.');
    }
    if (fallback && !state.failedMediaURLs.has(fallback.url) && (fallback.kind === 'image' || !fallback.url.startsWith('blob:'))) return { items: [fallback], fallback: true };
    throw new Error('Could not find the file. Open the post and try again.');
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
            if (response.status < 200 || response.status >= 300) { if ([403,404].includes(response.status)) rememberFailedMediaURL(url); finish(new Error('This download link expired. Try again.')); return; }
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
        throw new Error('This download link expired. Try again.');
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

  async function openMediaDownload(target, { allStories = false } = {}) {
    if (!mediaEnabled(target?.reference)) return;
    const jobKey = allStories ? `stories:${normalizeUsername(target.reference.username)}` : target.reference.key;
    if (state.mediaJobKey === jobKey && state.mediaController && !state.mediaController.signal.aborted) return;
    state.mediaController?.abort();
    removeModal('igp-media-modal');
    const controller = new AbortController();
    const accountId = loggedInAccountID();
    state.mediaController = controller;
    state.mediaJobKey = jobKey;
    state.panelOpen = false; renderPanel();
    const modal = createModalShell('igp-media-modal', allStories ? 'Download stories' : `Download ${target.reference.kind}`, { onClose: () => {
      controller.abort();
      if (state.mediaController === controller) { state.mediaController = null; state.mediaJobKey = null; }
    } });
    modal.body.innerHTML = '<div class="igp-progress" role="status"><div class="igp-spinner"></div>Loading…</div>';
    try {
      const resolved = allStories ? await resolveAllStories(target,accountId,controller.signal) : await resolveMedia(target,controller.signal);
      if (controller.signal.aborted || !modal.backdrop.isConnected) return;
      const { items } = resolved;
      const note = document.createElement('div');
      note.className = 'igp-note'; note.setAttribute('role','status');
      note.textContent = resolved.storyChoices ? `Choose a story` : resolved.fallback ? 'Current photo or video' : `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
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
            if (controller.signal.aborted) throw new DOMException('Cancelled','AbortError');
            note.textContent = `Saving ${item.index}/${items.length}…`;
            await saveMediaItem(target.reference,item,accountId,controller.signal);
            saved.add(item.index); completed++;
            if (selection.length > 1) await sleep(350);
          }
          note.textContent = `${completed} ${completed === 1 ? 'file' : 'files'} sent to Downloads`;
          note.title = 'If prompted, allow multiple downloads in your browser.';
          if (items.length === 1 && !allStories) { modal.close(); showToast('Sent to Downloads'); return; }
          for (const button of buttons) if (saved.has(Number(button.dataset.index))) {
            button.dataset.saved = 'true';
            button.querySelector('svg')?.remove(); button.insertAdjacentHTML('afterbegin',icon('check',18));
            button.querySelector('span').textContent = 'Saved';
          }
        } catch (error) {
          if (!controller.signal.aborted) note.textContent = `${completed ? `${completed} saved. ` : ''}${error.name === 'AbortError' ? 'Download timed out. Try again.' : error.message}`;
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
      if (allStories || items.length === 1) await download(items);
    } catch (error) {
      if (!controller.signal.aborted) modal.body.innerHTML = `<div class="igp-note" role="alert">${escapeHTML(error.message || 'Could not load this media. Try again.')}</div>`;
    }
  }

  async function resolveAllStories(target, accountId, signal) {
    const reference = target.reference;
    if (reference.kind !== 'story' || !reference.username) throw new Error('Open someone’s stories first.');
    // A fresh owner page is required: the current player cache may contain just
    // one story, and a numeric route identifies only the currently selected one.
    const records = await fetchMediaPage(reference,accountId,signal);
    const result = matchMediaRecords(records,{...reference,id:null},null);
    if (!result?.items.length) throw new Error('Instagram did not return this account’s stories. Reload their stories and retry.');
    return result;
  }

  const PLAYBACK_KEY = `${APP}:playback:v1`;
  function playbackPreferences() {
    const stored = loadJSON(PLAYBACK_KEY,null) || {};
    return {
      speed: typeof stored.speed === 'number' && Number.isFinite(stored.speed) ? clamp(stored.speed,0.25,3) : 1,
      volume: typeof stored.volume === 'number' && Number.isFinite(stored.volume) ? clamp(stored.volume,0,1) : null,
    };
  }

  function applyPlaybackPreferences(video) {
    const source = video.currentSrc || video.src;
    if (state.videoPreferencesApplied.get(video) === source) return;
    state.videoPreferencesApplied.set(video,source);
    const prefs = playbackPreferences();
    video.playbackRate = prefs.speed;
    // Keep Instagram's mute state. Remembering volume must not unexpectedly
    // unmute the next reel or start autoplay with sound.
    if (prefs.volume !== null) video.volume = prefs.volume;
  }

  function mediaSurface(target) {
    if (target.scope?.isConnected) return target.scope;
    if (target.reference.kind === 'story') {
      let parent = storyControlScope();
      for (let depth=0; parent && depth<9; depth++,parent=parent.parentElement) {
        if ([...parent.querySelectorAll('video,img')].some(el=>visibleMediaArea(el))) return parent;
      }
      return null;
    }
    return [...document.querySelectorAll('[role="dialog"],main,[role="main"]')].find(inMediaViewport) || null;
  }

  function targetVideo(target) {
    if (target.video?.isConnected && visibleMediaArea(target.video)) return target.video;
    const videos = [...(mediaSurface(target)?.querySelectorAll('video') || [])].filter(video => {
      const article = video.closest('article');
      return visibleMediaArea(video) && (!article || articleReference(article)?.key === target.reference.key);
    });
    return videos.length === 1 ? videos[0] : null;
  }

  const PLAYER_CSS = `
    .igp-player{box-sizing:border-box;display:grid;gap:8px;padding:12px;border:1px solid var(--bd);border-radius:16px;background:var(--bg);color:var(--fg);font:12px/1.4 ${UI_FONT};width:308px;max-width:calc(100vw - 32px)}
    .igp-player *{box-sizing:border-box}.igp-player .line{display:flex;align-items:center;gap:6px;min-width:0}.igp-player input[type=range]{min-width:0;width:100%;accent-color:#0095f6;cursor:pointer;height:32px;margin:0}.igp-player .time{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11px}
    .igp-player button{border:0;background:transparent;color:inherit;display:grid;place-items:center;width:36px;height:36px;padding:4px;border-radius:9px;flex:0 0 auto;cursor:pointer}.igp-player button:hover{background:var(--soft2)}.igp-player button:disabled{opacity:.35;cursor:default}.igp-player select{color:inherit;background:var(--soft);border:1px solid var(--bd);border-radius:9px;padding:5px;font:inherit;width:68px;min-height:36px}.igp-player [role=status]:empty{display:none}.igp-player [role=status]{font-size:11px}
  `;

  function makeVideoControls(video) {
    const element = document.createElement('div'); element.className='igp-player';
    element.setAttribute('role','group'); element.setAttribute('aria-label','Video controls');
    const button=(action,label,name)=>`<button type="button" data-action="${action}" aria-label="${label}" title="${label}" ${action==='step'?'style="width:auto;padding-inline:8px"':''}>${action === 'back' ? '−5' : action === 'forward' ? '+5' : action === 'step' ? 'Frame' : icon(name,18)}</button>`;
    element.innerHTML=`<input type="range" min="0" max="1" step="0.01" value="0" aria-label="Seek video" disabled>
      <div class="line">${button('play','Play','play')}${button('back','Back 5 seconds','previous')}${button('forward','Forward 5 seconds','next')}<select aria-label="Playback speed">${[0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3].map(n=>`<option value="${n}">${n}×</option>`).join('')}</select><span class="time"></span></div>
      <div class="line">${button('mute','Unmute','volume')}<input type="range" min="0" max="1" step="0.01" aria-label="Volume">${button('step','Next frame','next')}${button('pip','Picture in picture','pip')}</div><span role="status"></span>`;
    const lifetime=new AbortController(), opts={signal:lifetime.signal};
    const seek=element.querySelector('[aria-label="Seek video"]'), volume=element.querySelector('[aria-label="Volume"]'), speed=element.querySelector('select');
    const play=element.querySelector('[data-action="play"]'), mute=element.querySelector('[data-action="mute"]'), pip=element.querySelector('[data-action="pip"]');
    const status=element.querySelector('[role="status"]');
    const time=n=>Number.isFinite(n)?`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`:'0:00';
    const remember=()=>saveJSON(PLAYBACK_KEY,{speed:video.playbackRate,volume:video.volume});
    const update=()=>{
      applyPlaybackPreferences(video);
      const finite=Number.isFinite(video.duration)&&video.duration>0;
      seek.disabled=!finite;seek.max=finite?video.duration:1;seek.value=finite?video.currentTime:0;
      element.querySelector('.time').textContent=`${time(video.currentTime)} / ${finite?time(video.duration):'—'}`;
      if (play.dataset.paused!==String(video.paused)) { play.dataset.paused=String(video.paused);play.innerHTML=icon(video.paused?'play':'pause',18);play.setAttribute('aria-label',video.paused?'Play':'Pause');play.title=play.getAttribute('aria-label'); }
      mute.setAttribute('aria-label',video.muted?'Unmute':'Mute');mute.title=video.muted?'Unmute':'Mute';mute.style.opacity=video.muted?'.5':'1';
      volume.value=video.volume;speed.value=String(video.playbackRate);
      element.querySelector('[data-action="step"]').disabled=!video.paused||!finite;
      for(const action of ['back','forward']) element.querySelector(`[data-action="${action}"]`).disabled=!finite;
      pip.hidden=!(document.pictureInPictureEnabled&&typeof video.requestPictureInPicture==='function');
      pip.disabled=video.readyState<1||video.disablePictureInPicture;
    };
    const seekTo=time=>{if(Number.isFinite(video.duration)&&video.duration>0)video.currentTime=clamp(time,0,video.duration);update();};
    seek.addEventListener('input',()=>seekTo(Number(seek.value)),opts);
    volume.addEventListener('input',()=>{video.volume=Number(volume.value);video.muted=video.volume===0;remember();update();},opts);
    speed.addEventListener('change',()=>{video.playbackRate=Number(speed.value);remember();update();},opts);
    element.addEventListener('click',async event=>{
      const action=event.target.closest('button')?.dataset.action;if(!action)return;
      event.stopPropagation();status.textContent='';
      try {
        if(action==='play'){if(video.paused)await video.play();else video.pause();}
        if(action==='back')seekTo(video.currentTime-5);
        if(action==='forward')seekTo(video.currentTime+5);
        if(action==='step'&&video.paused)seekTo(video.currentTime+1/30);
        if(action==='mute'){video.muted=!video.muted;update();}
        if(action==='pip'){if(document.pictureInPictureElement===video)await document.exitPictureInPicture();else await video.requestPictureInPicture();}
      }catch{status.textContent=action==='pip'?'Picture in picture is unavailable.':'This video is not ready. Try again.';}
      update();
    },opts);
    for(const type of ['timeupdate','durationchange','loadedmetadata','play','pause','volumechange','ratechange','emptied','enterpictureinpicture','leavepictureinpicture']) video.addEventListener(type,update,opts);
    applyPlaybackPreferences(video);update();
    return {element,dispose:()=>lifetime.abort()};
  }

  function viewerGeometry(width,height,boxWidth,boxHeight,rotation,zoom,x,y) {
    const rotated=Math.abs(rotation%180)===90, w=rotated?height:width,h=rotated?width:height;
    const fit=Math.min(boxWidth/Math.max(w,1),boxHeight/Math.max(h,1),1);
    const scale=fit*clamp(zoom,1,8),limitX=Math.max(0,(w*scale-boxWidth)/2),limitY=Math.max(0,(h*scale-boxHeight)/2);
    return {scale,x:clamp(x,-limitX,limitX),y:clamp(y,-limitY,limitY)};
  }

  async function openMediaViewer(target) {
    if (!target?.reference || !state.settings.mediaViewer) return;
    removeModal('igp-viewer-modal');
    const controller=new AbortController(),account=loggedInAccountID();state.viewerController=controller;
    let itemCleanup=()=>{}, resizeObserver;
    const sourceVideo=targetVideo(target);const resume=sourceVideo&&!sourceVideo.paused;const source=sourceVideo?.currentSrc;const path=location.pathname;
    if(resume)sourceVideo.pause();
    const modal=createModalShell('igp-viewer-modal','Media',{onClose:()=>{
      controller.abort();itemCleanup();resizeObserver?.disconnect();if(state.viewerController===controller)state.viewerController=null;
      if(resume&&sourceVideo.isConnected&&sourceVideo.currentSrc===source&&location.pathname===path&&loggedInAccountID()===account&&inMediaViewport(sourceVideo))void sourceVideo.play().catch(()=>{});
    }});
    state.panelOpen=false;renderPanel();
    const style=document.createElement('style');style.textContent=`${PLAYER_CSS}
      #igp-viewer-modal .igp-modal{width:min(1100px,calc(100vw - 24px));height:calc(100dvh - 40px);max-height:900px;display:flex;flex-direction:column}#igp-viewer-modal .igp-modal-body{padding:0;display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden}
      .igp-stage{position:relative;overflow:hidden;background:#101010;flex:1;min-height:120px;touch-action:none;outline-offset:-3px!important}.igp-stage img{position:absolute;left:50%;top:50%;max-width:none;max-height:none;user-select:none;pointer-events:none;transform-origin:center;will-change:transform}.igp-stage video{width:100%;height:100%;object-fit:contain}.igp-stage[data-zoomed=true]{cursor:grab}.igp-stage:active{cursor:grabbing}
      .igp-viewer-tools{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px;flex-wrap:wrap;border-top:1px solid var(--bd)}.igp-viewer-tools button{display:grid;place-items:center;border:0;border-radius:10px;background:transparent;padding:10px;min-width:44px;height:44px;color:inherit}.igp-viewer-tools button:hover{background:var(--soft)}.igp-viewer-count{font-size:12px;font-variant-numeric:tabular-nums;min-width:40px;text-align:center}#igp-viewer-modal .igp-player{width:100%;max-width:none;border:0;border-radius:0;padding:8px 14px}#igp-viewer-modal [hidden]{display:none!important}
      @media(max-width:480px){#igp-viewer-modal{padding:8px}#igp-viewer-modal .igp-modal{width:100%;height:calc(100dvh - 16px)}}`;
    modal.backdrop.appendChild(style);
    modal.body.innerHTML='<div class="igp-progress" role="status"><div class="igp-spinner"></div>Loading…</div>';
    try {
      const resolved=await resolveMedia(target,controller.signal);
      if(controller.signal.aborted||account!==loggedInAccountID())return;
      const items=resolved.items;
      modal.body.innerHTML='<div class="igp-stage" tabindex="0" aria-label="Media viewer. Scroll to zoom, drag to pan; plus, minus and zero to zoom or fit."></div><div class="igp-viewer-tools"></div><div class="igp-viewer-player"></div>';
      const stage=modal.body.querySelector('.igp-stage'),toolbar=modal.body.querySelector('.igp-viewer-tools'),playerSlot=modal.body.querySelector('.igp-viewer-player');
      const add=(label,name,run)=>{const button=document.createElement('button');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.innerHTML=icon(name,20);button.onclick=run;toolbar.appendChild(button);return button;};
      let index=0,zoom=1,x=0,y=0,rotation=0,media;
      const draw=()=>{
        if(!media||items[index].kind!=='image')return;
        const w=media.naturalWidth||items[index].width||stage.clientWidth,h=media.naturalHeight||items[index].height||stage.clientHeight;
        const geometry=viewerGeometry(w,h,stage.clientWidth,stage.clientHeight,rotation,zoom,x,y);x=geometry.x;y=geometry.y;
        media.style.width=`${w}px`;media.style.height=`${h}px`;media.style.transform=`translate(-50%,-50%) translate(${x}px,${y}px) rotate(${rotation}deg) scale(${geometry.scale})`;
        stage.dataset.zoomed=String(zoom>1);fit.textContent=zoom===1?'Fit':`${Math.round(zoom*100)}%`;
      };
      const zoomTo=(value,px=0,py=0)=>{const next=clamp(value,1,8),ratio=next/zoom;x=px-(px-x)*ratio;y=py-(py-y)*ratio;zoom=next;draw();};
      const previous=add('Previous item','previous',()=>show(index-1));
      const count=document.createElement('span');count.className='igp-viewer-count';count.setAttribute('aria-live','polite');toolbar.appendChild(count);
      const next=add('Next item','next',()=>show(index+1));
      const minus=add('Zoom out','minus',()=>zoomTo(zoom/1.5));
      const fit=add('Fit media','expand',()=>{zoom=1;x=y=0;draw();});
      const plus=add('Zoom in','zoom',()=>zoomTo(zoom*1.5));
      const rotate=add('Rotate','refresh',()=>{rotation=(rotation+90)%360;x=y=0;draw();});
      const save=add('Download this item','download',async()=>{
        save.disabled=true;
        try{await saveMediaItem(target.reference,items[index],account,controller.signal);showToast('Sent to Downloads');}
        catch(error){if(!controller.signal.aborted)showToast(error.message);}
        finally{save.disabled=!mediaEnabled(target.reference);}
      });
      const show=position=>{
        if(position<0||position>=items.length)return;
        itemCleanup();pointers.clear();gesture=null;index=position;zoom=1;x=y=rotation=0;
        const item=items[index],image=item.kind==='image';media=document.createElement(image?'img':'video');stage.replaceChildren(media);playerSlot.replaceChildren();
        previous.disabled=index===0;next.disabled=index===items.length-1;previous.hidden=next.hidden=items.length===1;count.textContent=`${index+1} / ${items.length}`;
        for(const button of [minus,fit,plus,rotate])button.hidden=!image;
        save.disabled=!mediaEnabled(target.reference);
        const mediaElement=media;
        if(image){media.alt=`Media ${index+1}`;media.draggable=false;media.onload=draw;itemCleanup=()=>{mediaElement.onload=null;};}
        else{media.playsInline=true;media.preload='metadata';media.controls=!state.settings.videoControls;media.loop=true;media.muted=sourceVideo?.muted??true;
          const controls=state.settings.videoControls?makeVideoControls(media):null;if(controls)playerSlot.appendChild(controls.element);
          itemCleanup=()=>{controls?.dispose();mediaElement.pause();mediaElement.removeAttribute('src');mediaElement.load();};
        }
        media.onerror=()=>{if(media===mediaElement&&!controller.signal.aborted)showToast('This media could not load. Try reopening it.');};
        media.src=item.url;draw();
      };
      const pointers=new Map();let gesture=null;
      const snapshot=()=>{const values=[...pointers.values()];if(!values.length){gesture=null;return;}const center=values.length>1?{x:(values[0].x+values[1].x)/2,y:(values[0].y+values[1].y)/2}:values[0];gesture={center,x,y,zoom,distance:values.length>1?Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y):0};};
      const opts={signal:controller.signal};
      stage.addEventListener('pointerdown',event=>{if(items[index].kind!=='image'||event.button!==0)return;event.preventDefault();stage.focus();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});try{stage.setPointerCapture(event.pointerId);}catch{}snapshot();},opts);
      stage.addEventListener('pointermove',event=>{if(!pointers.has(event.pointerId)||!gesture)return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});const values=[...pointers.values()];
        const center=values.length>1?{x:(values[0].x+values[1].x)/2,y:(values[0].y+values[1].y)/2}:values[0];
        zoom=gesture.distance?clamp(gesture.zoom*Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y)/gesture.distance,1,8):gesture.zoom;
        const rect=stage.getBoundingClientRect(),px=gesture.center.x-rect.left-rect.width/2,py=gesture.center.y-rect.top-rect.height/2,ratio=zoom/gesture.zoom;
        x=px-(px-gesture.x)*ratio+center.x-gesture.center.x;y=py-(py-gesture.y)*ratio+center.y-gesture.center.y;draw();
      },opts);
      for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,event=>{pointers.delete(event.pointerId);snapshot();},opts);
      stage.addEventListener('wheel',event=>{if(items[index].kind!=='image')return;event.preventDefault();const r=stage.getBoundingClientRect();zoomTo(zoom*Math.exp(-clamp(event.deltaY,-100,100)*.004),event.clientX-r.left-r.width/2,event.clientY-r.top-r.height/2);},{...opts,passive:false});
      stage.addEventListener('dblclick',()=>zoomTo(zoom>1?1:2),opts);
      modal.backdrop.addEventListener('keydown',event=>{if(event.target.matches('input,select'))return;const key=event.key;
        if(key==='ArrowLeft')show(index-1);else if(key==='ArrowRight')show(index+1);else if(items[index].kind==='image'&&['+','=','-','0','r','R'].includes(key)){if(key==='-')zoomTo(zoom/1.5);else if(key==='0')fit.click();else if(key.toLowerCase()==='r')rotate.click();else zoomTo(zoom*1.5);}else return;event.preventDefault();event.stopPropagation();
      },opts);
      resizeObserver=new ResizeObserver(draw);resizeObserver.observe(stage);show(0);stage.focus();
    }catch(error){if(!controller.signal.aborted)modal.body.innerHTML=`<div class="igp-note" role="alert">${escapeHTML(error.message)}</div>`;}
  }

  function clearMediaButtons() {
    for (const host of state.mediaBindings.values()) { host.igpDispose?.(); host.remove(); }
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
      if (selected && (mediaEnabled(selected) || state.settings.mediaViewer || state.settings.videoControls) && (!routeReference || reference?.key === routeReference.key) && inMediaViewport(article)) targets.set(article,{ reference:selected, scope:article });
    }
    if (direct && (mediaEnabled(direct.reference) || state.settings.mediaViewer || state.settings.videoControls) && !targets.has(direct.scope)) {
      const scope = direct.reference.kind === 'story' ? storyControlScope() : direct.scope || [...document.querySelectorAll('[role="dialog"],main')].find(el => inMediaViewport(el) && el.querySelector('video,img,svg[aria-label]')) || document.querySelector('main');
      if (scope && !scope.closest('[data-igp-media-host]')) targets.set(scope,direct);
    }
    for (const [scope,host] of state.mediaBindings) {
      if (!targets.has(scope) || !host.isConnected) { host.igpDispose?.();host.remove(); state.mediaBindings.delete(scope); }
    }
    for (const [scope,target] of targets) {
      const kind = target.reference.kind, slot = mediaActionSlot(scope,kind);
      if (!slot) continue;
      let host = state.mediaBindings.get(scope);
      if (!host) {
        host = document.createElement('span'); host.setAttribute('data-igp-media-host','');
        host.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;vertical-align:middle;pointer-events:auto;';
        const shadow = host.attachShadow({mode:'open'});
        shadow.innerHTML = `<style>${THEME_CSS}${PLAYER_CSS}:host{color:inherit;position:relative}.tools{display:flex;align-items:center}:host([data-rail="true"]) .tools{flex-direction:column}.tools>button{display:grid;place-items:center;width:32px;height:36px;padding:5px;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer;touch-action:manipulation}.tools>button:hover{opacity:.6}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #0095f6;outline-offset:2px}svg{display:block;pointer-events:none}:host([data-kind="story"]) .tools>button{width:28px;height:30px;padding:5px}:host([data-kind="story"]) svg{width:19px;height:19px}.popover{position:absolute;z-index:10;right:0;bottom:calc(100% + 8px);box-shadow:var(--shadow);border-radius:10px}:host([data-kind="story"]) .popover{bottom:auto;top:calc(100% + 8px)}[hidden]{display:none!important}</style><span class="tools"><button type="button" data-tool="download">${icon('download')}</button><button type="button" data-tool="stories" title="Download all stories" aria-label="Download all stories">${icon('downloadAll')}</button><button type="button" data-tool="viewer" title="Open media viewer" aria-label="Open media viewer">${icon('expand')}</button><button type="button" data-tool="video" title="Video controls" aria-label="Video controls" aria-expanded="false">${icon('controls')}</button></span><div class="popover" hidden></div>`;
        const freshTarget=()=>{
          const article = scope.matches('article') ? articleReference(scope) : null, route = parseMediaReference(location.href);
          return scope.matches('article') ? {reference:route?.key === article?.key ? route : article,scope} : currentMediaTarget();
        };
        let videoUI=null;const popover=shadow.querySelector('.popover'),videoButton=shadow.querySelector('[data-tool="video"]');
        const closeVideo=()=>{videoUI?.dispose();videoUI=null;if(typeof popover.hidePopover==='function'&&popover.matches(':popover-open'))popover.hidePopover();popover.replaceChildren();popover.hidden=true;videoButton.setAttribute('aria-expanded','false');};
        const outside=event=>{if(videoUI&&!event.composedPath().includes(host))closeVideo();};
        document.addEventListener('pointerdown',outside,true);
        const reposition=()=>{if(videoUI)closeVideo();};
        document.addEventListener('scroll',reposition,true);window.addEventListener('resize',reposition);
        host.igpDispose=()=>{closeVideo();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',reposition,true);window.removeEventListener('resize',reposition);};
        host.igpCloseVideo=closeVideo;
        shadow.addEventListener('click', event => {
          event.stopPropagation();
          const tool=event.target.closest('[data-tool]')?.dataset.tool;if(!tool)return;
          event.preventDefault();
          const fresh=freshTarget();if(!fresh?.reference)return;
          if(tool==='download')void openMediaDownload(fresh);
          if(tool==='stories')void openMediaDownload(fresh,{allStories:true});
          if(tool==='viewer')void openMediaViewer(fresh);
          if(tool==='video'){
            if(videoUI){closeVideo();return;}
            const video=targetVideo(fresh);if(!video){showToast('Open the video first.');return;}
            videoUI=makeVideoControls(video);popover.replaceChildren(videoUI.element);popover.hidden=false;videoButton.setAttribute('aria-expanded','true');
            if(typeof popover.showPopover==='function'){
              popover.setAttribute('popover','manual');popover.style.cssText='position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;color:var(--fg)';popover.showPopover();
              const anchor=videoButton.getBoundingClientRect(),r=popover.getBoundingClientRect(),vp=viewport();
              popover.style.left=`${clamp(anchor.right-r.width,vp.left+8,Math.max(vp.left+8,vp.left+vp.width-r.width-8))}px`;
              popover.style.top=`${clamp(kind==='story'?anchor.bottom+8:anchor.top-r.height-8,vp.top+8,Math.max(vp.top+8,vp.top+vp.height-r.height-8))}px`;
            }
          }
        });
        shadow.addEventListener('keydown',event=>{if(event.key==='Escape'&&!popover.hidden){event.preventDefault();closeVideo();videoButton.focus();}});
        // Keep Instagram's delegated media/player handlers away from our control.
        for (const type of ['pointerdown','pointerup','dblclick','keydown','keyup']) host.addEventListener(type,event=>event.stopPropagation());
        state.mediaBindings.set(scope,host);
      }
      if (host.dataset.kind !== kind) host.dataset.kind = kind;
      const rail=String(getComputedStyle(slot.parent).flexDirection==='column');if(host.dataset.rail!==rail)host.dataset.rail=rail;
      const theme=state.rootHost?.dataset.theme||'light';if(host.dataset.theme!==theme)host.dataset.theme=theme;
      const placement = slot.native ? 'native' : 'inline';
      if (host.dataset.placement !== placement) host.dataset.placement = placement;
      const button = host.shadowRoot.querySelector('button'), label = `Download ${kind}`;
      if (button.getAttribute('aria-label') !== label) { button.setAttribute('aria-label',label); button.title = label; }
      const visibleVideo=targetVideo(target);
      if(host.igpVideo!==visibleVideo){host.igpCloseVideo?.();host.igpVideo=visibleVideo;}
      if(visibleVideo&&state.settings.videoControls)applyPlaybackPreferences(visibleVideo);
      const visibility={download:mediaEnabled(target.reference),stories:kind==='story'&&state.settings.storyDownloads,viewer:state.settings.mediaViewer,video:state.settings.videoControls&&!!visibleVideo};
      for(const [tool,visible] of Object.entries(visibility)){const element=host.shadowRoot.querySelector(`[data-tool="${tool}"]`);if(element.hidden===!!visible)element.hidden=!visible;}
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
    if (!previous.includes('/stories/') || !next.includes('/stories/')) removeModal('igp-viewer-modal');

    const oldStory = previous.includes('/stories/');
    const newStory = next.includes('/stories/');
    if (oldStory && (!newStory || storyRouteKey() !== state.storySession?.routeKey)) clearStorySession();
  }

  function scan() {
    if (document.hidden) return;
    ensureRoot();
    syncTheme();
    handleURLChange();
    enhanceMediaDownloads();
    enhanceBioFonts();
    enhanceStoryViewerSearch();
    PAGE.__IGP_SHELL_RECONCILE__?.();
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
      if (records.some(record => !record.target.closest?.('[data-igp-media-host],[data-igp-bio-toolbar-host],[data-igp-host],#igp-web-root,#igp-v2-root'))) scheduleScan(150);
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
      removeModal('igp-viewer-modal');
      clearMediaButtons();
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

      }
    }, true);

    addEventListener('resize', () => scheduleScan(100));
    scheduleScan(0);
  }

  const legacyAPI = Object.freeze({
    version: VERSION,
    extractPerson, collectPeopleBatch, findBestScroller, relationshipDiff,
    getSettings: () => ({ ...state.settings }),
    setSetting(key, value) {
      if (!Object.hasOwn(DEFAULTS, key) || typeof DEFAULTS[key] !== typeof value) return false;
      if (state.settings[key] === value) return true;
      state.settings[key] = value;
      saveSettings();
      cleanupDisabledFeatures();
      if (key === 'relationshipNotifier') {
        if (!value) state.relationshipController?.abort();
        state.relationshipNextCheck = 0;
      }
      scheduleScan(0);
      return true;
    },
    openFollowerComparison: () => runFollowerCompare(),
    openFriendActivity: () => openRelationshipHistory(),
    checkFriendActivity: () => checkRelationships(true),
    readFriendActivity: () => {
      const account = loggedInAccountID();
      return account ? readRelationships(account) : null;
    },
    clearFriendActivity() {
      const account = loggedInAccountID(), record = account ? readRelationships(account) : null;
      if (!record) return false;
      writeRelationships(account, { ...record, history: [] });
      return true;
    },
    friendActivityText: relationshipEventText,
    friendActivityStatus: () => state.relationshipStatus,
    downloadCurrent() {
      const target = currentMediaTarget();
      if (target && mediaEnabled(target.reference)) return openMediaDownload(target);
      showToast('Open a story, post or reel with downloads enabled.');
      return null;
    },
    rescan: () => scheduleScan(0),
  });
  try { Object.defineProperty(PAGE, '__IGP_LEGACY_ENGINE__', { value: legacyAPI, configurable: false }); }
  catch { PAGE.__IGP_LEGACY_ENGINE__ = legacyAPI; }

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

// Instagram Plus Control Center and native social tools.
(() => {
  'use strict';
  const PAGE = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const pageFunction = fn => typeof exportFunction === 'function' ? exportFunction(fn, PAGE) : fn;
  const APP = 'igp-web';
  const VERSION = '2.4.0';
  const SETTINGS_KEY = `${APP}:settings:v3`;
  const OLD_SETTINGS_KEY = `${APP}:settings:v2`;
  const DEFAULTS = Object.freeze({
    postDownloads: true,
    reelDownloads: true,
    storyDownloads: true,
    mediaViewer: true,
    videoControls: true,
    bioFonts: true,
    viewerSearch: true,
    relationshipNotifier: true,
    desktopNotifications: false,
    storyPreview: false,
  });
  const BOOLEAN_SETTINGS = new Set(Object.keys(DEFAULTS).filter(key => typeof DEFAULTS[key] === 'boolean'));

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    });
  }
  function escapeHTML(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }
  function normalizeUsername(value) { return String(value || '').trim().replace(/^@/, '').toLocaleLowerCase(); }
  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }
  function viewport() {
    const value = window.visualViewport;
    return value ? { left: value.offsetLeft, top: value.offsetTop, width: value.width, height: value.height } : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }
  function debounce(fn, wait = 100) {
    let timer = null;
    const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...args); }, wait); };
    wrapped.cancel = () => { clearTimeout(timer); timer = null; };
    return wrapped;
  }
  function cookieValue(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }
  function accountId() { return cookieValue('ds_user_id'); }
  function parseJSON(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
  function readSettings() {
    const current = parseJSON(localStorage.getItem(SETTINGS_KEY), null);
    const previous = current || parseJSON(localStorage.getItem(OLD_SETTINGS_KEY), null) || {};
    const next = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      if (BOOLEAN_SETTINGS.has(key)) next[key] = typeof previous[key] === 'boolean' ? previous[key] : fallback;
      else next[key] = fallback;
    }
    return next;
  }

  class EventBus {
    constructor() { this.listeners = new Map(); }
    on(type, listener, options = {}) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      const off = () => this.listeners.get(type)?.delete(listener);
      options.signal?.addEventListener('abort', off, { once: true });
      return off;
    }
    emit(type, detail) {
      for (const listener of [...(this.listeners.get(type) || [])]) {
        try { listener(detail); } catch (error) { console.warn(`[Instagram Plus] ${type} listener failed`, error); }
      }
    }
  }

  class Scope {
    constructor(name) { this.name = name; this.controller = new AbortController(); this.cleanups = []; }
    get signal() { return this.controller.signal; }
    listen(target, type, listener, options = {}) { target.addEventListener(type, listener, { ...options, signal: this.signal }); return listener; }
    observe(observer, target, options) { observer.observe(target, options); this.cleanups.push(() => observer.disconnect()); return observer; }
    cleanup(fn) { this.cleanups.push(fn); return fn; }
    close() { if (this.signal.aborted) return; this.controller.abort(); for (const fn of this.cleanups.splice(0).reverse()) try { fn(); } catch {} }
  }

  const IGP = {
    APP, VERSION, PAGE, pageFunction, DEFAULTS, SETTINGS_KEY,
    state: {
      settings: readSettings(), route: location.href, accountId: accountId(), routeScope: null,
      rootHost: null, root: null, panelOpen: false, panelView: 'overview', modules: new Map(),
    },
    bus: new EventBus(),
    util: { clamp, sleep, escapeHTML, normalizeUsername, isVisible, viewport, debounce, cookieValue, accountId, parseJSON, Scope },
    saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(IGP.state.settings)); } catch {} IGP.bus.emit('settings:changed', { ...IGP.state.settings }); },
    setSetting(key, value) {
      if (!Object.hasOwn(DEFAULTS, key)) return;
      if (BOOLEAN_SETTINGS.has(key)) value = !!value;
      IGP.state.settings[key] = value; IGP.saveSettings();
    },
    register(name, module) { IGP.state.modules.set(name, module); },
    runSafe(name, fn) { try { return fn(); } catch (error) { console.error(`[Instagram Plus] ${name}`, error); IGP.ui?.notice?.(`${name} stopped working on this page.`, { tone: 'error' }); return null; } },
  };

  {
  const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  const ICONS = Object.freeze({
    logo: '<path d="M3 5h8M7 5v14M3 19h8M14 12h7m-3.5-3.5v7"/>',
    home: '<path d="m3 11 9-8 9 8v10h-6v-6H9v6H3Z"/>',
    social: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-3v6m-3-3h6"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2m-8-9L4 2M17 5l3-3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a2 2 0 0 0 .4 2.2l.1.1-2.6 2.6-.1-.1a2 2 0 0 0-2.2-.4 2 2 0 0 0-1.2 1.8V21h-3.6v-.2A2 2 0 0 0 9 19a2 2 0 0 0-2.2.4l-.1.1-2.6-2.6.1-.1A2 2 0 0 0 4.6 15a2 2 0 0 0-1.8-1.2H2v-3.6h.8A2 2 0 0 0 4.6 9a2 2 0 0 0-.4-2.2l-.1-.1 2.6-2.6.1.1A2 2 0 0 0 9 4.6a2 2 0 0 0 1.2-1.8V2h3.6v.8A2 2 0 0 0 15 4.6a2 2 0 0 0 2.2-.4l.1-.1 2.6 2.6-.1.1A2 2 0 0 0 19.4 9a2 2 0 0 0 1.8 1.2h.8v3.6h-.8A2 2 0 0 0 19.4 15Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 19h16"/>', stack: '<rect x="6" y="6" width="15" height="15" rx="3"/><path d="M3 17V5a2 2 0 0 1 2-2h12"/>',
    expand: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>', sliders: '<path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6"/>',
    compare: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>', activity: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>', back: '<path d="m15 5-7 7 7 7"/>', check: '<path d="m5 12 4 4L19 6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>', pause: '<path d="M8 5v14M16 5v14"/>', pip: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 11h7v7h-7Z"/>',
    volume: '<path d="M3 9h4l5-4v14l-5-4H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>', rotate: '<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>',
    plus: '<path d="M5 12h14M12 5v14"/>', minus: '<path d="M5 12h14"/>', shield: '<path d="M12 2 4 5v6c0 5 3.4 9 8 11 4.6-2 8-6 8-11V5Z"/>',
    archive: '<path d="M4 7h16v14H4Zm-1-4h18v4H3Zm6 8h6"/>', refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>', bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
  });
  function icon(name, size = 22) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.logo}</svg>`;
  }
  const UI_CSS = `
    :host{--bg:#fff;--surface:#fff;--soft:#f5f5f5;--soft-hover:#ededed;--text:#161616;--muted:#666;--line:#e6e6e6;--accent:#006fc4;--danger:#d82e3f;--inverse:#fff;--shadow:0 12px 48px #0002;color-scheme:light;font:14px/1.45 ${FONT}}
    :host([data-theme=dark]){--bg:#000;--surface:#161616;--soft:#232323;--soft-hover:#303030;--text:#fafafa;--muted:#adadad;--line:#353535;--accent:#53b5ff;--danger:#ff7684;--inverse:#161616;--shadow:0 12px 48px #0007;color-scheme:dark}
    *{box-sizing:border-box;font-family:${FONT}}button,input,select{font:inherit}button{color:inherit}a{color:inherit}.hidden,[hidden]{display:none!important}
    button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
    #igp-edge{position:fixed;right:0;top:42%;z-index:2147483645;pointer-events:auto;display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border:1px solid var(--line);border-right:0;border-radius:12px 0 0 12px;background:var(--surface);color:var(--text);box-shadow:var(--shadow);cursor:pointer;font-weight:650;transform:translateX(calc(100% - 44px));transition:transform .16s ease}
    #igp-edge:hover,#igp-edge:focus-visible{transform:none}#igp-edge svg{flex:none}
    #igp-nav-entry{pointer-events:auto;width:100%;min-width:48px;height:48px;display:flex;align-items:center;gap:16px;padding:0 13px;border:0;border-radius:9px;background:transparent;color:var(--text);cursor:pointer;font:500 16px/1 ${FONT};white-space:nowrap}
    #igp-nav-entry:hover{background:var(--soft)}#igp-nav-entry svg{flex:none}#igp-nav-entry span{overflow:hidden}
    dialog{font:14px/1.45 ${FONT};color:var(--text)}
    #igp-center{position:fixed;inset:24px 24px auto auto;width:min(440px,calc(100vw - 48px));max-width:none;max-height:calc(100dvh - 48px);margin:0;padding:0;border:1px solid var(--line);border-radius:22px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden;pointer-events:auto;animation:igpUp .16s ease}
    #igp-center::backdrop{background:#0004}.center-shell{display:flex;flex-direction:column;max-height:calc(100dvh - 50px)}
    .center-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;flex:none}.brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;letter-spacing:-.35px}.brand-mark{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--line);border-radius:11px;background:var(--soft)}
    .icon-button{display:grid;place-items:center;width:44px;height:44px;flex:none;border:0;border-radius:12px;background:transparent;cursor:pointer}.icon-button:hover{background:var(--soft)}.icon-button:disabled{opacity:.4;cursor:default}
    .center-nav{display:flex;gap:4px;margin:0 20px 4px;padding:4px;background:var(--soft);border-radius:12px;flex:none}.nav-button{display:flex;align-items:center;justify-content:center;gap:8px;min-height:40px;flex:1;border:0;border-radius:9px;background:transparent;color:var(--muted);cursor:pointer;font-size:13px;font-weight:600}.nav-button.active{color:var(--text);background:var(--surface);box-shadow:0 1px 4px #0001}.nav-button svg{width:17px;height:17px}
    .center-body{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.view{padding:20px 20px 24px}.view-title{margin:4px 0 16px;font-size:23px;letter-spacing:-.6px;line-height:1.2}.view-title:focus{outline:none}.view-copy{margin:0 0 16px;color:var(--muted);font-size:13px;line-height:1.5}.section{margin:24px 0 0}.section:first-child{margin-top:0}.section-title{margin:0 0 10px;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.01em}
    .card{border:1px solid var(--line);border-radius:16px;background:var(--surface);overflow:hidden}.card+.card{margin-top:12px}.row{display:flex;align-items:center;gap:12px;min-height:58px;padding:12px 16px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);text-align:left;width:100%;text-decoration:none}.row:last-child{border-bottom:0}.row.action,.setting-row{cursor:pointer}.row.action:hover,.setting-row:hover{background:var(--soft)}.setting-row:focus-within{outline:2px solid var(--accent);outline-offset:-3px}.row-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:var(--soft);flex:none}.row-main{min-width:0;flex:1}.row-title{display:block;font-size:14px;font-weight:550}.row-detail{display:block;margin-top:3px;color:var(--muted);font-size:12px;line-height:1.4}.row-tail{color:var(--muted);flex:none}
    .quick-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.quick{display:flex;flex-direction:column;align-items:flex-start;gap:16px;min-height:108px;border:1px solid var(--line);border-radius:16px;background:var(--surface);padding:16px;color:var(--text);cursor:pointer;text-align:left;font-size:14px}.quick:hover{background:var(--soft)}.quick strong{font-size:14px;font-weight:600;line-height:1.35}.quick svg{width:23px;height:23px}
    .download-action{display:flex;align-items:center;gap:14px;width:100%;min-height:68px;padding:16px;border:0;border-radius:16px;background:var(--text);color:var(--inverse);text-align:left;cursor:pointer}.download-action:hover{opacity:.88}.download-action strong{font-size:14px;font-weight:600;flex:1}.download-action svg:last-child{width:17px;height:17px;opacity:.6}.story-note{margin:10px 2px 0;font-size:12px;color:var(--muted)}
    .switch{position:relative;width:44px;height:26px;flex:none}.switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}.switch .track{display:block;width:100%;height:100%;border-radius:20px;background:#8b8b8b;transition:background .15s;pointer-events:none}.switch .track:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;border-radius:50%;background:white;box-shadow:0 1px 3px #0003;transition:transform .15s}.switch input:checked+.track{background:var(--accent)}.switch input:checked+.track:before{transform:translateX(18px)}.switch input:focus-visible{outline:none}
    .setting-row .setting-state{color:var(--muted);font-size:11px;min-width:20px;text-align:right}.setting-row:has(input:checked) .setting-state{color:var(--accent)}
    .field{width:100%;height:44px;border:1px solid var(--line);border-radius:12px;background:var(--soft);color:var(--text);padding:0 14px}.field::placeholder{color:var(--muted);opacity:1}.tabs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border-bottom:1px solid var(--line);margin-top:16px}.tab{display:flex;align-items:center;justify-content:center;gap:7px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);min-height:52px;padding:10px 8px;cursor:pointer;font-weight:600;font-size:12px;line-height:1.35}.tab.active{border-color:var(--text);color:var(--text)}.count{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:7px;background:var(--soft);font-size:11px;flex:none}
    .toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}.toolbar .field{min-width:120px;flex:1}.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text);cursor:pointer;font-weight:600}.button:hover{background:var(--soft)}.button.primary{border-color:var(--text);background:var(--text);color:var(--inverse)}.button.danger{color:var(--danger)}.button:disabled{opacity:.4;cursor:default}
    .empty,.loading,.error{padding:40px 20px;text-align:center;color:var(--muted)}.loading:before{content:"";display:block;width:23px;height:23px;margin:0 auto 12px;border:2px solid var(--line);border-top-color:var(--text);border-radius:50%;animation:igpSpin .7s linear infinite}.error{color:var(--danger)}.list-note{margin:14px 20px 0;padding:12px;border-radius:12px;background:var(--soft);color:var(--muted);font-size:12px;line-height:1.5}
    .person{display:grid;grid-template-columns:40px 1fr auto;gap:12px;align-items:center;min-height:64px;padding:10px 20px;color:inherit;text-decoration:none}.person:hover{background:var(--soft)}.person img,.avatar{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--soft);color:var(--muted);font-size:14px;font-weight:600}.person strong,.person small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.person strong{font-weight:550}.person small{color:var(--muted)}.about{display:flex;justify-content:space-between;gap:10px;margin-top:28px;color:var(--muted);font-size:11px}
    #igp-notices{position:fixed;left:50%;bottom:max(24px,env(safe-area-inset-bottom));z-index:2147483647;transform:translateX(-50%);width:min(380px,calc(100vw - 32px));pointer-events:none}.notice{display:flex;align-items:center;gap:10px;width:100%;margin-top:8px;padding:14px 16px;border:1px solid #ffffff20;border-radius:14px;background:#262626;color:white;box-shadow:var(--shadow);pointer-events:auto;animation:igpUp .16s ease}.notice.error{background:#a82332}.notice span{flex:1}.notice button{min-height:44px;border:0;border-radius:8px;background:#ffffff20;color:white;padding:5px 12px;cursor:pointer}
    .igp-menu{position:fixed;z-index:2147483647;width:250px;margin:0;padding:6px;border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--text);box-shadow:var(--shadow);pointer-events:auto}.igp-menu button{display:flex;align-items:center;gap:11px;width:100%;min-height:44px;border:0;border-radius:10px;background:transparent;padding:10px;color:inherit;cursor:pointer;text-align:left}.igp-menu button:hover{background:var(--soft)}
    .confirm{width:min(390px,calc(100vw - 32px));border:1px solid var(--line);border-radius:20px;background:var(--surface);color:var(--text);padding:0;box-shadow:var(--shadow);pointer-events:auto}.confirm::backdrop{background:#0007}.confirm-body{padding:24px}.confirm h2{margin:0 0 10px;font-size:19px;letter-spacing:-.3px}.confirm p{margin:0;color:var(--muted)}.confirm-actions{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.confirm-actions button{min-height:52px;border:0;border-right:1px solid var(--line);background:transparent;padding:14px;cursor:pointer}.confirm-actions button:hover{background:var(--soft)}.confirm-actions button:last-child{border:0}.confirm-actions .danger{color:var(--danger);font-weight:650}
    @keyframes igpUp{from{transform:translateY(6px);opacity:0}}@keyframes igpSpin{to{transform:rotate(360deg)}}
    @media(max-width:560px){#igp-center{inset:auto 0 0;width:100vw;max-height:calc(100dvh - 12px);border-radius:22px 22px 0 0;border-bottom:0}.center-shell{max-height:calc(100dvh - 13px)}.center-body{padding-bottom:env(safe-area-inset-bottom)}.center-head{padding-top:14px}.view{padding:18px 20px 24px}#igp-edge{top:auto;bottom:76px}}
    @media(max-width:340px){.view{padding-inline:14px}.center-nav{margin-inline:14px}.quick{padding:12px}.row{padding-inline:12px}.row-title{font-size:13px}.tab{font-size:11px}.count{min-width:18px;padding:0 4px}}
    @media(prefers-reduced-motion:reduce){*,*:before{animation:none!important;transition:none!important}}
`;

  const views = new Map();
  let viewScope = null, nativeHost = null, menu = null, menuOutside = null, returnFocus = null;
  function themeValue() {
    const value = getComputedStyle(document.body || document.documentElement).getPropertyValue('--ig-primary-background').trim();
    const rgb = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
    if (rgb?.length === 3) return rgb.reduce((sum, part) => sum + part, 0) / 3 < 128 ? 'dark' : 'light';
    return getComputedStyle(document.body || document.documentElement).backgroundColor.match(/\d+/g)?.slice(0, 3).reduce((sum, value) => sum + Number(value), 0) / 3 < 128 ? 'dark' : 'light';
  }
  function syncTheme() {
    const theme = themeValue(); if (IGP.state.rootHost) IGP.state.rootHost.dataset.theme = theme;
    for (const host of document.querySelectorAll('[data-igp-host]')) host.dataset.theme = theme;
  }
  function ensureRoot() {
    if (IGP.state.root?.isConnected) return IGP.state.root;
    const host = document.createElement('div'); host.id = 'igp-v2-root'; host.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' }); root.innerHTML = `<style>${UI_CSS}</style><button id="igp-edge" type="button" aria-label="Open Instagram Plus">${icon('logo')}<span>Instagram Plus</span></button><div id="igp-notices" aria-live="polite"></div>`;
    document.documentElement.appendChild(host); IGP.state.rootHost = host; IGP.state.root = root; syncTheme();
    root.getElementById('igp-edge').addEventListener('click', () => openCenter());
    return root;
  }
  function tryNativeLauncher() {
    ensureRoot();
    if (nativeHost?.isConnected) {
      nativeHost.dataset.compact = String(nativeHost.getBoundingClientRect().width < 110);
      return;
    }
    const visibleLinks = [...document.querySelectorAll('a[href],[role=link][href]')].filter(IGP.util.isVisible);
    const pathOf = element => { try { return new URL(element.href || element.getAttribute('href'), location.origin).pathname; } catch { return ''; } };
    const home = visibleLinks.find(element => pathOf(element) === '/'), reels = visibleLinks.find(element => /^\/reels?\/?$/.test(pathOf(element))), messages = visibleLinks.find(element => pathOf(element) === '/direct/inbox/');
    let nav = null;
    if (home && reels && messages) {
      for (let candidate = home.parentElement, depth = 0; candidate && depth < 12; candidate = candidate.parentElement, depth++) {
        const rect = candidate.getBoundingClientRect();
        if (rect.height > 220 && rect.width >= 48 && rect.width <= 330 && candidate.contains(reels) && candidate.contains(messages)) { nav = candidate; break; }
      }
    }
    if (!nav && home && reels && messages) nav = [...document.querySelectorAll('nav,[role=navigation]')].find(element => { const rect = element.getBoundingClientRect(); return IGP.util.isVisible(element) && rect.height > 220 && rect.width <= 330 && element.contains(home) && element.contains(reels) && element.contains(messages); }) || null;
    if (!nav || nav.getBoundingClientRect().width < 48) { IGP.state.root.getElementById('igp-edge').hidden = false; return; }
    const navRect = nav.getBoundingClientRect(), anchors = [...nav.querySelectorAll('a[href],[role=link][href]')].filter(IGP.util.isVisible).filter(element => { const rect = element.getBoundingClientRect(), center = rect.left + rect.width / 2; return center >= navRect.left && center <= navRect.right; }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const reserved = new Set(['explore', 'reels', 'reel', 'direct', 'stories', 'accounts']), messagesTop = messages.getBoundingClientRect().top;
    const profile = anchors.find(element => { const parts = pathOf(element).split('/').filter(Boolean), label = `${element.getAttribute('aria-label') || ''} ${element.querySelector('img')?.alt || ''}`; return parts.length === 1 && !reserved.has(parts[0].toLowerCase()) && /profile picture|^\s*profile\s*$/i.test(label) && element.getBoundingClientRect().top > messagesTop; });
    const reference = profile || (nav.contains(messages) && anchors.includes(messages) ? messages : anchors.at(-1));
    const parent = reference?.parentElement;
    if (!parent || parent.closest('[data-igp-native-launcher]')) return;
    nativeHost = document.createElement('span'); nativeHost.dataset.igpNativeLauncher = '1'; nativeHost.dataset.igpHost = '1'; nativeHost.style.cssText = 'display:block;width:100%;color:inherit';
    const shadow = nativeHost.attachShadow({ mode: 'open' }); shadow.innerHTML = `<style>${UI_CSS}:host([data-compact=true]) #igp-nav-entry span{display:none}</style><button id="igp-nav-entry" type="button" aria-label="Instagram Plus" title="Instagram Plus">${icon('logo',25)}<span>Instagram Plus</span></button>`;
    shadow.querySelector('button').addEventListener('click', () => openCenter()); parent.insertAdjacentElement('afterend', nativeHost);
    IGP.state.root.getElementById('igp-edge').hidden = true; syncTheme();
    nativeHost.dataset.compact = String(nativeHost.getBoundingClientRect().width < 110);
  }
  function registerView(id, config) { views.set(id, config); }
  function renderNavigation() {
    const center = IGP.state.root?.getElementById('igp-center'); if (!center) return;
    const nav = center.querySelector('.center-nav');
    nav.innerHTML = [...views].filter(([, value]) => value.nav !== false).map(([id, value]) => `<button class="nav-button ${(IGP.state.panelView === id || (id === 'overview' && IGP.state.panelView === 'social')) ? 'active' : ''}" data-view="${id}" aria-current="${IGP.state.panelView === id || (id === 'overview' && IGP.state.panelView === 'social') ? 'page' : 'false'}" type="button">${icon(value.icon || 'home', 20)}<span>${IGP.util.escapeHTML(value.label)}</span></button>`).join('');
    nav.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { const id=button.dataset.view; showView(id); center.querySelector(`[data-view="${id}"]`)?.focus(); }));
  }
  function showView(id, params = null) {
    const view = views.get(id); if (!view) return;
    IGP.state.panelView = id; IGP.state.panelParams = params; viewScope?.close(); viewScope = new IGP.util.Scope(`view:${id}`);
    const center = IGP.state.root?.getElementById('igp-center'); if (!center) return openCenter(id, params);
    const activeScope = viewScope; renderNavigation(); const body = center.querySelector('.center-body'); body.scrollTop = 0; body.replaceChildren();
    try { const result = view.render(body, activeScope, params); if (result?.catch) result.catch(error => { if (!activeScope.signal.aborted) body.innerHTML = `<div class="error">${IGP.util.escapeHTML(error.message || 'Could not open this page.')}</div>`; }); const heading=body.querySelector('h1'); if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});} else center.querySelector('.nav-button.active')?.focus({preventScroll:true}); }
    catch (error) { body.innerHTML = `<div class="error">${IGP.util.escapeHTML(error.message || 'This view could not load.')}</div>`; }
  }
  function closeCenter() {
    const center = IGP.state.root?.getElementById('igp-center'); if (!center) return;
    IGP.state.panelOpen = false; viewScope?.close(); viewScope = null; closeMenu(); if (center.open) center.close(); center.remove(); const target = returnFocus; returnFocus = null; if (target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }
  function openCenter(id = IGP.state.panelView || 'overview', params = null) {
    ensureRoot(); let center = IGP.state.root.getElementById('igp-center');
    if (!center) {
      returnFocus = nativeHost?.shadowRoot?.activeElement || IGP.state.root.activeElement || document.activeElement;
      center = document.createElement('dialog'); center.id = 'igp-center'; center.setAttribute('aria-label', 'Instagram Plus');
      center.innerHTML = `<div class="center-shell"><header class="center-head"><div class="brand"><span class="brand-mark">${icon('logo',24)}</span>Instagram Plus</div><button class="icon-button" type="button" aria-label="Close">${icon('close')}</button></header><nav class="center-nav" aria-label="Instagram Plus sections"></nav><main class="center-body"></main></div>`;
      IGP.state.root.appendChild(center); center.querySelector('[aria-label=Close]').addEventListener('click', closeCenter); center.addEventListener('cancel', event => { event.preventDefault(); closeCenter(); }); center.addEventListener('click', event => { if (event.target === center) closeCenter(); });
      center.showModal();
    }
    IGP.state.panelOpen = true; showView(id, params); center.querySelector('[aria-label=Close]').focus({ preventScroll: true });
  }
  function notice(message, { tone = 'normal', action = null, duration = 7000 } = {}) {
    ensureRoot(); const region = IGP.state.root.getElementById('igp-notices'), item = document.createElement('div'); item.className = `notice ${tone === 'error' ? 'error' : ''}`;
    item.innerHTML = `<span>${IGP.util.escapeHTML(message)}</span>${action ? `<button type="button">${IGP.util.escapeHTML(action.label)}</button>` : ''}`;
    if (action) item.querySelector('button').addEventListener('click', () => { item.remove(); action.run(); }); region.appendChild(item); setTimeout(() => item.remove(), duration); return item;
  }
  function confirmAction({ title, message, confirmLabel = 'Delete', danger = true }) {
    ensureRoot(); return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'confirm'; dialog.setAttribute('aria-label',title);
      dialog.innerHTML = `<div class="confirm-body"><h2>${IGP.util.escapeHTML(title)}</h2><p>${IGP.util.escapeHTML(message)}</p></div><div class="confirm-actions"><button type="button" data-result="false">Cancel</button><button type="button" data-result="true" class="${danger ? 'danger' : ''}">${IGP.util.escapeHTML(confirmLabel)}</button></div>`;
      IGP.state.root.appendChild(dialog); let finished = false; const finish = value => { if (finished) return; finished = true; if (dialog.open) dialog.close(); dialog.remove(); resolve(value); };
      dialog.querySelectorAll('[data-result]').forEach(button => button.addEventListener('click', () => finish(button.dataset.result === 'true'))); dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); }); dialog.showModal(); dialog.querySelector('[data-result=false]').focus();
    });
  }
  function closeMenu() { if (menuOutside) { document.removeEventListener('pointerdown', menuOutside, true); menuOutside = null; } if (!menu) return; if (typeof menu.hidePopover === 'function' && menu.matches(':popover-open')) menu.hidePopover(); menu.remove(); menu = null; }
  function openMenu(anchor, items) {
    ensureRoot(); closeMenu(); menu = document.createElement('div'); menu.className = 'igp-menu'; menu.setAttribute('role', 'menu');
    menu.innerHTML = items.map((item, index) => `<button type="button" data-index="${index}" role="menuitem">${icon(item.icon || 'chevron', 19)}<span>${IGP.util.escapeHTML(item.label)}</span></button>`).join('');
    IGP.state.root.appendChild(menu); const rect = anchor.getBoundingClientRect(), vp = IGP.util.viewport(); menu.style.left = `${IGP.util.clamp(rect.right - 250, vp.left + 8, vp.left + vp.width - 258)}px`; menu.style.top = `${IGP.util.clamp(rect.bottom + 7, vp.top + 8, vp.top + vp.height - menu.offsetHeight - 8)}px`;
    menu.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { const item = items[Number(button.dataset.index)]; closeMenu(); item.run(); }));
    menu.addEventListener('keydown',event=>{ const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(IGP.state.root.activeElement); if(event.key==='Escape'){event.preventDefault();closeMenu();anchor.focus();} else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();} });
    menuOutside = event => { if (!event.composedPath().includes(menu) && !event.composedPath().includes(anchor)) closeMenu(); }; document.addEventListener('pointerdown', menuOutside, true); menu.querySelector('button')?.focus();
  }
  function switchRow(key, title, detail = '') {
    const checked = IGP.state.settings[key];
    return `<label class="row setting-row"><span class="row-main"><span class="row-title">${IGP.util.escapeHTML(title)}</span>${detail ? `<span class="row-detail">${IGP.util.escapeHTML(detail)}</span>` : ''}</span><span class="setting-state" aria-hidden="true">${checked ? 'On' : 'Off'}</span><span class="switch"><input type="checkbox" data-setting="${key}" ${checked ? 'checked' : ''}><span class="track"></span></span></label>`;
  }
  function bindSettings(container) {
    container.querySelectorAll('[data-setting]').forEach(input => input.addEventListener('change', async () => {
      if(input.dataset.setting==='desktopNotifications' && input.checked){
        input.disabled=true;
        try { if(typeof Notification==='undefined' || await Notification.requestPermission()!=='granted') throw new Error(); }
        catch { input.checked=false;notice('Allow notifications in your browser first.'); }
        finally { input.disabled=false; }
      }
      IGP.setSetting(input.dataset.setting, input.checked);
      input.closest('label').querySelector('.setting-state').textContent = input.checked ? 'On' : 'Off';
      const note = container.querySelector('[data-story-note]');
      if (note) note.hidden = !IGP.state.settings.storyPreview;
    }));
  }
  function actionRow({ icon: name, title, detail = '', id = '' }) { return `<button class="row action" type="button" ${id ? `data-action="${id}"` : ''}><span class="row-icon">${icon(name, 19)}</span><span class="row-main"><span class="row-title">${IGP.util.escapeHTML(title)}</span>${detail ? `<span class="row-detail">${IGP.util.escapeHTML(detail)}</span>` : ''}</span><span class="row-tail">${icon('chevron', 17)}</span></button>`; }
  function storyNote() { return `<p class="story-note" data-story-note ${IGP.state.settings.storyPreview ? '' : 'hidden'}>Some story views may still be counted.</p>`; }
  function renderOverview(body) {
    const path = location.pathname;
    const download = /^\/stories\//.test(path) ? 'Download story' : /^\/reels?\//.test(path) ? 'Download reel' : /^\/(?:[^/]+\/)?p\//.test(path) ? 'Download post' : 'Download open photo or video';
    body.innerHTML = `<div class="view"><section class="section"><h2 class="section-title">While browsing</h2><div class="card">${switchRow('storyPreview','Story Preview','Hide your story views')}${switchRow('videoControls','Video controls')}${switchRow('mediaViewer','Photo zoom')}</div>${storyNote()}</section><section class="section"><h2 class="section-title">Save</h2><button class="download-action" type="button" data-action="download">${icon('download',24)}<strong>${download}</strong>${icon('chevron',17)}</button></section><section class="section"><h2 class="section-title">Followers</h2><div class="quick-grid"><button class="quick" type="button" data-action="compare">${icon('compare')}<strong>Compare followers</strong></button><button class="quick" type="button" data-action="activity">${icon('activity')}<strong>Friend Activity</strong></button></div></section></div>`;
    bindSettings(body);
    body.querySelector('[data-action=compare]').addEventListener('click', () => showView('social', {compare:true}));
    body.querySelector('[data-action=activity]').addEventListener('click', () => showView('social', {activity:true}));
    body.querySelector('[data-action=download]').addEventListener('click', () => IGP.legacy.launch('downloadCurrent'));
  }
  function renderSettings(body) {
    body.innerHTML = `<div class="view"><section class="section"><h2 class="section-title">Browsing</h2><div class="card">${switchRow('storyPreview','Story Preview','Hide your story views')}${switchRow('videoControls','Video controls')}${switchRow('mediaViewer','Photo zoom')}${switchRow('viewerSearch','Search story viewers')}</div>${storyNote()}</section><section class="section"><h2 class="section-title">Download buttons</h2><div class="card">${switchRow('storyDownloads','Stories')}${switchRow('reelDownloads','Reels')}${switchRow('postDownloads','Posts')}</div></section><section class="section"><h2 class="section-title">Follow changes</h2><div class="card">${switchRow('relationshipNotifier','Friend Activity')}${switchRow('desktopNotifications','Desktop notifications')}</div></section><section class="section"><h2 class="section-title">Profile</h2><div class="card">${switchRow('bioFonts','Bio fonts')}</div></section><footer class="about"><span>Made by Jasermomm</span><span>Version ${VERSION}</span></footer></div>`;
    bindSettings(body);
  }

  registerView('overview', { label: 'Tools', icon: 'sliders', render: renderOverview });
  registerView('social', { label: 'Social', nav: false, render: body => body.innerHTML = '<div class="loading">Loading followers</div>' });
  registerView('settings', { label: 'Settings', icon: 'settings', render: renderSettings });
  IGP.ui = { icon, UI_CSS, ensureRoot, syncTheme, tryNativeLauncher, registerView, openCenter, closeCenter, showView, notice, confirm: confirmAction, openMenu, closeMenu, switchRow, bindSettings, actionRow, views };
  }

  {
  const SNAPSHOT_TTL = 6 * 60 * 60 * 1000;
  const HISTORY_LIMIT = 200;
  const nativeState = { running: false, controller: null, dialog: null, progressHost: null, observed: null };
  const engine = () => PAGE.__IGP_LEGACY_ENGINE__;
  const cacheKey = account => `${APP}:native-social:v1:${account}`;
  const abortError = () => new DOMException('Cancelled', 'AbortError');
  function profileName(href) {
    try {
      const url = new URL(href, location.origin), parts = url.pathname.split('/').filter(Boolean);
      const reserved = new Set(['accounts','explore','reels','reel','stories','direct','api','graphql','archive','notifications']);
      return url.origin === location.origin && parts.length === 1 && /^[\w.]{1,30}$/.test(parts[0]) && !reserved.has(parts[0]) ? parts[0].toLowerCase() : null;
    } catch { return null; }
  }
  function exactCount(text, kind) {
    const word = kind === 'followers' ? 'followers?' : 'following';
    const match = String(text || '').replace(/\u00a0|\u202f/g, ' ').match(new RegExp(`(?:^|\\s)([\\d, .]+)\\s+${word}(?:\\s|$)`, 'i'));
    if (!match || /\d[.,]\d{1,2}(?:\s|$)/.test(match[1].trim())) return null;
    const number = Number(match[1].replace(/[, .]/g, ''));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }
  function validPeople(map) {
    return map && typeof map === 'object' && !Array.isArray(map) && Object.entries(map).every(([key,p]) => key === `u:${IGP.util.normalizeUsername(p?.username)}` && /^[\w.]{1,30}$/.test(p?.username || ''));
  }
  function readRecord(account = IGP.util.accountId()) {
    const record = IGP.util.parseJSON(localStorage.getItem(cacheKey(account)), null);
    if (record?.schema !== 1 || record.accountId !== account || !validPeople(record.followers) || !validPeople(record.following) || !Number.isFinite(record.checkedAt)) return null;
    record.pending = { followers: validPeople(record.pending?.followers) ? record.pending.followers : {}, following: validPeople(record.pending?.following) ? record.pending.following : {} };
    record.history = Array.isArray(record.history) ? record.history.filter(e => e && ['followers','following'].includes(e.kind) && ['added','removed'].includes(e.change) && /^[\w.]{1,30}$/.test(e.person?.username || '') && Number.isFinite(e.at)).slice(0,HISTORY_LIMIT) : [];
    return record;
  }
  function saveSnapshot(account, lists, at = Date.now()) {
    if (account !== IGP.util.accountId()) throw abortError();
    const previous = readRecord(account), tracking = IGP.state.settings.relationshipNotifier;
    const baseline = previous?.trackingSince ? { ...previous, initializedAt: previous.trackingSince } : null;
    const diff = tracking ? engine().relationshipDiff(baseline, lists, at) : { events:[], pending:{followers:{},following:{}} };
    const record = { schema:1, accountId:account, followers:lists.followers, following:lists.following, checkedAt:at,
      trackingSince: tracking ? previous?.trackingSince || at : 0, pending:diff.pending,
      history:[...diff.events,...(previous?.history || [])].slice(0,HISTORY_LIMIT), source:'native-lists' };
    // No partial result is written. A storage failure remains visible to callers.
    localStorage.setItem(cacheKey(account), JSON.stringify(record));
    IGP.bus.emit('social:snapshot', record);
    if (diff.events.length) {
      const message = diff.events.length === 1 ? eventText(diff.events[0]) : `${diff.events.length} relationship changes`;
      IGP.ui.notice(message, { action:{label:'View',run:()=>IGP.ui.openCenter('social',{activity:true})} });
      if (IGP.state.settings.desktopNotifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('Instagram Plus · Friend Activity', {body:message,tag:`${APP}-relationships`}); } catch {}
      }
    }
    return { ...record, fetchedAt:at, cached:false };
  }
  function eventText(event) {
    const name = `@${event.person.username}`;
    return event.kind === 'followers'
      ? event.change === 'added' ? `${name} now follows you` : `${name} no longer follows you`
      : event.change === 'added' ? `You now follow ${name}` : `You no longer follow ${name}`;
  }
  function readCached() {
    const record = readRecord();
    const partial = IGP.util.parseJSON(localStorage.getItem(`${cacheKey(IGP.util.accountId())}:available`),null);
    if (partial?.accountId === IGP.util.accountId() && validPeople(partial.followers) && validPeople(partial.following) && Number.isFinite(partial.fetchedAt) && partial.fetchedAt > (record?.checkedAt || 0)) return {...partial,cached:true,stale:Date.now()-partial.fetchedAt>SNAPSHOT_TTL};
    return record ? {...record, fetchedAt:record.checkedAt, cached:true, stale:Date.now()-record.checkedAt > SNAPSHOT_TTL} : null;
  }
  function countControl(kind) {
    const candidates = [...document.querySelectorAll('a[href],button,[role="button"]')];
    for (const element of candidates) {
      if (!IGP.util.isVisible(element) || element.closest('[data-igp-host],#igp-web-root,#igp-v2-root,[role="dialog"]')) continue;
      const text = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`;
      if (!new RegExp(`\\b${kind}\\b`, 'i').test(text)) continue;
      const title = element.getAttribute('title') || element.querySelector('[title]')?.getAttribute('title');
      const count = title && /^\d[\d, .]*$/.test(title) ? Number(title.replace(/[, .]/g,'')) : exactCount(text,kind);
      if (Number.isSafeInteger(count) && count >= 0) return {element,count};
    }
    return null;
  }
  function ownProfile() {
    return !!document.querySelector('a[href^="/accounts/edit"]') && !!profileName(location.href);
  }
  function profileLink() {
    return [...document.querySelectorAll('a[href]')].find(a => {
      if (!profileName(a.href) || !IGP.util.isVisible(a)) return false;
      const rect = a.getBoundingClientRect(), label = a.getAttribute('aria-label') || a.querySelector('img')?.alt || '';
      return rect.left < 330 && /profile picture|^profile$/i.test(label) && !a.closest('main,article,[role="main"],[role="dialog"]');
    });
  }
  function visibleDialog(kind) {
    return [...document.querySelectorAll('[role="dialog"]')].find(d => IGP.util.isVisible(d) &&
      [...d.querySelectorAll('[role="heading"],h1,h2')].some(h => h.textContent.trim().toLowerCase() === kind));
  }
  function closeDialog(dialog) {
    if (!dialog?.isConnected) return;
    const glyph = dialog.querySelector('[aria-label="Close" i]');
    const button = glyph?.closest('button,[role="button"]');
    if (button) button.click();
  }
  async function waitUntil(check, signal, timeout = 15000) {
    const end = Date.now()+timeout;
    while (Date.now()<end) {
      if (signal.aborted) throw abortError();
      const value = check(); if (value) return value;
      await IGP.util.sleep(160,signal);
    }
    throw new Error('Instagram is taking too long to load. Try again.');
  }
  function progress(message) {
    nativeState.progressHost?.querySelector('[data-progress]')?.replaceChildren(document.createTextNode(message));
  }
  function mountProgress() {
    IGP.ui.ensureRoot();
    const host = document.createElement('div');
    host.className = 'notice'; host.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);width:min(390px,calc(100vw - 24px));z-index:2147483647;pointer-events:auto';
    host.innerHTML = '<span data-progress>Opening your profile</span><button type="button">Cancel</button>';
    host.querySelector('button').addEventListener('click',cancel);
    IGP.state.root.appendChild(host); nativeState.progressHost=host;
  }
  async function readList(kind, expected, account, signal) {
    const map = new Map();
    if (expected === 0) return {people:{},complete:true,expected};
    const control = countControl(kind); if (!control || control.count !== expected) throw new Error('Your follower counts changed. Try again.');
    if ([...document.querySelectorAll('[role="dialog"]')].some(IGP.util.isVisible)) throw new Error('Close the open Instagram dialog, then try again.');
    control.element.click();
    const dialog = await waitUntil(()=>visibleDialog(kind),signal);
    nativeState.dialog=dialog;
    try {
      let noGrowth = 0, last = -1, scroller = null;
      const end = Date.now()+180000;
      while (Date.now()<end) {
        if (signal.aborted || account !== IGP.util.accountId()) throw abortError();
        if (!dialog.isConnected) throw new Error('The list was closed. Try again.');
        const input = dialog.querySelector('input');
        if (input?.value) throw new Error('Clear the search in Instagram’s follower list first.');
        engine().collectPeopleBatch(dialog,map);
        progress(`${kind === 'followers' ? 'Followers' : 'Following'} ${map.size} of ${expected}`);
        if (map.size > expected) throw new Error('Your follower counts changed. Try again.');
        const people = () => Object.fromEntries([...map.values()].map(p=>[`u:${p.key}`,{id:`u:${p.key}`,username:p.username,displayName:p.displayName,avatar:p.avatar,href:p.href}]));
        if (map.size === expected) return {people:people(),complete:true,expected};
        scroller = scroller?.isConnected ? scroller : engine().findBestScroller(dialog);
        if (scroller) {
          // Scroll in visible increments; wait between pagination triggers.
          scroller.scrollTop = Math.min(scroller.scrollHeight-scroller.clientHeight,scroller.scrollTop+Math.max(120,scroller.clientHeight*.8));
          scroller.dispatchEvent(new Event('scroll',{bubbles:true}));
        }
        noGrowth = map.size === last ? noGrowth+1 : 0; last=map.size;
        if (noGrowth >= 14) {
          const bottom = scroller && scroller.scrollTop+scroller.clientHeight >= scroller.scrollHeight-8;
          if (bottom && map.size > 0 && !dialog.querySelector('[role="progressbar"],[aria-busy="true"]')) return {people:people(),complete:false,expected};
          throw new Error(`Instagram loaded ${map.size} of ${expected} ${kind}. Try again.`);
        }
        await IGP.util.sleep(900,signal);
      }
      throw new Error('The list took too long to load. Try again.');
    } finally { closeDialog(dialog); if (nativeState.dialog === dialog) nativeState.dialog=null; }
  }
  async function collectNative() {
    const account = IGP.util.accountId();
    if (!account) throw new Error('Sign in to Instagram to compare followers.');
    if (nativeState.running) throw new Error('A comparison is already running.');
    nativeState.running=true; const controller=new AbortController(); nativeState.controller=controller;
    mountProgress();
    const run = async () => {
      if (!ownProfile()) {
        const link = profileLink(); if (!link) throw new Error('Open your own Instagram profile and try Compare again.');
        link.click(); await waitUntil(ownProfile,controller.signal);
      }
      const totals=await waitUntil(()=>{const a=countControl('followers'),b=countControl('following');return a&&b?{followers:a.count,following:b.count}:null;},controller.signal);
      const followers=await readList('followers',totals.followers,account,controller.signal);
      await IGP.util.sleep(600,controller.signal);
      const following=await readList('following',totals.following,account,controller.signal);
      if (countControl('followers')?.count !== totals.followers || countControl('following')?.count !== totals.following) throw new Error('Your follower counts changed. Try again.');
      if (followers.complete && following.complete) {
        localStorage.removeItem(`${cacheKey(account)}:available`);
        return saveSnapshot(account,{followers:followers.people,following:following.people});
      }
      const available = {schema:1,accountId:account,fetchedAt:Date.now(),followers:followers.people,following:following.people,
        complete:{followers:followers.complete,following:following.complete},expected:totals,partial:true,cached:false};
      // Incomplete observations can support qualified comparisons, never removals.
      localStorage.setItem(`${cacheKey(account)}:available`,JSON.stringify(available));
      return available;
    };
    try {
      return navigator.locks?.request ? await navigator.locks.request(`${APP}:native-list-check:${account}`,{ifAvailable:true},lock=>{if(!lock)throw new Error('Another Instagram tab is comparing. Wait for it to finish.');return run();}) : await run();
    } finally {
      closeDialog(nativeState.dialog); nativeState.dialog=null;
      nativeState.progressHost?.remove();nativeState.progressHost=null;
      nativeState.running=false;nativeState.controller=null;
    }
  }
  function cancel() { nativeState.controller?.abort(); }
  function clearHistory() {
    const account=IGP.util.accountId(),record=readRecord(account);if(!record)return;
    localStorage.setItem(cacheKey(account),JSON.stringify({...record,history:[]}));
  }
  function observeLoadedList() {
    if (nativeState.running || !IGP.state.settings.relationshipNotifier || !ownProfile()) return;
    const kind = visibleDialog('followers') ? 'followers' : visibleDialog('following') ? 'following' : null;
    if (!kind) { nativeState.observed=null; return; }
    const dialog=visibleDialog(kind),account=IGP.util.accountId(),expected=countControl(kind)?.count;
    if (!account || expected == null || dialog.querySelector('input')?.value) return;
    if (nativeState.observed?.dialog !== dialog) nativeState.observed={dialog,kind,map:new Map()};
    const observed=nativeState.observed;engine().collectPeopleBatch(dialog,observed.map);
    if (observed.map.size !== expected) return;
    // Complete lists observed during normal use update a local draft only.
    const key=`${APP}:native-list-draft:v1:${account}`;
    const draft=IGP.util.parseJSON(localStorage.getItem(key),{}) || {};
    const people=Object.fromEntries([...observed.map.values()].map(p=>[`u:${p.key}`,{id:`u:${p.key}`,username:p.username,displayName:p.displayName,avatar:p.avatar,href:p.href}]));
    const signature=JSON.stringify(people);
    if (observed.savedSignature === signature) return;
    draft[kind]={people,at:Date.now(),expected};localStorage.setItem(key,JSON.stringify(draft));observed.savedSignature=signature;
    const other=kind==='followers'?'following':'followers';
    if (draft[other] && validPeople(draft[other].people) && Date.now()-draft[other].at < 5*60*1000 && Object.keys(draft[other].people).length === countControl(other)?.count) {
      saveSnapshot(account,{[kind]:people,[other]:draft[other].people});
      localStorage.removeItem(key);
    }
  }
  IGP.social={collectNative,readCached,readRecord,saveSnapshot,clearHistory,eventText,cancel,observeLoadedList,exactCount,profileName,validPeople,state:nativeState};
  PAGE.__IGP_NATIVE_SOCIAL__={openComparison:()=>IGP.ui.openCenter('social',{compare:true}),check:collectNative};
  }

  {
  function legacyEngine() { return PAGE.__IGP_LEGACY_ENGINE__ || null; }

  function syncLegacySettings(settings = IGP.state.settings) {
    const engine = legacyEngine();
    if (!engine) return;
    const existing = engine.getSettings();
    for (const [key, value] of Object.entries(settings)) if (existing[key] !== value) engine.setSetting(key, value);
  }

  function launchLegacy(method) {
    const engine = legacyEngine();
    if (!engine || typeof engine[method] !== 'function') {
      IGP.ui.notice('Still loading. Try again in a moment.', { tone: 'error' });
      return;
    }
    IGP.ui.closeCenter();
    requestAnimationFrame(() => {
      try {
        const result = engine[method]();
        result?.catch?.(error => IGP.ui.notice(error?.message || 'The action could not be completed.', { tone: 'error' }));
      } catch (error) {
        IGP.ui.notice(error?.message || 'The action could not be completed.', { tone: 'error' });
      }
    });
  }

  function renderPeople(container, people) {
    container.innerHTML = people.length ? people.map(person => `<a class="person" href="/${encodeURIComponent(person.username)}/"><span class="avatar" aria-hidden="true">${IGP.util.escapeHTML(person.username.slice(0,1).toUpperCase())}</span><span><strong>@${IGP.util.escapeHTML(person.username)}</strong></span><span class="row-tail">${IGP.ui.icon('chevron', 16)}</span></a>`).join('') : '<div class="empty">No accounts found</div>';
  }

  function drawComparison(body, scope, result) {
    const groups = [
      { label: result.complete?.followers === false ? 'May not follow you' : "Don't follow you", people: Object.values(result.following).filter(person => !Object.hasOwn(result.followers, person.id)) },
      { label: result.complete?.following === false ? 'You may not follow' : "You don't follow", people: Object.values(result.followers).filter(person => !Object.hasOwn(result.following, person.id)) },
    ];
    groups.forEach(group => group.people.sort((a, b) => a.username.localeCompare(b.username)));
    body.innerHTML = `<div class="view" style="padding-inline:0"><div style="padding:0 20px"><div class="toolbar"><button class="icon-button" type="button" data-back aria-label="Back">${IGP.ui.icon('back')}</button><span style="flex:1"></span><button class="button" type="button" data-refresh>${IGP.ui.icon('refresh',17)} Refresh</button></div><h1 class="view-title">Compare followers</h1><p class="view-copy">Checked ${IGP.util.escapeHTML(new Date(result.fetchedAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}</p><input class="field" type="search" placeholder="Search accounts" aria-label="Search accounts"></div><div class="tabs">${groups.map((group, index) => `<button class="tab ${index ? '' : 'active'}" data-tab="${index}" aria-pressed="${!index}" type="button"><span>${IGP.util.escapeHTML(group.label)}</span><span class="count">${group.people.length}</span></button>`).join('')}</div><div data-results aria-live="polite"></div></div>`;
    if (result.partial) {
      const warning = document.createElement('p'); warning.className='list-note'; warning.setAttribute('role','status');
      const counts = ['followers','following'].filter(kind=>result.complete?.[kind] === false).map(kind=>`${Object.keys(result[kind]).length} of ${result.expected[kind]} ${kind}`);
      warning.textContent=`Instagram showed ${counts.join(' and ')}. Some matches may be missing.`;
      body.querySelector('.tabs').before(warning);
    }
    let active = 0;
    const input = body.querySelector('input'), output = body.querySelector('[data-results]');
    const draw = () => {
      const query = input.value.trim().toLocaleLowerCase();
      renderPeople(output, groups[active].people.filter(person => person.username.toLocaleLowerCase().includes(query)));
    };
    body.querySelector('[data-back]').addEventListener('click', () => IGP.ui.showView('overview'), { signal: scope.signal });
    body.querySelector('[data-refresh]').addEventListener('click', () => void renderComparison(body, scope, true), { signal: scope.signal });
    input.addEventListener('input', draw, { signal: scope.signal });
    body.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
      active = Number(button.dataset.tab);
      body.querySelectorAll('[data-tab]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); });
      input.value = '';
      draw();
    }, { signal: scope.signal }));
    draw();
  }

  async function refreshSocial(mode = 'compare') {
    if (IGP.social.state.running) return;
    IGP.ui.closeCenter();
    try {
      const result = await IGP.social.collectNative();
      IGP.ui.openCenter('social', mode === 'compare' ? {compare:true,result} : {activity:true});
    } catch (error) {
      IGP.ui.openCenter('social', mode === 'compare' ? {compare:true,error:error?.message || 'Could not compare followers.'} : {activity:true});
      if (mode !== 'compare') IGP.ui.notice(error?.message || 'The check stopped.', {tone:'error'});
    }
  }
  function renderComparison(body, scope, force = false, params = null) {
    const result = params?.result || (!force && IGP.social.readCached());
    if (result) return drawComparison(body, scope, result);
    body.innerHTML = `<div class="view"><button class="icon-button" type="button" data-back aria-label="Back">${IGP.ui.icon('back')}</button><h1 class="view-title">Compare followers</h1>${params?.error ? `<div class="error">${IGP.util.escapeHTML(params.error)}</div>` : '<div class="loading">Loading followers</div>'}<button class="button primary" type="button" data-load>Try again</button></div>`;
    body.querySelector('[data-back]').addEventListener('click',()=>IGP.ui.showView('overview'),{signal:scope.signal});
    body.querySelector('[data-load]').addEventListener('click',()=>void refreshSocial(),{signal:scope.signal});
    if (force || !params?.error) queueMicrotask(()=>{if(!scope.signal.aborted)void refreshSocial();});
  }

  function renderActivity(body, scope) {
    const record = IGP.social.readRecord(), events = Array.isArray(record?.history) ? record.history : [];
    const pending = Object.values(record?.pending || {}).reduce((sum, value) => sum + Object.keys(value).length, 0);
    const status = !IGP.util.accountId() ? 'Sign in to check followers' : !IGP.state.settings.relationshipNotifier ? 'Friend Activity is off' : record?.trackingSince ? 'Following changes' : 'Check followers to start';
    body.innerHTML = `<div class="view"><button class="icon-button" type="button" data-back aria-label="Back">${IGP.ui.icon('back')}</button><h1 class="view-title">Friend Activity</h1><div class="card">${IGP.ui.switchRow('relationshipNotifier','Track follow changes')}<div class="row"><span class="row-main"><span class="row-title">${IGP.util.escapeHTML(status)}</span><span class="row-detail">${record?.checkedAt ? `Checked ${IGP.util.escapeHTML(new Date(record.checkedAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}` : 'Not checked yet'}${pending ? `<br>${pending} ${pending === 1 ? 'change needs' : 'changes need'} another check` : ''}</span></span></div><div class="row"><button class="button" data-check type="button" ${!IGP.util.accountId() || !IGP.state.settings.relationshipNotifier ? 'disabled' : ''}>${IGP.ui.icon('refresh', 17)} Check followers</button><button class="button" data-alerts type="button" aria-label="Desktop alerts" aria-pressed="${IGP.state.settings.desktopNotifications}">${IGP.ui.icon('bell', 19)} Alerts</button></div></div><section class="section"><div class="toolbar"><h2 class="section-title" style="flex:1;margin:0">History</h2><button class="button" data-clear type="button" ${events.length ? '' : 'disabled'}>Clear history</button></div><div class="card">${events.length ? events.map(event => `<a class="row action" href="/${encodeURIComponent(event.person.username)}/"><span class="row-icon">${IGP.ui.icon(event.change === 'added' ? 'plus' : 'minus', 18)}</span><span class="row-main"><span class="row-title">${IGP.util.escapeHTML(IGP.social.eventText(event))}</span><span class="row-detail">${IGP.util.escapeHTML(new Date(event.at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}</span></span></a>`).join('') : '<div class="empty">No changes yet</div>'}</div></section></div>`;
    IGP.ui.bindSettings(body);
    body.querySelector('[data-setting=relationshipNotifier]').addEventListener('change', () => { IGP.ui.showView('social',{activity:true}); body.querySelector('[data-setting=relationshipNotifier]')?.focus(); }, {signal:scope.signal});
    body.querySelector('[data-back]').addEventListener('click', () => IGP.ui.showView('overview'), { signal: scope.signal });
    body.querySelector('[data-check]')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try { await refreshSocial('activity'); }
      catch (error) { IGP.ui.notice(error?.message || 'The check could not finish.', { tone: 'error' }); }
      if (!scope.signal.aborted) IGP.ui.showView('social',{activity:true});
    }, { signal: scope.signal });
    body.querySelector('[data-clear]')?.addEventListener('click', async () => {
      if (!await IGP.ui.confirm({ title: 'Clear history?', message: 'Your saved follow changes will be deleted.', confirmLabel: 'Clear history' })) return;
      IGP.social.clearHistory();
      if (!scope.signal.aborted) IGP.ui.showView('social',{activity:true});
    }, { signal: scope.signal });
    body.querySelector('[data-alerts]')?.addEventListener('click', async () => {
      if (IGP.state.settings.desktopNotifications) IGP.setSetting('desktopNotifications', false);
      else {
        try {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') throw new Error();
          IGP.setSetting('desktopNotifications', true);
        } catch { IGP.ui.notice('Allow notifications in your browser first.', { tone: 'error' }); }
      }
      if (!scope.signal.aborted) IGP.ui.showView('social',{activity:true});
    }, { signal: scope.signal });
  }

  function renderSocial(body, scope, params) {
    if (params?.compare) return renderComparison(body, scope, false, params);
    if (params?.activity) return renderActivity(body, scope);
    IGP.ui.showView('overview');
  }

  IGP.ui.registerView('social', { label: 'Social', nav: false, render: renderSocial });
  IGP.bus.on('settings:changed', syncLegacySettings);
  IGP.legacy = { engine: legacyEngine, syncSettings: syncLegacySettings, launch: launchLegacy };
  }

  {
  const appState = { started: false };
  const reconcileSoon = IGP.util.debounce(reconcile, 100);
  function checkRoute() {
    if (location.href !== IGP.state.route) {
      IGP.state.routeScope?.close();
      IGP.state.routeScope = new IGP.util.Scope(`route:${location.pathname}`);
      IGP.state.route = location.href;
      IGP.bus.emit('route:changed', { current: location.href });
    }
    const account = IGP.util.accountId();
    if (account !== IGP.state.accountId) {
      IGP.social.cancel();
      IGP.state.accountId = account;
      IGP.bus.emit('account:changed', account);
    }
  }
  function reconcile() {
    if (!document.documentElement || document.hidden) return;
    checkRoute();
    IGP.runSafe('Interface', () => {
      IGP.ui.ensureRoot(); IGP.ui.tryNativeLauncher(); IGP.ui.syncTheme();
    });
    IGP.runSafe('Friend Activity', () => IGP.social.observeLoadedList());
  }
  function boot() {
    if (appState.started) return;
    appState.started = true;
    IGP.state.routeScope = new IGP.util.Scope(`route:${location.pathname}`);
    IGP.ui.ensureRoot(); IGP.legacy.syncSettings(); reconcile();
    // Share the established engine's filtered observer and SPA route watcher.
    PAGE.__IGP_SHELL_RECONCILE__ = reconcileSoon;
    window.addEventListener('resize', reconcileSoon, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reconcileSoon(); });
    window.addEventListener('pagehide', () => { IGP.social.cancel(); reconcileSoon.cancel(); });
    window.addEventListener('storage', event => {
      if (event.key !== SETTINGS_KEY || !event.newValue) return;
      IGP.state.settings = readSettings();
      IGP.bus.emit('settings:changed', { ...IGP.state.settings });
    });
    IGP.bus.on('settings:changed', reconcileSoon);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  IGP.app = { boot, reconcile, checkRoute, state: appState };
  }
})();
