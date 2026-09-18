/* App wiring: menus, the Open dialog, the inspector, stats, autosave.
 *
 * State lives in one object. The project object IS the thing we POST back to
 * the server, so whatever you see in annotations/*.json is exactly what the UI
 * is holding. Mutate it, call markDirty(), done.
 */

const state = {
  root: null,
  scope: 'dataset',   // 'dataset' = the whole recording, 'file' = one mp4
  chunk: 0,
  file: 0,
  session: null,
  project: null,
  browsePath: null,
  browseDataset: null,
};

// Must match API_VERSION in app.py. See checkApi() for why this exists.
const API_VERSION = 2;

/** Throws instead of returning null: a missing id means the template and this
 *  script are out of step, and "can't access property textContent of null" a
 *  few frames later tells you nothing about which one. */
const $ = (id) => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(
      `No element with id "${id}". templates/index.html is out of step with app.js `
      + '(restart the server so Jinja re-reads the template, and hard-reload the page).');
  }
  return node;
};

/** For ids that are only present some of the time. */
const $opt = (id) => document.getElementById(id);
const player = new MultiView($('views'));

const timeline = new Timeline({
  bodyEl: $('tl-body'),
  scrollEl: $('tl-scroll'),
  rulerEl: $('ruler'),
  lanesEl: $('lanes'),
  headLanesEl: $('lane-heads'),
  playheadEl: $('playhead'),
  gridEl: $('grid'),
  getProject: () => state.project,
  onChange: () => { markDirty(); renderStats(); },
  onSeek: (t) => player.seek(t),
  onSelectClip: (clip, layer, focusEditor) => renderInspector(clip, layer, focusEditor),
  onSelectionChange: () => refreshCreateButton(),
  onClipPreview: (clip) => updateInspectorTimes(clip),
  onEditClip: () => { const ta = $opt('clip-text'); if (ta) { ta.focus(); ta.select(); } },
  onAddStyle: (name, layer) => addStyle(name, layer),
  onAutoAnnotate: (sel) => openAutoAnnotate(sel),
});

/* ---------------- saving ---------------- */

let saveState = 'idle';
function setSaveState(next, detail) {
  saveState = next;
  const node = $('save-state');
  node.dataset.state = next;
  node.textContent = { idle: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: detail || 'Save failed' }[next];
}

const saveSoon = U.debounce(() => saveNow(), 700);

function markDirty() {
  if (!state.project) return;
  setSaveState('dirty');
  saveSoon();
}

async function saveNow() {
  if (!state.project) return;
  setSaveState('saving');
  try {
    await U.api('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.project),
    });
    setSaveState('idle');
  } catch (err) {
    setSaveState('error', err.message);
    U.fail(err, 'Could not save');
  }
}

window.addEventListener('beforeunload', (e) => {
  if (saveState === 'dirty' || saveState === 'saving') { e.preventDefault(); e.returnValue = ''; }
});

/* ---------------- session ---------------- */

/** Catch the server and the frontend being different versions of this app.
 *  Without this you get a TypeError on session.timeline, several frames away
 *  from the actual cause. */
function checkApi(session) {
  if (session && session.api === API_VERSION) return;
  const got = session && session.api ? `v${session.api}` : 'an older response format';
  throw new Error(
    `The server is running a different version of this app (${got}, this page needs v${API_VERSION}). `
    + 'Restart the Flask process to pick up the current code.');
}

async function openSession(root, scope = 'dataset', chunk = 0, file = 0) {
  try {
    const q = `root=${encodeURIComponent(root)}&scope=${scope}&chunk=${chunk}&file=${file}`;
    const session = await U.api(`/api/session?${q}`);
    checkApi(session);
    Object.assign(state, { root, scope: session.scope, chunk, file, session, project: session.project });

    const tl = session.timeline;
    const label = session.scope === 'dataset'
      ? `whole recording · ${U.dur(tl.duration)}`
      : `chunk-${pad3(chunk)}/file-${pad3(file)}`;
    $('ds-name').textContent = `${session.dataset.name} · ${label}`;
    document.title = `${session.dataset.name} — segment annotator`;
    history.replaceState(null, '', `/?${q}`);

    renderScopeSelect(session);

    // Each view is its own playlist: v3 splits every video key independently
    // by file size, so the two cameras' file boundaries do not line up.
    const plan = Object.entries(tl.views).map(([key, p]) => ({
      key,
      segments: p.segments.map((seg) => ({
        start: seg.start,
        end: seg.end,
        label: `chunk-${pad3(seg.chunk_index)}/file-${pad3(seg.file_index)}`,
        url: `/media?root=${encodeURIComponent(root)}&path=${encodeURIComponent(seg.path)}`,
      })),
    }));

    timeline.activeLayerId = state.project.layers[0]?.id || null;
    timeline.selectedClipId = null;
    timeline.selection = null;
    timeline._fitted = false;
    timeline.setTimeline(tl);

    $('duration').textContent = `/ ${U.tc(tl.duration)}`;
    await player.load(plan, tl.fps, tl.duration);
    player.setRate(parseFloat($('rate').value));

    renderInspector(null, null);
    renderStats();
    setSaveState('idle');

    const files = Object.values(tl.views).reduce((n, p) => n + p.segments.length, 0);
    U.toast(`${session.dataset.name}: ${plan.length} view(s), ${files} file(s), ${U.dur(tl.duration)}`);
    for (const w of (tl.warnings || [])) U.toast(w, true);
  } catch (err) {
    U.fail(err, 'Opening session');
  }
}

