(function() {
  'use strict';
  const STORAGE_KEY = 'khw-decisions-v1';

  function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveAll(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('Could not save decision:', e); }
  }

  function getOption(id) {
    return document.querySelector('[data-option-id="' + CSS.escape(id) + '"]');
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function makeDot() {
    const dot = document.createElement('span');
    dot.className = 'dot';
    return dot;
  }

  function buildStatus(parent, opt) {
    clearChildren(parent);
    parent.appendChild(makeDot());
    if (!opt) {
      parent.appendChild(document.createTextNode('No decision saved yet — pick an option above to record it.'));
      parent.classList.remove('saved');
      return;
    }
    parent.classList.add('saved');
    parent.appendChild(document.createTextNode('Decision saved: '));
    const strong = document.createElement('strong');
    strong.textContent = opt.dataset.optionName || opt.dataset.optionId;
    parent.appendChild(strong);
    if (opt.classList.contains('recommended')) {
      const match = document.createElement('span');
      match.className = 'rec-match';
      match.textContent = '✓ matches recommendation';
      parent.appendChild(match);
    }
  }

  function initDecisionPage() {
    const root = document.documentElement;
    const questionId = root.dataset.questionId;
    if (!questionId) return;

    const state = loadAll();
    const currentSel = state[questionId];

    function applySelection(id, persist) {
      document.querySelectorAll('[data-option-id]').forEach(function(o) {
        o.classList.remove('selected');
      });
      let opt = null;
      if (id) {
        opt = getOption(id);
        if (opt) opt.classList.add('selected');
      }
      const status = document.querySelector('.decision-status');
      if (status) buildStatus(status, opt);
      const clearBtn = document.querySelector('.clear-decision');
      if (clearBtn) clearBtn.disabled = !id;
      if (persist) {
        const s = loadAll();
        if (id) s[questionId] = id;
        else delete s[questionId];
        saveAll(s);
      }
    }

    if (currentSel) applySelection(currentSel, false);
    else applySelection(null, false);

    document.querySelectorAll('[data-option-id]').forEach(function(opt) {
      opt.addEventListener('click', function(e) {
        if (e.target.tagName === 'A') return;
        applySelection(opt.dataset.optionId, true);
      });
      opt.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          applySelection(opt.dataset.optionId, true);
        }
      });
      opt.setAttribute('tabindex', '0');
      opt.setAttribute('role', 'button');
    });

    const clearBtn = document.querySelector('.clear-decision');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        applySelection(null, true);
      });
    }
  }

  function initNavStatus() {
    const state = loadAll();
    document.querySelectorAll('header.site .qnav a[data-qid]').forEach(function(a) {
      const qid = a.dataset.qid;
      if (state[qid]) a.classList.add('done');
    });
  }

  function initIndexPage() {
    if (!document.body.classList.contains('is-index')) return;
    const state = loadAll();
    let decidedCount = 0;
    document.querySelectorAll('.index-card').forEach(function(card) {
      const qid = card.dataset.qid;
      if (state[qid]) {
        decidedCount++;
        const status = card.querySelector('.ic-status');
        if (status) {
          status.classList.add('decided');
          status.textContent = '✓ Decided';
        }
      }
    });
    const total = document.querySelectorAll('.index-card').length;
    const fill = document.querySelector('.progress-fill');
    const count = document.querySelector('.progress-count');
    if (fill) fill.style.width = (decidedCount / total * 100) + '%';
    if (count) count.textContent = decidedCount + ' / ' + total;
  }

  function init() {
    initDecisionPage();
    initNavStatus();
    initIndexPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
