/*
 * zira_go_privacy_shield.js
 * -----------------------------------------------------------------------
 * IMPORTANT, HONEST LIMITATION UP FRONT:
 * No website can truly stop a device's OS-level screenshot or screen
 * recording feature — browsers do not expose that control, on desktop or
 * mobile. Anything claiming otherwise is not being straight with you.
 *
 * What this file *can* do, and does:
 *   1. Blur/hide the screen the instant the tab loses focus or is put in
 *      the background (app switcher, alt-tab, screen recording software
 *      that only captures what's on screen at grab-time). This is the
 *      single most effective real-world protection — it means a wallet
 *      balance or PIN screen isn't sitting there for an app-switcher
 *      thumbnail or an opportunistic recording to pick up.
 *   2. Disable right-click / long-press context menus and text selection
 *      on the sensitive panel chrome (not inside real inputs — typing
 *      still works normally).
 *   3. Block the common "view/copy page source" and devtools keyboard
 *      shortcuts, and Ctrl/Cmd+P printing of the page.
 *   4. Block copy/cut out of PIN and registration-number fields
 *      specifically, and disable dragging the logo/banner images.
 * None of this is a security boundary by itself — treat it as reducing
 * casual/opportunistic exposure, not as a guarantee.
 * -----------------------------------------------------------------------
 */
(function () {
  'use strict';

  function addStyle(css) {
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  addStyle(
    '.zira-privacy-blur-overlay{position:fixed;inset:0;z-index:2147483647;' +
    'background:var(--bg,#0b0512);display:none;align-items:center;justify-content:center;' +
    'backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);}' +
    '.zira-privacy-blur-overlay.active{display:flex}' +
    '.zira-privacy-blur-overlay span{font-family:inherit;font-weight:700;font-size:13px;' +
    'color:var(--text-dim,#9aa0b4);letter-spacing:.02em}' +
    'body.zira-no-select, body.zira-no-select *{-webkit-user-select:none;user-select:none;' +
    '-webkit-touch-callout:none;}' +
    'body.zira-no-select input, body.zira-no-select textarea{-webkit-user-select:text;user-select:text;}' +
    '@media print { html.zira-block-print body { display:none !important; } }'
  );

  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('zira-no-select');
    document.documentElement.classList.add('zira-block-print');

    var overlay = document.createElement('div');
    overlay.className = 'zira-privacy-blur-overlay';
    overlay.innerHTML = '<span>Content hidden while the app is in the background</span>';
    document.body.appendChild(overlay);

    function shield() { overlay.classList.add('active'); }
    function unshield() { overlay.classList.remove('active'); }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) shield(); else unshield();
    });
    window.addEventListener('blur', shield);
    window.addEventListener('focus', unshield);
    window.addEventListener('pagehide', shield);

    // No context menu on the panel chrome.
    document.addEventListener('contextmenu', function (e) {
      var editable = e.target.closest('input, textarea, [contenteditable="true"]');
      if (!editable) e.preventDefault();
    });

    // Block copy/cut specifically out of PIN and reg-no style fields.
    document.addEventListener('copy', blockIfSensitive);
    document.addEventListener('cut', blockIfSensitive);
    function blockIfSensitive(e) {
      var el = e.target;
      if (!el || !el.id) return;
      if (/pin|regno|reg_no/i.test(el.id)) e.preventDefault();
    }

    // Don't let logo/banner images be dragged out to save easily.
    document.querySelectorAll('img').forEach(function (img) {
      img.setAttribute('draggable', 'false');
    });

    // Best-effort: swallow common "inspect / view source / print" shortcuts.
    document.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      var blockedCombo =
        k === 'f12' ||
        (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) ||
        ((e.ctrlKey || e.metaKey) && (k === 'u' || k === 's' || k === 'p'));
      if (blockedCombo) e.preventDefault();
    });
  });
})();
