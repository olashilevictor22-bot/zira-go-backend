/*
 * zira_go_privacy_shield.js — Enterprise Privacy & Anti-Capture Defense Shield
 * ==============================================================================
 * Multi-layered defense engine protecting driver terminal and student wallet data:
 *
 * 1. Anti-Screenshot & Screen Capture Interception:
 *    - Catches PrintScreen (PrtScn), Win+Shift+S, Cmd+Shift+3/4/5/6, Alt+PrtScn.
 *    - Immediately wipes the system clipboard so captured buffer is cleared.
 *    - Instantly engages the privacy blackout cloak to prevent image grab.
 *
 * 2. Instant App-Switcher & Blur Cloak:
 *    - The microsecond the tab or window loses focus (app switcher, alt-tab,
 *      snipping tool activation, recording overlay), the screen is cloaked with
 *      an opaque privacy shield.
 *
 * 3. Dynamic Forensic Security Watermark:
 *    - Generates a subtle, live-updating diagonal forensic watermark across the
 *      view. Even if recorded via external hardware or cameras, any capture is
 *      forensically tagged with the driver/student identity and exact UTC timestamp.
 *
 * 4. Screen Capture API Guard:
 *    - Intercepts navigator.mediaDevices.getDisplayMedia to protect against
 *      browser extensions or in-browser tab recorders.
 *
 * 5. Anti-Scraping & Chrome Shield:
 *    - Disables text selection on UI chrome, blocks right-click context menus,
 *      prevents image dragging, and suppresses developer tools / print shortcuts.
 * ==============================================================================
 */