const pad3 = (n) => String(n).padStart(3, '0');

function renderScopeSelect(session) {
  const select = $('file-select');
  select.innerHTML = '';
  const total = session.groups.length;
  select.appendChild(U.el('option', {
    value: 'dataset', text: `Whole recording (${total} file${total === 1 ? '' : 's'})`,
    selected: state.scope === 'dataset',
  }));
  for (const g of session.groups) {
    select.appendChild(U.el('option', {
      value: `file:${g.chunk_index}:${g.file_index}`,
      text: `Only ${g.key}`,
      selected: state.scope === 'file' && g.chunk_index === state.chunk && g.file_index === state.file,
    }));
  }
  select.onchange = () => {
    saveSoon.flush();
    if (select.value === 'dataset') return openSession(state.root, 'dataset');
    const [, c, f] = select.value.split(':');
    openSession(state.root, 'file', Number(c), Number(f));
  };
}

/* ---------------- global time -> source file ---------------- */

/** Mirror of store.locate(): which mp4 covers this global time, and where. */
function locate(t, viewKey) {
  const map = (state.project && state.project.timeline) || {};
  const key = viewKey || Object.keys(map)[0];
  for (const seg of (map[key] || [])) {
    if (seg.start <= t && t < seg.end) {
      return { view: key, seg, local: t - seg.start };
    }
  }
  return null;
}

function episodeAt(t) {
  for (const ep of (state.project?.episodes || [])) {
    if (ep.global_start <= t && (ep.global_end == null || t < ep.global_end)) return ep;
  }
  return null;
}

function sourceLine(t) {
  const where = locate(t);
  const ep = episodeAt(t);
  const bits = [];
  if (ep) bits.push(`episode ${ep.episode_index}`);
  if (where) {
    bits.push(`${where.view.split('.').pop()} chunk-${pad3(where.seg.chunk_index)}/file-${pad3(where.seg.file_index)}`);
    bits.push(`at ${U.tc(where.local)}`);
  }
  return bits.join(' · ');
}

/* ---------------- inspector ---------------- */

function renderInspector(clip, layer, focusEditor) {
  const host = $('inspector');
  host.innerHTML = '';
  if (!clip) {
    host.appendChild(U.el('p', {
      class: 'muted',
      text: 'Select a clip to edit it, or drag on a layer to mark a segment.',
    }));
    return;
  }
  const style = timeline.styleOf(layer);

  const timeField = (which) => U.el('input', {
    type: 'text', class: 'num', id: `clip-${which}`, value: clip[which].toFixed(3),
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (!isFinite(v)) { e.target.value = clip[which].toFixed(3); return; }
      const next = { ...clip, [which]: v };
      if (next.end - next.start < 1e-3) { e.target.value = clip[which].toFixed(3); return; }
      clip[which] = +v.toFixed(3);
      layer.clips.sort((a, b) => a.start - b.start);
      timeline.onChange('edit-clip');
      timeline.render();
      renderInspector(clip, layer);
    },
  });

  const text = U.el('textarea', {
    id: 'clip-text', placeholder: 'What happens in this segment?', spellcheck: 'true',
    oninput: (e) => {
      clip.text = e.target.value;
      clip.updated_at = new Date().toISOString();
      const node = timeline.lanesEl.querySelector(`.clip[data-clip="${clip.id}"]`);
      if (node) {
        node.querySelector('.label').textContent = clip.text.trim() || 'untitled';
        node.classList.toggle('empty', !clip.text.trim());
      }
      markDirty();
    },
  });
  text.value = clip.text || '';

  host.append(
    U.el('div', { class: 'row' }, [
      U.el('span', { class: 'style-tag' }, [
        U.el('span', { class: 'swatch', style: { background: style.color } }),
        U.el('span', { text: style.name }),
      ]),
      U.el('span', { class: 'muted', style: { marginLeft: 'auto' }, text: U.dur(clip.end - clip.start) }),
    ]),
    U.el('div', { class: 'row' }, [U.el('label', { text: 'Start' }), timeField('start'),
      U.el('button', {
        class: 'btn small', type: 'button', text: '↧', title: 'Set start to playhead',
        onclick: () => { clip.start = Math.min(+timeline.playhead.toFixed(3), clip.end - 0.01); timeline.onChange('edit'); timeline.render(); renderInspector(clip, layer); },
      })]),
    U.el('div', { class: 'row' }, [U.el('label', { text: 'End' }), timeField('end'),
      U.el('button', {
        class: 'btn small', type: 'button', text: '↧', title: 'Set end to playhead',
        onclick: () => { clip.end = Math.max(+timeline.playhead.toFixed(3), clip.start + 0.01); timeline.onChange('edit'); timeline.render(); renderInspector(clip, layer); },
      })]),
    text,
    U.el('div', { class: 'muted', style: { fontSize: '11px' }, text: sourceLine(clip.start) }),
    U.el('div', { class: 'row' }, [
      U.el('button', { class: 'btn', type: 'button', text: 'Go to start', onclick: () => player.seek(clip.start) }),
      U.el('button', {
        class: 'btn', type: 'button', text: 'Delete clip',
        style: { marginLeft: 'auto', color: 'var(--danger)' },
        onclick: () => timeline.deleteClip(clip.id),
      }),
    ]),
  );

  if (focusEditor) text.focus();
}

