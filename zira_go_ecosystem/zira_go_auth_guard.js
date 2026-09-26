/*
 * zira_go_auth_guard.js
 * -----------------------------------------------------------------------
 * Stops the "paste the link and you're in" problem: this file MUST be the
 * first <script> loaded in <head> (before any body markup renders) on every
 * page that shows real account data (admin panel, driver panel, student
 * wallet, account settings).
 *
 * What it does, in order, before a single pixel of the real page is shown:
 *   1. Hides <html> immediately (visibility:hidden) so there is zero flash
 *      of dashboard content while we check things.
 *   2. Looks for a locally-stored session token for the role this page
 *      expects.
 *   3. Confirms that token with the server (GET /api/auth/me) — a token
 *      that is missing, expired, tampered with, or belongs to the wrong
 *      role never gets past this point.
 *   4. Only then reveals the page. Anything else, and the visitor is sent
 *      straight to the correct login screen with the (invalid) session
 *      wiped, no dashboard skeleton ever shown.
 *
 * It also re-runs the check whenever the page is restored from the
 * back/forward cache, so hitting "back" after logging out never shows a
 * stale, already-rendered copy of a protected page.
 * -----------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var AUTH_KEYS = ['zira_token', 'zira_role', 'zira_id', 'zira_name', 'zira_reg_no', 'zira_email',
    'zira_admin_token', 'zira_admin_id'];

  function clearSession() {
    AUTH_KEYS.forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    });
  }

  function hide() {
    try { document.documentElement.style.visibility = 'hidden'; } catch (e) { /* ignore */ }
  }

  function reveal() {
    try { document.documentElement.style.visibility = 'visible'; } catch (e) { /* ignore */ }
  }

  function bounce(loginUrl) {
    clearSession();
    global.location.replace(loginUrl);
  }

  function tokenForRole(role) {
    if (role === 'admin') return localStorage.getItem('zira_admin_token') || '';
    return localStorage.getItem('zira_token') || '';
  }

  function verify(token, onOk, onFail) {
    fetch('/api/auth/me', {
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('unauthorized');
      return r.json();
    }).then(onOk).catch(onFail);
  }

  /**
   * protect(allowedRoles, opts)
   *  - allowedRoles: string or array of strings, e.g. 'admin' or ['student','driver']
   *  - opts.loginUrl: where to send an unauthenticated/failed visitor
   *  - opts.previewParam / opts.previewAllow: an existing "?adminPreview=x" style
   *    escape hatch some pages use to let a signed-in admin preview a student/
   *    driver screen. It is now ONLY honoured if a currently valid admin
   *    session is present — a bare query string can no longer unlock the page.
   */
  function protect(allowedRoles, opts) {
    opts = opts || {};
    var roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    var defaultLogin = roles.indexOf('admin') !== -1 ? 'zira_go_admin_login.html' : 'zira_go_login.html';
    var loginUrl = opts.loginUrl || defaultLogin;

    hide();

    var params = new URLSearchParams(global.location.search);
    var previewVal = opts.previewParam ? params.get(opts.previewParam) : null;

    if (opts.previewParam && previewVal === opts.previewAllow) {
      var adminToken = localStorage.getItem('zira_admin_token') || '';
      if (!adminToken) return bounce(loginUrl);
      return verify(adminToken, function (data) {
        if (data.role !== 'admin') return bounce(loginUrl);
        reveal();
      }, function () { bounce(loginUrl); });
    }

    // Try every candidate token for the roles this page accepts.
    var candidates = roles.map(tokenForRole).filter(Boolean);
    if (!candidates.length) return bounce(loginUrl);

    verify(candidates[0], function (data) {
      if (roles.indexOf(data.role) === -1) return bounce(loginUrl);
      reveal();
    }, function () { bounce(loginUrl); });
  }

  // Never show a cached, already-unlocked copy of a protected page from the
  // back/forward cache — force a fresh check every time it's (re)shown.
  global.addEventListener('pageshow', function (e) {
    if (e.persisted) global.location.reload();
  });

  global.ZiraGuard = { protect: protect, clearSession: clearSession };
})(window);
