/**
 * 核心逻辑：特征提取 + 三维评估 + 排序
 */

/* ---------- 通用工具 ---------- */
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}
function colorDistance(h1, h2) {
  const a = hexToRgb(h1), b = hexToRgb(h2);
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
function nearestFamily(hex) {
  let best = null, bestD = Infinity;
  for (const [family, list] of Object.entries(COLOR_FAMILY)) {
    for (const c of list) {
      const d = colorDistance(hex, c);
      if (d < bestD) { bestD = d; best = family; }
    }
  }
  return { family: best, dist: bestD };
}
function colorScoreFor(asset, families) {
  if (!families || !families.length) return 55;
  const hit = asset.colors.some(c => families.includes(nearestFamily(c).family));
  if (hit) return 92;
  // 部分接近
  let acc = 0;
  asset.colors.forEach(c => { acc += Math.max(0, 100 - nearestFamily(c).dist * 0.9); });
  return clamp(acc / asset.colors.length);
}

/* ---------- 文本特征解析 ---------- */
function parseText(text) {
  const t = (text || '').toLowerCase();
  const out = { category: null, style: null, color: null, keywords: [] };
  const hit = (dict) => {
    for (const [key, words] of Object.entries(dict)) {
      if (words.some(w => t.includes(w))) return key;
    }
    return null;
  };
  out.category = hit(KEYWORD_MAP.category);
  out.style = hit(KEYWORD_MAP.style);
  out.color = hit(KEYWORD_MAP.color);
  out.keywords = Object.values(KEYWORD_MAP).flatMap(d => Object.values(d)).flat().filter(w => t.includes(w));
  return out;
}

/* ---------- 图像主色提取（Canvas 量化） ---------- */
function extractImageColors(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const W = 80, H = 80;
      canvas.width = W; canvas.height = H;
      ctx.drawImage(img, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      const buckets = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) continue;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 248 || lum < 12) continue; // 去背景/纯黑
        const key = `${r >> 5},${g >> 5},${b >> 5}`;
        const cur = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        cur.n++; cur.r += r; cur.g += g; cur.b += b;
        buckets.set(key, cur);
      }
      const colors = [...buckets.values()]
        .sort((x, y) => y.n - x.n).slice(0, 4)
        .map(v => '#' + [v.r / v.n, v.g / v.n, v.b / v.n]
          .map(x => Math.round(x).toString(16).padStart(2, '0')).join(''));
      const families = [...new Set(colors.map(c => nearestFamily(c).family))];
      URL.revokeObjectURL(url);
      resolve({ colors, families });
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ colors: [], families: [] }); };
    img.src = url;
  });
}