function updateInspectorTimes(clip) {
  if (!clip || timeline.selectedClipId !== clip.id) return;
  const s = $opt('clip-start');
  const e = $opt('clip-end');
  if (s) s.value = clip.start.toFixed(3);
  if (e) e.value = clip.end.toFixed(3);
}

/* ---------------- stats ---------------- */

function renderStats() {
  const host = $('stats');
  host.innerHTML = '';
  const p = state.project;
  if (!p) return;

  const styles = new Map(p.styles.map((s) => [s.id, s]));
  const files = Object.values(p.timeline || {}).reduce((n, segs) => n + segs.length, 0);
  const rows = [
    ['Duration', U.tc(p.duration || 0, false)],
    ['Frame rate', `${p.dataset.fps} fps`],
    ['Views', String(p.views.length)],
    ['Video files', String(files)],
    ['Episodes', String((p.episodes || []).length)],
    ['Layers', String(p.layers.length)],
  ];

  let total = 0;
  let covered = 0;
  for (const layer of p.layers) {
    total += layer.clips.length;
    for (const c of layer.clips) covered += c.end - c.start;
  }
  rows.push(['Clips', String(total)]);
  rows.push(['Annotated', `${U.dur(covered)}`]);

  for (const [k, v] of rows) {
    host.append(U.el('dt', { text: k }), U.el('dd', { text: v }));
  }

  // Per-style breakdown with a coverage bar against the file duration.
  const perStyle = new Map();
  for (const layer of p.layers) {
    const s = styles.get(layer.style_id);
    if (!s) continue;
    const agg = perStyle.get(s.id) || { style: s, count: 0, seconds: 0 };
    for (const c of layer.clips) { agg.count += 1; agg.seconds += c.end - c.start; }
    perStyle.set(s.id, agg);
  }
  for (const { style, count, seconds } of perStyle.values()) {
    if (!count) continue;
    host.append(
      U.el('dt', {}, [U.el('span', { class: 'swatch', style: { background: style.color, display: 'inline-block', marginRight: '6px' } }), style.name]),
      U.el('dd', { text: `${count} · ${U.dur(seconds)}` }),
      U.el('div', { class: 'bar' }, [
        U.el('span', {
          style: { width: `${Math.min(100, (seconds / (p.duration || 1)) * 100)}%`, background: style.color },
        }),
      ]),
    );
  }
}

function addStyle(name, layer) {
  const p = state.project;
  const palette = ['#6EA8FF', '#7ED9A7', '#E2A0FF', '#F2B45C', '#7FD6E8', '#FF9BA8', '#B9CE6A', '#C3A1F0'];
  const style = { id: U.uid('st'), name, color: palette[p.styles.length % palette.length] };
  p.styles.push(style);
  if (layer) layer.style_id = style.id;
  timeline.onChange('add-style');
  timeline.render();
}

/* ---------------- LeRobot write-back / import ---------------- */

