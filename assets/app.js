/* Lee Ngari — portfolio runtime.
   Boots the real JoyDB engine (Go → WebAssembly) when the live section
   approaches the viewport, then wires the query console, table browser,
   visitor row form, and reset control. */

(() => {
  'use strict';

  const EXAMPLES = {
    career: 'SELECT company, role, period FROM experience ORDER BY start_date DESC',
    impact: 'SELECT e.company, m.label, m.value FROM experience AS e INNER JOIN metrics AS m ON e.id = m.experience_id ORDER BY e.id',
    go: "SELECT name, stack FROM projects WHERE language = 'Go'",
    stack: 'SELECT category, items FROM stack ORDER BY id',
    visitors: 'SELECT id, name, note, created_at FROM visitors ORDER BY id DESC',
    count: 'SELECT COUNT(*) AS projects FROM projects',
  };

  const TABLES = ['experience', 'projects', 'metrics', 'stack', 'visitors'];

  const els = {
    console: document.getElementById('console'),
    statusText: document.getElementById('console-status-text'),
    bootFact: document.getElementById('boot-fact'),
    output: document.getElementById('console-output'),
    note: document.getElementById('console-note'),
    form: document.getElementById('console-form'),
    input: document.getElementById('console-input'),
    run: document.querySelector('.console-run'),
    reset: document.getElementById('console-reset'),
    chips: Array.from(document.querySelectorAll('[data-example]')),
    tabQuery: document.getElementById('tab-query'),
    tabSchema: document.getElementById('tab-schema'),
    panelQuery: document.getElementById('panel-query'),
    panelSchema: document.getElementById('panel-schema'),
    visitorForm: document.getElementById('visitor-form'),
    visitorName: document.getElementById('visitor-name'),
    visitorNote: document.getElementById('visitor-note'),
    visitorStatus: document.getElementById('visitor-status'),
  };

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  if (!els.console || !els.output) return;

  let engine = null;
  let bootPromise = null;
  let bootFailed = false;
  let fallbackData = null;
  let hasRunDefault = false;
  let history = [];
  let historyIndex = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function setState(state, message) {
    els.console.dataset.state = state;
    els.statusText.textContent = message;
  }

  function setChipsEnabled(enabled) {
    for (const chip of els.chips) chip.disabled = !enabled;
  }

  function setVisitorEnabled(enabled) {
    if (els.visitorName) els.visitorName.disabled = !enabled;
    if (els.visitorNote) els.visitorNote.disabled = !enabled;
    if (els.visitorForm) {
      const submit = els.visitorForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = !enabled;
    }
  }

  function setVisitorStatus(message, isError) {
    if (!els.visitorStatus) return;
    els.visitorStatus.textContent = message;
    els.visitorStatus.classList.toggle('is-error', Boolean(isError));
  }

  function statementKeyword(sql) {
    const match = String(sql).trim().match(/^([a-zA-Z]+)/);
    return match ? match[1].toUpperCase() : '';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-src="' + src + '"]')) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.dataset.src = src;
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(script);
    });
  }

  async function boot() {
    if (bootPromise) return bootPromise;

    setState('booting', 'BOOTING');
    setChipsEnabled(false);
    if (els.input) els.input.disabled = true;
    if (els.run) els.run.disabled = true;
    if (els.reset) els.reset.disabled = true;

    bootPromise = (async () => {
      try {
        await loadScript('wasm/wasm_exec.js');
        if (typeof window.Go !== 'function') {
          throw new Error('Go WebAssembly runtime is unavailable');
        }

        const go = new window.Go();
        const response = await fetch('wasm/joydb.wasm');
        if (!response.ok) {
          throw new Error('WASM download failed (' + response.status + ')');
        }

        let instance;
        try {
          const streamed = await WebAssembly.instantiateStreaming(response.clone(), go.importObject);
          instance = streamed.instance;
        } catch (streamError) {
          const bytes = await response.arrayBuffer();
          const compiled = await WebAssembly.instantiate(bytes, go.importObject);
          instance = compiled.instance;
        }

        const running = go.run(instance);
        if (running && typeof running.catch === 'function') {
          running.catch((error) => console.error('JoyDB runtime stopped', error));
        }

        const deadline = Date.now() + 15000;
        while (!window.JoyDB && Date.now() < deadline) {
          await sleep(30);
        }
        if (!window.JoyDB) throw new Error('JoyDB did not start');
        if (!window.JoyDB.ready) {
          throw new Error(window.JoyDB.initError || 'JoyDB failed to boot');
        }

        engine = window.JoyDB;
        const bootMs = Math.max(1, Math.round(engine.bootMs));
        setState('ready', 'READY · ' + bootMs + 'MS');
        if (els.bootFact) els.bootFact.textContent = bootMs + ' ms, on this device';
        if (els.input) els.input.disabled = false;
        if (els.run) els.run.disabled = false;
        if (els.reset) els.reset.disabled = false;
        setVisitorEnabled(true);
        setChipsEnabled(true);
        refreshCounts();
        return engine;
      } catch (error) {
        bootFailed = true;
        console.error('JoyDB boot failed', error);
        setState('error', 'FALLBACK');
        if (els.bootFact) els.bootFact.textContent = 'WebAssembly unavailable';
        if (els.note) {
          els.note.textContent =
            'WebAssembly is unavailable here. The example buttons still work from a static copy of the data.';
        }
        if (els.input) {
          els.input.disabled = true;
          els.input.placeholder = 'Free-form SQL needs WebAssembly';
        }
        if (els.run) els.run.disabled = true;
        if (els.reset) els.reset.disabled = true;
        setVisitorEnabled(false);
        setVisitorStatus('Writes need WebAssembly.', true);
        setChipsEnabled(true);
        loadFallback().catch(() => {});
        return null;
      }
    })();

    return bootPromise;
  }

  async function loadFallback() {
    if (fallbackData) return fallbackData;
    const response = await fetch('data/content.json');
    if (!response.ok) throw new Error('could not load fallback data');
    fallbackData = await response.json();
    refreshCounts();
    return fallbackData;
  }

  async function runFallback(exampleId) {
    const data = await loadFallback();
    let columns;
    let rows;

    if (String(exampleId).startsWith('table-')) {
      const table = exampleId.slice(6);
      const source = data[table] || [];
      columns = source.length ? Object.keys(source[0]) : [];
      rows = source.map((row) => columns.map((column) => (row[column] === undefined ? null : row[column])));
      return { ok: true, columns, rows, count: rows.length, elapsedMs: 0 };
    }

    switch (exampleId) {
      case 'career': {
        columns = ['company', 'role', 'period'];
        rows = [...data.experience]
          .sort((a, b) => b.start_date.localeCompare(a.start_date))
          .map((row) => [row.company, row.role, row.period]);
        break;
      }
      case 'impact': {
        const byId = new Map(data.experience.map((row) => [row.id, row]));
        columns = ['company', 'label', 'value'];
        rows = [...data.metrics]
          .sort((a, b) => a.id - b.id)
          .map((metric) => [byId.get(metric.experience_id)?.company ?? null, metric.label, metric.value]);
        break;
      }
      case 'go': {
        columns = ['name', 'stack'];
        rows = data.projects.filter((row) => row.language === 'Go').map((row) => [row.name, row.stack]);
        break;
      }
      case 'stack': {
        columns = ['category', 'items'];
        rows = data.stack.map((row) => [row.category, row.items]);
        break;
      }
      case 'visitors': {
        columns = ['id', 'name', 'note', 'created_at'];
        rows = [...(data.visitors || [])]
          .sort((a, b) => b.id - a.id)
          .map((row) => [row.id, row.name, row.note, row.created_at]);
        break;
      }
      case 'count':
      default: {
        columns = ['projects'];
        rows = [[data.projects.length]];
        break;
      }
    }

    return { ok: true, columns, rows, count: rows.length, elapsedMs: 0 };
  }

  function clearChipState() {
    for (const chip of els.chips) chip.removeAttribute('aria-pressed');
  }

  function renderResult(response, sourceLabel) {
    els.output.replaceChildren();

    if (!response.ok) {
      const error = document.createElement('p');
      error.className = 'console-error';
      error.textContent = response.error || 'Query failed';
      els.output.appendChild(error);
      return;
    }

    const meta = document.createElement('p');
    meta.className = 'console-meta';
    const elapsedRaw = Number(response.elapsedMs || 0);
    const elapsed = elapsedRaw > 0.005 ? elapsedRaw.toFixed(2) : '< 0.01';
    meta.textContent =
      response.count +
      (response.count === 1 ? ' row' : ' rows') +
      ' · ' +
      elapsed +
      ' ms · ' +
      sourceLabel +
      (response.truncated ? ' · truncated' : '');
    els.output.appendChild(meta);

    if (!response.rows || response.rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'console-placeholder';
      empty.textContent = '0 rows returned.';
      els.output.appendChild(empty);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'result-wrap';

    const table = document.createElement('table');
    table.className = 'result-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const column of response.columns || []) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = String(column);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of response.rows) {
      const tr = document.createElement('tr');
      for (const value of row) {
        const td = document.createElement('td');
        if (value === null || value === undefined) {
          td.textContent = 'NULL';
          td.className = 'null';
        } else {
          td.textContent = String(value);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    els.output.appendChild(wrap);
  }

  function renderWriteResult(response) {
    els.output.replaceChildren();

    if (!response.ok) {
      const error = document.createElement('p');
      error.className = 'console-error';
      error.textContent = response.error || 'Write failed';
      els.output.appendChild(error);
      return;
    }

    const elapsedRaw = Number(response.elapsedMs || 0);
    const elapsed = elapsedRaw > 0.005 ? elapsedRaw.toFixed(2) : '< 0.01';
    const meta = document.createElement('p');
    meta.className = 'console-meta';
    meta.textContent = elapsed + ' ms · JoyDB / WASM';
    els.output.appendChild(meta);

    const box = document.createElement('div');
    box.className = 'write-result';
    const mark = document.createElement('span');
    mark.className = 'write-mark';
    mark.textContent = '✓';
    const text = document.createElement('span');
    const affected = Number(response.rowsAffected || 0);
    text.textContent =
      (response.message || 'Statement executed') +
      ' — ' +
      affected +
      (affected === 1 ? ' row affected' : ' rows affected');
    box.append(mark, text);
    els.output.appendChild(box);
  }

  async function refreshCounts() {
    for (const table of TABLES) {
      let count = '—';
      if (engine) {
        try {
          const response = JSON.parse(engine.query('SELECT COUNT(*) AS n FROM ' + table));
          if (response.ok && response.rows && response.rows[0]) {
            count = String(response.rows[0][0]);
          }
        } catch (error) {
          /* leave the em dash */
        }
      } else if (fallbackData) {
        count = String((fallbackData[table] || []).length);
      }
      const el = document.querySelector('[data-count="' + table + '"]');
      if (el) el.textContent = count;
    }
  }

  async function execute(sql, exampleId) {
    const query = String(sql || '').trim();
    if (!query) return;

    if (els.input) els.input.value = query;

    if (!engine) {
      if (!bootPromise) await boot();
      else await bootPromise;
    }

    if (engine) {
      const keyword = statementKeyword(query);
      try {
        if (keyword === 'SELECT') {
          const response = JSON.parse(engine.query(query));
          renderResult(response, 'JoyDB / WASM');
        } else if (keyword === 'INSERT' || keyword === 'UPDATE' || keyword === 'DELETE') {
          const response = JSON.parse(engine.exec(query));
          renderWriteResult(response);
          if (response.ok) refreshCounts();
        } else {
          renderResult(
            {
              ok: false,
              error:
                'DDL is disabled in this demo. Only SELECT, INSERT, UPDATE, and DELETE are enabled — use reset to restore the seed.',
            },
            'JoyDB / WASM'
          );
        }
      } catch (error) {
        renderResult({ ok: false, error: 'Engine error: ' + error.message }, 'JoyDB / WASM');
      }
      return;
    }

    if (exampleId) {
      try {
        const response = await runFallback(exampleId);
        renderResult(response, 'static fallback');
      } catch (error) {
        renderResult({ ok: false, error: 'Fallback data could not be loaded.' }, 'static fallback');
      }
      return;
    }

    renderResult(
      {
        ok: false,
        error:
          'Writes and free-form SQL need WebAssembly, which did not load in this browser. The example buttons still work.',
      },
      'static fallback'
    );
  }

  function runExample(exampleId) {
    const sql = EXAMPLES[exampleId];
    if (!sql) return;
    clearChipState();
    const chip = els.chips.find((item) => item.dataset.example === exampleId);
    if (chip) chip.setAttribute('aria-pressed', 'true');
    execute(sql, exampleId);
  }

  async function runDefault() {
    if (hasRunDefault) return;
    hasRunDefault = true;
    if (!engine && !bootFailed) {
      await boot();
    }
    if (engine) {
      execute(EXAMPLES.career, 'career');
    } else {
      runExample('career');
    }
  }

  // Tabs
  function selectTab(name) {
    const isQuery = name === 'query';
    els.tabQuery.setAttribute('aria-selected', String(isQuery));
    els.tabSchema.setAttribute('aria-selected', String(!isQuery));
    els.panelQuery.hidden = !isQuery;
    els.panelSchema.hidden = isQuery;
  }

  if (els.tabQuery && els.tabSchema) {
    els.tabQuery.addEventListener('click', () => selectTab('query'));
    els.tabSchema.addEventListener('click', () => selectTab('schema'));
  }

  // Example chips
  for (const chip of els.chips) {
    chip.addEventListener('click', () => runExample(chip.dataset.example));
  }

  // Table browser
  for (const chip of document.querySelectorAll('[data-table]')) {
    chip.addEventListener('click', () => {
      const table = chip.dataset.table;
      if (!table || !TABLES.includes(table)) return;
      selectTab('query');
      clearChipState();
      const sql = 'SELECT * FROM ' + table;
      if (els.input) els.input.value = sql;
      execute(sql, 'table-' + table);
    });
  }

  // Form
  if (els.form) {
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const sql = els.input ? els.input.value : '';
      if (!sql.trim()) return;
      if (!history.length || history[history.length - 1] !== sql) history.push(sql);
      historyIndex = history.length;
      clearChipState();
      execute(sql, null);
    });
  }

  // Query history
  if (els.input) {
    els.input.addEventListener('keydown', (event) => {
      if (!history.length) return;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        historyIndex = Math.max(0, historyIndex - 1);
        els.input.value = history[historyIndex] || '';
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        historyIndex = Math.min(history.length, historyIndex + 1);
        els.input.value = history[historyIndex] || '';
      }
    });
  }

  // Reset
  if (els.reset) {
    els.reset.addEventListener('click', async () => {
      if (!engine) return;
      els.reset.disabled = true;
      try {
        const response = JSON.parse(engine.reset());
        if (!response.ok) throw new Error(response.error || 'reset failed');
        if (els.visitorForm) els.visitorForm.reset();
        setVisitorStatus('', false);
        await refreshCounts();
        selectTab('query');
        clearChipState();
        await execute(EXAMPLES.career, 'career');
      } catch (error) {
        renderResult({ ok: false, error: 'Reset failed: ' + error.message }, 'JoyDB / WASM');
      } finally {
        els.reset.disabled = false;
      }
    });
  }

  // Visitor row
  if (els.visitorForm) {
    els.visitorForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = els.visitorName ? els.visitorName.value.trim() : '';
      const note = els.visitorNote ? els.visitorNote.value.trim() : '';

      if (!name) {
        setVisitorStatus('Give me a name first.', true);
        if (els.visitorName) els.visitorName.focus();
        return;
      }
      if (!engine) {
        setVisitorStatus('Writes need WebAssembly.', true);
        return;
      }

      try {
        const response = JSON.parse(engine.addVisitor(name, note));
        if (!response.ok) throw new Error(response.error || 'insert failed');

        els.visitorForm.reset();
        setVisitorStatus('Row added — id ' + response.id + '.', false);
        await refreshCounts();
        selectTab('query');
        clearChipState();
        const sql = 'SELECT id, name, note, created_at FROM visitors ORDER BY id DESC';
        if (els.input && !els.input.disabled) els.input.value = sql;
        await execute(sql, null);
      } catch (error) {
        setVisitorStatus(error.message, true);
      }
    });
  }

  // Boot when the live section gets close, or immediately if linked/clicked.
  const section = document.getElementById('joydb');
  const shouldBootNow = window.location.hash === '#joydb';

  if (shouldBootNow) {
    boot().then(runDefault);
  } else if ('IntersectionObserver' in window && section) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          boot().then(runDefault);
        }
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(section);
  } else {
    boot().then(runDefault);
  }

  // If a visitor jumps to the console before the observer fires.
  const heroQuery = document.querySelector('a[href="#joydb"]');
  if (heroQuery) {
    heroQuery.addEventListener('click', () => {
      boot().then(runDefault);
    });
  }
})();
