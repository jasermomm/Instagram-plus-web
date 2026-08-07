// ==UserScript==
// @name         Instagram Plus (Web)
// @namespace    https://greasyfork.org/
// @version      1.5.2
// @description  Instagram Web enhancements: Unicode bio fonts, local Story viewer search, anonymous Story mode, and local follower comparison from the IG+ menu.
// @author       Jasermomm
// @match        https://www.instagram.com/*
// @icon         https://www.instagram.com/static/images/ico/favicon-200.png/ab6eff595bb1.png
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const APP = 'igp-web';
  const VERSION = '1.5.2';
  const SETTINGS_KEY = `${APP}:settings:v2`;
  const POSITION_KEY = `${APP}:launcher-position:v2`;
  const PENDING_COMPARE_KEY = `${APP}:pending-follower-compare:v1`;
  const DEFAULTS = Object.freeze({
    bioFonts: true,
    viewerSearch: true,
    storyPreview: true,
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
    compareResumeScheduled: false,
    ownUsername: null,
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? { ...(fallback || {}), ...parsed } : (fallback ? { ...fallback } : null);
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
  function debounce(fn, delay = 100) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }
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

  function parseExactNumber(text) {
    const m = String(text || '').match(/([\d][\d,.]*)/);
    if (!m) return null;
    const n = Number(m[1].replace(/[,.](?=\d{3}\b)/g, '').replace(/,/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  // ---------------------------------------------------------------------------
  // Anonymous Story mode — Credit to Mobile46
  // ---------------------------------------------------------------------------
  function bodyContainsViewSeenAt(body) {
    try {
      if (typeof body === 'string') return body.includes('viewSeenAt');
      if (body instanceof URLSearchParams) return body.toString().includes('viewSeenAt');
      if (body instanceof FormData) {
        for (const [k, v] of body.entries()) {
          if (String(k).includes('viewSeenAt') || String(v).includes('viewSeenAt')) return true;
        }
      }
    } catch {}
    return false;
  }

  function installStorySeenGuard() {
    if (window.__IGP_STORY_SEEN_GUARD__) return;
    window.__IGP_STORY_SEEN_GUARD__ = true;
    const originalXMLSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      if (state.settings.storyPreview && bodyContainsViewSeenAt(args[0])) return;
      return originalXMLSend.apply(this, args);
    };
  }

  installStorySeenGuard();

  // ---------------------------------------------------------------------------
  // Main UI
  // ---------------------------------------------------------------------------
  const UI_FONT = 'Constantia, Cambria, "Times New Roman", serif';
  const GLOBAL_CSS = `
    :host {
      all: initial;
      color-scheme: light dark;
      --bg: rgba(255,255,255,.985);
      --fg: #0a0a0a;
      --muted: #737373;
      --bd: rgba(0,0,0,.14);
      --soft: rgba(0,0,0,.055);
      --soft2: rgba(0,0,0,.09);
      --strong: #000;
      --inverse: #fff;
      --shadow: 0 22px 70px rgba(0,0,0,.22);
      font-family: ${UI_FONT};
      font-size: 14px;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: rgba(15,15,15,.985);
        --fg: #f5f5f5;
        --muted: #aaa;
        --bd: rgba(255,255,255,.16);
        --soft: rgba(255,255,255,.075);
        --soft2: rgba(255,255,255,.12);
        --strong: #fff;
        --inverse: #000;
        --shadow: 0 24px 80px rgba(0,0,0,.55);
      }
    }
    * { box-sizing: border-box; }
    button,input,select { font-family: ${UI_FONT}; }
    button { color: inherit; }
    #igp-launcher {
      position: fixed;
      width: 50px; height: 50px;
      border: 1px solid var(--bd);
      border-radius: 999px;
      background: var(--bg); color: var(--fg);
      box-shadow: 0 8px 28px rgba(0,0,0,.18);
      z-index: 2147483646;
      display: grid; place-items: center;
      cursor: grab;
      font: 700 15px/1 ${UI_FONT};
      user-select: none; touch-action: none;
      pointer-events: auto;
      transition: transform .17s cubic-bezier(.22,1,.36,1), left .30s cubic-bezier(.22,1,.36,1), top .30s cubic-bezier(.22,1,.36,1), box-shadow .2s ease;
    }
    #igp-launcher:hover { transform: scale(1.045); box-shadow: 0 10px 34px rgba(0,0,0,.23); }
    #igp-launcher:active { transform: scale(.95); }
    #igp-launcher.dragging { cursor: grabbing; transform: scale(.90); transition: transform .11s ease; box-shadow: 0 16px 45px rgba(0,0,0,.28); }
    #igp-panel {
      position: fixed;
      width: min(365px, calc(100vw - 28px));
      border: 1px solid var(--bd);
      border-radius: 20px;
      background: var(--bg); color: var(--fg);
      box-shadow: var(--shadow);
      z-index: 2147483646;
      overflow: hidden;
      opacity: 0; transform: translateY(8px) scale(.97);
      pointer-events: none;
      transition: opacity .18s ease, transform .22s cubic-bezier(.22,1,.36,1), left .18s ease, top .18s ease;
      backdrop-filter: blur(22px);
      font-family: ${UI_FONT};
    }
    #igp-panel.open { opacity: 1; transform: none; pointer-events: auto; }
    .head { padding: 18px 18px 14px; border-bottom: 1px solid var(--bd); }
    .title { font: 700 20px/1.1 ${UI_FONT}; letter-spacing: -.02em; }
    .list { padding: 7px; }
    .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 10px; border-radius:13px; }
    .setting:hover { background: var(--soft); }
    .setting strong { font: 700 15px/1.2 ${UI_FONT}; display:block; letter-spacing:-.01em; }
    .menu-action { width:100%; border:1px solid var(--bd); border-radius:13px; background:var(--soft); color:var(--fg); padding:12px 14px; cursor:pointer; text-align:left; font:700 15px/1.2 ${UI_FONT}; letter-spacing:-.01em; transition:background .16s ease, transform .12s ease; }
    .menu-action:hover { background:var(--soft2); }
    .menu-action:active { transform:scale(.985); }
    .menu-action[disabled] { opacity:.55; cursor:default; transform:none; }
    .switch { position:relative; width:39px; height:22px; flex:none; }
    .switch input { opacity:0; width:0; height:0; position:absolute; }
    .slider { position:absolute; inset:0; border-radius:999px; background:var(--soft); border:1px solid var(--bd); cursor:pointer; transition:.18s; }
    .slider:before { content:""; position:absolute; width:16px; height:16px; left:2px; top:2px; border-radius:50%; background:var(--fg); transition:.18s; }
    .switch input:checked + .slider { background:var(--strong); border-color:var(--strong); }
    .switch input:checked + .slider:before { transform:translateX(17px); background:var(--inverse); }
    .foot { display:flex; justify-content:center; align-items:center; padding:11px 12px 13px; border-top:1px solid var(--bd); color:var(--muted); font:600 11px/1.3 ${UI_FONT}; }

    .igp-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      padding: 18px;
      pointer-events: auto;
      background: rgba(0,0,0,.48);
      backdrop-filter: blur(7px);
      animation: igpFade .16s ease both;
    }
    .igp-modal {
      width: min(470px, 100%);
      max-height: min(720px, calc(100vh - 36px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--bd);
      border-radius: 22px;
      background: var(--bg);
      color: var(--fg);
      box-shadow: var(--shadow);
      transform-origin: 50% 55%;
      animation: igpPop .22s cubic-bezier(.22,1,.36,1) both;
    }
    .igp-modal-head {
      flex: none;
      display: grid;
      grid-template-columns: 36px 1fr 36px;
      align-items: center;
      min-height: 58px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--bd);
    }
    .igp-modal-title { text-align:center; font:700 18px/1.2 ${UI_FONT}; letter-spacing:-.015em; }
    .igp-icon-btn {
      width: 34px; height: 34px;
      display:grid; place-items:center;
      border:0; border-radius:999px;
      background:transparent; color:var(--fg);
      cursor:pointer; font:400 24px/1 ${UI_FONT};
    }
    .igp-icon-btn:hover { background:var(--soft); }
    .igp-search-wrap { flex:none; padding:11px 13px; border-bottom:1px solid var(--bd); }
    .igp-search {
      width:100%; height:39px;
      border:0; outline:0; border-radius:11px;
      background:var(--soft); color:var(--fg);
      padding:0 13px;
      font:400 14px/39px ${UI_FONT};
    }
    .igp-search::placeholder { color:var(--muted); }
    .igp-tabs { flex:none; display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:8px; border-bottom:1px solid var(--bd); }
    .igp-tab { border:0; border-radius:10px; background:transparent; color:var(--muted); padding:9px 8px; cursor:pointer; font:700 13px/1.2 ${UI_FONT}; }
    .igp-tab.active { background:var(--soft2); color:var(--fg); }
    .igp-results { min-height:120px; overflow:auto; overscroll-behavior:contain; padding:4px 0; }
    .igp-person {
      display:grid;
      grid-template-columns:48px minmax(0,1fr) 28px;
      gap:11px;
      align-items:center;
      padding:9px 14px;
      color:var(--fg);
      text-decoration:none;
    }
    .igp-person:hover { background:var(--soft); }
    .igp-avatar {
      width:46px; height:46px;
      border-radius:50%; object-fit:cover;
      background:var(--soft2);
      border:1px solid var(--bd);
    }
    .igp-person-text { min-width:0; }
    .igp-username { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:700 14px/1.2 ${UI_FONT}; }
    .igp-name { margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font:400 13px/1.2 ${UI_FONT}; }
    .igp-heart { text-align:center; font:700 17px/1 ${UI_FONT}; }
    .igp-empty { padding:36px 18px; text-align:center; color:var(--muted); font:400 14px/1.4 ${UI_FONT}; }
    .igp-progress { padding:36px 22px 40px; text-align:center; }
    .igp-progress strong { display:block; font:700 18px/1.25 ${UI_FONT}; }
    .igp-progress span { display:block; margin-top:7px; color:var(--muted); font:400 13px/1.35 ${UI_FONT}; }
    .igp-spinner { width:28px; height:28px; margin:0 auto 16px; border:2px solid var(--soft2); border-top-color:var(--fg); border-radius:50%; animation:igpSpin .7s linear infinite; }
    @keyframes igpSpin { to { transform:rotate(360deg); } }
    @keyframes igpFade { from { opacity:0; } to { opacity:1; } }
    @keyframes igpPop { from { opacity:0; transform:scale(.965) translateY(7px); } to { opacity:1; transform:none; } }
  `;

  function ensureRoot() {
    if (state.rootHost?.isConnected || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = `${APP}-root`;
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${GLOBAL_CSS}</style><button id="igp-launcher" type="button" aria-label="Instagram Plus settings">IG+</button><div id="igp-panel"></div>`;
    document.documentElement.appendChild(host);
    state.rootHost = host;
    state.root = root;

    const launcher = root.getElementById('igp-launcher');
    installLauncherDrag(launcher);
    launcher.addEventListener('click', () => {
      if (Date.now() < state.suppressLauncherClickUntil) return;
      state.panelOpen = !state.panelOpen;
      renderPanel();
    });
    applyLauncherPosition();
    renderPanel();
  }

  function launcherBounds(launcher) {
    const vp = viewport();
    const margin = 14;
    const w = launcher.offsetWidth || 50;
    const h = launcher.offsetHeight || 50;
    return {
      minX: vp.left + margin,
      maxX: Math.max(vp.left + margin, vp.left + vp.width - w - margin),
      minY: vp.top + margin,
      maxY: Math.max(vp.top + margin, vp.top + vp.height - h - margin),
    };
  }

  function applyLauncherPosition() {
    if (!state.root) return;
    const launcher = state.root.getElementById('igp-launcher');
    if (!launcher) return;
    const b = launcherBounds(launcher);
    let x = Number.isFinite(state.launcherPosition?.x) ? state.launcherPosition.x : b.maxX;
    let y = Number.isFinite(state.launcherPosition?.y) ? state.launcherPosition.y : b.maxY;
    x = clamp(x, b.minX, b.maxX);
    y = clamp(y, b.minY, b.maxY);
    state.launcherPosition = { x, y };
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';
    launcher.style.left = `${x}px`;
    launcher.style.top = `${y}px`;
    saveLauncherPosition();
  }

  function installLauncherDrag(launcher) {
    let drag = null;
    launcher.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const r = launcher.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: r.left,
        top: r.top,
        moved: false,
      };
      launcher.setPointerCapture?.(event.pointerId);
    });

    launcher.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        launcher.classList.add('dragging');
      }
      if (!drag.moved) return;
      const b = launcherBounds(launcher);
      launcher.style.left = `${clamp(drag.left + dx, b.minX, b.maxX)}px`;
      launcher.style.top = `${clamp(drag.top + dy, b.minY, b.maxY)}px`;
      if (state.panelOpen) positionPanel();
    });

    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      launcher.releasePointerCapture?.(event.pointerId);
      launcher.classList.remove('dragging');
      if (drag.moved) {
        const r = launcher.getBoundingClientRect();
        const b = launcherBounds(launcher);
        const vp = viewport();
        const x = (r.left + r.width / 2) < (vp.left + vp.width / 2) ? b.minX : b.maxX;
        const y = clamp(r.top, b.minY, b.maxY);
        launcher.style.left = `${x}px`;
        launcher.style.top = `${y}px`;
        state.launcherPosition = { x, y };
        saveLauncherPosition();
        state.suppressLauncherClickUntil = Date.now() + 350;
        setTimeout(() => state.panelOpen && positionPanel(), 320);
      }
      drag = null;
    };

    launcher.addEventListener('pointerup', finish);
    launcher.addEventListener('pointercancel', finish);
  }

  function positionPanel() {
    if (!state.root) return;
    const panel = state.root.getElementById('igp-panel');
    const launcher = state.root.getElementById('igp-launcher');
    if (!panel || !launcher) return;
    const vp = viewport();
    const b = launcher.getBoundingClientRect();
    const w = panel.offsetWidth || 365;
    const h = panel.offsetHeight || 360;
    const gap = 10;
    const margin = 14;
    const left = clamp(
      b.left + b.width / 2 - w / 2,
      vp.left + margin,
      Math.max(vp.left + margin, vp.left + vp.width - w - margin)
    );
    const above = b.top - h - gap;
    const below = b.bottom + gap;
    const top = above >= vp.top + margin
      ? above
      : clamp(below, vp.top + margin, Math.max(vp.top + margin, vp.top + vp.height - h - margin));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function renderPanel() {
    if (!state.root) return;
    const panel = state.root.getElementById('igp-panel');
    panel.classList.toggle('open', state.panelOpen);
    const rows = [
      ['bioFonts', 'Bio Fonts'],
      ['viewerSearch', 'Viewer Search'],
      ['storyPreview', 'Story Preview'],
    ];
    panel.innerHTML = `
      <div class="head"><div class="title">Instagram Plus</div></div>
      <div class="list">
        ${rows.map(([key, name]) => `
          <label class="setting">
            <strong>${escapeHTML(name)}</strong>
            <span class="switch">
              <input type="checkbox" data-key="${key}" ${state.settings[key] ? 'checked' : ''}>
              <span class="slider"></span>
            </span>
          </label>`).join('')}
        <button id="igp-compare-followers" class="menu-action" type="button" ${state.followerCompareRunning ? 'disabled' : ''}>${state.followerCompareRunning ? 'Comparing…' : 'Compare Followers'}</button>
      </div>
      <div class="foot">Made by Jasermomm</div>`;

    panel.querySelectorAll('input[data-key]').forEach(input => {
      input.addEventListener('change', () => {
        state.settings[input.dataset.key] = input.checked;
        saveSettings();
        cleanupDisabledFeatures();
        scheduleScan(0);
      });
    });

    const compare = panel.querySelector('#igp-compare-followers');
    if (compare) compare.addEventListener('click', runFollowerCompare);

    if (state.panelOpen) requestAnimationFrame(positionPanel);
  }

  function cleanupDisabledFeatures() {
    if (!state.settings.bioFonts) {
      document.querySelectorAll('[data-igp-bio-toolbar-host]').forEach(el => el.remove());
    }
    if (!state.settings.viewerSearch) clearStorySession();
  }

  // ---------------------------------------------------------------------------
  // Reusable modal UI
  // ---------------------------------------------------------------------------
  function removeModal(id) {
    state.root?.getElementById(id)?.remove();
  }

  function createModalShell(id, title, { closeLabel = '×', onClose = null } = {}) {
    ensureRoot();
    removeModal(id);
    const backdrop = document.createElement('div');
    backdrop.id = id;
    backdrop.className = 'igp-modal-backdrop';
    backdrop.innerHTML = `
      <section class="igp-modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(title)}">
        <div class="igp-modal-head">
          <span></span>
          <div class="igp-modal-title">${escapeHTML(title)}</div>
          <button class="igp-icon-btn" type="button" aria-label="Close">${escapeHTML(closeLabel)}</button>
        </div>
        <div class="igp-modal-body"></div>
      </section>`;
    state.root.appendChild(backdrop);
    const close = () => {
      backdrop.remove();
      if (typeof onClose === 'function') onClose();
    };
    backdrop.querySelector('.igp-icon-btn').addEventListener('click', close);
    backdrop.addEventListener('pointerdown', event => {
      if (event.target === backdrop) close();
    });
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
    document.querySelectorAll('textarea').forEach(textarea => {
      if (textarea.dataset.igpBioEnhanced === '1' || !looksLikeBioTextarea(textarea)) return;
      textarea.dataset.igpBioEnhanced = '1';
      const host = document.createElement('span');
      host.dataset.igpBioToolbarHost = '1';
      host.style.cssText = 'display:block;margin-top:7px';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        :host{color-scheme:light dark;font-family:${UI_FONT}}
        .wrap{--bg:#fff;--fg:#111;--bd:rgba(0,0,0,.16);--muted:#737373;display:flex;align-items:center;gap:8px;color:var(--fg)}
        @media(prefers-color-scheme:dark){.wrap{--bg:#111;--fg:#f5f5f5;--bd:rgba(255,255,255,.16);--muted:#aaa}}
        select,button{border:1px solid var(--bd);background:var(--bg);color:var(--fg);border-radius:10px;min-height:34px;padding:5px 9px;font:600 12px ${UI_FONT}}
        button{cursor:pointer}.hint{font:400 10px ${UI_FONT};color:var(--muted)}
      </style>
      <div class="wrap">
        <select aria-label="Bio font">${Object.keys(FONT_MAPS).map(name => `<option>${escapeHTML(name)}</option>`).join('')}</select>
        <button type="button">Apply</button>
        <span class="hint">Unicode</span>
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
  } = {}) {
    collectPeopleBatch(dialog, map, { detectLiked });
    let scroller = findBestScroller(dialog);

    if (!scroller) {
      for (let i = 0; i < 20 && dialog.isConnected; i++) {
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

    for (let pass = 0; pass < maxPasses && dialog.isConnected; pass++) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(170);
      collectPeopleBatch(dialog, map, { detectLiked });

      let stable = 0;
      let bottomStable = 0;
      let lastCount = map.size;

      for (let round = 0; round < 260 && dialog.isConnected; round++) {
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
    shadow.innerHTML = `<style>
      :host{color-scheme:light dark;--bg:#efefef;--fg:#111;--bd:rgba(0,0,0,.10);font-family:${UI_FONT}}
      @media(prefers-color-scheme:dark){:host{--bg:#262626;--fg:#f5f5f5;--bd:rgba(255,255,255,.12)}}
      button{width:100%;height:38px;border:1px solid var(--bd);border-radius:11px;background:var(--bg);color:var(--fg);cursor:pointer;font:700 14px ${UI_FONT};transition:opacity .15s ease,transform .15s ease}
      button:not(:disabled):hover{transform:translateY(-1px)}button:disabled{cursor:progress;opacity:.72}
    </style><button type="button" disabled>Indexing viewers…</button>`;
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
      session.button.textContent = session.target ? `Indexing ${loaded}/${session.target}` : `Indexing ${loaded}`;
      return;
    }
    const complete = session.target ? loaded >= session.target : loaded > 0;
    session.button.disabled = !complete;
    session.button.textContent = complete ? `Search ${loaded} viewers` : `Indexing ${loaded}/${session.target || '?'}`;
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
      startStoryViewerSession(dialog);
    } else {
      placeViewerButton(session);
      updateViewerButton(session);
    }
  }

  // ---------------------------------------------------------------------------
  // Followers / Following comparison
  // ---------------------------------------------------------------------------
  function currentProfileRouteUsername() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length === 1 ? getProfileUsernameFromHref(`/${parts[0]}/`) : null;
  }

  function findOwnUsernameFromNavigation() {
    const anchors = [...document.querySelectorAll('a[href]')];

    for (const anchor of anchors) {
      const username = getProfileUsernameFromHref(anchor.href);
      if (!username) continue;
      const aria = (anchor.getAttribute('aria-label') || '').trim().toLocaleLowerCase();
      const title = (anchor.getAttribute('title') || '').trim().toLocaleLowerCase();
      const text = (anchor.innerText || '').trim().toLocaleLowerCase();
      if (aria === 'profile' || title === 'profile' || text === 'profile') return username;
      if (anchor.querySelector('svg[aria-label="Profile" i]')) return username;
    }

    return null;
  }

  function findOwnUsernameFromBootData() {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const script of scripts) {
      const text = script.textContent || '';
      const marker = text.indexOf('PolarisViewer');
      if (marker < 0) continue;
      const start = Math.max(0, marker - 6000);
      const end = Math.min(text.length, marker + 18000);
      const chunk = text.slice(start, end);
      const matches = [...chunk.matchAll(/"username"\s*:\s*"([^"\\]+)"/g)];
      if (matches.length) return matches[matches.length - 1][1];
    }
    return null;
  }

  function getOwnUsername() {
    const fromNav = findOwnUsernameFromNavigation();
    if (fromNav) {
      state.ownUsername = fromNav;
      return fromNav;
    }
    if (state.ownUsername) return state.ownUsername;
    const fromBoot = findOwnUsernameFromBootData();
    if (fromBoot) {
      state.ownUsername = fromBoot;
      return fromBoot;
    }
    return null;
  }

  function isOwnProfilePage() {
    const routeUsername = currentProfileRouteUsername();
    if (!routeUsername) return false;

    const ownUsername = getOwnUsername();
    if (ownUsername && normalizeUsername(ownUsername) === normalizeUsername(routeUsername)) return true;

    const main = document.querySelector('main');
    if (!main) return false;
    if (main.querySelector('a[href*="/accounts/edit"],a[href*="/accounts/center"]')) return true;
    const text = (main.innerText || '').toLocaleLowerCase();
    return /\bedit profile\b/.test(text)
      || /\bshare profile\b/.test(text)
      || /\bview archive\b/.test(text)
      || /\bprofessional dashboard\b/.test(text);
  }

  function findProfileListLink(kind) {
    const routeUsername = currentProfileRouteUsername();
    if (!routeUsername) return null;

    const main = document.querySelector('main') || document;
    const header = main.querySelector('header') || main;
    const wanted = `/${routeUsername}/${kind}/`.toLocaleLowerCase();

    const anchors = [...main.querySelectorAll('a[href]')].filter(anchor => {
      try {
        const path = new URL(anchor.href, location.origin).pathname.toLocaleLowerCase();
        return path === wanted || path.endsWith(`/${kind}/`);
      } catch {
        return false;
      }
    });
    const linked = anchors.find(isVisible) || anchors[0];
    if (linked) return linked;

    const word = kind === 'followers' ? /\bfollowers\b/i : /\bfollowing\b/i;
    const candidates = [...header.querySelectorAll('button,[role="button"],span,div')].filter(isVisible);
    for (const element of candidates) {
      const text = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`.trim();
      if (!word.test(text) || text.length > 100) continue;
      const clickable = element.matches('button,[role="button"],a[href]')
        ? element
        : element.closest('button,[role="button"],a[href]');
      if (clickable && isVisible(clickable)) return clickable;
    }
    return null;
  }


  function profileStatTarget(kind) {
    const link = findProfileListLink(kind);
    if (!link) return null;
    const text = `${link.innerText || ''} ${link.getAttribute('aria-label') || ''}`;
    if (/[kmb]\b/i.test(text)) return null;
    return parseExactNumber(text);
  }

  function getVisibleInstagramDialogs() {
    return [...document.querySelectorAll('[role="dialog"]')].filter(dialog => {
      if (!isVisible(dialog)) return false;
      return true;
    });
  }

  function peopleDialogLooksLike(dialog, kind) {
    if (!(dialog instanceof Element) || !isVisible(dialog)) return false;
    if (isStoryRoute() && isStoryViewerDialog(dialog)) return false;
    const wanted = kind === 'followers' ? /\bfollowers\b/i : /\bfollowing\b/i;
    const headingText = [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .map(el => `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`)
      .join(' ');
    if (wanted.test(headingText)) return true;
    const shortText = (dialog.innerText || '').slice(0, 500);
    if (wanted.test(shortText)) return true;
    return false;
  }

  async function waitForPeopleDialog(kind, before = new Set(), timeout = 10000) {
    const started = performance.now();
    let fallback = null;
    while (performance.now() - started < timeout) {
      const dialogs = getVisibleInstagramDialogs();
      const newDialogs = dialogs.filter(dialog => !before.has(dialog));
      const named = [...newDialogs, ...dialogs].find(dialog => peopleDialogLooksLike(dialog, kind));
      if (named) return named;

      if (!fallback) fallback = newDialogs.find(dialog => !(isStoryRoute() && isStoryViewerDialog(dialog))) || null;
      if (fallback?.isConnected) {
        const hasClose = !!fallback.querySelector('button[aria-label="Close" i],[role="button"][aria-label="Close" i],svg[aria-label*="close" i]');
        const rect = fallback.getBoundingClientRect();
        if (hasClose && rect.width >= 250 && rect.height >= 180 && performance.now() - started > 650) return fallback;
      }
      await sleep(80);
    }
    return fallback?.isConnected ? fallback : null;
  }

  function closeInstagramDialog(dialog) {
    if (!dialog?.isConnected) return;
    const directClose = dialog.querySelector('button[aria-label="Close" i],[role="button"][aria-label="Close" i]');
    if (directClose) {
      directClose.click();
      return;
    }
    const svgClose = [...dialog.querySelectorAll('svg[aria-label]')].find(svg => /close/i.test(svg.getAttribute('aria-label') || ''));
    const clickable = svgClose?.closest('button,[role="button"]');
    if (clickable) {
      clickable.click();
      return;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  }

  async function waitUntilDialogCloses(dialog, timeout = 3500) {
    const start = performance.now();
    while (dialog?.isConnected && performance.now() - start < timeout) await sleep(80);
  }

  async function waitForProfileListControls(timeout = 10000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const followers = findProfileListLink('followers');
      const following = findProfileListLink('following');
      if (followers && following) return { followers, following };
      await sleep(100);
    }
    const followers = findProfileListLink('followers');
    const following = findProfileListLink('following');
    return followers && following ? { followers, following } : null;
  }

  function findFollowerScroller(dialog) {
    if (!(dialog instanceof Element)) return null;
    const candidates = [dialog, ...dialog.querySelectorAll('div,ul,section')].filter(element => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.clientHeight < 90 || element.clientWidth < 180) return false;
      if (element.scrollHeight <= element.clientHeight + 20) return false;
      const style = getComputedStyle(element);
      return /(auto|scroll|overlay)/.test(style.overflowY) || /(auto|scroll|overlay)/.test(style.overflow);
    });

    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const profileAnchors = [...element.querySelectorAll('a[href]')].filter(a => getProfileUsernameFromHref(a.href));
      const rect = element.getBoundingClientRect();
      const score = profileAnchors.length * 5000
        + Math.min(200000, element.scrollHeight - element.clientHeight)
        + Math.min(1200, rect.height)
        + (rect.width >= 250 ? 500 : 0);
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  function collectFollowerBatch(dialog, people) {
    if (!(dialog instanceof Element)) return people.size;
    const anchors = [...dialog.querySelectorAll('a[href]')];
    for (const anchor of anchors) {
      const username = getProfileUsernameFromHref(anchor.href);
      if (!username) continue;
      const key = normalizeUsername(username);
      if (!key || people.has(key)) continue;

      const row = findPersonRow(anchor, dialog);
      if (!row) continue;
      const person = extractPerson(anchor, dialog);
      if (!person) continue;

      people.set(key, { ...person, key, order: people.size });
    }
    return people.size;
  }

  async function waitForFollowerListHydration(dialog, people, timeout = 9000) {
    const start = performance.now();
    while (dialog?.isConnected && performance.now() - start < timeout) {
      collectFollowerBatch(dialog, people);
      if (people.size > 0) return true;
      await sleep(100);
    }
    return people.size > 0;
  }

  async function walkFollowerDialog(dialog, people, { target = null, onProgress = null } = {}) {
    await waitForFollowerListHydration(dialog, people);
    onProgress?.(people.size, target);

    let scroller = null;
    for (let i = 0; i < 45 && dialog.isConnected; i++) {
      scroller = findFollowerScroller(dialog);
      if (scroller) break;
      collectFollowerBatch(dialog, people);
      if (target && people.size >= target) return;
      await sleep(100);
    }

    if (!scroller) {
      collectFollowerBatch(dialog, people);
      onProgress?.(people.size, target);
      return;
    }

    let unchangedRounds = 0;
    let bottomUnchanged = 0;
    let lastCount = people.size;
    let lastHeight = scroller.scrollHeight;

    for (let round = 0; round < 1600 && dialog.isConnected; round++) {
      collectFollowerBatch(dialog, people);
      onProgress?.(people.size, target);
      if (target && people.size >= target) return;

      if (!scroller.isConnected) {
        scroller = findFollowerScroller(dialog);
        if (!scroller) {
          await sleep(120);
          continue;
        }
      }

      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const beforeTop = scroller.scrollTop;
      const step = Math.max(220, Math.floor(scroller.clientHeight * 0.72));
      scroller.scrollTop = Math.min(maxTop, beforeTop + step);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      try {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true }));
      } catch {}
      await sleep(115);

      collectFollowerBatch(dialog, people);
      onProgress?.(people.size, target);

      const count = people.size;
      const height = scroller.scrollHeight;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= height - 12;
      if (count === lastCount) unchangedRounds += 1; else unchangedRounds = 0;
      if (atBottom && count === lastCount && Math.abs(height - lastHeight) <= 3) bottomUnchanged += 1;
      else if (!atBottom || count !== lastCount || Math.abs(height - lastHeight) > 3) bottomUnchanged = 0;
      lastCount = count;
      lastHeight = height;

      if (atBottom) {
        await sleep(240);
        collectFollowerBatch(dialog, people);
        onProgress?.(people.size, target);
        if (people.size !== lastCount || scroller.scrollHeight !== lastHeight) {
          lastCount = people.size;
          lastHeight = scroller.scrollHeight;
          unchangedRounds = 0;
          bottomUnchanged = 0;
          continue;
        }
      }

      if (!target && bottomUnchanged >= 10 && unchangedRounds >= 12) return;
      if (target && bottomUnchanged >= 16 && unchangedRounds >= 18) return;
    }
  }

  async function collectProfileList(kind, updateProgress) {
    const controls = await waitForProfileListControls(10000);
    const link = controls?.[kind] || findProfileListLink(kind);
    if (!link) throw new Error(`Could not find ${kind} control`);
    const target = profileStatTarget(kind);
    const beforeDialogs = new Set(getVisibleInstagramDialogs());

    try { link.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
    await sleep(80);
    link.click();

    const dialog = await waitForPeopleDialog(kind, beforeDialogs, 10000);
    if (!dialog) throw new Error(`Instagram did not open the ${kind} dialog`);

    const people = new Map();
    await walkFollowerDialog(dialog, people, {
      target,
      onProgress: (loaded, total) => updateProgress(kind, loaded, total),
    });

    if (!people.size && target !== 0) {
      closeInstagramDialog(dialog);
      await waitUntilDialogCloses(dialog);
      throw new Error(`No ${kind} accounts were captured`);
    }

    if (target && people.size < target) {
      closeInstagramDialog(dialog);
      await waitUntilDialogCloses(dialog);
      throw new Error(`Only captured ${people.size} of ${target} ${kind}`);
    }

    closeInstagramDialog(dialog);
    await waitUntilDialogCloses(dialog);
    await waitForProfileListControls(7000);
    await sleep(180);
    return people;
  }

  function openCompareProgressModal() {
    const modal = createModalShell('igp-follow-compare-modal', 'Followers Compare', {
      onClose: () => {
        state.focusedIGPInput = null;
      },
    });
    modal.body.innerHTML = `<div class="igp-progress"><div class="igp-spinner"></div><strong>Comparing</strong><span>Loading followers…</span></div>`;
    return {
      ...modal,
      set(kind, loaded, total) {
        const label = kind === 'followers' ? 'followers' : 'following';
        const suffix = total ? `${loaded}/${total}` : `${loaded}`;
        const span = modal.body.querySelector('.igp-progress span');
        if (span) span.textContent = `Loading ${label} ${suffix}`;
      },
      error(message) {
        modal.body.innerHTML = `<div class="igp-empty">${escapeHTML(message)}</div>`;
      },
    };
  }

  function showFollowerComparison(followersMap, followingMap) {
    const followers = new Set(followersMap.keys());
    const following = new Set(followingMap.keys());
    const dontFollowYou = [...followingMap.values()]
      .filter(person => !followers.has(person.key))
      .sort((a, b) => a.username.localeCompare(b.username));
    const youDontFollow = [...followersMap.values()]
      .filter(person => !following.has(person.key))
      .sort((a, b) => a.username.localeCompare(b.username));

    const modal = createModalShell('igp-follow-compare-modal', 'Followers Compare', {
      onClose: () => { state.focusedIGPInput = null; },
    });
    modal.body.innerHTML = `
      <div class="igp-tabs">
        <button class="igp-tab active" type="button" data-tab="dontFollowYou">Don't follow you · ${dontFollowYou.length}</button>
        <button class="igp-tab" type="button" data-tab="youDontFollow">You don't follow · ${youDontFollow.length}</button>
      </div>
      <div class="igp-search-wrap"><input class="igp-search" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search accounts"></div>
      <div class="igp-results"></div>`;

    const input = modal.body.querySelector('.igp-search');
    const results = modal.body.querySelector('.igp-results');
    let activeTab = 'dontFollowYou';

    const render = () => {
      const source = activeTab === 'dontFollowYou' ? dontFollowYou : youDontFollow;
      const q = input.value.trim().toLocaleLowerCase();
      const filtered = q ? source.filter(person => person.search.includes(q)) : source;
      renderPeopleList(results, filtered);
    };

    modal.body.querySelectorAll('.igp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        modal.body.querySelectorAll('.igp-tab').forEach(t => t.classList.toggle('active', t === tab));
        input.value = '';
        render();
      });
    });
    bindIGPInput(input, render);
    render();
  }

  function showFollowerCompareError(message) {
    const modal = createModalShell('igp-follow-compare-modal', 'Followers Compare');
    modal.body.innerHTML = `<div class="igp-empty">${escapeHTML(message)}</div>`;
  }

  function markPendingFollowerCompare(username) {
    try { sessionStorage.setItem(PENDING_COMPARE_KEY, username); } catch {}
  }

  function clearPendingFollowerCompare() {
    try { sessionStorage.removeItem(PENDING_COMPARE_KEY); } catch {}
  }

  function pendingFollowerCompareUsername() {
    try { return sessionStorage.getItem(PENDING_COMPARE_KEY); } catch { return null; }
  }

  function navigateToOwnProfileForCompare(username) {
    markPendingFollowerCompare(username);
    const path = `/${encodeURIComponent(username)}/`;
    if (location.pathname === path) {
      scheduleScan(0);
      return;
    }
    location.assign(path);
  }

  async function runFollowerCompareOnProfile() {
    if (state.followerCompareRunning) return;
    state.followerCompareRunning = true;
    state.panelOpen = false;
    renderPanel();
    const progress = openCompareProgressModal();
    try {
      const controls = await waitForProfileListControls(12000);
      if (!controls) throw new Error('Followers/Following controls did not finish loading');
      const followers = await collectProfileList('followers', (kind, loaded, total) => progress.set(kind, loaded, total));
      const following = await collectProfileList('following', (kind, loaded, total) => progress.set(kind, loaded, total));
      showFollowerComparison(followers, following);
    } catch (error) {
      console.warn('[Instagram Plus] follower comparison failed:', error);
      progress.error('Could not finish the comparison.');
    } finally {
      state.followerCompareRunning = false;
      renderPanel();
    }
  }

  async function runFollowerCompare() {
    if (state.followerCompareRunning) return;
    const ownUsername = getOwnUsername();
    if (!ownUsername) {
      state.panelOpen = false;
      renderPanel();
      showFollowerCompareError('Could not determine the logged-in profile.');
      return;
    }

    const routeUsername = currentProfileRouteUsername();
    if (!routeUsername || normalizeUsername(routeUsername) !== normalizeUsername(ownUsername)) {
      state.panelOpen = false;
      renderPanel();
      navigateToOwnProfileForCompare(ownUsername);
      return;
    }

    clearPendingFollowerCompare();
    await runFollowerCompareOnProfile();
  }

  function maybeResumePendingFollowerCompare() {
    if (state.followerCompareRunning || state.compareResumeScheduled) return;
    const pending = pendingFollowerCompareUsername();
    if (!pending) return;

    const routeUsername = currentProfileRouteUsername();
    if (!routeUsername || normalizeUsername(routeUsername) !== normalizeUsername(pending)) return;

    state.compareResumeScheduled = true;
    setTimeout(async () => {
      state.compareResumeScheduled = false;
      const stillPending = pendingFollowerCompareUsername();
      const current = currentProfileRouteUsername();
      if (!stillPending || !current || normalizeUsername(current) !== normalizeUsername(stillPending)) return;
      clearPendingFollowerCompare();
      await runFollowerCompareOnProfile();
    }, 500);
  }

  // shotrcut isolation
  window.addEventListener('keydown', event => {
    const input = state.focusedIGPInput;
    if (!input || !input.isConnected) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + event.key + input.value.slice(end);
    const pos = start + event.key.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, true);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function handleURLChange() {
    const previous = state.lastURL;
    const next = location.href;
    if (previous === next) return;
    state.lastURL = next;

    const oldStory = previous.includes('/stories/');
    const newStory = next.includes('/stories/');
    if (oldStory && (!newStory || storyRouteKey() !== state.storySession?.routeKey)) clearStorySession();
  }

  function scan() {
    ensureRoot();
    handleURLChange();
    enhanceBioFonts();
    enhanceStoryViewerSearch();
    maybeResumePendingFollowerCompare();
  }

  function scheduleScan(delay = 80) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scan, delay);
  }

  function installRouteWatcher() {
    const notify = () => {
      handleURLChange();
      scheduleScan(20);
    };
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original === 'function') {
        history[method] = function (...args) {
          const result = original.apply(this, args);
          queueMicrotask(notify);
          return result;
        };
      }
    }
    addEventListener('popstate', notify, true);
  }

  function boot() {
    ensureRoot();
    installRouteWatcher();
    new MutationObserver(debounce(() => scheduleScan(0), 90))
      .observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.panelOpen) {
        state.panelOpen = false;
        renderPanel();
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
