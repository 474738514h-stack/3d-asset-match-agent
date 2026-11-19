/**
 * UI 控制器
 */
let state = { file: null, scene: 'realtime', results: [], intent: null, vision: null, compare: [] };

// 把资产图片路径解析为内联 Base64（避免子目录静态资源在预览环境加载失败）
function assetImg(path) {
  if (!path) return '';
  const file = String(path).split('/').pop();
  return (window.ASSET_IMAGES && window.ASSET_IMAGES[file]) || path;
}

const els = {
  uploadZone: $('#uploadZone'), fileInput: $('#fileInput'),
  uploadPlaceholder: $('#uploadPlaceholder'), uploadPreview: $('#uploadPreview'),
  previewImg: $('#previewImg'), fileName: $('#fileName'), removeFile: $('#removeFile'),
  reqText: $('#reqText'), sceneChips: $('#sceneChips'), matchBtn: $('#matchBtn'),
  emptyState: $('#emptyState'), processing: $('#processing'), processSteps: $$('#processSteps li'),
  resultContent: $('#resultContent'), confidence: $('#confidence'),
  intentSummary: $('#intentSummary'), intentTags: $('#intentTags'), matchCount: $('#matchCount'),
  sortSelect: $('#sortSelect'), resultGrid: $('#resultGrid'),
  drawerOverlay: $('#drawerOverlay'), drawer: $('#drawer'), drawerTitle: $('#drawerTitle'),
  drawerBody: $('#drawerBody'), closeDrawer: $('#closeDrawer'), drawerClose2: $('#drawerClose2'),
  selectAsset: $('#selectAsset'), toast: $('#toast'), resetBtn: $('#resetBtn'),
  compareBar: $('#compareBar'), cbThumbs: $('#cbThumbs'), cbHint: $('#cbHint'),
  cbClear: $('#cbClear'), cbGo: $('#cbGo'),
  compareOverlay: $('#compareOverlay'), cmBody: $('#cmBody'), cmClose: $('#cmClose')
};

