"""README hero and three cards for one plugin, light and dark, English and Chinese.

    python3 make_svgs.py <pc|jws|aa> <out dir>

Same frame, palette and type as the Git Note History sample (readme-kit); the right half of the hero
draws the plugin's own interface with the demo vault's made-up data.
"""
import sys
from pathlib import Path

THEMES = {
    "light": dict(bg="#F7F6FB", fg="#1D1B26", muted="#6B6780", line="#E4E1EE",
                  card="#FFFFFF", accent="#7A5AF0", accent_soft="#EEE9FF",
                  red="#C93A40", red_soft="#FCEBEC", green="#22855A", green_soft="#E5F4EC",
                  orange="#B25E09", orange_soft="#FBEEDD"),
    "dark": dict(bg="#15141B", fg="#EEECF5", muted="#9C98AF", line="#2C2A36",
                 card="#1E1D26", accent="#A48BFF", accent_soft="#2C2643",
                 red="#F07C80", red_soft="#3A1E24", green="#5CC892", green_soft="#16301F",
                 orange="#F2A65A", orange_soft="#3A2A18"),
}
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------- the plugins' own interface, drawn

def proof_pc(c, zh):
    t = (lambda en, cn: cn if zh else en)
    ring_len = 2 * 3.1416 * 30
    return f"""
    <rect x="700" y="48" width="436" height="304" rx="20" fill="{c['card']}" stroke="{c['line']}"/>
    <text x="728" y="92" font-size="18" fill="{c['muted']}">{t('Demo pass · 7 days', '示例通行证 · 7 天')}</text>
    <text x="726" y="158" font-size="64" font-weight="700" letter-spacing="-1.5" fill="{c['fg']}">44</text>
    <text x="818" y="158" font-size="24" font-weight="600" fill="{c['muted']}">{t('of 52 left', '/ 52 次')}</text>
    <rect x="728" y="178" width="380" height="6" rx="3" fill="{c['line']}"/>
    <rect x="728" y="178" width="321" height="6" rx="3" fill="{c['accent']}"/>
    <rect x="724" y="206" width="388" height="72" rx="14" fill="{c['bg']}"/>
    <text x="744" y="236" font-size="17" fill="{c['muted']}">{t('Current pass', '当前这张')}</text>
    <text x="744" y="264" font-size="22" font-weight="600" fill="{c['fg']}">{t('6 d 23 h left', '剩 6 天 23 小时')}</text>
    <g transform="rotate(-90 1070 242)">
      <circle cx="1070" cy="242" r="20" fill="none" stroke="{c['line']}" stroke-width="5"/>
      <circle cx="1070" cy="242" r="20" fill="none" stroke="{c['accent']}" stroke-width="5" stroke-linecap="round"
              stroke-dasharray="{2 * 3.1416 * 20:.1f}" stroke-dashoffset="{2 * 3.1416 * 20 * 0.02:.1f}"/>
    </g>
    <rect x="724" y="296" width="388" height="40" rx="12" fill="{c['green_soft']}"/>
    <text x="742" y="322" font-size="18" fill="{c['green']}"><tspan font-weight="700">{t('On pace.', '节奏正常。')}</tspan> {t('Next one by Dec 5, 11:59 PM', '下一张最晚 12月5日 23:59')}</text>
"""


def proof_jws(c, zh):
    t = (lambda en, cn: cn if zh else en)
    days = (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] if not zh else ["一", "二", "三", "四", "五", "六", "日"])
    hours = [5, 4, 0, 5, 0, 7, 6]
    base, scale, x0, step = 288, 14, 742, 52
    bars = []
    for i, (d, h) in enumerate(zip(days, hours)):
        x = x0 + i * step
        if h:
            bars.append(f'<rect x="{x}" y="{base - h * scale}" width="30" height="{h * scale}" rx="6" fill="{c["accent"] if i < 5 else c["green"]}"/>')
        bars.append(f'<text x="{x + 15}" y="{base + 26}" font-size="16" text-anchor="middle" fill="{c["muted"]}">{d}</text>')
    # the shift being added: Fri 18:00-20:00, drawn as the over-the-line warning
    fx = x0 + 4 * step
    bars.append(f'<rect x="{fx}" y="{base - 2 * scale}" width="30" height="{2 * scale}" rx="6" fill="{c["red_soft"]}" stroke="{c["red"]}" stroke-width="2" stroke-dasharray="4 3"/>')
    return f"""
    <rect x="700" y="48" width="436" height="304" rx="20" fill="{c['card']}" stroke="{c['line']}"/>
    <text x="728" y="92" font-size="18" fill="{c['muted']}">{t('This week', '本周')}</text>
    <text x="726" y="136" font-size="40" font-weight="700" letter-spacing="-1" fill="{c['fg']}">27 h</text>
    <text x="814" y="136" font-size="20" fill="{c['muted']}">{t('of 28', '/ 28 小时')}</text>
    <rect x="{902 if zh else 892}" y="72" width="{210 if zh else 220}" height="34" rx="17" fill="{c['red_soft']}"/>
    <text x="{1007 if zh else 1002}" y="95" font-size="17" font-weight="600" text-anchor="middle" fill="{c['red']}">{t('+ Fri 18–20 → 29 h', '+ 周五 18–20 → 29 小时')}</text>
    {''.join(bars)}
"""


