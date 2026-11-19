/**
 * 多模态视觉理解模块
 * 通过 WorkBuddy 免密钥大模型服务，把买家上传的商品图/草图解析成结构化特征。
 * 识别结果直接驱动匹配引擎，替代原先用硬编码关键词猜测的"伪理解"。
 */

// 前端可公开的云配置（publishableKey 本身不携带权限，服务端按 Origin 校验）
const VISION_CONFIG = {
  endpoint: 'https://asset-match-agent.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_Ueby935wrTVKHDFv40PrZ5_MSa7DDk7wkJasb8fO08W7W8NNdUyW3gs',
  model: 'glm-5.3-flash'
};

const VALID_CATEGORIES = ['动物', '植物花卉', '建筑', '载具', '角色', '鞋履', '工业机械'];
const VALID_STYLES = ['写实', '卡通', '科幻', '古典', '潮流设计'];
const VALID_COLORS = ['米白/奶油', '原木/棕', '灰/黑', '金属/金', '蓝/透明', '橙/红'];

let _cloud = null;
function getCloud() {
  if (!window.WorkBuddyCloud) throw new Error('SDK 未加载');
  if (!_cloud) {
    _cloud = WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: VISION_CONFIG.endpoint,
      oauthRelayBaseUrl: VISION_CONFIG.oauthRelayBaseUrl,
      publishableKey: VISION_CONFIG.publishableKey,
    });
  }
  return _cloud;
}

// 图片预处理参数：草图的主体/风格识别不需要高清，长边 1024 足够
const IMG_MAX_EDGE = 1024;
const JPEG_QUALITY = 0.82;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

/** 裁掉四周纯白/透明边；主体占满画面时返回 null 不裁，避免误裁 */
function trimWhitespace(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  const isInk = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 24) return false;
    return !(data[i] > 244 && data[i + 1] > 244 && data[i + 2] > 244);
  };
  let left = w, right = -1, top = h, bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isInk(x, y)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  const tw = right - left + 1, th = bottom - top + 1;
  // 仅当主体几乎占满整张图（无白边可裁）时放弃；草图主体小、白边多正需要裁
  if (tw > w * 0.96 && th > h * 0.96) return null;
  const pad = Math.max(2, Math.round(Math.min(w, h) * 0.01));
  left = Math.max(0, left - pad); top = Math.max(0, top - pad);
  right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** 预处理：缩放 → 裁白边 → JPEG 压缩，返回 base64 与统计信息 */
async function preprocessImage(file) {
  const origBytes = file.size || 0;
  const img = await loadImage(file);
  const origDim = `${img.naturalWidth}×${img.naturalHeight}`;
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const sw = Math.max(1, Math.round(img.naturalWidth * scale));
  const sh = Math.max(1, Math.round(img.naturalHeight * scale));
  const c1 = document.createElement('canvas');
  c1.width = sw; c1.height = sh;
  const ctx1 = c1.getContext('2d', { willReadFrequently: true });
  ctx1.fillStyle = '#fff';
  ctx1.fillRect(0, 0, sw, sh);
  ctx1.drawImage(img, 0, 0, sw, sh);

  let source = c1, trimmed = false;
  if (sw >= 64 && sh >= 64) {
    const r = trimWhitespace(ctx1, sw, sh);
    if (r && r.w >= 32 && r.h >= 32) {
      const c2 = document.createElement('canvas');
      c2.width = r.w; c2.height = r.h;
      const ctx2 = c2.getContext('2d');
      ctx2.fillStyle = '#fff';
      ctx2.fillRect(0, 0, r.w, r.h);
      ctx2.drawImage(c1, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      source = c2; trimmed = true;
    }
  }
  const dataUrl = source.toDataURL('image/jpeg', JPEG_QUALITY);
  const b64 = String(dataUrl).split(',')[1] || '';
  return {
    b64,
    origBytes,
    outBytes: Math.round(b64.length * 3 / 4),
    origDim,
    outDim: `${source.width}×${source.height}`,
    trimmed
  };
}

const SYSTEM_PROMPT = `你是 3D 资产检索平台的视觉分析助手。分析用户上传的商品照片或手绘草图，输出结构化特征用于匹配 3D 资产库。
严格只输出一个 JSON 对象，不要输出任何解释文字或 Markdown。字段取值必须从给定选项中选，不确定则填 null。`;

function buildPrompt(text) {
  const extra = text && text.trim() ? `\n用户补充描述（可修正你的判断）：${text.trim().slice(0, 200)}` : '';
  return `识别图中的 3D 模型，输出 JSON：
{
  "category": "从[动物,植物花卉,建筑,载具,角色,鞋履,工业机械]中选最匹配的一个",
  "style": "从[写实,卡通,科幻,古典,潮流设计]中选一个",
  "color": "从[米白/奶油,原木/棕,灰/黑,金属/金,蓝/透明,橙/红]中选主体色一个",
  "subject": "主体名词，例如 犀牛、运动鞋、机甲、教堂",
  "material": "主体材质，例如 金属、皮革、陶瓷、织物、石材",
  "keywords": ["用于检索的关键词，3-6 个中文词"],
  "summary": "一句话描述这个 3D 模型的外观与用途"
}${extra}`;
}

function extractJSON(raw) {
  const s = String(raw || '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
  }
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch (e) {}
  return null;
}

/**
 * 调用视觉模型理解需求图片
 * @returns {{ok, data, error, model, raw}}
 */
async function understandRequirement(file, text) {
  let preprocess = null;
  try {
    const cloud = getCloud();
    preprocess = await preprocessImage(file);
    let answer = '';
    for await (const chunk of cloud.llm.chat.completions.create({
      model: VISION_CONFIG.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: buildPrompt(text) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${preprocess.b64}` } }
        ]}
      ],
      stream: true,
      response_format: { type: 'json_object' }
    })) {
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && delta.content) answer += delta.content;
    }
    const data = extractJSON(answer);
    if (!data) return { ok: false, error: '模型返回结果无法解析', raw: answer, model: VISION_CONFIG.model, preprocess };
    // 归一化：不在枚举内的值置空，避免污染匹配
    data.category = VALID_CATEGORIES.includes(data.category) ? data.category : null;
    data.style = VALID_STYLES.includes(data.style) ? data.style : null;
    data.color = VALID_COLORS.includes(data.color) ? data.color : null;
    data.keywords = Array.isArray(data.keywords) ? data.keywords.filter(x => typeof x === 'string').slice(0, 8) : [];
    data.subject = typeof data.subject === 'string' ? data.subject.slice(0, 40) : null;
    data.material = typeof data.material === 'string' ? data.material.slice(0, 40) : null;
    data.summary = typeof data.summary === 'string' ? data.summary.slice(0, 160) : null;
    return { ok: true, data, model: VISION_CONFIG.model, raw: answer, preprocess };
  } catch (e) {
    const code = e && e.error && e.error.code ? e.error.code : 'unknown';
    let msg = '视觉理解调用失败';
    if (code.indexOf('auth_') === 0) msg = '视觉服务授权失败（请在已发布的站点访问）';
    else if (code.indexOf('quota_') === 0) msg = '视觉服务额度不足';
    else if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) msg = '视觉服务暂时不可用，请重试';
    else if (e && e.message) msg = e.message;
    return { ok: false, error: msg, code, model: VISION_CONFIG.model, preprocess };
  }
}

const Vision = { understandRequirement, VALID_CATEGORIES, VALID_STYLES, VALID_COLORS };
