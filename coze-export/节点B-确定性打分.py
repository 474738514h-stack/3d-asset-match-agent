# 代码节点 B：RAG 召回 + 确定性打分 + 过滤 + 排序（复刻原项目 engine.js 评分公式）
# 资产不内嵌！只处理上游「知识库检索」节点召回的资产，代码里没有任何资产数据。
# engine 场景 -> 决定分辨率标准；budget 预算 -> 超预算降权并标注。
#
# 扣子输入参数（在节点面板添加）：
#   intent    Object  引用"多模态需求解析"节点的整个输出对象
#                     （含 category/style/color/subject/keywords，多余的 query/summary 自动忽略；
#                       也兼容 JSON 字符串）
#   recalled  Array   引用"知识库检索"节点的 outputList（召回结果数组）
#   engine    String  引用"开始"节点的 engine（如 render / 静帧渲染 / 电商主图）
#   budget    Number  引用"开始"节点的 budget（数字，0 表示不限）
# 扣子输出参数：results(String) / summary(String) / count(Number) / topOne(String)

import json

# ===== 颜色族查找表（规则常量，不是资产数据）=====
COLOR_FAMILY = json.loads(r'''{"米白/奶油":["#F0EBE1","#E8DCC8","#F4F4F4","#EDEDED","#D8D0C0","#EFE4D2"],"原木/棕":["#A07850","#8B6A45","#6B5847","#8A7058","#6A4A38","#B9915F","#C49A6C"],"灰/黑":["#55504A","#4A4A4A","#2F2F2F","#2D2C2E","#4C4C4D","#5A5148","#8A8A88"],"金属/金":["#C8A840","#C0A987","#8C7853","#B0A68A","#C8B898"],"蓝/透明":["#7F94B7","#DCEAF0","#A9C7D4","#667899"],"橙/红":["#F2A020","#E8792A","#C03030","#EF7E49","#D96A8A"]}''')

SCENE_REQUIREMENTS = {
    'realtime': {'minTexture':1024,'minPoly':8000,'idealTexture':2048,'idealPoly':40000},
    'render':   {'minTexture':2048,'minPoly':20000,'idealTexture':4096,'idealPoly':70000},
    'ar':       {'minTexture':2048,'minPoly':15000,'idealTexture':4096,'idealPoly':60000},
    'film':     {'minTexture':4096,'minPoly':50000,'idealTexture':4096,'idealPoly':100000}
}
PRODUCT_NOUNS = ['猞猁','犀牛','袋熊','浣熊','恐龙','鸟','运动鞋','球鞋','花束','机甲','机器人','雕像','雕塑','太空站','狗屋','教堂','房屋','摩托','机车','发动机','引擎','机械','动物','花','珊瑚','角色','鞋']
SPECIFIC_NOUNS = ['猞猁','犀牛','袋熊','浣熊','恐龙','鸟','花束','珊瑚','教堂','房屋','狗屋','太空站','摩托','机车','机甲','机器人','雕像','雕塑','运动鞋','球鞋','发动机','引擎']
GENERIC_NOUNS = ['动物','植物','建筑','载具','角色','鞋履','工业机械','机械','花','鞋']
TOPIC_STOP = ['模型','产品','物品','物体','东西','一个','这个','那个','主体','3d','3D','展示','道具']

# ===== 从 RAG 召回结果解析资产（知识库每条文档是一行完整 JSON）=====
def extract_json_objects(text):
    """从一段召回文本里提取所有平衡的 {...} JSON 对象（容忍前后缀、markdown 代码块）"""
    text = str(text or '').replace('```json', '').replace('```', '')
    objs, depth, start = [], 0, -1
    in_str, esc = False, False
    for i, ch in enumerate(text):
        if in_str:
            if esc: esc = False
            elif ch == '\\': esc = True
            elif ch == '"': in_str = False
            continue
        if ch == '"': in_str = True
        elif ch == '{':
            if depth == 0: start = i
            depth += 1
        elif ch == '}':
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    try:
                        o = json.loads(text[start:i+1])
                        if isinstance(o, dict): objs.append(o)
                    except Exception:
                        pass
                    start = -1
    return objs

# ===== 扣子知识库召回的是"文本化 JSON"：数值是字符串、数组变成 a|b|c、可能缺 texture =====
# 归一化成代码期望的类型，否则 score_asset 里做除法/比较会报 str/int 类型错误
def to_num(v, default=0.0):
    if v is None or v == '': return default
    if isinstance(v, (int, float)): return float(v)
    try: return float(str(v).strip())
    except Exception: return default

