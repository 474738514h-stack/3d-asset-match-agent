# 代码节点 C：结果组装（确定性，不用大模型，省 token）
# 位置：第5步「选择器 count>0」的【是】分支 → 本节点 → 回复节点
#
# 扣子输入参数（在节点面板手动添加）：
#   results  String  引用"确定性打分(RAG)"节点的 results（Top5 的 JSON 字符串）
#   summary  String  引用"确定性打分(RAG)"节点的 summary（一句话推荐）
#   count    Number  引用"确定性打分(RAG)"节点的 count
#   topOne   String  引用"确定性打分(RAG)"节点的 topOne
# 扣子输出参数（手动添加，1 个）：
#   text  String —— 整理好的 Markdown，直接给回复节点引用

import json

def reason(compat, res, verdict):
    """一句话推荐理由，对齐原型前端的文案逻辑"""
    c = '品类与需求高度契合' if compat >= 85 else '品类基本匹配' if compat >= 68 else '与需求契合度偏低'
    r = '画质满足商用标准' if res >= 85 else '画质够用' if res >= 65 else '画质偏弱'
    p = '价格有明显优势' if verdict == '性价比高' else '价格略高' if verdict == '价格偏高' else '价格处于合理区间'
    return '；'.join([c, r, p])

async def main(args: Args) -> Output:
    params = args.params
    raw = params.get('results') or '[]'
    summary = params.get('summary') or ''
    try:
        count = int(params.get('count') or 0)
    except Exception:
        count = 0

    try:
        items = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except Exception:
        items = []

    if not items:
        return {'text': '没有找到合适的资产，试试放宽关键词或预算。'}

    # 标题 + 一句话结论
    lines = ['## 🎯 为你找到 %d 个匹配的 3D 资产' % len(items), '']
    if summary:
        lines += [summary, '']

    medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣']
    for i, a in enumerate(items):
        s = a.get('scores') or {}
        compat = s.get('compatibility', 0)
        res = s.get('resolution', 0)
        price = s.get('price', 0)
        overall = a.get('overall', 0)
        lic = '可商用' if '商用' in (a.get('license') or '') else '仅个人'
        flag = ' · ⚠️超出预算' if a.get('overBudget') else ''
        medal = medals[i] if i < len(medals) else str(i + 1) + '.'

        lines.append('### %s %d. %s · 综合 %g 分' % (medal, i + 1, a.get('name', ''), overall))
        lines.append('- **兼容性** %g · **画质** %g · **价格** %g'
                     % (compat, res, price))
        lines.append('- ¥%s · %s · %s%s'
                     % (a.get('price', ''), lic, a.get('verdict', ''), flag))
        lines.append('- %s' % reason(compat, res, a.get('verdict', '')))
        lines.append('')

    lines.append('---')
    lines.append('> 分辨率/画质、价格合理度为演示估算，实际以平台数据为准。')
    return {'text': '\n'.join(lines)}