def proof_aa(c, zh):
    t = (lambda en, cn: cn if zh else en)
    lines = "".join(f'<rect x="740" y="{y}" width="{w}" height="6" rx="3" fill="{c["line"]}"/>' for y, w in
                    [(118, 70), (138, 90), (166, 96), (182, 80), (198, 88), (222, 70), (238, 84), (262, 60)])
    rows = [(t("Onigiri, green tea", "饭团、绿茶"), t("Convenience store", "便利店"), "¥450"),
            (t("Notebook, pen", "本子、圆珠笔"), t("Stationery", "文具"), "¥330")]
    out = [f"""
    <rect x="700" y="48" width="436" height="304" rx="20" fill="{c['card']}" stroke="{c['line']}"/>
    <rect x="724" y="74" width="128" height="250" rx="10" fill="{c['bg']}" stroke="{c['line']}"/>
    <rect x="752" y="92" width="72" height="10" rx="5" fill="{c['muted']}"/>
    {lines}
    <path d="M864 199 H884" stroke="{c['accent']}" stroke-width="3" stroke-linecap="round"/>
    <path d="M878 192 L886 199 L878 206" fill="none" stroke="{c['accent']}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>"""]
    for i, (title, cat, amount) in enumerate(rows):
        y = 84 + i * 92
        out.append(f'<rect x="896" y="{y}" width="216" height="80" rx="14" fill="{c["bg"]}"/>')
        out.append(f'<text x="912" y="{y + 28}" font-size="16" fill="{c["fg"]}">{esc(title)}</text>')
        pill = round(len(cat) * (13 if zh else 7.4) + 22)
        out.append(f'<rect x="912" y="{y + 42}" width="{pill}" height="24" rx="12" fill="{c["accent_soft"]}"/>')
        out.append(f'<text x="{912 + pill / 2}" y="{y + 59}" font-size="13" text-anchor="middle" fill="{c["accent"]}">{esc(cat)}</text>')
        out.append(f'<text x="1098" y="{y + 60}" font-size="18" font-weight="600" text-anchor="end" fill="{c["fg"]}">{amount}</text>')
    out.append(f'<rect x="896" y="276" width="216" height="44" rx="22" fill="{c["accent"]}"/>')
    out.append(f'<text x="1004" y="304" font-size="18" font-weight="600" text-anchor="middle" fill="{c["card"]}">{t("Record 2", "确认 2 笔入账")}</text>')
    return "\n    ".join(out)