/* ---------- 融合意图 ---------- */
async function buildIntent({ file, text, scene }) {
  const parsed = parseText(text);
  let img = { colors: [], families: [] };
  if (file && /image\//.test(file.type)) img = await extractImageColors(file);

  const families = [...new Set([parsed.color, ...img.families].filter(Boolean))];
  const category = parsed.category;
  const style = parsed.style;
  const source = [];
  if (file) source.push(file.type.startsWith('image/') ? '图片' : '文件');
  if (text && text.trim()) source.push('文本');

  // 置信度：有图 + 文本最高
  let confidence = 40;
  if (file) confidence += 26;
  if (text && text.trim()) confidence += 22;
  if (familyCount(families)) confidence += 8;
  confidence = clamp(confidence, 0, 99);

  return {
    category, style, families, imageColors: img.colors,
    textKeywords: parsed.keywords, scene, confidence,
    source: source.length ? source.join(' + ') : '默认',
    summary: describeIntent({ category, style, families, file })
  };
}
function familyCount(f) { return f ? f.filter(Boolean).length : 0; }
function describeIntent({ category, style, families, file }) {
  const parts = [];
  parts.push(category ? `品类「${category}」` : '品类未限定');
  parts.push(style ? `风格「${style}」` : '风格不限');
  if (families.length) parts.push(`主色调偏「${families.slice(0, 2).join('、')}」`);
  if (file) parts.push('已参考上传图的色彩特征');
  return parts.join('，');
}

/* ---------- 三维评分 ---------- */
function scoreAsset(asset, intent) {
  const req = SCENE_REQUIREMENTS[intent.scene] || SCENE_REQUIREMENTS.realtime;

  // 1. 兼容性
  let catScore = 55;
  if (intent.category) catScore = asset.category === intent.category ? 96 : 30;
  let styleScore = 52;
  if (intent.style) styleScore = asset.style.includes(intent.style) || intent.style.includes(asset.style) ? 95 : 42;
  const colorScore = colorScoreFor(asset, intent.families);
  let tagScore = 50;
  if (intent.textKeywords.length) {
    const hit = intent.textKeywords.filter(k => asset.tags.includes(k) || asset.name.includes(k)).length;
    tagScore = clamp(50 + hit * 26);
  }
  const compatibility = clamp(catScore * 0.42 + styleScore * 0.26 + colorScore * 0.20 + tagScore * 0.12);

  // 显式品类名词优先级：需求中点名的具体产品（如"耳机"）不匹配时压低兼容性
  // 具体名词优先于泛类名词；按列表顺序（具体在前）匹配，而非关键词出现顺序
  const PRODUCT_NOUNS = ['猞猁','犀牛','袋熊','浣熊','恐龙','鸟','运动鞋','球鞋','花束','机甲','机器人','雕像','雕塑','太空站','狗屋','教堂','房屋','摩托','机车','发动机','引擎','机械','动物','花','珊瑚','角色','鞋'];
  const named = PRODUCT_NOUNS.find(k => intent.textKeywords.includes(k));
  let compatFinal = compatibility;
  let compatCapped = false;
  if (named && !(asset.tags.includes(named) || asset.name.includes(named))) {
    compatFinal = Math.min(compatibility, 62);
    compatCapped = true;
  }

  // 2. 分辨率 / 画质适配
  const texRatio = clamp(asset.texture / req.idealTexture, 0, 1.25);
  const polyRatio = clamp(asset.polygons / req.idealPoly, 0, 1.25);
  let textureScore = texRatio * 100;
  let polyScore = polyRatio * 100;
  if (asset.texture < req.minTexture) textureScore *= 0.72;
  if (asset.polygons < req.minPoly) polyScore *= 0.78;
  textureScore = clamp(textureScore); polyScore = clamp(polyScore);
  let qualityBonus = (asset.pbr ? 12 : 0) + Math.min(asset.lod, 4) * 2;
  const resolution = clamp(textureScore * 0.42 + polyScore * 0.40 + qualityBonus);

  // 3. 价格评估
  const discount = (asset.marketAvg - asset.price) / asset.marketAvg;
  const valueScore = clamp(58 + discount * 150);
  const ratingScore = (asset.rating / 5) * 100;
  const priceScore = clamp(valueScore * 0.62 + ratingScore * 0.20 + 62 * 0.18);
  let verdict = '价格合理';
  if (discount > 0.18) verdict = '性价比高';
  else if (discount < -0.05) verdict = '价格偏高';

  const overall = clamp(compatFinal * 0.46 + resolution * 0.30 + priceScore * 0.24);

  // 评分归因：每个分项 → 权重 → 贡献分，供抽屉展示「分数怎么算出来的」
  const pbrBonus = asset.pbr ? 12 : 0;
  const lodBonus = Math.min(asset.lod, 4) * 2;
  const breakdown = {
    compatibility: {
      final: compatFinal, capped: compatCapped,
      parts: [
        { name: '品类匹配', score: catScore, weight: 0.42 },
        { name: '风格匹配', score: styleScore, weight: 0.26 },
        { name: '色彩匹配', score: colorScore, weight: 0.20 },
        { name: '关键词', score: tagScore, weight: 0.12 }
      ]
    },
    resolution: {
      final: resolution,
      parts: [
        { name: '贴图分辨率', score: textureScore, weight: 0.42 },
        { name: '多边形面数', score: polyScore, weight: 0.40 },
        { name: 'PBR + LOD 加成', score: qualityBonus, weight: null, bonus: true }
      ]
    },
    price: {
      final: priceScore,
      parts: [
        { name: '价格折扣分', score: valueScore, weight: 0.62 },
        { name: '用户评分', score: ratingScore, weight: 0.20 },
        { name: '基准分', score: 62, weight: 0.18 }
      ]
    },
    overall: {
      final: overall,
      parts: [
        { name: '兼容性', score: compatFinal, weight: 0.46 },
        { name: '分辨率', score: resolution, weight: 0.30 },
        { name: '价格评估', score: priceScore, weight: 0.24 }
      ]
    }
  };

  return {
    asset, overall,
    scores: { compatibility: compatFinal, resolution, price: priceScore },
    detail: {
      catScore, styleScore, colorScore, tagScore,
      textureScore, polyScore, qualityBonus, pbrBonus, lodBonus, pbr: asset.pbr, lod: asset.lod,
      discount, verdict, valueScore, ratingScore, compatCapped,
      estLow: Math.round(asset.price * 0.9), estHigh: Math.round(asset.price * 1.18),
      breakdown
    }
  };
}

/* ---------- 相关性过滤：剔除与需求完全不相干的资产 ---------- */
// 具体产品名词：一旦识别到，作为强锚点，只保留命中它的资产
const SPECIFIC_NOUNS = [
  '猞猁','犀牛','袋熊','浣熊','恐龙','鸟','花束','珊瑚','教堂','房屋','狗屋',
  '太空站','摩托','机车','机甲','机器人','雕像','雕塑','运动鞋','球鞋','发动机','引擎'
];
// 泛类名：仅在无具体主体时用于收拢同类，不与具体主体叠加（否则会把整个类放进来）
const GENERIC_NOUNS = ['动物','植物','建筑','载具','角色','鞋履','工业机械','机械','花','鞋'];
// 视觉模型可能给出的无信息量主体词，不作为过滤锚点
const TOPIC_STOP = ['模型','产品','物品','物体','东西','一个','这个','那个','主体','3d','3D','展示','道具'];

function collectTopics(intent) {
  const strong = [], generic = [];
  const v = intent.visionData;
  // 视觉识别的主体最可信，作为强锚点
  if (v && v.subject && v.subject.length >= 2 && !TOPIC_STOP.includes(v.subject)) strong.push(v.subject);
  (intent.textKeywords || []).forEach(k => {
    if (SPECIFIC_NOUNS.includes(k) && !strong.includes(k)) strong.push(k);
    else if (GENERIC_NOUNS.includes(k) && !generic.includes(k) && !strong.includes(k)) generic.push(k);
  });
  return { strong, generic };
}

function assetMatchesTopic(asset, topic, useCategory) {
  if (!topic || topic.length < 2) return false;
  // 只在 name / tags 上做包含匹配；category 容易把"动物"这类泛称扩散到整类，故按需关闭
  const fields = [asset.name, ...(asset.tags || [])];
  if (useCategory && asset.category) fields.push(asset.category);
  return fields.some(f => f && (String(f).includes(topic) || topic.includes(String(f))));
}

function filterRelevant(ranked, intent) {
  const { strong, generic } = collectTopics(intent);

  // 1) 有具体主体（视觉 subject 或点名产品）：严格只留命中的，不再叠加泛类
  if (strong.length) {
    const hit = ranked.filter(r => strong.some(t => assetMatchesTopic(r.asset, t, false)));
    if (hit.length) return hit;
  }

  // 2) 有品类信号：只保留同品类
  if (intent.category) {
    const hit = ranked.filter(r => r.asset.category === intent.category);
    if (hit.length) return hit;
  }

  // 3) 仅有泛类名：按泛类收拢
  if (generic.length) {
    const hit = ranked.filter(r => generic.some(t => assetMatchesTopic(r.asset, t, true)));
    if (hit.length) return hit;
  }

  // 4) 无明确主题（如纯风格/色彩需求）：剔除兼容性过低者，并限量
  const decent = ranked.filter(r => r.scores.compatibility >= 45);
  const pool = decent.length ? decent : ranked;
  return pool.slice(0, 8);
}

function evaluateAll(intent) {
  const ranked = ASSETS.map(a => scoreAsset(a, intent)).sort((x, y) => y.overall - x.overall);
  return filterRelevant(ranked, intent);
}
