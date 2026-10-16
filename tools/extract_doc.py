#!/usr/bin/env python3
"""从 Word 97-2003 二进制 .doc 中提取纯文本（仅依赖 olefile）。

.doc 的正文不在明文里，而是由 FIB + 分片表（piece table）描述：
  · FIB 位于 WordDocument 流头部，flags(0x0A) 的 bit9 决定用 0Table 还是 1Table；
  · CLX 位于表流的 fcClx 处，其中的 Pcdt 给出 PlcPcd（CP 数组 + PCD 数组）；
  · 每个 PCD 的 FC 字段 bit30 表示该片段是「压缩」的 8 位编码还是 UTF-16LE。
用法：python tools/extract_doc.py <file.doc> [out.txt]
"""
import struct
import sys
from pathlib import Path

import olefile


def _u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def _u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def extract(path):
    ole = olefile.OleFileIO(path)
    try:
        if not ole.exists('WordDocument'):
            raise ValueError('不是 Word 文档：缺少 WordDocument 流')
        wd = ole.openstream('WordDocument').read()

        if _u16(wd, 0) != 0xA5EC:
            raise ValueError('不是 Word 文档：wIdent 校验失败')

        flags = _u16(wd, 0x0A)
        f_complex = bool(flags & 0x0004)
        table_name = '1Table' if (flags & 0x0200) else '0Table'
        fc_min, fc_mac = _u32(wd, 0x18), _u32(wd, 0x1C)
        lid = _u16(wd, 0x06)

        # 中文文档的 ANSI 码页
        try:
            ansi = {0x0804: 'gbk', 0x0404: 'big5'}.get(lid, 'gbk')
        except Exception:
            ansi = 'gbk'

        # Word 97 及以后：正文一律以「分片表」为准。
        # fcMin/fcMac 是 Word 6/95 的遗留字段，Word 2000+ 与 WPS 常写成 (fcMin, fcMin+1) 这种无效值，
        # 直接用它只会取到 1 个字符，因此这里优先解析分片表，失败才回退。
        text = None
        try:
            text = _from_piece_table(ole, wd, table_name, ansi)
        except Exception as e:
            sys.stderr.write('[warn] 分片表解析失败：%s\n' % e)

        if not text or len(text.strip()) <= 1:
            raw = wd[fc_min:fc_mac]
            text = raw.decode(ansi, errors='replace')
        return text
    finally:
        ole.close()


def _from_piece_table(ole, wd, table_name, ansi):
    """按 CLX 里的 PlcPcd 还原正文。"""
    if not ole.exists(table_name):
        raise ValueError('缺少表流 %s' % table_name)
    tbl = ole.openstream(table_name).read()
    fc_clx, lcb_clx = _u32(wd, 0x01A2), _u32(wd, 0x01A6)
    if lcb_clx == 0:
        raise ValueError('FIB 中 fcClx/lcbClx 为空')
    clx = tbl[fc_clx:fc_clx + lcb_clx]

    # 跳过前置的 Prc 块（0x01），定位 Pcdt（0x02）
    i = 0
    while i < len(clx) and clx[i] == 0x01:
        cb = _u16(clx, i + 1)
        i += 3 + cb
    if i >= len(clx) or clx[i] != 0x02:
        raise ValueError('CLX 中未找到 Pcdt')
    lcb = _u32(clx, i + 1)
    plc = clx[i + 5:i + 5 + lcb]

    n = (len(plc) - 4) // 12          # PlcPcd: (n+1)*4 字节 CP + n*8 字节 PCD
    if n <= 0:
        raise ValueError('PlcPcd 长度为 %d，分片数为 %d' % (len(plc), n))
    cps = [_u32(plc, k * 4) for k in range(n + 1)]
    pcds = plc[(n + 1) * 4:]

    out = []
    for k in range(n):
        pcd = pcds[k * 8:(k + 1) * 8]
        fc = _u32(pcd, 2)
        compressed = bool(fc & 0x40000000)
        off = (fc & 0x3FFFFFFF) >> 1 if compressed else fc
        cnt = cps[k + 1] - cps[k]
        if compressed:
            out.append(wd[off:off + cnt].decode(ansi, errors='replace'))
        else:
            out.append(wd[off:off + cnt * 2].decode('utf-16-le', errors='replace'))
    return ''.join(out)


def normalize(text):
    """把 Word 控制符转成便于阅读/解析的形式。"""
    text = text.replace('\x07', '\t')      # 表格单元格/行结束
    text = text.replace('\x0b', '\n')      # 手动换行
    text = text.replace('\x0c', '\n')      # 分页
    text = text.replace('\x13', '').replace('\x14', '').replace('\x15', '')  # 域代码标记
    text = text.replace('\x01', '').replace('\x02', '').replace('\x08', '')
    text = text.replace('\xa0', ' ')
    text = text.replace('\r', '\n')
    lines = [ln.rstrip() for ln in text.split('\n')]
    return '\n'.join(lines)


if __name__ == '__main__':
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    txt = normalize(extract(src))
    if dst:
        Path(dst).write_text(txt, encoding='utf-8')
        print('已写出 %s（%d 字符，%d 行）' % (dst, len(txt), txt.count('\n') + 1))
    else:
        sys.stdout.reconfigure(encoding='utf-8')
        print(txt)