const PALETTE = ['#6EA8FF', '#7ED9A7', '#E2A0FF', '#F2B45C', '#7FD6E8', '#FF9BA8', '#B9CE6A', '#C3A1F0'];

function ensureStyle(name) {
  const p = state.project;
  let style = p.styles.find((s) => s.name === name);
  if (!style) {
    style = { id: U.uid('st'), name, color: PALETTE[p.styles.length % PALETTE.length] };
    p.styles.push(style);
  }
  return style;
}

function figure(value, label) {
  return U.el('div', { class: 'figure' }, [U.el('b', { text: String(value) }), U.el('span', { text: label })]);
}

/** Generic preview + confirm. onConfirm null => informational only. */
function showReport(title, nodes, confirmLabel, onConfirm, note = '') {
  $('report-title').textContent = title;
  const body = $('report-body');
  body.innerHTML = '';
  for (const n of nodes) if (n) body.appendChild(n);
  $('report-note').textContent = note;
  const btn = $('report-confirm');
  btn.hidden = !onConfirm;
  btn.textContent = confirmLabel || 'Confirm';
  btn.onclick = onConfirm || null;
  openModal('report-modal');
}

function warnBlock(warnings) {
  if (!warnings || !warnings.length) return null;
  return U.el('div', {}, warnings.map((w) => U.el('div', { class: 'warn', text: w })));
}

function exportPayload(extra) {
  return JSON.stringify({
    root: state.root, scope: state.scope, chunk: state.chunk, file: state.file, ...extra,
  });
}

async function exportToLeRobot() {
  if (!state.root) { U.toast('Open a dataset first'); return; }
  saveSoon.flush();
  try {
    const plan = await U.api('/api/export/lerobot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exportPayload({ dry_run: true }),
    });
    renderExportPlan(plan);
  } catch (err) {
    U.fail(err, 'Export preview');
  }
}

function renderExportPlan(plan) {
  const styleRows = Object.entries(plan.styles || {})
    .map(([from, to]) => U.el('li', { class: 'mono', text: from === to ? from : `${from} → ${to}` }));

  const nodes = [
    U.el('div', { class: 'figures' }, [
      figure(plan.rows, 'rows to write'),
      figure(`${plan.episodes_annotated}/${plan.episodes_total}`, 'episodes annotated'),
      figure(plan.episodes_cleared, 'episodes cleared'),
    ]),
    U.el('h3', { text: 'Styles' }),
    U.el('ul', {}, styleRows),
    plan.skipped && plan.skipped.length
      ? U.el('div', {}, [
        U.el('h3', { text: `Skipped (${plan.skipped.length})` }),
        U.el('ul', {}, plan.skipped.slice(0, 8).map((s) => U.el('li', { text: `${s.clip}: ${s.reason}` }))),
      ])
      : null,
    warnBlock(plan.warnings),
  ];

  const canWrite = plan.ok && plan.rows > 0;
  showReport(
    'Write into dataset',
    nodes,
    'Write to parquet',
    canWrite ? () => applyExport() : null,
    canWrite ? 'Rewrites data/*.parquet in place. A copy of data/ is saved first.' : 'Nothing to write.',
  );
}

async function applyExport() {
  const btn = $('report-confirm');
  btn.disabled = true;
  btn.textContent = 'Writing…';
  try {
    const done = await U.api('/api/export/lerobot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exportPayload({ dry_run: false, backup: true, spans: true }),
    });
    showReport('Written', [
      U.el('div', { class: 'figures' }, [
        figure(done.rows, 'rows written'),
        figure(done.episodes_annotated, 'episodes'),
        figure((done.written || []).length, 'shards rewritten'),
      ]),
      U.el('h3', { text: 'Files' }),
      U.el('ul', {}, (done.written || []).map((w) => U.el('li', { class: 'mono', text: w }))),
      done.backup ? U.el('p', { class: 'mono muted', text: `backup: ${done.backup}` }) : null,
      warnBlock(done.warnings),
    ], null, null, done.validator || '');
    U.toast(`Wrote ${done.rows} language_persistent row(s)`);
  } catch (err) {
    U.fail(err, 'Writing to the dataset');
    closeModal('report-modal');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Write to parquet';
  }
}

