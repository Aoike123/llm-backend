"""Convert [pinyin+tone] tags into CosyVoice3 special-token form.

CosyVoice3's tokenizer registers initials and tone-marked finals as special
tokens (e.g. [sh], [àn]); [shan4] must become [sh][àn] before tokenization.
"""
import re

INITIALS = ('zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l',
            'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w')
TONE_MARKS = {
    'a': 'āáǎà', 'o': 'ōóǒò', 'e': 'ēéěè',
    'i': 'īíǐì', 'u': 'ūúǔù', 'v': 'ǖǘǚǜ',
}
TAG_RE = re.compile(r'\[([a-zA-ZüÜ]+)([1-5])?\]')


def mark_tone(final: str, tone: int) -> str:
    if tone == 5:
        return final.replace('v', 'ü')
    target = next((c for c in ('a', 'o', 'e') if c in final), None)
    if target is None:
        vowels = [i for i, c in enumerate(final) if c in 'iuüv']
        if not vowels:
            return final
        target = final[vowels[-1]]
    marked = TONE_MARKS.get('v' if target in ('ü', 'v') else target)
    if marked is None:
        return final
    return final.replace(target, marked[tone - 1], 1)


def convert_syllable(syllable: str, tone: int) -> str:
    syl = syllable.lower().replace('ü', 'v')
    initial = next((i for i in INITIALS if syl.startswith(i) and len(syl) > len(i)), '')
    final = syl[len(initial):]
    # j/q/x + u is written u but pronounced ü; the token set keeps the written form.
    final = mark_tone(final, tone)
    return f'[{initial}][{final}]' if initial else f'[{final}]'


def convert(text: str) -> str:
    def repl(m):
        return convert_syllable(m.group(1), int(m.group(2) or 5))
    return TAG_RE.sub(repl, text)


if __name__ == '__main__':
    import sys
    for line in sys.argv[1:] or ['今天我去见[shan4]田芳。', '重庆[chong2]庆，[lv4]色[an4]全。']:
        print(line, '=>', convert(line))
