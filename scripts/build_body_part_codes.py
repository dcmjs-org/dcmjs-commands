#!/usr/bin/env python3
"""Build src/enhanced/bodyPartCodes.js from PS3.16 Annex L.

Table L-1 maps each Body Part Examined (0018,0015) defined term to its SNOMED CT
code. Table L-5 tells, for each code, whether the structure is paired. A row of
Table L-1 with no code value is left out.

Usage:
    curl -sSL https://dicom.nema.org/medical/dicom/current/output/chtml/part16/chapter_L.html -o chapter_L.html
    python3 scripts/build_body_part_codes.py chapter_L.html > src/enhanced/bodyPartCodes.js
    npx prettier --write src/enhanced/bodyPartCodes.js
"""
import html
import json
import re
import sys


def table(page, table_id):
    start = page.index('<table', page.index(f'id="{table_id}"'))
    body = page[start:page.index('</table>', start)]
    rows = re.findall(r'<tr.*?</tr>', body, re.S)
    return [
        [re.sub(r'\s+', ' ', html.unescape(re.sub(r'<.*?>', '', cell))).strip()
         for cell in re.findall(r'<t[hd].*?</t[hd]>', row, re.S)]
        for row in rows
    ]


def main(path):
    page = open(path, encoding='utf-8').read()
    edition = re.search(r'DICOM PS3\.16 (\d{4}[a-z])', page).group(1)
    paired = {row[0]: row[2] == 'Y' for row in table(page, 'table_L-5')[1:]}
    entries = {}
    for row in table(page, 'table_L-1')[1:]:
        scheme, value, meaning, body_part = row[:4]
        if scheme == 'SCT' and value and body_part:
            if value not in paired:
                sys.exit(f'{body_part} {value}: no row in Table L-5')
            entries[body_part] = [value, meaning, paired[value]]
    print('// src/enhanced/bodyPartCodes.js')
    print('//')
    print(f'// Generated from PS3.16 {edition}, Annex L: Table L-1 (Body Part Examined')
    print('// (0018,0015) to the SNOMED CT code) and Table L-5 (paired structure).')
    print('// Do not edit by hand: run scripts/build_body_part_codes.py.')
    print()
    print('/** BodyPartExamined -> [SCT code value, code meaning, paired]. */')
    print('export const BODY_PART_CODES = {')
    for body_part in sorted(entries):
        print(f'  {json.dumps(body_part)}: {json.dumps(entries[body_part])},')
    print('};')


if __name__ == '__main__':
    main(sys.argv[1])