async function importFromLeRobot() {
  if (!state.root) { U.toast('Open a dataset first'); return; }
  try {
    const q = `root=${encodeURIComponent(state.root)}&scope=${state.scope}&chunk=${state.chunk}&file=${state.file}`;
    const found = await U.api(`/api/import/lerobot?${q}`);
    const nodes = [
      U.el('div', { class: 'figures' }, [
        figure(found.clips, 'segments'),
        figure(found.styles.length, 'styles'),
        figure(found.episodes, 'episodes'),
      ]),
      U.el('h3', { text: 'Styles found' }),
      U.el('ul', {}, found.styles.map((s) => U.el('li', {
        class: 'mono', text: `${s} — ${found.clips_by_style[s].length} segment(s)`,
      }))),
      found.exact_ends === found.clips && found.clips
        ? U.el('p', { class: 'muted', text: 'Every segment carries an exact end_timestamp, so '
          + 'starts and ends come back as they were written.' })
        : U.el('div', { class: 'warn', text: 'Some rows have no end_timestamp. Those segments end '
          + 'where the next annotation of the same style begins, or at the end of their episode.' }),
      warnBlock(found.warnings),
    ];
    showReport('Read from dataset', nodes, 'Add as new layers',
      found.clips ? () => { applyImport(found); closeModal('report-modal'); } : null,
      found.clips ? 'One new layer per style. Existing layers are left alone.' : 'Nothing found.');
  } catch (err) {
    U.fail(err, 'Reading from the dataset');
  }
}

function applyImport(found) {
  const p = state.project;
  let added = 0;
  for (const name of found.styles) {
    const style = ensureStyle(name);
    const clips = found.clips_by_style[name]
      .map((c) => ({
        id: U.uid('cl'),
        start: c.start,
        end: c.end,
        text: U.asText(c.text),
        source: { episode_index: c.episode_index, from: 'language_persistent' },
      }))
      .sort((a, b) => a.start - b.start);
    p.layers.push({ id: U.uid('ly'), style_id: style.id, clips });
    added += clips.length;
  }
  timeline.render();
  renderStats();
  markDirty();
  U.toast(`Added ${added} segment(s) in ${found.styles.length} new layer(s)`);
}

/* ---------------- auto-annotate ---------------- */

let autoPoll = null;

/** Clips on `layerId` that overlap [start, end), as prompt context. */
function annotationsOverlapping(layerId, start, end) {
  const layer = (state.project.layers || []).find((l) => l.id === layerId);
  if (!layer) return [];
  return layer.clips
    .filter((c) => c.end > start && c.start < end && (c.text || '').trim())
    .map((c) => ({ start: c.start, end: c.end, text: c.text }));
}

function styleNameOf(layer) {
  const style = (state.project.styles || []).find((s) => s.id === layer.style_id);
  return style ? style.name : 'untitled';
}

function styleColorOf(layer) {
  const style = (state.project.styles || []).find((s) => s.id === layer.style_id);
  return style ? style.color : '#6EA8FF';
}

function openAutoAnnotate(sel) {
  const start = Math.min(sel.start, sel.end);
  const end = Math.max(sel.start, sel.end);
  const project = state.project;
  const body = $('auto-body');
  body.innerHTML = '';

  // Every view is sent by default: the backend takes any number of videos,
  // and more angles is usually the better prompt.
  const viewRows = Object.keys(project.timeline || {}).map((view) => {
    const row = U.el('label', { class: 'view-row', 'data-view': view }, [
      U.el('input', {
        type: 'checkbox', checked: true, 'data-role': 'view',
        onchange: (e) => row.classList.toggle('off', !e.target.checked),
      }),
      U.el('span', { text: view }),
    ]);
    return row;
  });

  // Everything is pre-checked except nothing: the layer the selection was
  // drawn on is the obvious target, so it starts checked and the rest do not.
  const rows = project.layers.map((layer, i) => {
    const checked = layer.id === sel.layerId;
    const row = U.el('div', { class: `layer-row${checked ? '' : ' off'}`, 'data-layer': layer.id }, [
      U.el('input', {
        type: 'checkbox', checked, 'data-role': 'pick',
        onchange: (e) => row.classList.toggle('off', !e.target.checked),
      }),
      U.el('span', { class: 'name' }, [
        U.el('span', { class: 'swatch', style: { background: styleColorOf(layer) } }),
        U.el('span', { text: `${i + 1}. ${styleNameOf(layer)}` }),
      ]),
      U.el('input', {
        type: 'text', 'data-role': 'instruction',
        placeholder: 'instructions for this layer (optional)',
      }),
    ]);
    return row;
  });

  const contextSelect = U.el('select', { id: 'auto-context' }, [
    U.el('option', { value: '', text: 'none' }),
    ...project.layers.map((layer, i) => U.el('option', {
      value: layer.id, text: `${i + 1}. ${styleNameOf(layer)}`,
    })),
  ]);

  body.append(
    U.el('div', { class: 'figures' }, [
      figure(U.dur(end - start), 'selection'),
      figure(U.tc(start, false), 'from'),
      figure(project.layers.length, 'layers'),
    ]),
    U.el('div', { class: 'field' }, [
      U.el('label', { text: 'Camera views to send' }),
      U.el('div', { class: 'view-pick' }, viewRows),
    ]),
    U.el('div', { class: 'field' }, [
      U.el('label', { text: 'Layers to annotate' }),
      U.el('div', { class: 'layer-pick' }, rows),
    ]),
    U.el('div', { class: 'field' }, [
      U.el('label', { text: 'Use existing annotations from' }), contextSelect,
    ]),
    U.el('div', { class: 'field' }, [
      U.el('label', { text: 'Extra notes for the prompt' }),
      U.el('textarea', { id: 'auto-notes', rows: '2', placeholder: 'optional' }),
    ]),
  );

  $('auto-progress').hidden = true;
  $('auto-note').textContent = `${U.tc(start)} → ${U.tc(end)}`;
  const run = $('auto-run');
  run.hidden = false;
  run.disabled = false;
  run.textContent = 'Annotate';
  run.onclick = () => startAutoAnnotate({ start, end, rows, viewRows, contextSelect });
  openModal('auto-modal');
}