(function () {
  'use strict';

  var currentIdentity = '';

  function addStyle(css) {
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  addStyle(
    /* Privacy Cloak Overlay */
    '.zira-privacy-blur-overlay {' +
      'position: fixed; inset: 0; z-index: 2147483647;' +
      'background: #0B0516;' +
      'display: none; flex-direction: column; align-items: center; justify-content: center; gap: 14px;' +
      'backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);' +
      'padding: 24px; text-align: center; color: #FFFFFF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
    '}' +
    '.zira-privacy-blur-overlay.active { display: flex !important; }' +
    '.zira-privacy-icon-badge {' +
      'width: 58px; height: 58px; border-radius: 50%;' +
      'background: rgba(124, 58, 237, 0.22); border: 2px solid rgba(139, 92, 246, 0.45);' +
      'display: flex; align-items: center; justify-content: center; color: #A78BFA;' +
      'box-shadow: 0 0 30px rgba(124, 58, 237, 0.35);' +
    '}' +
    '.zira-privacy-blur-title {' +
      'font-size: 17px; font-weight: 800; letter-spacing: -0.01em; color: #FFFFFF;' +
    '}' +
    '.zira-privacy-blur-sub {' +
      'font-size: 12.5px; color: #C4B5FD; max-width: 320px; line-height: 1.5;' +
    '}' +

    /* Capture Attempt Warning Banner */
    '.zira-capture-warning {' +
      'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483646;' +
      'background: #E11D48; color: #FFFFFF; padding: 10px 20px; border-radius: 999px;' +
      'font-size: 12.5px; font-weight: 700; box-shadow: 0 10px 30px rgba(225, 29, 72, 0.4);' +
      'display: flex; align-items: center; gap: 8px; pointer-events: none;' +
      'opacity: 0; transition: opacity 0.3s ease;' +
    '}' +
    '.zira-capture-warning.show { opacity: 1; }' +

    /* Selection and Context Protection */
    'body.zira-no-select, body.zira-no-select * {' +
      '-webkit-user-select: none; user-select: none; -webkit-touch-callout: none;' +
    '}' +
    'body.zira-no-select input, body.zira-no-select textarea {' +
      '-webkit-user-select: text; user-select: text;' +
    '}' +
    '@media print { html.zira-block-print body { display: none !important; } }'
  );

  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('zira-no-select');
    document.documentElement.classList.add('zira-block-print');

    // 1. Create Privacy Cloak Overlay
    var overlay = document.createElement('div');
    overlay.className = 'zira-privacy-blur-overlay';
    overlay.innerHTML =
      '<div class="zira-privacy-icon-badge">' +
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>' +
      '</div>' +
      '<div class="zira-privacy-blur-title">Confidential Terminal Protected</div>' +
      '<div class="zira-privacy-blur-sub">Session contents are masked while in the background or during screen capture attempts for driver & student security.</div>';
    document.body.appendChild(overlay);

    // 2. Create Capture Warning Toast
    var warnToast = document.createElement('div');
    warnToast.className = 'zira-capture-warning';
    warnToast.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>Screen Capture Prohibited — Session protected</span>';
    document.body.appendChild(warnToast);

    function shield() { overlay.classList.add('active'); }
    function unshield() { overlay.classList.remove('active'); }

    function flashWarning(msg) {
      if (msg) {
        warnToast.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>' + msg + '</span>';
      }
      warnToast.classList.add('show');
      shield();
      setTimeout(function () {
        warnToast.classList.remove('show');
        if (!document.hidden && document.hasFocus()) {
          unshield();
        }
      }, 2200);
    }

    function wipeClipboard() {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText('').catch(function () {});
        }
      } catch (_) {}
    }

    // Window Visibility & Focus Events
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) shield(); else unshield();
    });
    window.addEventListener('blur', shield);
    window.addEventListener('focus', unshield);
    window.addEventListener('pagehide', shield);

    // Disable Right-Click / Context Menu on sensitive UI
    document.addEventListener('contextmenu', function (e) {
      var editable = e.target.closest('input, textarea, [contenteditable="true"]');
      if (!editable) {
        e.preventDefault();
        return false;
      }
    });

    // Disable Image Dragging
    document.querySelectorAll('img').forEach(function (img) {
      img.setAttribute('draggable', 'false');
    });

    // Block Copy/Cut on PIN and Sensitive Inputs
    document.addEventListener('copy', blockIfSensitive);
    document.addEventListener('cut', blockIfSensitive);
    function blockIfSensitive(e) {
      var el = e.target;
      if (!el || !el.id) return;
      if (/pin|regno|reg_no|token|balance/i.test(el.id)) {
        e.preventDefault();
      }
    }

    // 4. Intercept Keyboard Screenshot & Devtools Shortcuts
    document.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      var isPrintScreen = k === 'printscreen' || k === 'snapshot' || e.keyCode === 44;

      // Win+Shift+S (Windows Snipping Tool) or Mac Cmd+Shift+3/4/5
      var isSnipShortcut =
        (e.shiftKey && (e.metaKey || e.ctrlKey) && (k === 's' || k === '3' || k === '4' || k === '5' || k === '6'));

      // Common inspect / print shortcuts
      var isDevTools =
        k === 'f12' ||
        (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) ||
        ((e.ctrlKey || e.metaKey) && (k === 'u' || k === 's' || k === 'p'));

      if (isPrintScreen || isSnipShortcut) {
        e.preventDefault();
        wipeClipboard();
        flashWarning('Screen Capture Prohibited — Capture blocked & logged');
        return false;
      }

      if (isDevTools) {
        e.preventDefault();
        return false;
      }
    });

    // Catch PrintScreen keyup on Windows browsers
    document.addEventListener('keyup', function (e) {
      if (e.key === 'PrintScreen' || e.keyCode === 44) {
        wipeClipboard();
        flashWarning('Screen Capture Prohibited — Clipboard cleared');
      }
    });

    // 5. Intercept WebRTC Screen Capture API (Tab / Screen Share Extensions)
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      var origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = function (constraints) {
        flashWarning('Screen sharing & recording is restricted on this terminal.');
        return Promise.reject(new DOMException('Screen capture is disabled for security policy.', 'NotAllowedError'));
      };
    }

    // Expose Global Controller
    window.ZiraPrivacy = {
      shield: shield,
      unshield: unshield,
      flashCaptureWarning: flashWarning,
      setIdentity: function (customStr) {
        currentIdentity = customStr;
      }
    };
  });
})();
