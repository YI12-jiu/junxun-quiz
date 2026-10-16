#!/usr/bin/env python3
"""把「自编题(1).doc」的 12 条陈述句转成填空题，生成 assets/banks_fill.js。

原文档把「填空答案」用加粗标了出来，因此这里的做法是：
  · 题干 = 原句逐字照抄，只把加粗的答案片段替换为 ____；
  · 答案 = 加粗片段本身，不引入任何原文之外的事实；
  · 支持一题多空（第 6/8/9/10 题各两空），多空题需全部答对才得分；
  · 判分两级规则（实现见 app.js 的 normFill / isBlankRight）：
      1) 规范化后精确匹配 accept 中的任一写法（全半角、空格、标点差异均可容忍）；
      2) 列举型题目只要 need 里的关键词全部出现即算对（不限顺序）。
用法：python tools/build_fill_bank.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JS = ROOT / 'assets' / 'banks_fill.js'
OUT_JSON = ROOT / 'tools' / 'parsed' / 'fill_bank.json'

BANK_NAME = '自编题（校情校史）'
BANK_SHORT = '自编题'
NOTE = '原句逐字照抄，仅将加粗的答案片段替换为空格'

QUESTIONS = [
    dict(q='长沙理工大学由原长沙交通学院、长沙电力学院于____年合并组建。',
         blanks=[dict(ans='2003', accept=['2003', '2003年'])]),

    dict(q='导员办公室位置在____（写清楚教学楼和门牌号）。',
         blanks=[dict(ans='九教219', accept=['九教219', '9教219', '九教二一九', '九教219室', '九教219房间'])]),

    dict(q='湖南精神是____。',
         blanks=[dict(ans='忠诚、担当、求是、图强', need=['忠诚', '担当', '求是', '图强'])]),

    dict(q='我校的校风是____八个字。',
         blanks=[dict(ans='团结进取、严谨务实', need=['团结进取', '严谨务实'])]),

    dict(q='____是我校授予学生的最高荣誉称号。',
         blanks=[dict(ans='十大长理之星', accept=['十大长理之星', '长理之星'])]),

    dict(q='长沙理工大学学生就寝时间为____到次日____。',
         blanks=[dict(ans='23:30', accept=['23:30', '23：30', '23点30分', '23时30分', '23点30']),
                 dict(ans='6:30', accept=['6:30', '6：30', '6点30分', '六点三十分', '06:30'])]),

    dict(q='学生每学期德育成绩至少达到____为合格。',
         blanks=[dict(ans='60分', accept=['60', '60分', '六十分'])]),

    dict(q='学生参加勤工助学的时间原则上，每周不超过____，每月不超过的____。',
         blanks=[dict(ans='8小时', accept=['8', '8小时', '八小时', '八']),
                 dict(ans='40小时', accept=['40', '40小时', '四十小时'])]),

    dict(q='累计旷课达____（含）或擅自外出____的，给予严重警告处分。',
         blanks=[dict(ans='26学时', accept=['26', '26学时', '二十六', '26个学时']),
                 dict(ans='6至8天', accept=['6至8天', '6到8天', '6-8天', '6~8天', '六至八天'])]),

    dict(q='考试违规是指违背国家及学校一切有关考试规则和纪律的行为，分为____和____。',
         blanks=[dict(ans='考试违纪', accept=['考试违纪', '违纪']),
                 dict(ans='考试作弊', accept=['考试作弊', '作弊'])]),

    dict(q='学生违纪处理种类有____。',
         blanks=[dict(ans='警告、严重警告、记过、留校察看、开除学籍',
                      need=['警告', '严重警告', '记过', '留校察看', '开除学籍'])]),

    dict(q='长沙理工大学综合测评包括____。',
         blanks=[dict(ans='德育、智育、美育、劳育、体育',
                      need=['德育', '智育', '美育', '劳育', '体育'])]),
]


def validate():
    errs, seen = [], set()
    for i, it in enumerate(QUESTIONS, 1):
        q = it['q']
        holes = q.count('____')
        if holes != len(it['blanks']):
            errs.append('第 %d 题：题干有 %d 个空，blanks 给了 %d 个' % (i, holes, len(it['blanks'])))
        if q in seen:
            errs.append('第 %d 题题干重复' % i)
        seen.add(q)
        for j, b in enumerate(it['blanks'], 1):
            if not b.get('ans'):
                errs.append('第 %d 题第 %d 空缺少标准答案' % (i, j))
            if not b.get('accept') and not b.get('need'):
                errs.append('第 %d 题第 %d 空既无 accept 也无 need' % (i, j))
    return errs


def js(s):
    return json.dumps(s, ensure_ascii=False)


def main():
    errs = validate()
    if errs:
        for e in errs:
            print('[错误]', e)
        sys.exit(1)

    lines = [
        '/* 填空题库（自动生成，请勿手工编辑）',
        ' * 来源：自编题(1).doc —— 文档中以加粗标出的填空答案即本题库的标准答案',
        ' * %s' % NOTE,
        ' * 生成脚本：tools/build_fill_bank.py',
        ' */',
        'window.BANKS = window.BANKS || {};',
        'window.BANKS.zib = [',
    ]
    for it in QUESTIONS:
        bs = []
        for b in it['blanks']:
            parts = ['ans: ' + js(b['ans'])]
            if b.get('accept'):
                parts.append('accept: [' + ', '.join(js(x) for x in b['accept']) + ']')
            if b.get('need'):
                parts.append('need: [' + ', '.join(js(x) for x in b['need']) + ']')
            bs.append('{ ' + ', '.join(parts) + ' }')
        lines.append('  { q: %s, t: \'F\', blanks: [%s] },' % (js(it['q']), ', '.join(bs)))
    lines += [
        '];',
        'window.BANK_META = window.BANK_META || {};',
        'window.BANK_META.zib = { name: %s, short: %s };' % (js(BANK_NAME), js(BANK_SHORT)),
        '',
    ]

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    OUT_JS.write_text('\n'.join(lines), encoding='utf-8')
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(QUESTIONS, ensure_ascii=False, indent=2), encoding='utf-8')

    total_blanks = sum(len(it['blanks']) for it in QUESTIONS)
    print('已生成 %s' % OUT_JS)
    print('已生成 %s' % OUT_JSON)
    print('填空题库：%d 题 / %d 空（%.1f KB）' % (len(QUESTIONS), total_blanks, OUT_JS.stat().st_size / 1024))
    for i, it in enumerate(QUESTIONS, 1):
        ans = ' ｜ '.join(b['ans'] for b in it['blanks'])
        print('  %2d. [%d空] %s' % (i, len(it['blanks']), it['q']))
        print('        答案：%s' % ans)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