async function startAutoAnnotate({ start, end, rows, viewRows, contextSelect }) {
  const layerIds = [];
  const instructions = {};
  for (const row of rows) {
    if (!row.querySelector('[data-role="pick"]').checked) continue;
    const id = row.dataset.layer;
    layerIds.push(id);
    const text = row.querySelector('[data-role="instruction"]').value.trim();
    if (text) instructions[id] = text;
  }
  if (!layerIds.length) { U.toast('Pick at least one layer'); return; }

  const views = viewRows
    .filter((row) => row.querySelector('[data-role="view"]').checked)
    .map((row) => row.dataset.view);
  if (!views.length) { U.toast('Pick at least one camera view'); return; }

  const contextLayerId = contextSelect.value || null;
  const run = $('auto-run');
  run.disabled = true;
  run.textContent = 'Working…';
  $('auto-progress').hidden = false;
  setAutoProgress('Starting', 0.05, '');

  try {
    const job = await U.api('/api/auto-annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: state.root,
        views,
        start,
        end,
        layer_ids: layerIds,
        layer_instructions: instructions,
        context_layer_id: contextLayerId,
        context_annotations: contextLayerId
          ? annotationsOverlapping(contextLayerId, start, end) : [],
        notes: ($('auto-notes').value || '').trim() || null,
      }),
    });
    pollAutoAnnotate(job.id);
  } catch (err) {
    U.fail(err, 'Auto-annotate');
    run.disabled = false;
    run.textContent = 'Annotate';
  }
}

function setAutoProgress(step, progress, note) {
  $('auto-step').textContent = step;
  const bar = $('auto-bar');
  if (progress < 0) {
    bar.classList.add('pending');      // the model call has nothing to measure
    bar.style.width = '';
  } else {
    bar.classList.remove('pending');
    bar.style.width = `${Math.round(progress * 100)}%`;
  }
  $('auto-log').textContent = note || '';
}

function pollAutoAnnotate(jobId) {
  clearInterval(autoPoll);
  autoPoll = setInterval(async () => {
    let job;
    try {
      job = await U.api(`/api/auto-annotate/${jobId}`);
    } catch (err) {
      clearInterval(autoPoll);
      U.fail(err, 'Auto-annotate');
      return;
    }
    setAutoProgress(job.step, job.progress, (job.log || []).slice(-1)[0] || '');
    if (job.state === 'done') {
      clearInterval(autoPoll);
      applyAutoAnnotations(job.result);
    } else if (job.state === 'error') {
      clearInterval(autoPoll);
      setAutoProgress('Failed', 1, '');
      U.toast(job.error, true);
      const run = $('auto-run');
      run.disabled = false;
      run.textContent = 'Try again';
    }
  }, 500);
}

function applyAutoAnnotations(results) {
  let made = 0;
  for (const item of results) {
    const layer = state.project.layers.find((l) => l.id === item.layer_id);
    if (!layer) continue;
    // Reuse createClip's neighbour trimming rather than shoving clips in raw.
    timeline.setSelection({ layerId: layer.id, start: item.start, end: item.end });
    if (timeline.createClip(U.asText(item.text))) made += 1;
  }
  timeline.setSelection(null);
  refreshCreateButton();
  closeModal('auto-modal');
  timeline.render();
  renderStats();
  markDirty();
  U.toast(made ? `Auto-annotated ${made} clip(s)` : 'Nothing could be placed (overlapping clips?)',
    !made);
}

/* ---------------- open dialog ---------------- */

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