PLUGINS = {
    "pc": dict(
        name="Pass Countdown", proof=proof_pc,
        en=dict(eyebrow="OBSIDIAN PLUGIN · OFFLINE, NO ACCOUNT", line1="Use every day of a multi-use pass.",
                line2="Know when to start the next one.", small="free · no network · desktop and mobile",
                desc="A pass with 52 uses of 7 days: 44 left, the current one has 6 days 23 hours left, and it is on pace: start the next one by December 5 to use them all.",
                cards=[("Count at a glance", "Uses, time left and pace.", "count"),
                       ("Never overlap", "Warned before you cut one short.", "overlap"),
                       ("Reminders outside", ".ics alerts before each ends.", "bell")],
                cards_desc="Count at a glance: uses left, time left on the running pass and the latest start that still fits every pass. Never overlap: a warning before a new pass would cut the running one short. Reminders outside Obsidian: an .ics file with alerts before each pass ends."),
        zh=dict(eyebrow="OBSIDIAN 插件 · 离线，无需账号", line1="多次券，一天也不浪费。",
                line2="下一张什么时候开，一眼知道。", small="免费 · 不联网 · 电脑和手机",
                desc="一张 52 次、每次 7 天的通行证：还剩 44 次，当前这张剩 6 天 23 小时，节奏正常，想全部用完，下一张最晚 12 月 5 日开。",
                cards=[("剩几次一眼看到", "次数、剩余时间、节奏", "count"),
                       ("不会叠着用", "压掉正在用的，先提醒你", "overlap"),
                       ("提醒带出去", "导出 .ics，到期前提醒", "bell")],
                cards_desc="剩几次一眼看到：剩余次数、当前这张还剩多久、最晚什么时候开下一张。不会叠着用：新开的会压掉正在用的那张时，先提醒你。提醒带出 Obsidian：导出 .ics，每张到期前提醒。")),
    "jws": dict(
        name="Japan Work Secretary", proof=proof_jws,
        en=dict(eyebrow="OBSIDIAN PLUGIN · FOR STUDENTS WORKING IN JAPAN", line1="Stay under 28 hours a week.",
                line2="Pay worked out like your payslip.", small="free · data stays in your vault",
                desc="This week has 27 of 28 hours. Adding a Friday shift from 18:00 to 20:00 would make it 29 hours, so it is marked before you save.",
                cards=[("Every 7 days", "Warned before 28 hours.", "week"),
                       ("Pay like a payslip", "Night, overtime, real breaks.", "yen"),
                       ("Roster to calendar", "From a message or photo.", "calendar")],
                cards_desc="Every 7 days: a warning before a shift takes any 7-day window over 28 hours. Pay like a payslip: night rates, overtime and the breaks you actually took. Roster to calendar: read a message or a photo, then sync to Calendar."),
        zh=dict(eyebrow="OBSIDIAN 插件 · 在日留学生打工", line1="每周不超 28 小时。",
                line2="工资按工资条的算法算。", small="免费 · 数据留在库里",
                desc="本周已排 27 小时，上限 28。再加周五 18:00–20:00 一班就是 29 小时，保存前会标出来。",
                cards=[("每个连续 7 天", "超 28 小时，保存前提醒", "week"),
                       ("按工资条算", "深夜、加班、实际休息", "yen"),
                       ("排班进日历", "读消息或照片，一键同步", "calendar")],
                cards_desc="每个连续 7 天：某个连续 7 天会超 28 小时，保存前就提醒。按工资条算：深夜时薪、加班、实际休息都算上。排班进日历：读消息或照片，同步到日历。")),
    "aa": dict(
        name="AI Accounting", proof=proof_aa,
        en=dict(eyebrow="OBSIDIAN PLUGIN · AI DRAFTS, YOU CONFIRM", line1="Snap a receipt.",
                line2="Check two lines. It's in your ledger.", small="your own key or a local model · Markdown ledger",
                desc="A convenience store receipt becomes two draft lines, onigiri and green tea for 450 yen and a notebook and pen for 330 yen, each with a category, waiting to be recorded.",
                cards=[("Nothing unchecked", "Every draft waits for you.", "check"),
                       ("Plain Markdown", "One table a month, yours.", "table"),
                       ("Any currency", "Kept as paid, converted.", "fx")],
                cards_desc="Nothing unchecked: every AI draft waits for your review. Plain Markdown: one table per month in your vault. Any currency: each row keeps what you paid and the converted amount."),
        zh=dict(eyebrow="OBSIDIAN 插件 · AI 起草，你来确认", line1="拍一张小票，",
                line2="核对两行，就进了账本。", small="自己的密钥或本地模型 · Markdown 账本",
                desc="一张便利店小票变成两行草稿：饭团和绿茶 450 日元、本子和圆珠笔 330 日元，各带分类，等你确认入账。",
                cards=[("不核对不入账", "每份草稿都等你确认", "check"),
                       ("纯 Markdown", "每月一张表，归你所有", "table"),
                       ("哪种币都行", "原币保留，自动换算", "fx")],
                cards_desc="不核对不入账：AI 起草的每一笔都等你核对。纯 Markdown：每月一张表，放在你的库里。哪种币都行：每行保留原币金额，并换算成报表币种。")),
}


def hero(p, c, zh):
    text = p["zh" if zh else "en"]
    name = p["name"]
    size = 64 if len(name) < 18 else 52
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400" role="img" aria-labelledby="t d">
  <title id="t">{esc(name)}</title>
  <desc id="d">{esc(text['line1'] + ' ' + text['line2'] + ' ' + text['desc'])}</desc>
  <rect width="1200" height="400" rx="28" fill="{c['bg']}"/>
  <g id="title-block" font-family="{SANS}">
    <text x="64" y="118" font-family="{MONO if not zh else SANS}" font-size="17" letter-spacing="{2 if not zh else 1}" fill="{c['accent']}">{esc(text['eyebrow'])}</text>
    <text x="62" y="196" font-size="{size}" font-weight="700" letter-spacing="-1.5" fill="{c['fg']}">{esc(name)}</text>
    <text x="64" y="252" font-size="29" fill="{c['fg']}">{esc(text['line1'])}</text>
    <text x="64" y="292" font-size="29" fill="{c['muted']}">{esc(text['line2'])}</text>
    <text x="64" y="346" font-family="{MONO if not zh else SANS}" font-size="17" fill="{c['muted']}">{esc(text['small'])}</text>
  </g>
  <g id="project-proof" font-family="{SANS}">{p['proof'](c, zh)}
  </g>
