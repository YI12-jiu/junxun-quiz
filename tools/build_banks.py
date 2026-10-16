# -*- coding: utf-8 -*-
"""从 docx 题库生成前端数据文件 assets/banks.js（一键构建）。

用法：
    python tools/build_banks.py <军事题库.docx> <学生手册题库.docx> <安全知识题库.docx>

依赖：仅标准库（zipfile / xml / re / json）。
"""
import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

BANKS = [
    ('mil', '军事技能训练理论', '军事'),
    ('stu', '学生手册', '学生手册'),
    ('saf', '安全知识', '安全'),
]

SECTION_RE = re.compile(r'[一二三四五六七八九十]\s*、\s*(单项选择题|单选题|多项选择题|多选题)')
SEC_STRIP = re.compile(r'[一二三四五六七八九十]\s*、\s*(?:单项选择题|单选题|多项选择题|多选题)')
ANS_RE = re.compile(r'[（(]\s*答\s*案\s*[:：]\s*([A-Ha-h]+)\s*[)）]')
OPT_RE = re.compile(r'(?<![A-Za-z])([A-H])[．.]')
CJK_RE = re.compile(r'[\u4e00-\u9fff\uff00-\uffefA-Za-z0-9]')


def docx_text(path):
    """读取 docx 全部段落文本，每段一行。"""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))
    lines = []
    for el in root.iter(W + 'p'):
        lines.append(''.join(t.text or '' for t in el.iter(W + 't')))
    return lines


def clean(s):
    s = SEC_STRIP.sub('', s)
    return re.sub(r'\s+', ' ', s).strip()


def parse(path):
    S = '\n'.join(l.strip() for l in docx_text(path))

    sections = []
    for m in SECTION_RE.finditer(S):
        sections.append((m.start(), 'multi' if ('多项' in m.group(1) or '多选' in m.group(1)) else 'single'))

    def sec_idx(pos):
        idx = 0
        for j, (st, _) in enumerate(sections):
            if st <= pos:
                idx = j
        return idx

    answers = [(m.start(), m.end(), m.group(1).upper()) for m in ANS_RE.finditer(S)]

    # 每个小节内题号从 1 递增
    counters, exp_nums = {}, []
    for (a_s, a_e, ans) in answers:
        j = sec_idx(a_s)
        counters[j] = counters.get(j, 0) + 1
        exp_nums.append(counters[j])

    def find_stem_start(lo, a_s, exp):
        """回溯定位题干起点。用题号字面串匹配，可处理数字粘连：
        D.10 + 59. -> D.1059.（题号 59）；D.1.8 + 75. -> D.1.875.（题号 75）。
        """
        pat = re.compile(rf'{exp}\s*[．.]')
        cands = [m for m in pat.finditer(S, lo, a_s)]
        if not cands:
            return None
        plain = [m for m in cands if not S[max(lo, m.start() - 1):m.start()].isdigit()]
        return (plain or cands)[-1].start()

    stems, prev_end = [], 0
    for i, (a_s, a_e, ans) in enumerate(answers):
        stems.append(find_stem_start(prev_end if i else 0, a_s, exp_nums[i]))
        prev_end = a_e

    questions = []
    for i, (a_s, a_e, ans) in enumerate(answers):
        st = stems[i]
        if st is None:
            continue
        exp, sec = exp_nums[i], sec_idx(a_s)
        q_end = st + len(str(exp)) + 1
        stem = clean(S[q_end:a_s])

        nxt = len(S)
        if i + 1 < len(answers):
            ns = stems[i + 1]
            nxt = ns if (ns is not None and ns > a_e) else answers[i + 1][0]
        region = S[a_e:nxt]

        marks = [(m.start(), m.end(), m.group(1)) for m in OPT_RE.finditer(region)]
        if not marks:
            continue
        # 答案标记写在题干中间时（如「请假（答案：C）以上，…」），把后续文字并回题干
        lead = clean(region[:marks[0][0]])
        if lead and CJK_RE.search(lead):
            stem = stem + '（）' + lead

        opts = []
        for pos, end, letter in marks:
            if not opts:
                if letter == 'A':
                    opts.append([letter, pos, end])
            elif letter == chr(ord(opts[-1][0]) + 1):
                opts.append([letter, pos, end])
        if len(opts) < 2:
            continue

        result = []
        for j, (letter, pos, end) in enumerate(opts):
            stop = opts[j + 1][1] if j + 1 < len(opts) else len(region)
            txt = clean(region[end:stop])
            if txt:
                result.append([letter, txt])
        if len(result) < 2:
            continue

        labels = [o[0] for o in result]
        keep = [c for c in ans if c in labels]
        if not keep:
            continue

        questions.append({
            'num': exp,
            'type': 'multi' if (sections and sections[sec][1] == 'multi') else 'single',
            'q': stem,
            'options': result,
            'answer': keep,
        })
    return questions


def main():
    args = sys.argv[1:]
    if len(args) != 3:
        print(__doc__)
        sys.exit(1)

    out_dir = os.path.join(ROOT, 'assets')
    os.makedirs(out_dir, exist_ok=True)

    data, meta, lines = {}, {}, []
    for (key, name, short), src in zip(BANKS, args):
        qs = parse(src)
        data[key] = qs
        meta[key] = {'name': name, 'short': short}
        lines.append('window.BANKS.{} = {};'.format(key, json.dumps(
            [{'q': q['q'], 'o': q['options'], 'a': q['answer'], 't': 'M' if q['type'] == 'multi' else 'S'}
             for q in qs], ensure_ascii=False, separators=(',', ':'))))
        s = sum(1 for q in qs if q['type'] == 'single')
        print(f'{name}: 共 {len(qs)} 题（单选 {s} / 多选 {len(qs) - s}）')

    header = ['/* 自动生成：题库数据（由 tools/build_banks.py 从 docx 解析） */',
              'window.BANKS = window.BANKS || {};']
    body = '\n'.join(header + lines + ['window.BANK_META = {};'.format(json.dumps(meta, ensure_ascii=False))])

    dst = os.path.join(out_dir, 'banks.js')
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(body + '\n')

    parsed_dir = os.path.join(ROOT, 'tools', 'parsed')
    os.makedirs(parsed_dir, exist_ok=True)
    with open(os.path.join(parsed_dir, 'banks.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    total = sum(len(v) for v in data.values())
    print(f'\n共 {total} 题 -> {dst}')


if __name__ == '__main__':
    main()