def to_list(v):
    if v is None or v == '': return []
    if isinstance(v, list): return v
    if isinstance(v, str):
        return [p.strip() for p in v.replace('|', ',').split(',') if p.strip()]
    return []

def to_bool(v):
    if isinstance(v, bool): return v
    return str(v).strip().lower() in ('true', '1', 'yes', 'y')

def normalize_asset(a):
    out = dict(a)
    for k in ('polygons','texture','price','marketAvg','rating','lod','browsers','downloads','collections','fileSize'):
        out[k] = to_num(a.get(k), 0)
    for k in ('colors','tags','formats'):
        out[k] = to_list(a.get(k))
    for k in ('pbr','verified'):
        out[k] = to_bool(a.get(k))
    # 召回文本可能缺 texture：按面数推算一个演示值（仅评分用，非真实规格）
    if not out['texture']:
        out['texture'] = 2048 if out['polygons'] >= 50000 else 1024
    if not out['rating']:
        out['rating'] = 4.5
    if not out.get('id'):
        out['id'] = a.get('apiId') or a.get('name') or ''
    return out

def parse_recalled(recalled):
    """把知识库 outputList 解析成资产数组，按文档ID/资产ID去重"""
    if recalled is None: return []
    if isinstance(recalled, str): items = [{'output': recalled}]
    elif isinstance(recalled, dict): items = [recalled]
    elif isinstance(recalled, list): items = recalled
    else: items = []
    assets, seen = [], set()
    need = ['name', 'category', 'price', 'polygons']  # texture 可能缺，normalize 里补
    for it in items:
        if isinstance(it, str): txt, docid = it, ''
        elif isinstance(it, dict):
            txt = it.get('output') or it.get('content') or ''
            docid = it.get('documentId') or ''
        else: continue
        for obj in extract_json_objects(txt):
            if not all(k in obj for k in need): continue
            a = normalize_asset(obj)
            key = a.get('apiId') or a.get('id') or docid or a.get('name')
            if key and key in seen: continue
            if key: seen.add(key)
            assets.append(a)
    return assets

def clamp(v, a=0, b=100): return max(a, min(b, v))
def hex_to_rgb(h):
    h = h.lstrip('#')
    n = int(h, 16)
    return (n >> 16) & 255, (n >> 8) & 255, n & 255