</svg>
"""


def glyph(kind, x, y, c):
    a, m, r, g = c["accent"], c["muted"], c["red"], c["green"]
    if kind == "count":
        return (f'<text x="{x+24}" y="{y+32}" font-size="20" font-weight="700" text-anchor="middle" fill="{a}" font-family="{SANS}">44</text>')
    if kind == "overlap":
        return (f'<rect x="{x+8}" y="{y+14}" width="22" height="8" rx="4" fill="{a}"/>'
                f'<rect x="{x+18}" y="{y+26}" width="22" height="8" rx="4" fill="none" stroke="{r}" stroke-width="2" stroke-dasharray="3 2"/>')
    if kind == "bell":
        return (f'<path d="M{x+15} {y+31} V{y+22} a9 9 0 0 1 18 0 V{y+31} Z" fill="none" stroke="{a}" stroke-width="2.5" stroke-linejoin="round"/>'
                f'<path d="M{x+12} {y+31} H{x+36}" stroke="{a}" stroke-width="2.5" stroke-linecap="round"/>'
                f'<circle cx="{x+24}" cy="{y+36}" r="2.5" fill="{a}"/>')
    if kind == "week":
        return "".join(f'<rect x="{x+9+i*6}" y="{y+34-h}" width="4" height="{h}" rx="2" fill="{a if h < 20 else r}"/>' for i, h in enumerate([12, 10, 4, 12, 22]))
    if kind == "yen":
        return (f'<text x="{x+24}" y="{y+33}" font-size="24" font-weight="700" text-anchor="middle" fill="{a}" font-family="{SANS}">¥</text>')
    if kind == "calendar":
        return (f'<rect x="{x+11}" y="{y+13}" width="26" height="24" rx="5" fill="none" stroke="{a}" stroke-width="2.5"/>'
                f'<path d="M{x+11} {y+20} H{x+37}" stroke="{a}" stroke-width="2.5"/>'
                f'<rect x="{x+16}" y="{y+25}" width="7" height="6" rx="2" fill="{a}"/>')
    if kind == "check":
        return (f'<path d="M{x+13} {y+25} L{x+21} {y+33} L{x+36} {y+16}" fill="none" stroke="{g}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>')
    if kind == "table":
        return (f'<rect x="{x+11}" y="{y+13}" width="26" height="22" rx="4" fill="none" stroke="{a}" stroke-width="2.5"/>'
                f'<path d="M{x+11} {y+21} H{x+37} M{x+11} {y+28} H{x+37} M{x+21} {y+13} V{y+35}" stroke="{a}" stroke-width="2"/>')
    return (f'<text x="{x+24}" y="{y+31}" font-size="16" font-weight="700" text-anchor="middle" fill="{a}" font-family="{SANS}">¥$</text>')


def cards(p, c, zh):
    text = p["zh" if zh else "en"]
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="190" viewBox="0 0 1200 190" role="img" aria-labelledby="t d">',
             f'<title id="t">{esc(("%s 能做什么" if zh else "What %s does") % p["name"])}</title>',
             f'<desc id="d">{esc(text["cards_desc"])}</desc>',
             f'<g font-family="{SANS}">']
    for i, (title, body, kind) in enumerate(text["cards"]):
        x = 24 + i * 392
        parts.append(f'<rect x="{x}" y="16" width="368" height="158" rx="22" fill="{c["bg"]}" stroke="{c["line"]}"/>')
        parts.append(f'<rect x="{x+28}" y="44" width="48" height="48" rx="14" fill="{c["accent_soft"]}"/>')
        parts.append(glyph(kind, x + 28, 44, c))
        parts.append(f'<text x="{x+96}" y="78" font-size="{27 if not zh else 26}" font-weight="700" fill="{c["fg"]}">{esc(title)}</text>')
        parts.append(f'<text x="{x+28}" y="138" font-size="20" fill="{c["muted"]}">{esc(body)}</text>')
    parts.append('</g></svg>\n')
    return "\n".join(parts)


if __name__ == "__main__":
    key, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    p = PLUGINS[key]
    for mode, c in THEMES.items():
        for zh, suffix in ((False, ""), (True, "-zh")):
            (out / f"hero{suffix}-{mode}.svg").write_text(hero(p, c, zh), encoding="utf-8")
            (out / f"cards{suffix}-{mode}.svg").write_text(cards(p, c, zh), encoding="utf-8")
    print("wrote", out)