async function browse(path) {
  try {
    const data = await U.api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    state.browsePath = data.path;
    $('browse-path').value = data.path;
    const list = $('browse-list');
    list.innerHTML = '';

    if (data.recent.length && !path) {
      list.appendChild(U.el('div', { class: 'group-head', text: 'Recent' }));
      for (const r of data.recent.slice(0, 5)) {
        list.appendChild(U.el('button', {
          class: 'row-item', type: 'button', onclick: () => pickDataset(r),
        }, [U.el('span', { text: r.split('/').pop() }), U.el('span', { class: 'meta', text: r })]));
      }
      list.appendChild(U.el('div', { class: 'group-head', text: data.path }));
    }

    if (data.is_dataset) {
      list.appendChild(U.el('button', {
        class: 'row-item', type: 'button', onclick: () => pickDataset(data.path),
      }, [U.el('span', { text: 'Use this folder' }), U.el('span', { class: 'tag', text: 'dataset' })]));
    }

    for (const entry of data.entries) {
      list.appendChild(U.el('button', {
        class: 'row-item', type: 'button',
        onclick: () => (entry.is_dataset ? pickDataset(entry.path) : browse(entry.path)),
      }, [
        U.el('span', { text: entry.name }),
        entry.is_dataset ? U.el('span', { class: 'tag', text: 'dataset' }) : null,
      ]));
    }
    if (!data.entries.length && !data.is_dataset) {
      list.appendChild(U.el('p', { class: 'muted pad', text: 'Nothing to open in this folder.' }));
    }
    $('browse-status').textContent = data.is_dataset ? 'LeRobot dataset' : `${data.entries.length} folders`;
  } catch (err) {
    U.fail(err, 'Browsing');
  }
}

async function pickDataset(root) {
  const host = $('group-list');
  host.innerHTML = '<p class="muted pad">Reading dataset…</p>';
  try {
    const data = await U.api(`/api/dataset?root=${encodeURIComponent(root)}`);
    state.browseDataset = data;
    host.innerHTML = '';
    host.appendChild(U.el('div', {
      class: 'group-head',
      text: `${data.name} · ${data.video_keys.length} view(s) · ${data.groups.length} file(s)`,
    }));
    if (!data.groups.length) {
      host.appendChild(U.el('p', { class: 'muted pad', text: 'No videos found under videos/.' }));
      return;
    }
    host.appendChild(U.el('button', {
      class: 'row-item', type: 'button',
      onclick: () => { closeModal('open-modal'); openSession(root, 'dataset'); },
    }, [
      U.el('span', { text: 'Whole recording' }),
      U.el('span', { class: 'tag', text: 'all files' }),
      U.el('span', { class: 'meta', text: `${data.groups.length} file(s) per view` }),
    ]));
    for (const g of data.groups) {
      host.appendChild(U.el('button', {
        class: 'row-item', type: 'button',
        onclick: () => { closeModal('open-modal'); openSession(root, 'file', g.chunk_index, g.file_index); },
      }, [
        U.el('span', { text: g.key }),
        U.el('span', { class: 'meta', text: `${Object.keys(g.views).length} views${g.episodes.length ? ` · ${g.episodes.length} ep` : ''}` }),
      ]));
    }
  } catch (err) {
    host.innerHTML = '';
    host.appendChild(U.el('p', { class: 'muted pad', text: err.message }));
  }
}

/* ---------------- actions ---------------- */

function refreshCreateButton() {
  const btn = document.querySelector('[data-action="create-clip"]');
  if (btn) btn.disabled = !timeline.selection;
}

const actions = {
  open: () => { openModal('open-modal'); browse(state.browsePath); },
  save: () => { saveSoon.flush(); },
  'export-json': () => exportAs('json'),
  'export-csv': () => exportAs('csv'),
  'export-lerobot': () => exportToLeRobot(),
  'import-lerobot': () => importFromLeRobot(),
  'auto-annotate': () => timeline.autoAnnotate(),
  reveal: () => U.toast(state.session ? state.session.project_path : 'Nothing open yet'),
  fit: () => timeline.fit(),
  'zoom-in': () => timeline.zoom(1.4),
  'zoom-out': () => timeline.zoom(1 / 1.4),
  shortcuts: () => openModal('shortcuts-modal'),
  play: () => player.toggle(),
  'step-back': () => player.step(-1),
  'step-fwd': () => player.step(1),
  'mark-in': () => { timeline.mark('in'); refreshCreateButton(); },
  'mark-out': () => { timeline.mark('out'); refreshCreateButton(); },
  'create-clip': () => { timeline.createClip(); refreshCreateButton(); },
};