def color_distance(h1, h2):
    a, b = hex_to_rgb(h1), hex_to_rgb(h2)
    return ((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2) ** 0.5
def nearest_family(h):
    best, bd = None, 1e9
    for fam, lst in COLOR_FAMILY.items():
        for c in lst:
            d = color_distance(h, c)
            if d < bd: bd, best = d, fam
    return best, bd
def color_score_for(asset, families):
    if not families: return 55
    for c in asset.get('colors') or []:
        if nearest_family(c)[0] in families: return 92
    acc = 0.0
    for c in asset.get('colors') or []:
        acc += max(0, 100 - nearest_family(c)[1] * 0.9)
    return clamp(acc / len(asset['colors'])) if asset.get('colors') else 55

def norm_engine(engine):
    s = str(engine or '').strip()
    if s in SCENE_REQUIREMENTS: return s
    m = {'实时预览':'realtime','网页':'realtime','静帧渲染':'render','电商主图':'render',
         '沉浸式':'ar','ar':'ar','AR':'ar','vr':'ar','VR':'ar','影视级':'film','特写':'film'}
    for k, v in m.items():
        if k in s: return v
    return 'realtime'

def score_asset(a, intent, req, budget):
    kws = intent.get('keywords') or []
    # 1. 兼容性
    cat = 55
    if intent.get('category'): cat = 96 if a['category'] == intent['category'] else 30
    sty = 52
    if intent.get('style'):
        s1, s2 = intent['style'], (a.get('style') or '')
        sty = 95 if (s1 in s2 or s2 in s1) else 42
    families = [intent['color']] if intent.get('color') else []
    col = color_score_for(a, families)
    tag = 50
    if kws:
        hit = sum(1 for k in kws if k in (a.get('tags') or []) or k in (a.get('name') or ''))
        tag = clamp(50 + hit * 26)
    compat = clamp(cat*0.42 + sty*0.26 + col*0.20 + tag*0.12)
    named = next((k for k in PRODUCT_NOUNS if k in kws), None)
    capped = False
    if named and not (named in (a.get('tags') or []) or named in (a.get('name') or '')):
        compat, capped = min(compat, 62), True
    # 2. 分辨率 / 画质（engine 在这里生效）
    tex_r = clamp(a['texture'] / req['idealTexture'], 0, 1.25)
    poly_r = clamp(a['polygons'] / req['idealPoly'], 0, 1.25)
    ts, ps = tex_r*100, poly_r*100
    if a['texture'] < req['minTexture']: ts *= 0.72
    if a['polygons'] < req['minPoly']: ps *= 0.78
    ts, ps = clamp(ts), clamp(ps)
    quality = (12 if a.get('pbr') else 0) + min(a.get('lod', 0), 4)*2
    resolution = clamp(ts*0.42 + ps*0.40 + quality)
    # 3. 价格评估
    avg = a.get('marketAvg') or a['price'] or 1
    discount = (avg - a['price']) / avg
    value = clamp(58 + discount*150)
    rating = (a.get('rating', 4.5)/5)*100
    price_s = clamp(value*0.62 + rating*0.20 + 62*0.18)
    # 4. 综合
    overall = clamp(compat*0.46 + resolution*0.30 + price_s*0.24)
    # budget 在这里生效：超预算降权并标注（不直接删，避免低预算时空结果）
    over = bool(budget and budget > 0 and a['price'] > budget)
    if over:
        price_s, overall = clamp(price_s*0.6), clamp(overall*0.75)
    verdict = '价格合理'
    if discount > 0.18: verdict = '性价比高'
    elif discount < -0.05: verdict = '价格偏高'
    return {
        'id': a.get('apiId') or a['id'], 'name': a['name'],
        'category': a['category'], 'style': a.get('style',''),
        'price': a['price'], 'license': a.get('license',''),
        'overall': round(overall,1),
        'scores': {'compatibility':round(compat,1),'resolution':round(resolution,1),'price':round(price_s,1)},
        'overBudget': over, 'verdict': verdict, 'capped': capped
    }

def match_topic(a, t, use_cat=False):
    if not t or len(str(t)) < 2: return False
    fields = [a.get('name','')] + list(a.get('tags') or [])
    if use_cat and a.get('category'): fields.append(a['category'])
    return any((t in str(f)) or (str(f) in t) for f in fields if f)

def filter_relevant(ranked, intent):
    strong, generic = [], []
    subj = intent.get('subject','')
    if subj and len(subj) >= 2 and subj not in TOPIC_STOP: strong.append(subj)
    for k in (intent.get('keywords') or []):
        if k in SPECIFIC_NOUNS and k not in strong: strong.append(k)
        elif k in GENERIC_NOUNS and k not in generic and k not in strong: generic.append(k)
    if strong:
        hit = [r for r in ranked if any(match_topic(r['_a'], t, False) for t in strong)]
        if hit: return hit
    if intent.get('category'):
        hit = [r for r in ranked if r['_a']['category'] == intent['category']]
        if hit: return hit
    if generic:
        hit = [r for r in ranked if any(match_topic(r['_a'], t, True) for t in generic)]
        if hit: return hit
    decent = [r for r in ranked if r['scores']['compatibility'] >= 45]
    return (decent or ranked)[:8]

async def main(args: Args) -> Output:
    params = args.params
    raw_intent = params.get('intent') or '{}'
    try:
        intent = json.loads(raw_intent) if isinstance(raw_intent, str) else (raw_intent or {})
    except Exception:
        intent = {}
    engine = params.get('engine') or 'realtime'
    try: budget = float(params.get('budget') or 0)
    except Exception: budget = 0

    # 数据来源：RAG 召回结果（不再内嵌资产）
    assets = parse_recalled(params.get('recalled'))
    req = SCENE_REQUIREMENTS[norm_engine(engine)]
    ranked = []
    for a in assets:
        r = score_asset(a, intent, req, budget)
        r['_a'] = a
        ranked.append(r)
    ranked.sort(key=lambda x: x['overall'], reverse=True)
    picked = filter_relevant(ranked, intent)
    for r in picked: r.pop('_a', None)
    top = picked[:5]

    n = len(top)
    if n == 0:
        summary = '知识库未召回相关资产，或召回结果与需求不匹配，建议放宽检索条件。'
    else:
        b = top[0]
        lic = '可商用' if '商用' in (b['license'] or '') else '仅个人'
        summary = ('从召回的 %d 个资产中推荐「%s」：¥%g · 综合 %g 分 · %s%s'
                   % (n, b['name'], b['price'], b['overall'], lic,
                      ' · 超出预算' if b['overBudget'] else ''))

    ret: Output = {
        'results': json.dumps(top, ensure_ascii=False),
        'summary': summary,
        'count': n,
        'topOne': top[0]['name'] if top else ''
    }
    return ret
