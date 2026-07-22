/**
 * Unified Sidebar Component — fotowisuda.ai
 * Injects an identical sidebar into all 5 pages.
 * Usage: <script src="/sidebar.js"></script>
 *        initUnifiedSidebar('page-name');
 */

(function() {
'use strict';

var API_BASE = window.location.origin;
var ACTIVE_PAGE = '';

// ═══ Nav link definitions ═══
var NAV_LINKS = [
    { id: 'home',           href: '/',               label: 'Home',              icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 shrink-0"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
    { id: 'swap-bg',        href: '/swap-bg',        label: 'Background Change', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 shrink-0"><rect x="9" y="9" width="13" height="13" rx="2.5"/><path d="M9 19.5l4.5-4.5 5 5"/><circle cx="17.5" cy="13" r="0.5" fill="currentColor" stroke="none"/><circle cx="7.5" cy="7.5" r="4.5"/><path d="M6 7.5h3M7.5 6l1.5 1.5-1.5 1.5"/></svg>', auth: true },
    { id: 'dress-swap',     href: '/dress-swap',      label: 'Dress Replicate',   icon: '<i class="fa-solid fa-shirt text-base w-5 shrink-0 text-center"></i>', auth: true },
    { id: 'filter-gallery', href: '/filter-gallery', label: 'Filter Gallery',    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 shrink-0"><path d="M2 19a1 1 0 0 0 1 1h12a1 1 0 0 0 .8-.4l-5.3-7.1a1.5 1.5 0 0 0-2.4 0L2.2 18.2A1 1 0 0 0 2 19z"/><path d="M11 19.5h9a1 1 0 0 0 .8-.4l-3.3-4.4a1.5 1.5 0 0 0-2.4 0l-1.3 1.7"/><circle cx="14" cy="6" r="2" fill="currentColor" stroke="none"/></svg>', auth: true },
    { id: 'my-creations',   href: '/my-creations',    label: 'My Creations',      icon: '<i class="fa-solid fa-images text-base w-5 shrink-0 text-center"></i>', auth: true },
    { id: 'pricing',        href: '/pricing',         label: 'Pricing / Top-Up',   icon: '<i class="fa-solid fa-coins text-base w-5 shrink-0 text-center" style="color:#fbbf24;"></i>' },
    { id: 'profile',         href: '/profile',          label: 'Masuk Sesi',         icon: '<i class="fa-solid fa-user text-base w-5 shrink-0 text-center"></i>' }
];

// ═══ LocalStorage helpers ═══
function getEmail() {
    try { return localStorage.getItem('active_user_email') || ''; } catch(_) { return ''; }
}

function setEmail(email) {
    try { localStorage.setItem('active_user_email', email); } catch(_) {}
}

function clearEmail() {
    try { localStorage.removeItem('active_user_email'); } catch(_) {}
}

// ═══ Inject Sidebar ═══
function injectSidebarHTML() {
    var html = '';
    // Overlay
    html += '<div id="unified-sidebar-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;" onclick="window._sidebarClose()"></div>';

    // Sidebar
    html += '<aside id="unified-sidebar" style="position:fixed;top:0;left:0;height:100%;width:260px;background:#0B0F19;border-right:1px solid #30363D;z-index:101;transform:translateX(-100%);transition:transform 0.3s ease;display:flex;flex-direction:column;padding:16px;box-sizing:border-box;">';

    // Header
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">';
    html += '<span style="font-size:10px;font-weight:700;color:#5c6370;text-transform:uppercase;letter-spacing:0.2em;">Navigation</span>';
    html += '<button onclick="window._sidebarClose()" style="background:none;border:none;color:#8B949E;cursor:pointer;font-size:20px;line-height:1;">&times;</button>';
    html += '</div>';

    // Nav links
    html += '<nav style="display:flex;flex-direction:column;gap:3px;flex:1;overflow-y:auto;">';
    for (var i = 0; i < NAV_LINKS.length; i++) {
        var link = NAV_LINKS[i];
        var isActive = link.id === ACTIVE_PAGE;
        var style = isActive
            ? 'color:#00D1FF;text-decoration:none;padding:10px 12px;border-radius:8px;font-size:13px;font-weight:600;background:rgba(0,209,255,0.08);border:1px solid rgba(0,209,255,0.15);display:flex;align-items:center;gap:10px;'
            : 'color:#8B949E;text-decoration:none;padding:10px 12px;border-radius:8px;font-size:13px;font-weight:500;display:flex;align-items:center;gap:10px;transition:all 0.15s;';
        var authAttr = link.auth ? ' data-auth="true"' : '';
        html += '<a href="' + link.href + '" style="' + style + '"' + authAttr + ' onmouseover="if(!this._active){this.style.background=\'rgba(255,255,255,0.03)\';this.style.color=\'#c4b5fd\'}" onmouseout="if(!this._active){this.style.background=\'transparent\';this.style.color=\'#8B949E\'}">';
        html += link.icon;
        html += '<span>' + link.label + '</span>';
        if (isActive) {
            html += '<span style="margin-left:auto;width:6px;height:6px;border-radius:50%;background:#00D1FF;box-shadow:0 0 6px #00D1FF;"></span>';
            // Tag for hover handlers
            html = html.replace('onmouseover', 'this._active=true;').replace('onmouseout', '');
        }
        html += '</a>';
        // Separator between Generators and Account sections
        if (link.id === 'filter-gallery') {
            html += '<div style="margin:4px 0;padding-top:4px;border-top:1px solid rgba(48,54,61,0.4);"></div>';
            html += '<span style="font-size:9px;font-weight:700;color:#5c6370;text-transform:uppercase;letter-spacing:0.15em;padding:4px 0 2px 0;display:block;">👤 Akun</span>';
        }
    }
    html += '</nav>';

    // Credit balance card
    html += '<div id="unified-credit-card" style="margin-top:12px;padding:12px;background:linear-gradient(135deg,rgba(0,209,255,0.04),rgba(157,91,255,0.04));border:1px solid rgba(0,209,255,0.15);border-radius:12px;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">';
    html += '<span style="font-size:10px;font-weight:700;color:#5c6370;text-transform:uppercase;letter-spacing:0.15em;">💰 Kredit</span>';
    html += '<button onclick="window._openTopUp()" style="background:rgba(0,209,255,0.1);border:1px solid rgba(0,209,255,0.2);color:#00D1FF;padding:4px 12px;border-radius:20px;font-size:9px;font-weight:700;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background=\'rgba(0,209,255,0.2)\';this.style.borderColor=\'rgba(0,209,255,0.4)\'" onmouseout="this.style.background=\'rgba(0,209,255,0.1)\';this.style.borderColor=\'rgba(0,209,255,0.2)\'">Isi Ulang</button>';
    html += '</div>';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00D1FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><ellipse cx="12" cy="6" rx="10" ry="3"/><path d="M2 6v6c0 1.66 4.48 3 10 3s10-1.34 10-3V6"/><path d="M2 12v6c0 1.66 4.48 3 10 3s10-1.34 10-3v-6"/></svg>';
    html += '<span id="unified-credit-balance" style="font-size:20px;font-weight:800;color:#F0F6FC;">—</span>';
    html += '<span style="font-size:10px;color:#8B949E;">kredit</span>';
    html += '</div>';
    html += '</div>';

    // User profile
    html += '<div id="unified-user-profile" style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(48,54,61,0.4);"></div>';

    html += '</aside>';

    // Inject into body
    var container = document.createElement('div');
    container.innerHTML = html;
    while (container.firstChild) {
        document.body.appendChild(container.firstChild);
    }

    // Auth guard: intercept clicks on protected links
    var sidebar = document.getElementById('unified-sidebar');
    if (sidebar) {
        sidebar.addEventListener('click', function(e) {
            var target = e.target.closest('a[data-auth="true"]');
            if (target && !getEmail()) {
                e.preventDefault();
                window.location.href = '/profile';
            }
        });
    }
}

// ═══ Render user profile ═══
function renderUserProfile() {
    var el = document.getElementById('unified-user-profile');
    if (!el) return;
    var email = getEmail();

    // Update Profile nav link label
    var profileLink = document.querySelector('#unified-sidebar nav a[href=\"/profile\"] span');
    if (profileLink) {
        profileLink.textContent = email ? 'Profile' : 'Masuk Sesi';
    }

    if (email) {
        // Derive short name: first segment before '@', split by '.', capitalize
        var namePart = email.split('@')[0].split('.')[0];
        var displayName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
        var initials = namePart.substring(0, 2).toUpperCase();
        el.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px;">' +
            '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:#0a0c10;border:1px solid #30363D;border-radius:10px;">' +
                '<div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#00D1FF,#9D5BFF);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">' + initials + '</div>' +
                '<div style="min-width:0;overflow:hidden;">' +
                    '<div style="font-size:11px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + displayName + '</div>' +
                    '<div style="font-size:9px;color:#8B949E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + email + '</div>' +
                '</div>' +
            '</div>' +
            '<button onclick="window._doLogout()" style="width:100%;padding:8px;background:rgba(255,180,171,0.1);border:1px solid rgba(255,180,171,0.2);color:#ffb4ab;border-radius:10px;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;"><i class="fa-solid fa-right-from-bracket"></i> Keluar Sesi</button>' +
        '</div>';
    } else {
        el.innerHTML = '<button onclick="window._openLogin()" style="width:100%;padding:10px;background:#0a0c10;border:1px solid #30363D;color:#c4b5fd;border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">' +
            '<i class="fa-solid fa-right-to-bracket"></i> Masuk Sesi</button>';
    }
}

// ═══ Credit balance fetch ═══
function fetchCreditBalance() {
    var display = document.getElementById('unified-credit-balance');
    if (!display) return;
    var email = getEmail();
    if (!email) { display.textContent = '0'; return; }
    try {
        fetch(API_BASE + '/api/credits/balance?email=' + encodeURIComponent(email))
            .then(function(r) { return r.json(); })
            .then(function(data) { display.textContent = data.credits_balance || 0; })
            .catch(function() { display.textContent = '—'; });
    } catch(_) { display.textContent = '—'; }
}

// ═══ Sidebar toggle ═══
function openSidebar() {
    var sb = document.getElementById('unified-sidebar');
    var ov = document.getElementById('unified-sidebar-overlay');
    if (sb) sb.style.transform = 'translateX(0)';
    if (ov) ov.style.display = 'block';
}

function closeSidebar() {
    var sb = document.getElementById('unified-sidebar');
    var ov = document.getElementById('unified-sidebar-overlay');
    if (sb) sb.style.transform = 'translateX(-100%)';
    if (ov) ov.style.display = 'none';
}

// ═══ Login/Logout ═══
function openLogin() {
    window.location.href = '/profile';
}

function doLogout() {
    clearEmail();
    window.location.href = '/';
}

// ═══ Top-up ═══
function openTopUp() {
    window.location.href = '/pricing';
}

// ═══ Public API ═══
window.initUnifiedSidebar = function(activePage) {
    ACTIVE_PAGE = activePage || '';
    injectSidebarHTML();
    renderUserProfile();
    fetchCreditBalance();

    // Expose global handlers
    window._sidebarGetEmail = getEmail;
    window._sidebarOpen  = openSidebar;
    window._sidebarClose = closeSidebar;
    window._openLogin    = openLogin;
    window._doLogout     = doLogout;
    window._openTopUp    = openTopUp;
    window._refreshCredits = fetchCreditBalance;
    window._renderUserProfile = renderUserProfile;

    // Watch for storage changes (login/logout in other tabs)
    window.addEventListener('storage', function(e) {
        if (e.key === 'active_user_email') {
            renderUserProfile();
            fetchCreditBalance();
        }
    });

    console.log('[sidebar] Unified sidebar initialized — active: ' + ACTIVE_PAGE);
};

// ═══ Auto-connect existing hamburger buttons ═══
document.addEventListener('DOMContentLoaded', function() {
    // Try to wire up existing toggle buttons
    setTimeout(function() {
        var toggleBtn = document.getElementById('sidebar-toggle-btn') || document.getElementById('sidebar-toggle');
        if (toggleBtn && !toggleBtn._wired) {
            toggleBtn._wired = true;
            toggleBtn.addEventListener('click', openSidebar);
        }
    }, 100);
});

})();
