/* Embed builder + Discord-like live preview for /compose.
   The whole payload is assembled client-side into the hidden `payload` field;
   the server re-validates everything, so this is convenience, not trust. */
(function () {
  'use strict';

  var form = document.getElementById('compose-form');
  if (!form) return;

  var embedsEl = document.getElementById('embeds');
  var previewEl = document.getElementById('preview');
  var payloadField = document.getElementById('payload-field');
  var jsonPane = document.getElementById('json-pane');
  var builderPane = document.getElementById('builder-pane');
  var jsonArea = document.getElementById('payload-json');
  var jsonError = document.getElementById('json-error');
  var jsonToggle = document.getElementById('json-mode');
  var budgetEl = document.getElementById('embed-budget');
  var contentEl = document.getElementById('content');
  var contentCount = document.getElementById('content-count');

  var DEFAULT_COLOR = '#5865f2';

  // ---- small helpers --------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  function labelled(text, input, hint) {
    var l = el('label', { text: text });
    l.appendChild(input);
    if (hint) l.appendChild(el('small', { text: hint }));
    return l;
  }

  function input(opts) {
    var i = el('input', opts || {});
    i.addEventListener('input', sync);
    return i;
  }

  function textarea(opts) {
    var t = el('textarea', opts || {});
    t.addEventListener('input', sync);
    return t;
  }

  function val(scope, selector) {
    var node = scope.querySelector(selector);
    if (!node) return '';
    return (node.value || '').trim();
  }

  // ---- embed editor ---------------------------------------------------------
  function addEmbed(data) {
    data = data || {};
    var box = el('div', { class: 'embed-editor' });

    var remove = el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: '削除' });
    remove.addEventListener('click', function () {
      box.remove();
      renumber();
      sync();
    });

    var head = el('div', { class: 'embed-head' }, [el('strong', { text: 'Embed' }), remove]);
    box.appendChild(head);

    box.appendChild(labelled('タイトル', input({ 'data-k': 'title', maxlength: '256', value: data.title || '' })));
    box.appendChild(
      labelled('本文 (description)', textarea({ 'data-k': 'description', rows: '3', maxlength: '4096' }))
    );
    box.querySelector('[data-k="description"]').value = data.description || '';

    box.appendChild(labelled('タイトルのリンク先 URL', input({ 'data-k': 'url', type: 'url', value: data.url || '' })));

    var colorText = input({ 'data-k': 'color', value: normaliseColor(data.color) || DEFAULT_COLOR, maxlength: '7' });
    var colorPick = el('input', { type: 'color', value: normaliseColor(data.color) || DEFAULT_COLOR });
    colorPick.addEventListener('input', function () {
      colorText.value = colorPick.value;
      sync();
    });
    colorText.addEventListener('input', function () {
      if (/^#[0-9a-fA-F]{6}$/.test(colorText.value)) colorPick.value = colorText.value;
    });
    var colorRow = el('div', { class: 'color-row' }, [colorPick, colorText]);
    var colorLabel = el('label', { text: '左端の色' });
    colorLabel.appendChild(colorRow);
    box.appendChild(colorLabel);

    box.appendChild(labelled('著者名 (author.name)', input({ 'data-k': 'author_name', maxlength: '256', value: (data.author && data.author.name) || '' })));
    box.appendChild(labelled('著者アイコン URL', input({ 'data-k': 'author_icon', type: 'url', value: (data.author && data.author.icon_url) || '' })));
    box.appendChild(labelled('サムネイル画像 URL', input({ 'data-k': 'thumbnail', type: 'url', value: (data.thumbnail && data.thumbnail.url) || '' })));
    box.appendChild(labelled('大きい画像 URL', input({ 'data-k': 'image', type: 'url', value: (data.image && data.image.url) || '' })));
    box.appendChild(labelled('フッター文言', input({ 'data-k': 'footer', maxlength: '2048', value: (data.footer && data.footer.text) || '' })));

    var tsWrap = el('label', { class: 'check' });
    var ts = el('input', { type: 'checkbox', 'data-k': 'timestamp' });
    if (data.timestamp) ts.checked = true;
    ts.addEventListener('change', sync);
    tsWrap.appendChild(ts);
    tsWrap.appendChild(el('span', { text: '送信時刻をフッターに表示する' }));
    box.appendChild(tsWrap);

    var fields = el('div', { class: 'fields' });
    box.appendChild(el('div', { class: 'section-head' }, [
      el('h3', { text: 'フィールド' }),
      (function () {
        var b = el('button', { type: 'button', class: 'btn btn-sm', text: '＋ フィールド' });
        b.addEventListener('click', function () {
          addField(fields, {});
          sync();
        });
        return b;
      })(),
    ]));
    box.appendChild(fields);
    (data.fields || []).forEach(function (f) {
      addField(fields, f);
    });

    embedsEl.appendChild(box);
    renumber();
    sync();
  }

  function addField(container, data) {
    var row = el('div', { class: 'field-row' });
    var name = input({ 'data-k': 'f_name', placeholder: '名前', maxlength: '256', value: data.name || '' });
    var value = input({ 'data-k': 'f_value', placeholder: '内容', maxlength: '1024', value: data.value || '' });
    var inlineWrap = el('label', { class: 'check' });
    var inline = el('input', { type: 'checkbox', 'data-k': 'f_inline' });
    if (data.inline) inline.checked = true;
    inline.addEventListener('change', sync);
    inlineWrap.appendChild(inline);
    inlineWrap.appendChild(el('span', { text: '横並び' }));
    var del = el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: '×' });
    del.addEventListener('click', function () {
      row.remove();
      sync();
    });
    row.appendChild(name);
    row.appendChild(value);
    row.appendChild(inlineWrap);
    row.appendChild(del);
    container.appendChild(row);
  }

  function renumber() {
    var boxes = embedsEl.querySelectorAll('.embed-editor');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].querySelector('.embed-head strong').textContent = 'Embed ' + (i + 1);
    }
    document.getElementById('add-embed').disabled = boxes.length >= 10;
  }

  function normaliseColor(c) {
    if (c === undefined || c === null || c === '') return '';
    if (typeof c === 'number') return '#' + c.toString(16).padStart(6, '0');
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
    return '';
  }

  // ---- payload assembly -----------------------------------------------------
  function collectEmbeds() {
    var out = [];
    var boxes = embedsEl.querySelectorAll('.embed-editor');
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var e = {};
      if (val(b, '[data-k="title"]')) e.title = val(b, '[data-k="title"]');
      if (val(b, '[data-k="description"]')) e.description = val(b, '[data-k="description"]');
      if (val(b, '[data-k="url"]')) e.url = val(b, '[data-k="url"]');
      var color = val(b, '[data-k="color"]');
      if (/^#[0-9a-fA-F]{6}$/.test(color)) e.color = parseInt(color.slice(1), 16);
      var authorName = val(b, '[data-k="author_name"]');
      if (authorName) {
        e.author = { name: authorName };
        if (val(b, '[data-k="author_icon"]')) e.author.icon_url = val(b, '[data-k="author_icon"]');
      }
      if (val(b, '[data-k="thumbnail"]')) e.thumbnail = { url: val(b, '[data-k="thumbnail"]') };
      if (val(b, '[data-k="image"]')) e.image = { url: val(b, '[data-k="image"]') };
      if (val(b, '[data-k="footer"]')) e.footer = { text: val(b, '[data-k="footer"]') };
      if (b.querySelector('[data-k="timestamp"]').checked) e.timestamp = new Date().toISOString();

      var fields = [];
      var rows = b.querySelectorAll('.field-row');
      for (var j = 0; j < rows.length; j++) {
        var n = val(rows[j], '[data-k="f_name"]');
        var v = val(rows[j], '[data-k="f_value"]');
        if (!n || !v) continue;
        var f = { name: n, value: v };
        if (rows[j].querySelector('[data-k="f_inline"]').checked) f.inline = true;
        fields.push(f);
      }
      if (fields.length) e.fields = fields;

      // Skip embeds with nothing renderable — Discord rejects them.
      if (Object.keys(e).filter(function (k) { return k !== 'color' && k !== 'timestamp'; }).length) out.push(e);
    }
    return out;
  }

  function buildPayload() {
    var p = {};
    var content = (contentEl.value || '').trim();
    if (content) p.content = content;
    var embeds = collectEmbeds();
    if (embeds.length) p.embeds = embeds;

    var username = (document.getElementById('username').value || '').trim();
    if (username) p.username = username;
    var avatar = (document.getElementById('avatar_url').value || '').trim();
    if (avatar) p.avatar_url = avatar;
    var thread = (document.getElementById('thread_id').value || '').trim();
    if (thread) p.thread_id = thread;

    p.allowed_mentions = document.getElementById('allow_everyone').checked
      ? { parse: ['everyone', 'roles', 'users'] }
      : { parse: [] };
    if (document.getElementById('silent').checked) p.flags = 4096;
    return p;
  }

  function embedBudget(payload) {
    var n = 0;
    (payload.embeds || []).forEach(function (e) {
      n += (e.title || '').length + (e.description || '').length;
      n += (e.footer && e.footer.text ? e.footer.text.length : 0);
      n += (e.author && e.author.name ? e.author.name.length : 0);
      (e.fields || []).forEach(function (f) {
        n += f.name.length + f.value.length;
      });
    });
    return n;
  }

  // ---- preview --------------------------------------------------------------
  function renderPreview(payload) {
    previewEl.textContent = '';
    var hasAnything = (payload.content && payload.content.trim()) || (payload.embeds || []).length;
    if (!hasAnything) {
      previewEl.appendChild(el('div', { class: 'dp-empty', text: '本文か Embed を入力するとここに表示されます。' }));
      return;
    }

    var avatar = payload.avatar_url
      ? el('img', { class: 'dp-avatar', src: payload.avatar_url, alt: '' })
      : el('div', { class: 'dp-avatar' });

    var body = el('div', { class: 'dp-body' });
    var nameLine = el('div');
    nameLine.appendChild(el('span', { class: 'dp-name', text: payload.username || 'Webhook' }));
    nameLine.appendChild(el('span', { class: 'dp-bot', text: 'BOT' }));
    body.appendChild(nameLine);

    if (payload.content) body.appendChild(el('div', { class: 'dp-content', text: payload.content }));

    (payload.embeds || []).forEach(function (e) {
      var box = el('div', { class: 'dp-embed' });
      if (typeof e.color === 'number') {
        box.style.borderLeftColor = '#' + e.color.toString(16).padStart(6, '0');
      }
      if (e.author) {
        var a = el('div', { class: 'dp-embed-author' });
        if (e.author.icon_url) a.appendChild(el('img', { src: e.author.icon_url, alt: '' }));
        a.appendChild(el('span', { text: e.author.name }));
        box.appendChild(a);
      }
      if (e.title) box.appendChild(el('div', { class: 'dp-embed-title', text: e.title }));
      if (e.description) box.appendChild(el('div', { class: 'dp-embed-desc', text: e.description }));
      if (e.fields && e.fields.length) {
        var anyInline = e.fields.some(function (f) { return f.inline; });
        var wrap = el('div', { class: 'dp-embed-fields' + (anyInline ? ' has-inline' : '') });
        e.fields.forEach(function (f) {
          var cell = el('div');
          if (!f.inline && anyInline) cell.style.gridColumn = '1 / -1';
          cell.appendChild(el('div', { class: 'dp-field-name', text: f.name }));
          cell.appendChild(el('div', { class: 'dp-field-value', text: f.value }));
          wrap.appendChild(cell);
        });
        box.appendChild(wrap);
      }
      if (e.thumbnail && e.thumbnail.url) box.appendChild(el('img', { class: 'dp-embed-img', src: e.thumbnail.url, alt: '' }));
      if (e.image && e.image.url) box.appendChild(el('img', { class: 'dp-embed-img', src: e.image.url, alt: '' }));
      if (e.footer || e.timestamp) {
        var f = el('div', { class: 'dp-embed-footer' });
        if (e.footer && e.footer.icon_url) f.appendChild(el('img', { src: e.footer.icon_url, alt: '' }));
        var bits = [];
        if (e.footer && e.footer.text) bits.push(e.footer.text);
        if (e.timestamp) bits.push(new Date(e.timestamp).toLocaleString('ja-JP'));
        f.appendChild(el('span', { text: bits.join(' • ') }));
        box.appendChild(f);
      }
      body.appendChild(box);
    });

    previewEl.appendChild(el('div', { class: 'dp-msg' }, [avatar, body]));
  }

  // ---- sync -----------------------------------------------------------------
  function sync() {
    var payload;
    if (jsonToggle.checked) {
      jsonError.hidden = true;
      try {
        payload = JSON.parse(jsonArea.value || '{}');
      } catch (err) {
        jsonError.textContent = 'JSON が不正です: ' + err.message;
        jsonError.hidden = false;
        return;
      }
      payloadField.value = jsonArea.value;
    } else {
      payload = buildPayload();
      payloadField.value = JSON.stringify(payload);
    }
    renderPreview(payload);

    if (contentCount) contentCount.textContent = (contentEl.value || '').length + ' / 2000';
    if (budgetEl) {
      var used = embedBudget(payload);
      budgetEl.textContent = 'Embed 合計 ' + used + ' / 6000 字' + (used > 6000 ? '（超過しています）' : '');
      budgetEl.style.color = used > 6000 ? 'var(--bad)' : '';
    }
  }

  // ---- wiring ---------------------------------------------------------------
  document.getElementById('add-embed').addEventListener('click', function () {
    addEmbed({});
  });

  form.querySelectorAll('input[name="target_type"]').forEach(function (r) {
    r.addEventListener('change', function () {
      form.querySelector('[data-target="named"]').hidden = r.value !== 'named';
      form.querySelector('[data-target="url"]').hidden = r.value !== 'url';
    });
  });

  form.querySelectorAll('input[name="when"]').forEach(function (r) {
    r.addEventListener('change', function () {
      form.querySelector('[data-when="later"]').hidden = r.value !== 'later';
    });
  });

  ['username', 'avatar_url', 'thread_id'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', sync);
  });
  ['allow_everyone', 'silent'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', sync);
  });
  contentEl.addEventListener('input', sync);
  jsonArea.addEventListener('input', sync);

  jsonToggle.addEventListener('change', function () {
    if (jsonToggle.checked) {
      jsonArea.value = JSON.stringify(buildPayload(), null, 2);
      jsonPane.hidden = false;
      builderPane.hidden = true;
    } else {
      jsonPane.hidden = true;
      builderPane.hidden = false;
    }
    sync();
  });

  form.addEventListener('submit', function (ev) {
    sync();
    if (jsonToggle.checked && !jsonError.hidden) {
      ev.preventDefault();
      return;
    }
    if (!payloadField.value || payloadField.value === '{}') {
      ev.preventDefault();
      alert('本文か Embed を入力してください。');
    }
  });

  // ---- initial state --------------------------------------------------------
  var initialNode = document.getElementById('initial-payload');
  var initial = null;
  try {
    initial = initialNode ? JSON.parse(initialNode.textContent || 'null') : null;
  } catch (e) {
    initial = null;
  }
  if (initial) {
    if (initial.content) contentEl.value = initial.content;
    if (initial.username) document.getElementById('username').value = initial.username;
    if (initial.avatar_url) document.getElementById('avatar_url').value = initial.avatar_url;
    if (initial.thread_id) document.getElementById('thread_id').value = initial.thread_id;
    if (initial.allowed_mentions && (initial.allowed_mentions.parse || []).length) {
      document.getElementById('allow_everyone').checked = true;
    }
    if (initial.flags === 4096) document.getElementById('silent').checked = true;
    (initial.embeds || []).forEach(addEmbed);
  }
  renumber();
  sync();
})();