function exportAs(fmt) {
  if (!state.root) { U.toast('Open a dataset first'); return; }
  saveSoon.flush();
  const url = `/api/export/${fmt}?root=${encodeURIComponent(state.root)}`
    + `&scope=${state.scope}&chunk=${state.chunk}&file=${state.file}`;
  setTimeout(() => window.open(url, '_blank'), 250);
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.menu-trigger');
  document.querySelectorAll('.menu').forEach((m) => {
    m.classList.toggle('open', trigger ? m.contains(trigger) && !m.classList.contains('open') : false);
  });

  const btn = e.target.closest('[data-action]');
  if (btn && actions[btn.dataset.action]) {
    e.preventDefault();
    actions[btn.dataset.action]();
    document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
  }
  if (e.target.closest('[data-close]')) {
    e.target.closest('.overlay').hidden = true;
  }
});

/* ---------------- player <-> timeline ---------------- */

player.on('tick', (t) => {
  timeline.setPlayhead(t, player.playing);
  $('timecode').textContent = U.tc(t);
});
player.on('state', (playing) => {
  const btn = document.querySelector('[data-action="play"]');
  if (btn) btn.innerHTML = playing ? '&#10073;&#10073;' : '&#9654;';
});
let decodeWarned = false;
player.on('error', (key) => {
  if (decodeWarned) return;
  decodeWarned = true;
  U.toast(`${key} will not decode. The timeline still runs on a fallback clock.`, true);
});

$('rate').addEventListener('change', (e) => player.setRate(parseFloat(e.target.value)));

/* ---------------- keyboard ---------------- */

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.overlay:not([hidden])').forEach((o) => { o.hidden = true; });
    if (U.typing()) document.activeElement.blur();
    timeline.setSelection(null);
    refreshCreateButton();
    return;
  }
  if (U.typing() || e.metaKey || e.ctrlKey) return;

  const step = e.shiftKey ? player.fps : 1;
  switch (e.key) {
    case ' ': e.preventDefault(); player.toggle(); break;
    case 'ArrowLeft': e.preventDefault(); player.step(-step); break;
    case 'ArrowRight': e.preventDefault(); player.step(step); break;
    case 'i': case 'I': actions['mark-in'](); break;
    case 'o': case 'O': actions['mark-out'](); break;
    // preventDefault matters: creating a clip focuses the text box, and
    // without this the 'c' keypress lands in it as the first character.
    case 'a': case 'A': e.preventDefault(); timeline.autoAnnotate(); break;
    case 'c': case 'C': case 'Enter': e.preventDefault(); actions['create-clip'](); break;
    case 'Delete': case 'Backspace':
      if (timeline.selectedClipId) { e.preventDefault(); timeline.deleteClip(); }
      break;
    case 'f': case 'F': timeline.fit(); break;
    case '+': case '=': timeline.zoom(1.4); break;
    case '-': case '_': timeline.zoom(1 / 1.4); break;
    case 's': case 'S': saveSoon.flush(); break;
    case '?': openModal('shortcuts-modal'); break;
    default:
      if (/^[1-9]$/.test(e.key) && state.project) {
        const layer = state.project.layers[Number(e.key) - 1];
        if (layer) timeline.setActiveLayer(layer.id);
      }
  }
});

/* ---------------- open dialog controls ---------------- */

$('browse-up').addEventListener('click', () => {
  const parts = (state.browsePath || '/').split('/').filter(Boolean);
  parts.pop();
  browse(`/${parts.join('/')}`);
});
$('browse-go').addEventListener('click', () => browse($('browse-path').value.trim()));
$('browse-path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') browse(e.target.value.trim());
});

/* ---------------- timeline height splitter ---------------- */

$('hsplit').addEventListener('mousedown', (e) => {
  const startY = e.clientY;
  const startH = $('timeline').getBoundingClientRect().height;
  const move = (ev) => {
    const h = U.clamp(startH - (ev.clientY - startY), 140, window.innerHeight - 260);
    document.body.style.setProperty('--tl-h', `${h}px`);
    timeline.renderRuler();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
  };
  document.body.classList.add('resizing');
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

/* ---------------- boot ---------------- */

// Handy in the Firefox console: window.player / window.timeline / window.state.
window.player = player;
window.timeline = timeline;
window.state = state;

(function boot() {
  U.installErrorReporting();
  refreshCreateButton();
  const params = new URLSearchParams(location.search);
  const root = params.get('root');
  if (root) {
    openSession(root, params.get('scope') || 'dataset',
      Number(params.get('chunk') || 0), Number(params.get('file') || 0));
  }
  else { openModal('open-modal'); browse(null); }
})();