/* ---- 上传交互 ---- */
els.uploadZone.addEventListener('click', e => { if (e.target.closest('#removeFile')) return; els.fileInput.click(); });
els.fileInput.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
['dragenter', 'dragover'].forEach(ev => els.uploadZone.addEventListener(ev, e => { e.preventDefault(); els.uploadZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => els.uploadZone.addEventListener(ev, e => { e.preventDefault(); els.uploadZone.classList.remove('dragover'); }));
els.uploadZone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f && /image\//.test(f.type)) loadFile(f); });

function loadFile(file) {
  if (!/image\//.test(file.type)) { showToast('请上传图片格式文件'); return; }
  state.file = file;
  els.previewImg.src = URL.createObjectURL(file);
  els.fileName.textContent = file.name;
  els.uploadPlaceholder.classList.add('hidden');
  els.uploadPreview.classList.remove('hidden');
}
els.removeFile.addEventListener('click', e => {
  e.stopPropagation(); state.file = null; els.fileInput.value = '';
  els.uploadPreview.classList.add('hidden'); els.uploadPlaceholder.classList.remove('hidden');
});

/* ---- 快捷描述 & 场景 ---- */
$$('.prompt-chip').forEach(b => b.addEventListener('click', () => {
  els.reqText.value = b.dataset.prompt;
  els.reqText.focus();
}));
els.sceneChips.addEventListener('click', e => {
  const chip = e.target.closest('.scene-chip'); if (!chip) return;
  $$('.scene-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active'); state.scene = chip.dataset.scene;
});

/* ---- 开始匹配 ---- */
els.matchBtn.addEventListener('click', async () => {
  const text = els.reqText.value.trim();
  if (!state.file && !text) { showToast('请上传图片或填写需求描述'); return; }
  els.matchBtn.disabled = true; els.matchBtn.innerHTML = '<span class="btn-spark">✦</span> 正在分析…';
  els.emptyState.classList.add('hidden'); els.resultContent.classList.add('hidden');
  els.processing.classList.remove('hidden');
  els.processSteps.forEach(s => s.classList.remove('active', 'done'));

  els.processSteps[0].classList.add('active');
  await sleep(280);
  els.processSteps[0].classList.remove('active'); els.processSteps[0].classList.add('done');

  // 第 2 步：有图则调用多模态大模型做真实视觉理解
  let vision = null;
  let base;
  if (state.file) {
    els.processSteps[1].classList.add('active');
    vision = await Vision.understandRequirement(state.file, text);
    els.processSteps[1].classList.remove('active');
    els.processSteps[1].classList.add(vision.ok ? 'done' : 'warn');
    base = await buildIntent({ file: null, text, scene: state.scene });
    if (vision.ok) {
      base = mergeVisionIntoIntent(base, vision.data, text);
    } else {
      base = await buildIntent({ file: state.file, text, scene: state.scene });
      base.visionError = vision.error;
    }
  } else {
    els.processSteps[1].classList.add('active');
    await sleep(200);
    els.processSteps[1].classList.remove('active'); els.processSteps[1].classList.add('done');
    base = await buildIntent({ file: null, text, scene: state.scene });
  }

  state.vision = vision;
  if (vision && vision.preprocess) base.preprocess = vision.preprocess;
  state.intent = base;
  state.compare = [];
  renderCompareBar();

  els.processSteps[2].classList.add('active');
  await sleep(320);
  els.processSteps[2].classList.remove('active'); els.processSteps[2].classList.add('done');
  state.results = evaluateAll(base);
  els.processSteps[3].classList.add('done');

  els.processing.classList.add('hidden');
  els.resultContent.classList.remove('hidden');
  renderIntent(base);
  renderResults();
  els.matchBtn.disabled = false; els.matchBtn.innerHTML = '<span class="btn-spark">✦</span> 重新匹配';
  if (vision && !vision.ok) showToast('视觉模型不可用，已用本地特征匹配：' + vision.error);
});

/** 把视觉模型输出合并进匹配引擎所需的 intent */
function mergeVisionIntoIntent(intent, v, rawText) {
  const parsed = parseText(rawText);
  const families = [];
  if (v.color) families.push(v.color);
  if (parsed.color && !families.includes(parsed.color)) families.push(parsed.color);
  // 用户文字里点名的品类/风格优先于模型（可纠正识别）
  const category = parsed.category || v.category;
  const style = parsed.style || v.style;
  const keywords = [...new Set([...(v.keywords || []), ...parsed.keywords])];
  if (v.subject && !keywords.includes(v.subject)) keywords.push(v.subject);

  intent.category = category;
  intent.style = style;
  intent.families = families;
  intent.textKeywords = keywords;
  intent.confidence = 96;
  intent.source = '多模态视觉模型';
  intent.visionData = v;
  intent.summary = v.summary
    ? `${v.summary}（视觉模型识别：${[v.category, v.style, v.color].filter(Boolean).join(' / ')}）`
    : describeIntent({ category, style, families, file: true });
  return intent;
}

function renderIntent(intent) {
  const v = intent.visionData;
  els.confidence.textContent = `置信度 ${intent.confidence}%`;
  els.intentSummary.textContent = intent.summary;
  const tags = [];
  if (v && v.subject) tags.push(`<span class="derived-tag vision-tag">主体 · ${escapeHtml(v.subject)}</span>`);
  if (v && v.material) tags.push(`<span class="derived-tag vision-tag">材质 · ${escapeHtml(v.material)}</span>`);
  if (intent.category) tags.push(`<span class="derived-tag">品类 · ${intent.category}</span>`);
  if (intent.style) tags.push(`<span class="derived-tag">风格 · ${intent.style}</span>`);
  intent.families.filter(Boolean).forEach(f => {
    const c = (COLOR_FAMILY[f] || ['#CCC'])[0];
    tags.push(`<span class="derived-tag color-tag"><i class="color-dot" style="background:${c}"></i>${f}</span>`);
  });
  if (v && v.keywords && v.keywords.length) {
    v.keywords.slice(0, 6).forEach(k => tags.push(`<span class="derived-tag vision-tag">${escapeHtml(k)}</span>`));
  }
  const srcTag = v ? '<span class="derived-tag ai-source">✦ 视觉模型识别</span>'
    : (intent.visionError ? `<span class="derived-tag warn-source">本地特征 · ${escapeHtml(intent.visionError)}</span>` : `<span class="derived-tag">输入 · ${intent.source}</span>`);
  tags.push(srcTag);
  const pp = intent.preprocess;
  if (pp && pp.outBytes) {
    const kb = b => b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB';
    const saved = pp.origBytes ? Math.max(0, Math.round((1 - pp.outBytes / pp.origBytes) * 100)) : 0;
    tags.push(`<span class="derived-tag compress-tag" title="上传图片已自动裁白边并压缩后再送入视觉模型">✂ 图片优化 ${kb(pp.origBytes)}→${kb(pp.outBytes)} · −${saved}%${pp.trimmed ? ' · 已裁白边' : ''}</span>`);
  }
  tags.push(`<span class="derived-tag">场景 · ${SCENE_REQUIREMENTS[intent.scene].label}</span>`);
  els.intentTags.innerHTML = tags.join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sortedResults() {
  const key = els.sortSelect.value;
  return [...state.results].sort((a, b) => {
    if (key === 'price') return (b.detail.discount - a.detail.discount);
    return b.scores[key] - a.scores[key];
  });
}

function renderResults() {
  const list = sortedResults();
  els.matchCount.textContent = list.length;
  els.resultGrid.innerHTML = '';
  list.forEach((r, i) => {
    const card = buildCard(r, i);
    if (state.compare.includes(r.asset.id)) card.classList.add('picked');
    els.resultGrid.appendChild(card);
  });
  requestAnimationFrame(() => setTimeout(() => {
    $$('.result-card .bar i').forEach((el, idx) => { el.style.width = el.dataset.w + '%'; });
    $$('.result-card .ring-fg').forEach(el => { el.style.strokeDashoffset = el.dataset.off; });
  }, 40));
}

function scoreColor(v) { return v >= 85 ? 'var(--green)' : v >= 65 ? 'var(--primary)' : v >= 45 ? 'var(--amber)' : 'var(--red)'; }
function verdictClass(v) { return v === '性价比高' ? 'good' : v === '价格偏高' ? 'high' : 'ok'; }

function buildCard(r, index) {
  const a = r.asset, s = r.scores, d = r.detail;
  const card = document.createElement('div');
  card.className = 'result-card' + (index === 0 ? ' top-match' : '');
  card.style.animationDelay = (index * 55) + 'ms';
  const off = 176 - (176 * r.overall / 100);
  card.innerHTML = `
    <div class="card-thumb">
      <img src="${assetImg(a.image)}" alt="${a.name}" style="width:100%;height:100%;object-fit:cover" onerror="this.onerror=null;this.src='data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22400%22%3E%3Crect width=%22400%22 height=%22400%22 fill=%22%23EEF0F5%22/%3E%3C/svg%3E'" />
      ${index === 0 ? '<span class="rank-badge">✦ 最佳匹配</span>' : `<span class="rank-badge">#${index + 1}</span>`}
      <button class="pick-btn${state.compare.includes(a.id) ? ' picked' : ''}" data-pick="${a.id}" title="加入对比" aria-label="加入对比">${state.compare.includes(a.id) ? '✓' : '+'}</button>
    </div>
    <div class="card-main">
      <div class="card-title-row">
        <h4>${a.name}</h4>
        ${a.pbr ? '<span class="badge pbr">PBR</span>' : ''}
        <span class="badge license">${a.license}</span>
      </div>
      <p class="card-desc">${a.desc}</p>
      <div class="card-specs">
        <span><b>${a.category}</b> · ${a.style}</span>
        <span>面数 <b>${(a.polygons / 1000).toFixed(1)}k</b></span>
        <span>贴图 <b>${a.texture}px</b></span>
        <span>格式 <b>${a.formats.join('/')}</b></span>
      </div>
      <div class="score-block">
        <div class="score-item">
          <div class="lbl"><span>兼容性</span><b style="color:${scoreColor(s.compatibility)}">${Math.round(s.compatibility)}</b></div>
          <div class="bar compat"><i data-w="${Math.round(s.compatibility)}"></i></div>
        </div>
        <div class="score-item">
          <div class="lbl"><span>分辨率</span><b style="color:${scoreColor(s.resolution)}">${Math.round(s.resolution)}</b></div>
          <div class="bar res"><i data-w="${Math.round(s.resolution)}"></i></div>
        </div>
        <div class="score-item">
          <div class="lbl"><span>价格评估</span><b style="color:${scoreColor(s.price)}">${Math.round(s.price)}</b></div>
          <div class="bar price"><i data-w="${Math.round(s.price)}"></i></div>
        </div>
      </div>
    </div>
    <div class="card-side">
      <div class="overall-ring">
        <svg viewBox="0 0 66 66" width="66" height="66">
          <circle class="ring-bg" cx="33" cy="33" r="28"/>
          <circle class="ring-fg" cx="33" cy="33" r="28" data-off="${off}"/>
        </svg>
        <div class="ring-num"><b>${Math.round(r.overall)}</b><small>综合</small></div>
      </div>
      <div class="price-box">
        <div class="price">¥${a.price} <small>/ 个</small></div>
        <div class="market">均价 ¥${a.marketAvg}</div>
        <span class="verdict ${verdictClass(d.verdict)}">${d.verdict}</span>
      </div>
      <button class="detail-btn">评估详情 →</button>
    </div>`;
  card.querySelector('.detail-btn').addEventListener('click', () => openDrawer(r));
  card.querySelector('.pick-btn').addEventListener('click', () => toggleCompare(a.id));
  return card;
}

/* ---- 并排对比 ---- */
function toggleCompare(id) {
  const i = state.compare.indexOf(id);
  if (i >= 0) state.compare.splice(i, 1);
  else {
    if (state.compare.length >= 3) { showToast('最多同时对比 3 个资产'); return; }
    state.compare.push(id);
  }
  renderResults();
  renderCompareBar();
}

function renderCompareBar() {
  const ids = state.compare;
  els.compareBar.classList.toggle('hidden', ids.length === 0);
  els.cbThumbs.innerHTML = ids.map(id => {
    const a = ASSETS.find(x => x.id === id);
    return `<span class="cb-thumb"><img src="${assetImg(a.image)}" alt="${a.name}"><i data-unpick="${id}" title="移除">✕</i></span>`;
  }).join('');
  els.cbHint.textContent = ids.length < 2 ? `再选 ${2 - ids.length} 个开始对比` : `${ids.length} 个已选`;
  els.cbGo.disabled = ids.length < 2;
  els.cbThumbs.querySelectorAll('[data-unpick]').forEach(el => {
    el.addEventListener('click', () => toggleCompare(el.dataset.unpick));
  });
}

function renderCompare() {
  const picked = state.compare.map(id => state.results.find(r => r.asset.id === id)).filter(Boolean);
  if (picked.length < 2) return;

  // ===== 决策摘要：从综合分、价格、授权算出一句话推荐 =====
  const commercialOK = a => /商用|商业|commercial/i.test(a.license || '');
  const score = r => Math.round(r.overall);
  // 排序：可商用优先 → 综合分高优先 → 同分区间价格低优先
  const ranked = [...picked].sort((a, b) => {
    const ca = commercialOK(a.asset) ? 1 : 0, cb = commercialOK(b.asset) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const sa = score(a), sb = score(b);
    if (Math.abs(sa - sb) >= 2) return sb - sa;
    return a.asset.price - b.asset.price;
  });
  const best = ranked[0];
  const bestScore = score(best);
  const runnerUp = ranked[1];
  const summary = [];
  summary.push(`推荐「${best.asset.name}」：¥${best.asset.price.toFixed(0)} · 综合 ${bestScore} 分${commercialOK(best.asset) ? ' · 可商用' : ' · 仅限个人'}`);
  if (runnerUp) {
    const gap = bestScore - score(runnerUp);
    const priceGap = runnerUp.asset.price - best.asset.price;
    if (gap >= 2) summary.push(`比次优高 ${gap} 分`);
    else if (priceGap > 0) summary.push(`比次优便宜 ¥${priceGap.toFixed(0)}${gap === 0 ? '、同分' : `、仅差 ${Math.abs(gap)} 分`}`);
  }
  const excluded = picked.filter(r => !commercialOK(r.asset) && commercialOK(best.asset));
  if (excluded.length) summary.push(`${excluded.map(r => r.asset.name.replace(/[.。]+$/, '')).join('、')} 仅限个人，商用需求下建议排除`);
  const summaryHtml = `<div class="cm-summary">
    <div class="cm-sum-title">✦ 决策摘要 <span>基于综合分、价格与授权自动算出</span></div>
    <div class="cm-sum-main">${summary.join('　·　')}</div>
  </div>`;

  // 定义对比维度：label, 取值函数, 越大越好(betterHigh)/越小越好/中性, 是否真实数据
  const rows = [
    { label: '综合评分', get: r => Math.round(r.overall), best: 'high' },
    { label: '兼容性', get: r => Math.round(r.scores.compatibility), best: 'high' },
    { label: '分辨率', get: r => Math.round(r.scores.resolution), best: 'high' },
    { label: '价格评估', get: r => Math.round(r.scores.price), best: 'high', note: '基于估算均价' },
    { label: '售价', get: r => `¥${r.asset.price.toFixed(2)}`, best: 'low', raw: r => r.asset.price },
    { label: '官方分类', get: r => r.asset.categoryName || r.asset.category, best: 'none' },
    { label: '文件体积', get: r => r.asset.fileSizeLabel || '—', best: 'none' },
    { label: '多边形面数', get: r => `${r.asset.polygons.toLocaleString()} tris`, best: 'high', raw: r => r.asset.polygons, est: true },
    { label: '贴图分辨率', get: r => `${r.asset.texture}px`, best: 'high', raw: r => r.asset.texture, est: true },
    { label: 'PBR 材质', get: r => r.asset.pbr ? '支持' : '不支持', best: 'none', est: true },
    { label: '浏览 / 下载', get: r => `${(r.asset.browses||0).toLocaleString()} / ${(r.asset.downloads||0).toLocaleString()}`, best: 'none' },
    { label: '发布年份', get: r => r.asset.year, best: 'none' },
    { label: '授权', get: r => r.asset.license, best: 'none', veto: r => !commercialOK(r.asset) }
  ];
  // 表头
  let html = '<table class="cm-table"><thead><tr><th class="cm-dim-col">对比维度</th>';
  picked.forEach(r => {
    html += `<th><div class="cm-asset"><img src="${assetImg(r.asset.image)}" alt=""><div><b>${r.asset.name}</b><small>${r.asset.categoryName || r.asset.category}</small></div></div></th>`;
  });
  html += '</tr></thead><tbody>';
  // 数据行
  rows.forEach(row => {
    const vals = picked.map(r => row.raw ? row.raw(r) : row.get(r));
    const nums = vals.filter(v => typeof v === 'number');
    // 平局检测：所有资产取值完全一致时不评优、整行灰显，避免"人人有星"的误导
    const isTie = vals.every(v => String(v) === String(vals[0]));
    let bestVal = null;
    if (!isTie && row.best !== 'none' && nums.length) {
      bestVal = row.best === 'high' ? Math.max(...nums) : Math.min(...nums);
    }
    const badge = row.est ? ' <span class="src-badge estimated">估算</span>'
      : row.note ? ' <span class="src-badge estimated">'+row.note+'</span>' : '';
    html += `<tr class="${isTie ? 'cm-tie' : ''}"><td class="cm-dim-col">${row.label}${badge}</td>`;
    picked.forEach((r, i) => {
      const isBest = bestVal !== null && vals[i] === bestVal;
      const isVeto = row.veto && row.veto(r);
      const cls = isVeto ? 'cm-veto' : (isBest ? 'cm-best' : '');
      html += `<td class="${cls}">${row.get(r)}${isVeto ? ' <span class="cm-veto-tag">不可商用</span>' : ''}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  els.cmBody.innerHTML = summaryHtml + html;
  els.compareOverlay.classList.remove('hidden');
}

function closeCompare() { els.compareOverlay.classList.add('hidden'); }

/* ---- 详情抽屉 ---- */
function openDrawer(r) {
  const a = r.asset, s = r.scores, d = r.detail;
  els.drawerTitle.textContent = a.name;
  const req = SCENE_REQUIREMENTS[state.intent.scene];
  // 统一结构 [文本, 是否警示]，避免 push 多参数产生错误元素
  const note = (text, warn = false) => [text, warn];
  const notes = [];
  if (d.catScore >= 90) notes.push(note(`品类与需求高度匹配（${a.category}）`));
  else if (state.intent.category) notes.push(note(`品类与需求不完全一致：资产为${a.category}，需求偏${state.intent.category}`, true));
  if (d.styleScore >= 90) notes.push(note(`风格一致：${a.style}`));
  else if (state.intent.style) notes.push(note(`风格有偏差：资产为${a.style}`, true));
  if (d.colorScore >= 85) notes.push(note('主色调与参考图 / 描述接近'));
  if (a.texture >= req.idealTexture) notes.push(note(`贴图 ${a.texture}px 满足「${req.label}」理想标准`));
  else if (a.texture < req.minTexture) notes.push(note(`贴图 ${a.texture}px 低于「${req.label}」最低要求 ${req.minTexture}px`, true));
  if (a.pbr) notes.push(note('含完整 PBR 材质，光照表现更真实'));
  else notes.push(note('未含 PBR 材质，真实感表现有限', true));
  if (d.discount > 0.12) notes.push(note(`价格低于市场均价 ${Math.round(d.discount * 100)}%，性价比突出`));
  else if (d.discount < 0) notes.push(note(`价格高于市场均价 ${Math.round(-d.discount * 100)}%`, true));

  const markerLeft = clamp(50 + d.discount * 180, 6, 94);

  // 一句话结论：把三个维度拼成普通人看得懂的话，不暴露权重细节
  const conclusion = [
    s.compatibility >= 85 ? '品类与需求高度契合' : s.compatibility >= 68 ? '品类基本匹配' : '与需求契合度偏低',
    s.resolution >= 85 ? '画质满足商用标准' : s.resolution >= 65 ? '画质够用' : '画质偏弱',
    d.verdict === '性价比高' ? '价格有明显优势' : d.verdict === '价格偏高' ? '价格略高' : '价格处于合理区间'
  ].join('，') + '。';

  // 关键提醒：一正一负各取一条，首屏只看这两条
  const positives = notes.filter(n => !n[1]);
  const warnings = notes.filter(n => n[1]);
  const reminders = [];
  if (warnings.length) reminders.push({ text: warnings[0][0], warn: true });
  if (positives.length) reminders.push({ text: positives[0][0], warn: false });
  if (!reminders.length) reminders.push({ text: '各项指标均达标，可放心选用', warn: false });

  els.drawerBody.innerHTML = `
    <div class="drawer-thumb"><img src="${assetImg(a.image)}" style="width:100%;height:100%;object-fit:cover" alt=""/></div>
    <div class="conclusion-card">
      <div class="cc-head"><span class="cc-score" style="color:${scoreColor(r.overall)}">${Math.round(r.overall)}</span><span class="cc-label">综合评分 <small>· 满分 100</small></span></div>
      <p class="cc-sentence">${conclusion}</p>
      <div class="cc-reminders">
        ${reminders.map(m => `<div class="cc-remind ${m.warn ? 'warn' : 'good'}"><span class="cc-dot"></span><span>${m.text}</span></div>`).join('')}
      </div>
    </div>
    <div class="dsec">
      <h4>三维评估</h4>
      <div class="breakdown">
        ${bdRow('兼容性', s.compatibility)}
        ${bdRow('分辨率', s.resolution)}
        ${bdRow('价格评估', s.price)}
        ${bdRow('综合评分', r.overall)}
      </div>
    </div>
    <details class="attr-fold">
      <summary><span>这个分怎么算的</span><span class="af-hint">分项 × 权重 = 贡献 · 点击展开</span></summary>
      <div class="attr-fold-body">
        <p class="attr-intro">每一项分数都由下列分项加权得出，可逐项核对。权重之和为 100%。</p>
        ${d.breakdown ? `
          ${attribBlock('兼容性', d.breakdown.compatibility, d.compatCapped ? '需求点名品类不一致，兼容性封顶 62 分' : null)}
          ${attribBlock('分辨率 / 画质', d.breakdown.resolution)}
          ${attribBlock('价格评估', d.breakdown.price)}
          ${attribBlock('综合评分', d.breakdown.overall)}
        ` : ''}
      </div>
    </details>
    <div class="dsec">
      <h4>官方数据 <span class="src-badge verified">● Mita3D 站点核验</span></h4>
      <table class="spec-table">
        <tr><td>售价</td><td><b>¥${a.price.toFixed(2)}</b> / 个</td></tr>
        <tr><td>官方分类</td><td>${a.categoryName || a.category}</td></tr>
        <tr><td>文件体积</td><td>${a.fileSizeLabel || '—'}</td></tr>
        <tr><td>平台格式</td><td>${a.platformFormat || a.formats.join(' / ')}</td></tr>
        <tr><td>浏览 / 下载</td><td>${(a.browses || 0).toLocaleString()} 次 / ${(a.downloads || 0).toLocaleString()} 次</td></tr>
        <tr><td>发布年份</td><td>${a.year}</td></tr>
        <tr><td>授权</td><td>${a.license}</td></tr>
        <tr><td>站点编号</td><td class="mono-dim">#${a.apiId || a.id}</td></tr>
      </table>
    </div>
    <div class="dsec">
      <h4>技术规格 <span class="src-badge estimated">○ 站点未公开 · 演示估算</span></h4>
      <table class="spec-table">
        <tr><td>多边形面数</td><td>${a.polygons.toLocaleString()} tris</td></tr>
        <tr><td>贴图分辨率</td><td>${a.texture} × ${a.texture} px</td></tr>
        <tr><td>PBR 材质</td><td>${a.pbr ? '支持' : '不支持'}</td></tr>
        <tr><td>LOD 层级</td><td>${a.lod} 级</td></tr>
      </table>
    </div>
    <div class="dsec">
      <h4>价格评估</h4>
      <div class="price-analysis">
        <div class="pa-head"><div class="pa-price">¥${a.price} <small>/ 个</small></div><small>市场均价 ¥${a.marketAvg}</small></div>
        <div class="price-range"><span>¥${d.estLow} 偏低</span><span>合理区间</span><span>¥${d.estHigh} 偏高</span></div>
        <div class="range-bar"><div class="range-marker" style="left:${markerLeft}%"></div></div>
        <div class="pa-verdict ${verdictClass(d.verdict)}">${d.verdict} · 建议成交区间 ¥${d.estLow}–${d.estHigh}</div>
      </div>
    </div>
    <div class="dsec">
      <h4>风险提示 <span class="src-badge neutral">仅列出需留意项</span></h4>
      ${warnings.length
        ? `<ul class="note-list">${warnings.map(n => `<li class="warn">${n[0]}</li>`).join('')}</ul>`
        : `<div class="no-risk"><span class="cc-dot"></span>没有明显风险项，各项均达标</div>`}
    </div>`;
  els.drawerOverlay.classList.remove('hidden');
  requestAnimationFrame(() => els.drawer.classList.add('open'));
}
function bdRow(name, val) {
  return `<div class="bd-row"><span class="bd-name">${name}</span><div class="bar"><i style="width:${Math.round(val)}%;background:${scoreColor(val)}"></i></div><span class="bd-val" style="color:${scoreColor(val)}">${Math.round(val)}</span></div>`;
}
// 单个维度的评分归因：分项 × 权重 = 贡献分，末尾汇总校验
function attribBlock(name, block, note) {
  if (!block) return '';
  const rows = block.parts.map(p => {
    if (p.bonus) {
      return `<div class="attr-row"><span class="attr-name">${p.name}</span><span class="attr-formula">+${Math.round(p.score)} 加成</span><span class="attr-contrib">+${Math.round(p.score)}</span></div>`;
    }
    const contrib = p.score * p.weight;
    return `<div class="attr-row"><span class="attr-name">${p.name}</span><span class="attr-formula">${Math.round(p.score)} × ${Math.round(p.weight * 100)}%</span><span class="attr-contrib">${contrib.toFixed(1)}</span></div>`;
  }).join('');
  return `<div class="attr-block">
    <div class="attr-head"><span>${name}</span><b style="color:${scoreColor(block.final)}">${Math.round(block.final)}</b></div>
    ${rows}
    ${note ? `<div class="attr-note">${note}</div>` : ''}
  </div>`;
}
function closeDrawer() {
  els.drawer.classList.remove('open');
  setTimeout(() => els.drawerOverlay.classList.add('hidden'), 320);
}
els.closeDrawer.addEventListener('click', closeDrawer);
els.drawerClose2.addEventListener('click', closeDrawer);
els.drawerOverlay.addEventListener('click', closeDrawer);
els.selectAsset.addEventListener('click', () => { showToast('已选用该资产（原型演示）'); closeDrawer(); });

/* ---- 其它 ---- */
els.sortSelect.addEventListener('change', renderResults);
els.resetBtn.addEventListener('click', () => location.reload());
els.cbClear.addEventListener('click', () => { state.compare = []; renderResults(); renderCompareBar(); });
els.cbGo.addEventListener('click', renderCompare);
els.cmClose.addEventListener('click', closeCompare);
els.compareOverlay.addEventListener('click', e => { if (e.target === els.compareOverlay) closeCompare(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCompare(); closeDrawer(); } });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function showToast(msg) {
  els.toast.textContent = msg; els.toast.classList.add('show');
  clearTimeout(showToast._t); showToast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}
